/**
 * PowerPoint 97–2003 (.ppt, MS-PPT binary format): slide text from the "PowerPoint Document" stream.
 *
 * Slides are found in presentation order through the persist directory (Current User → UserEditAtom chain →
 * PersistDirectoryAtom → DocumentContainer → SlideListWithText). Text comes from TextCharsAtom (UTF-16LE) and
 * TextBytesAtom (8-bit) records, typed by the preceding TextHeaderAtom; it may live in the slide's drawing or after
 * the slide's SlidePersistAtom in SlideListWithText. If the persist structures are unreadable, slides are read in
 * stream order instead (notes are then skipped).
 */
import { corrupt, encrypted } from "./errors.js";
import { heading, inlineText, joinBlocks } from "./markdown.js";
import { cfbStream, readCfb } from "./office.js";
import type { Extracted } from "./types.js";

const RT = {
  Document: 0x03e8,
  Slide: 0x03ee,
  SlideAtom: 0x03ef,
  Notes: 0x03f0,
  SlidePersistAtom: 0x03f3,
  MainMaster: 0x03f8,
  SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5,
  PersistDirectoryAtom: 0x1772,
  TextHeaderAtom: 0x0f9f,
  TextCharsAtom: 0x0fa0,
  TextBytesAtom: 0x0fa8,
  CryptSession10Container: 0x2f14,
} as const;

const MAX_SLIDES = 1000;
const MAX_DEPTH = 16;

type Rec = { type: number; ver: number; inst: number; start: number; body: number; end: number };

function header(s: Buffer, off: number, limit: number): Rec | null {
  if (off < 0 || off + 8 > limit) return null;
  const vi = s.readUInt16LE(off);
  const len = s.readUInt32LE(off + 4);
  const end = off + 8 + len;
  if (end > limit) return null;
  return { type: s.readUInt16LE(off + 2), ver: vi & 0xf, inst: vi >> 4, start: off, body: off + 8, end };
}

function* children(s: Buffer, rec: Rec): Generator<Rec> {
  let off = rec.body;
  while (off + 8 <= rec.end) {
    const r = header(s, off, rec.end);
    if (!r) return;
    yield r;
    off = r.end;
  }
}

type TextRun = { kind: number; text: string };

/** Text atoms under `rec` (depth-first), each tagged with the latest TextHeaderAtom type. */
function collectText(s: Buffer, rec: Rec, out: TextRun[], state: { kind: number }, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const r of children(s, rec)) {
    if (r.type === RT.TextHeaderAtom && r.end - r.body >= 4) state.kind = s.readUInt32LE(r.body);
    else if (r.type === RT.TextCharsAtom) out.push({ kind: state.kind, text: s.subarray(r.body, r.end).toString("utf16le") });
    else if (r.type === RT.TextBytesAtom) out.push({ kind: state.kind, text: s.subarray(r.body, r.end).toString("latin1") });
    else if (r.ver === 0xf) collectText(s, r, out, state, depth + 1);
  }
}

/** persistId → stream offset, walking the UserEditAtom chain from the newest edit (newest entry wins). */
function persistDirectory(s: Buffer, currentUser: Buffer | null): { offsets: Map<number, number>; docRef: number } | null {
  if (!currentUser || currentUser.length < 20) return null;
  let editOffset = currentUser.readUInt32LE(16);
  const offsets = new Map<number, number>();
  let docRef = -1;
  for (let guard = 0; guard < 256 && editOffset > 0 && editOffset < s.length; guard++) {
    const edit = header(s, editOffset, s.length);
    if (!edit || edit.type !== RT.UserEditAtom || edit.end - edit.body < 20) return null;
    if (docRef < 0) docRef = s.readUInt32LE(edit.body + 16);
    const lastEdit = s.readUInt32LE(edit.body + 8);
    const dir = header(s, s.readUInt32LE(edit.body + 12), s.length);
    if (!dir || dir.type !== RT.PersistDirectoryAtom) return null;
    let p = dir.body;
    while (p + 4 <= dir.end) {
      const v = s.readUInt32LE(p);
      const first = v & 0xfffff;
      const count = v >>> 20;
      p += 4;
      for (let k = 0; k < count && p + 4 <= dir.end; k++, p += 4) {
        if (!offsets.has(first + k)) offsets.set(first + k, s.readUInt32LE(p));
      }
    }
    if (lastEdit === 0 || lastEdit >= editOffset) break;
    editOffset = lastEdit;
  }
  return docRef >= 0 ? { offsets, docRef } : null;
}

type Slide = { runs: TextRun[]; notes: TextRun[] };

