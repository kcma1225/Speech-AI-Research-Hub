/**
 * Deterministic outline of a note and the parts a request names (「第二段」「第三節」「『結論』那段」「section 2」
 * 「the conclusion section」). Shared by the assistant's note tools (get_note outline / section reads, the
 * suggest_note_edit scope guard), the editor's 「AI 草擬」 (rewrite only the named section) and the workflow 「繼續改」
 * (re-run sections only). Pure functions, no I/O.
 *
 * Numbering: a `# ` heading on the first non-blank line (or the only `# ` heading, when it comes first) is the note's
 * title, not a section. The shallowest remaining
 * heading level is numbered 1, 2, 3…; the next level 2.1, 2.2…; deeper headings belong to their parent. Paragraphs are
 * blocks separated by blank lines (a fenced code block is one block, headings are not paragraphs), numbered 1… in
 * document order across the whole note.
 */
import { pageNumber } from "../../workflows/requirements.js";

export type OutlineSection = {
  /** 「2」 or 「2.1」. */
  n: string;
  /** Markdown heading level (2 for `##`). */
  level: number;
  depth: 1 | 2;
  title: string;
  /** Heading line start … end of the section (subsections included), offsets into the text. */
  from: number;
  to: number;
  /** First and last paragraph number inside the section, null when it has none. */
  paragraphs: [number, number] | null;
};
export type OutlineParagraph = { n: number; from: number; to: number; section: string | null };
export type NoteOutline = { title: string | null; sections: OutlineSection[]; paragraphs: OutlineParagraph[]; length: number };

