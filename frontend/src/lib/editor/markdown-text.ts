/**
 * Text statistics and outline for Markdown sources (status bar, TOC panel). Pure functions, tested in
 * `markdown-text.test.ts`.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDISH = /[\p{L}\p{N}]/u;

/** Strips Markdown syntax that should not count as words (markers, URLs, fences, HTML comments). */
export function plainText(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^```.*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]:?/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/[*_~`|$#>]/g, " ");
}

export type TextStats = { words: number; chars: number; charsNoSpaces: number; cjk: number; lines: number };

let segmenter: Intl.Segmenter | null | undefined;

/**
 * Word count where every CJK character is one word (the usual 字數 convention) and other scripts count
 * word-like segments. `chars` counts user-perceived characters of the raw source.
 */
export function textStats(source: string): TextStats {
  const plain = plainText(source);
  let cjk = 0;
  let words = 0;
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  if (segmenter) {
    for (const seg of segmenter.segment(plain)) {
      if (!seg.isWordLike) continue;
      const han = [...seg.segment].filter(ch => CJK.test(ch)).length;
      if (han) {
        cjk += han;
        words += han;
        // Latin letters glued to CJK in one segment (rare) still count once.
        if ([...seg.segment].some(ch => !CJK.test(ch) && WORDISH.test(ch))) words += 1;
      } else words += 1;
    }
  } else {
    for (const ch of plain) if (CJK.test(ch)) cjk++;
    words = cjk + (plain.replace(new RegExp(CJK.source, "gu"), " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0);
  }
  const chars = [...source].length;
  const charsNoSpaces = [...source.replace(/\s+/g, "")].length;
  const lines = source ? source.split("\n").length : 0;
  return { words, chars, charsNoSpaces, cjk, lines };
}

export type Heading = { level: number; text: string; line: number; from: number };

/** ATX (`## x`) and setext headings, skipping fenced code and math blocks. `line` is 1-based. */
export function outline(source: string): Heading[] {
  const out: Heading[] = [];
  const lines = source.split("\n");
  let fence: string | null = null;
  let math = false;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const from = offset;
    offset += line.length + 1;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (/^\s{0,3}\$\$/.test(line)) {
      const single = /^\s{0,3}\$\$.*\$\$\s*$/.test(line) && line.trim().length > 4;
      if (!single) math = !math;
      continue;
    }
    if (math) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      const text = cleanHeading(atx[2]!);
      if (text) out.push({ level: atx[1]!.length, text, line: i + 1, from });
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !/^\s{0,3}([-*+]|\d+[.)]|>|\|)/.test(line) && /^\s{0,3}(=+|-+)\s*$/.test(next) && (i === 0 || !lines[i - 1]!.trim())) {
      out.push({ level: next.trim().startsWith("=") ? 1 : 2, text: cleanHeading(line.trim()), line: i + 1, from });
    }
  }
  return out;
}

const cleanHeading = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