function slidesFromPersist(s: Buffer, currentUser: Buffer | null): Slide[] | null {
  const dir = persistDirectory(s, currentUser);
  if (!dir) return null;
  const docOffset = dir.offsets.get(dir.docRef);
  const doc = docOffset === undefined ? null : header(s, docOffset, s.length);
  if (!doc || doc.type !== RT.Document) return null;
  const slides: { persist: number; runs: TextRun[] }[] = [];
  const notesById = new Map<number, number>(); // notes slideId → persist id
  for (const list of children(s, doc)) {
    if (list.type !== RT.SlideListWithText) continue;
    let current: { persist: number; runs: TextRun[] } | null = null;
    const state = { kind: 4 };
    for (const r of children(s, list)) {
      if (r.type === RT.SlidePersistAtom && r.end - r.body >= 16) {
        const persist = s.readUInt32LE(r.body);
        const slideId = s.readUInt32LE(r.body + 12);
        if (list.inst === 0) {
          current = { persist, runs: [] };
          slides.push(current);
        } else if (list.inst === 2) notesById.set(slideId, persist);
        else current = null;
      } else if (current && list.inst === 0) {
        if (r.type === RT.TextHeaderAtom && r.end - r.body >= 4) state.kind = s.readUInt32LE(r.body);
        else if (r.type === RT.TextCharsAtom) current.runs.push({ kind: state.kind, text: s.subarray(r.body, r.end).toString("utf16le") });
        else if (r.type === RT.TextBytesAtom) current.runs.push({ kind: state.kind, text: s.subarray(r.body, r.end).toString("latin1") });
      }
    }
  }
  if (!slides.length) return null;
  return slides.slice(0, MAX_SLIDES).map(({ persist, runs }) => {
    const out: Slide = { runs: [...runs], notes: [] };
    const off = dir.offsets.get(persist);
    const slide = off === undefined ? null : header(s, off, s.length);
    if (slide?.type !== RT.Slide) return out;
    collectText(s, slide, out.runs, { kind: 4 });
    // SlideAtom: geom(4) rgPlaceholderTypes(8) masterIdRef(4) notesIdRef(4) → notes container.
    for (const r of children(s, slide)) {
      if (r.type !== RT.SlideAtom || r.end - r.body < 20) continue;
      const notesPersist = notesById.get(s.readUInt32LE(r.body + 16));
      const notesOff = notesPersist === undefined ? undefined : dir.offsets.get(notesPersist);
      const notes = notesOff === undefined ? null : header(s, notesOff, s.length);
      if (notes?.type === RT.Notes) collectText(s, notes, out.notes, { kind: 2 });
    }
    return out;
  });
}

/** Fallback: Slide containers in stream order. */
function slidesInStreamOrder(s: Buffer): Slide[] {
  const slides: Slide[] = [];
  let off = 0;
  while (off + 8 <= s.length && slides.length < MAX_SLIDES) {
    const r = header(s, off, s.length);
    if (!r) break;
    if (r.type === RT.Slide) {
      const slide: Slide = { runs: [], notes: [] };
      collectText(s, r, slide.runs, { kind: 4 });
      slides.push(slide);
    }
    off = r.end;
  }
  return slides;
}

const paragraphs = (t: string) =>
  t
    .split("\r")
    .map((p) => p.replace(/\u000b/g, " ").trim())
    .filter((p) => p && p !== "*");

export async function extractPpt(bytes: Uint8Array): Promise<Extracted> {
  const cfb = readCfb(bytes);
  const stream = cfbStream(cfb, "PowerPoint Document");
  if (!stream) throw corrupt("PowerPoint 簡報");
  if (cfbStream(cfb, "EncryptedSummary")) throw encrypted();
  for (let off = 0, guard = 0; off + 8 <= stream.length && guard < 100_000; guard++) {
    const r = header(stream, off, stream.length);
    if (!r) break;
    if (r.type === RT.CryptSession10Container) throw encrypted();
    off = r.end;
  }
  let slides: Slide[];
  try {
    slides = slidesFromPersist(stream, cfbStream(cfb, "Current User")) ?? slidesInStreamOrder(stream);
  } catch {
    slides = slidesInStreamOrder(stream);
  }
  const sections = slides.map((slide, i) => {
    let title = "";
    const body: string[] = [];
    for (const run of slide.runs) {
      const ps = paragraphs(run.text);
      if ((run.kind === 0 || run.kind === 6) && !title) title = ps.join(" ");
      else if (run.kind !== 2) body.push(...ps.map((p) => `- ${inlineText(p)}`));
    }
    const notes = slide.notes.filter((r) => r.kind === 2).flatMap((r) => paragraphs(r.text));
    return joinBlocks([heading(2, title || `Slide ${i + 1}`), body.join("\n"), notes.length ? notes.map((p) => `> ${inlineText(p)}`).join("\n>\n") : null]);
  });
  const warnings = slides.length >= MAX_SLIDES ? [`簡報超過 ${MAX_SLIDES} 張投影片，只匯入前 ${MAX_SLIDES} 張。`] : [];
  return { markdown: joinBlocks(sections), title: null, pages: slides.length, warnings };
}