type Line = { start: number; end: number; text: string; fence: boolean };

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  let inFence: string | null = null;
  for (const raw of text.split("\n")) {
    const start = pos;
    const end = Math.min(text.length, pos + raw.length + 1);
    pos += raw.length + 1;
    const fenceMark = /^\s{0,3}(```+|~~~+)/.exec(raw)?.[1];
    let fence = !!inFence;
    if (fenceMark) {
      if (!inFence) inFence = fenceMark[0]!;
      else if (fenceMark[0] === inFence) inFence = null;
      fence = true;
    }
    out.push({ start, end, text: raw, fence });
  }
  return out;
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

export function noteOutline(text: string): NoteOutline {
  const lines = linesOf(text);
  const heads: { level: number; title: string; at: number; line: number }[] = [];
  lines.forEach((l, i) => {
    if (l.fence) return;
    const m = HEADING_RE.exec(l.text);
    if (m) heads.push({ level: m[1]!.length, title: m[2]!.trim(), at: l.start, line: i });
  });
  // The title: a `# ` heading on the first line, or the only `# ` heading when it is the first heading (a banner
  // paragraph may sit above it).
  const firstLine = lines.findIndex((l) => l.text.trim());
  let title: string | null = null;
  let titleLine = -1;
  if (heads[0] && heads[0].level === 1 && (heads[0].line === firstLine || heads.filter((h) => h.level === 1).length === 1)) {
    title = heads[0].title;
    titleLine = heads[0].line;
    heads.shift();
  }
  const top = heads.length ? Math.min(...heads.map((h) => h.level)) : 0;
  const sections: OutlineSection[] = [];
  let major = 0;
  let minor = 0;
  heads.forEach((h, i) => {
    if (h.level > top + 1) return;
    const depth: 1 | 2 = h.level === top ? 1 : 2;
    if (depth === 1) {
      major++;
      minor = 0;
    } else {
      if (!major) return; // a subsection before any section: part of the preamble
      minor++;
    }
    const next = heads.slice(i + 1).find((x) => x.level <= h.level);
    sections.push({ n: depth === 1 ? `${major}` : `${major}.${minor}`, level: h.level, depth, title: h.title, from: h.at, to: next ? next.at : text.length, paragraphs: null });
  });

  const paragraphs: OutlineParagraph[] = [];
  let cur: { from: number; to: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const inner = sections.filter((s) => s.from <= cur!.from && cur!.from < s.to);
    const owner = inner.at(-1) ?? null;
    paragraphs.push({ n: paragraphs.length + 1, from: cur.from, to: cur.to, section: owner?.n ?? null });
    cur = null;
  };
  lines.forEach((l, i) => {
    const isHead = !l.fence && HEADING_RE.test(l.text);
    if (i === titleLine || isHead || (!l.fence && !l.text.trim())) {
      flush();
      return;
    }
    if (cur) cur.to = l.end;
    else cur = { from: l.start, to: l.end };
  });
  flush();
  for (const s of sections) {
    const inside = paragraphs.filter((p) => p.from >= s.from && p.from < s.to);
    s.paragraphs = inside.length ? [inside[0]!.n, inside.at(-1)!.n] : null;
  }
  return { title, sections, paragraphs, length: text.length };
}

/** The outline as the assistant sees it (get_note). */
export function outlineView(o: NoteOutline) {
  return o.sections.slice(0, 80).map((s) => ({
    n: s.n, level: s.level, title: s.title, chars: s.to - s.from,
    ...(s.paragraphs ? { paragraphs: s.paragraphs[0] === s.paragraphs[1] ? `${s.paragraphs[0]}` : `${s.paragraphs[0]}–${s.paragraphs[1]}` } : {}),
  }));
}

// ---------------------------------------------------------------- what a request names

export type NoteRef = { kind: "section" | "paragraph"; label: string; from: number; to: number };

/** Words about the note as a whole: not a part-scoped edit (「整篇」「每一段」「翻成英文」「rewrite the whole note」). */
const WHOLE_RE = /整篇|全文|整份|整則|整個筆記|全篇|通篇|每一?[段節章]|各[段節章]|所有(?:的)?(?:段落?|章節|小節|內容)|全部(?:的)?(?:段落?|章節|內容|重寫|改寫)|從頭(?:到尾)?|重新(?:寫|改寫|整理|組織|排列)|翻譯|翻成|譯成|語氣|風格|格式|排版|\b(?:whole|entire|full) (?:note|text|document)\b|\ball (?:the )?(?:sections|paragraphs)\b|\bevery (?:section|paragraph)\b|\bthroughout\b|\btranslat|\b(?:rewrite|reorganize|restructure) (?:the|this|my) note\b/i;
export const wholeNoteAsk = (words: string) => WHOLE_RE.test(words);

const NUM = "(?:\\d{1,2}|[一二兩三四五六七八九十]{1,3})";
const SEP = "(?:\\s*(?:[、,，和跟與及]|到|至|~|-|–)\\s*(?:第\\s*)?)";
const SEC_WORD = "(?:個\\s*)?(?:小節|節|章|部分|部份|大段|個標題|標題)";
const PARA_WORD = "(?:個\\s*)?段(?:落)?";
const ZH_REF_RE = new RegExp(`第\\s*(${NUM}(?:${SEP}${NUM})*)\\s*(${SEC_WORD}|${PARA_WORD})`, "g");
const DOTTED_RE = /(?:第\s*|\b(?:section|sec\.?)\s*|§\s*)(\d{1,2}\.\d{1,2})\s*(?:節|小節)?/gi;
const EN_REF_RE = /\b(sections?|sec\.?|paragraphs?|para\.?)\s+(\d{1,2}(?:\s*(?:,|and|&|to|-|–)\s*\d{1,2})*)\b|§\s*(\d{1,2})\b/gi;
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const EN_ORD_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d{1,2}(?:st|nd|rd|th))\s+(section|paragraph)\b/gi;
const LAST_RE = /最後(?:一|1)?\s*(段(?:落)?|節|章|部分|部份)/g;
const QUOTE_RE = /[「『"“]([^」』"”]{1,80})[」』"”]/g;

/** Numbers in 「三、五」「3到5」「2 and 4」 (ranges expanded). */
function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const p of s.matchAll(new RegExp(`(到|至|~|-|–|\\bto\\b)?\\s*(?:第\\s*)?(${NUM})`, "gi"))) {
    const n = pageNumber(p[2]!);
    if (!n) continue;
    const prev = out.at(-1);
    if (p[1] && prev && n > prev && n - prev <= 30) for (let k = prev + 1; k <= n; k++) out.push(k);
    else out.push(n);
  }
  return out;
}

const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
/** A heading without its own numbering (「2. 方法」「三、結論」「Chapter 2: Method」 → the words). */
const bareTitle = (t: string) => t.replace(/^(?:第?\s*[\d一二三四五六七八九十]+(?:\.\d+)*\s*[、.．:：)）章節]?\s*|chapter\s+\d+\s*[:.]?\s*|section\s+\d+\s*[:.]?\s*)/i, "").trim() || t;
const isCjk = (s: string) => /\p{Script=Han}/u.test(s);

function sectionRef(s: OutlineSection): NoteRef {
  return { kind: "section", label: `第 ${s.n} 節「${s.title}」`, from: s.from, to: s.to };
}
function paragraphRef(p: OutlineParagraph): NoteRef {
  return { kind: "paragraph", label: `第 ${p.n} 段`, from: p.from, to: p.to };
}

/** Sections whose heading a request names in words (unquoted): 「結論那段」「把結論改短」「the conclusion section」. */
function titleHits(words: string, o: NoteOutline): OutlineSection[] {
  const said = squash(words);
  return o.sections.filter((s) => {
    const t = bareTitle(s.title);
    const k = squash(t);
    if (!k) return false;
    if (!isCjk(t)) return k.length >= 4 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i").test(words);
    if (k.length >= 3) return said.includes(k);
    // Two characters (「方法」「結論」): only next to a word that points at a part (「結論那段」「把結論…」).
    return k.length === 2 && new RegExp(`(?:把|將|在|針對|關於)\\s*${t}|${t}\\s*(?:那|這|的)?\\s*(?:一?段|節|章|部分|部份|section|part)`, "i").test(words);
  });
}

