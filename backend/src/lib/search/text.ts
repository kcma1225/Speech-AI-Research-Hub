/**
 * Pure text helpers for search: Markdown → plain text, query tokenizing (CJK-aware), snippets with highlights.
 *
 * CJK keyword search: Chinese has no spaces, and pg_trgm treats a whole CJK run as one "word" (so `similarity()` of a
 * short CJK query against a long run is 0). Matching therefore uses substring ILIKE (accelerated by the GIN trigram
 * indexes for terms of ≥ 3 characters). Every whitespace-separated query word must appear (strict match); in addition a
 * relaxed match accepts rows containing ≥ 60 % of the query's grams (words), where a CJK run of ≥ 3 characters contributes its
 * overlapping bigrams (「語音情緒辨識」 → 語音 音情 情緒 緒辨 辨識) — this finds 「情緒的語音辨識」 for 「語音情緒辨識」.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 8;
const MAX_GRAMS = 24;

/** Plain text of Markdown (keeps code and table text; drops markup, link targets, HTML tags). No length cap. */
export function plainText(input: string): string {
  return input
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\[[ xX]\]\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const hasCjk = (s: string) => CJK.test(s);

export type QueryTerms = {
  /** Normalized query (NFKC, lower case, single spaces). */
  normalized: string;
  /** Whitespace/punctuation separated words; all must match for a strict hit. */
  terms: string[];
  /** Grams for the relaxed match: ASCII words as-is, CJK runs ≥ 3 chars as bigrams. Equal to `terms` when nothing to relax. */
  grams: string[];
  /** Whether a relaxed match adds anything over the strict one. */
  relaxed: boolean;
};

export function normalizeQuery(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Splits a query into strict terms and relaxed grams (see the file comment). */
export function tokenizeQuery(q: string): QueryTerms {
  const normalized = normalizeQuery(q);
  const words = normalized
    .split(/[\s\p{P}\p{S}]+/u)
    .map((w) => w.trim())
    .filter(Boolean);
  const terms = [...new Set(words)].slice(0, MAX_TERMS);
  const grams: string[] = [];
  for (const term of terms) {
    for (const run of term.match(CJK_RUN) ?? []) {
      if (hasCjk(run) && run.length >= 3) for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
      else grams.push(run);
    }
  }
  const uniqueGrams = [...new Set(grams)].slice(0, MAX_GRAMS);
  // Several words or bigrams: rows with most (not all) of them also count, ranked below strict hits.
  const relaxed = uniqueGrams.length > 1;
  return { normalized, terms, grams: relaxed ? uniqueGrams : terms, relaxed };
}

/** Grams needed for a relaxed hit. */
export const relaxedThreshold = (grams: number) => Math.max(1, Math.ceil(grams * 0.6));

export const likeEscape = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export type Highlight = [start: number, end: number];

/** All (merged, sorted) ranges in `text` where any needle occurs, case-insensitively. */
export function findHighlights(text: string, needles: string[]): Highlight[] {
  const lower = text.toLowerCase();
  const ranges: Highlight[] = [];
  for (const n of needles) {
    if (!n) continue;
    let at = lower.indexOf(n);
    while (at >= 0 && ranges.length < 200) {
      ranges.push([at, at + n.length]);
      at = lower.indexOf(n, at + n.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Highlight[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export type Snippet = { text: string; highlights: Highlight[] };

/**
 * A window of `body` (plain text) around the first strict term (else the first gram), with highlight ranges relative to
 * the returned text (which may start/end with "…"). Without any match: the start of the text.
 */
export function makeSnippet(body: string, q: Pick<QueryTerms, "terms" | "grams">, max = 160): Snippet {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return { text: "", highlights: [] };
  const lower = text.toLowerCase();
  const first = (needles: string[]) => needles.map((n) => lower.indexOf(n)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const pos = first(q.terms) ?? first(q.grams);
  let start = 0;
  if (pos !== undefined && pos > max / 3) {
    start = pos - Math.floor(max / 4);
    // Prefer starting after a sentence/space boundary close to the window start.
    const window = text.slice(Math.max(0, start - 20), start);
    const cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("。"), window.lastIndexOf("，"), window.lastIndexOf(". "));
    if (cut >= 0) start = Math.max(0, start - 20) + cut + 1;
  }
  const end = Math.min(text.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const out = prefix + text.slice(start, end).trim() + (end < text.length ? "…" : "");
  const needles = [...new Set([...q.terms, ...q.grams])].sort((a, b) => b.length - a.length);
  return { text: out, highlights: findHighlights(out, needles) };
}

/** Highlights of the query in a title (strict terms and grams). */
export const titleHighlights = (title: string, q: Pick<QueryTerms, "terms" | "grams">) => findHighlights(title, [...new Set([...q.terms, ...q.grams])]);
