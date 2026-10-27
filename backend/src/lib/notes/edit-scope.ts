/**
 * Scope guards for AI edits of a note (the class: a request that names part of a note changes only that part; every
 * other part is kept byte for byte). Pure functions over the live text, the proposed hunks and the user's words:
 *  - `fullTextRefusal`: a whole-text proposal (`content_md`) is only accepted for a short note, an explicit whole-note
 *    ask, after the whole note was read, and when it does not silently drop most of the note;
 *  - `scopeRefusal`: when the user's words name parts (「第二段」「『結論』那段」), every hunk must lie inside them;
 *  - `continuePatch`: 「繼續改」 of a workflow note proposes only the sections that changed between the committed and
 *    the new assembled text, mapped onto the live note (the user's later edits elsewhere, localized headings and the
 *    banner are never touched).
 */
import type { RawHunk } from "../suggestions/diff.js";
import { mergeRefs, noteOutline, noteRefs, placeOf, wholeNoteAsk, type NoteOutline, type OutlineSection } from "./outline.js";

/** Notes up to this length may be proposed as a whole text without a whole-note ask. */
export const SHORT_NOTE = 1500;
/** What get_note returns per call. */
export const NOTE_READ_CHUNK = 12000;

/** Words that ask to remove or shorten (a big shrink is then expected). */
const SHRINK_RE = /刪|拿掉|去掉|移除|精簡|縮短|簡短|濃縮|摘要|刪減|只留|只保留|\bremove\b|\bdelete\b|\bdrop\b|\bshorten\b|\bcondense\b|\btrim\b|\bsummari[sz]e\b|\bcut\b/i;

/** 繁中 refusal of a full-text proposal, or null when it is acceptable. */
export function fullTextRefusal(p: { text: string; proposed: string; words: string | null; readAll: boolean }): string | null {
  const len = p.text.length;
  if (!p.text.trim()) return null;
  if (!p.readAll) return `這篇筆記有 ${len} 字，你還沒有讀完整篇（get_note 每次最多 ${NOTE_READ_CHUNK} 字），整篇重寫會把沒讀到的部分當成刪除。請改用 edits（before/after）只修改要改的段落；真的要整篇改寫時，先用 offset 或 section 讀完全文。`;
  const whole = !!p.words && wholeNoteAsk(p.words);
  if (!whole && len > SHORT_NOTE) {
    return `這篇筆記有 ${len} 字，局部修改請用 edits（before/after）只改要改的段落，其他內容保持原樣；只有使用者要求整篇改寫（例如「整篇重寫」「翻成英文」）時才用 content_md。`;
  }
  if (p.proposed.trim().length < len * 0.5 && !(p.words && SHRINK_RE.test(p.words))) {
    return `這個建議會把筆記從 ${len} 字刪到 ${p.proposed.trim().length} 字，但使用者沒有要求刪減。請用 edits 只修改要改的部分。`;
  }
  return null;
}

const inside = (h: { from: number; to: number }, r: { from: number; to: number }) => h.from >= r.from && h.to <= r.to;

/** 繁中 refusal when the words name parts of the note and a hunk lies outside them; null otherwise. */
export function scopeRefusal(text: string, hunks: { from: number; to: number }[], words: string | null): string | null {
  if (!words || wholeNoteAsk(words) || !hunks.length) return null;
  const o = noteOutline(text);
  const refs = noteRefs(words, o, text);
  if (!refs.length) return null;
  const out = hunks.filter((h) => !refs.some((r) => inside(h, r)));
  if (!out.length) return null;
  const named = mergeRefs(refs).map((r) => r.label).join("、");
  const where = [...new Set(out.map((h) => placeOf(o, h.from)))].join("、");
  return `使用者這次只要求修改${named}；這個建議還改到了${where}。請用 edits 只修改使用者指定的部分，其他段落一字不改。`;
}

// ---------------------------------------------------------------- 繼續改