/**
 * The parts of the note a request names, as ranges of the current text. 「第N段」 is the N-th paragraph and, because
 * people also say 段 for a section, the N-th section too. Quoted text that is not a heading names the paragraph that
 * contains it. Empty when the request names no part (or names the note as a whole).
 */
export function noteRefs(words: string, o: NoteOutline, text?: string): NoteRef[] {
  const refs: NoteRef[] = [];
  const top = o.sections.filter((s) => s.depth === 1);
  const sec = (n: string) => o.sections.find((s) => s.n === n);
  const addSection = (n: number) => {
    const s = top[n - 1];
    if (s) refs.push(sectionRef(s));
  };
  const addParagraph = (n: number, alsoSection = true) => {
    const p = o.paragraphs[n - 1];
    if (p) refs.push(paragraphRef(p));
    if (alsoSection) addSection(n);
  };
  for (const m of words.matchAll(DOTTED_RE)) {
    const s = sec(m[1]!);
    if (s) refs.push(sectionRef(s));
  }
  for (const m of words.matchAll(ZH_REF_RE)) {
    const para = /段/.test(m[2]!) && !/大段/.test(m[2]!);
    for (const n of numbersIn(m[1]!)) (para ? addParagraph(n) : addSection(n));
  }
  for (const m of words.matchAll(EN_REF_RE)) {
    if (m[3]) {
      addSection(+m[3]);
      continue;
    }
    const para = /^para/i.test(m[1]!);
    for (const n of numbersIn(m[2]!.replace(/\band\b|&/g, "、"))) (para ? addParagraph(n, false) : addSection(n));
  }
  for (const m of words.matchAll(EN_ORD_RE)) {
    const w = m[1]!.toLowerCase();
    const para = m[2]!.toLowerCase() === "paragraph";
    const n = w === "last" ? (para ? o.paragraphs.length : top.length) : ORD[w] ?? parseInt(w, 10);
    if (para) addParagraph(n, false);
    else addSection(n);
  }
  for (const m of words.matchAll(LAST_RE)) {
    if (/段/.test(m[1]!)) addParagraph(o.paragraphs.length, false);
    else addSection(top.length);
  }
  for (const m of words.matchAll(QUOTE_RE)) {
    const q = m[1]!.trim();
    const k = squash(q);
    if (!k) continue;
    const heads = o.sections.filter((s) => {
      const t = squash(bareTitle(s.title));
      return t === k || (k.length >= 2 && t.includes(k)) || (t.length >= 2 && k.includes(t));
    });
    if (heads.length) {
      refs.push(...heads.map(sectionRef));
      continue;
    }
    if (text && q.length >= 2) {
      const at = text.indexOf(q);
      if (at >= 0 && text.indexOf(q, at + 1) < 0) {
        const p = o.paragraphs.find((x) => x.from <= at && at < x.to);
        if (p) refs.push(paragraphRef(p));
      }
    }
  }
  refs.push(...titleHits(words.replace(QUOTE_RE, " "), o).map(sectionRef));
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.from}:${r.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Non-overlapping ranges covering the refs (a paragraph inside a named section is part of that section). */
export function mergeRefs(refs: NoteRef[]): NoteRef[] {
  const sorted = [...refs].sort((a, b) => a.from - b.from || b.to - a.to);
  const out: NoteRef[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.from < last.to) {
      if (r.to > last.to) out[out.length - 1] = { ...last, to: r.to, label: `${last.label}、${r.label}` };
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/** The section a reference string names: its number (「2」「2.1」), 「第二節」, or (part of) its title. */
export function findSection(o: NoteOutline, ref: string): OutlineSection | null {
  const r = ref.trim();
  const exact = o.sections.find((s) => s.n === r);
  if (exact) return exact;
  const n = /^\d{1,2}$/.test(r) ? null : pageNumber(r);
  if (n) return o.sections.filter((s) => s.depth === 1)[n - 1] ?? null;
  const viaRefs = noteRefs(r, o).find((x) => x.kind === "section");
  if (viaRefs) return o.sections.find((s) => s.from === viaRefs.from && s.to === viaRefs.to) ?? null;
  const k = squash(r);
  if (!k) return null;
  return o.sections.find((s) => squash(s.title) === k) ?? o.sections.find((s) => squash(s.title).includes(k)) ?? null;
}

/** Where an offset sits, for messages: 「第 2 節「方法」」 or 「開頭」. */
export function placeOf(o: NoteOutline, at: number): string {
  const s = o.sections.filter((x) => x.from <= at && at < x.to).at(-1) ?? (at >= o.length ? o.sections.at(-1) : undefined);
  return s ? `第 ${s.n} 節「${s.title}」` : "開頭";
}