type Chunk = { title: string; key: string; from: number; to: number; text: string };
const key = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

function topChunks(text: string, o: NoteOutline = noteOutline(text)): Chunk[] {
  return o.sections.filter((s: OutlineSection) => s.depth === 1).map((s) => ({ title: s.title, key: key(s.title), from: s.from, to: s.to, text: text.slice(s.from, s.to) }));
}
const same = (a: string, b: string) => a.replace(/\s+$/, "") === b.replace(/\s+$/, "");

export type ContinuePatch = {
  hunks: RawHunk[];
  /** Headings (of the assembled text) whose sections the patch rewrites or adds. */
  sections: string[];
  /** Changed sections not found in the live note (deleted or renamed by the user): left alone. */
  unmapped: string[];
};

/**
 * Hunks against `live` for the sections of `doc` that differ from `prevDoc` (the text committed last time).
 * `prevBody` / `body` are the same texts as written to the note (localized headings, banner); section i of `doc`
 * is section i of `body`. A changed section replaces the live section titled like the committed one; a new section is
 * inserted after its predecessor. Untouched sections never produce hunks.
 */
export function continuePatch(p: { prevDoc: string; doc: string; prevBody: string; body: string; live: string }): ContinuePatch {
  const prev = topChunks(p.prevDoc);
  const next = topChunks(p.doc);
  let prevBody = topChunks(p.prevBody);
  let body = topChunks(p.body);
  if (prevBody.length !== prev.length) prevBody = prev;
  if (body.length !== next.length) body = next;
  const live = topChunks(p.live);
  const hunks: RawHunk[] = [];
  const sections: string[] = [];
  const unmapped: string[] = [];
  const byKey = new Map<string, number>();
  prev.forEach((c, i) => {
    if (!byKey.has(c.key)) byKey.set(c.key, i);
  });
  /** Live section for committed section j: same heading as written, nearest to its position. */
  const liveOf = (j: number) => {
    const k = prevBody[j]!.key;
    const hits = live.map((c, i) => ({ c, i })).filter((x) => x.c.key === k);
    hits.sort((a, b) => Math.abs(a.i - j) - Math.abs(b.i - j));
    return hits[0]?.c ?? null;
  };
  let anchor: number | null = null;
  next.forEach((c, i) => {
    let j = byKey.get(c.key);
    // A heading renamed in place (same position, the old heading gone): the same section.
    if (j === undefined && prev.length === next.length && !next.some((x) => x.key === prev[i]!.key)) j = i;
    const target = j !== undefined ? liveOf(j) : null;
    const replacement = body[i]!.text.replace(/\s+$/, "");
    if (j !== undefined && same(prev[j]!.text, c.text)) {
      if (target) anchor = target.to;
      return;
    }
    if (j !== undefined) {
      if (!target) {
        unmapped.push(c.title);
        return;
      }
      const before = p.live.slice(target.from, target.to);
      const tail = /\s*$/.exec(before)![0] || (target.to >= p.live.length ? "\n" : "\n\n");
      const after = `${replacement}${tail}`;
      if (after !== before) {
        hunks.push({ from: target.from, to: target.to, before, after });
        sections.push(c.title);
      }
      anchor = target.to;
      return;
    }
    // A section the committed text did not have: after the previous section (or before the first one).
    const at = anchor ?? live[0]?.from ?? p.live.length;
    const lead = at > 0 && !p.live.slice(0, at).endsWith("\n\n") ? (p.live.slice(0, at).endsWith("\n") ? "\n" : "\n\n") : "";
    const last = hunks.at(-1);
    if (last && last.from === at && last.to === at) last.after += `${replacement}\n\n`;
    else hunks.push({ from: at, to: at, before: "", after: `${lead}${replacement}\n\n` });
    sections.push(c.title);
  });
  return { hunks: hunks.sort((a, b) => a.from - b.from), sections, unmapped };
}
