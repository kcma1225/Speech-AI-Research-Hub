import { isPdf } from "../library/pdf.js";
import { corrupt, DocImportError, encrypted } from "./errors.js";
import { heading, inlineText, joinBlocks, mergeLists, textToMarkdown } from "./markdown.js";
import type { Extracted } from "./types.js";

export const PDF_MAX_PAGES = 300;

type Item = { str: string; x: number; y: number; w: number; h: number; eol: boolean };
type Line = { text: string; y: number; size: number };

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯\u3000-〿]/;
const BULLET = /^[•●▪◦‣∙·○■□➢►\-–]\s*/;

function lineOf(items: Item[]): Line[] {
  const lines: Line[] = [];
  let cur: { parts: string[]; y: number; size: number; end: number } | null = null;
  let breakNext = false;
  const flush = () => {
    if (cur) {
      const text = cur.parts.join("").replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, y: cur.y, size: cur.size });
    }
    cur = null;
  };
  for (const it of items) {
    const blank = !it.str.trim();
    if (cur && !blank && (breakNext || Math.abs(it.y - cur.y) > 0.5 * Math.max(it.h, cur.size, 1))) flush();
    breakNext = false;
    if (!cur) {
      if (!blank) cur = { parts: [it.str], y: it.y, size: it.h, end: it.x + it.w };
    } else {
      const gap = it.x - cur.end;
      const prev = cur.parts[cur.parts.length - 1] ?? "";
      if (!blank && gap > 0.25 * Math.max(it.h, cur.size) && !/\s$/.test(prev) && !/^\s/.test(it.str)) cur.parts.push(" ");
      cur.parts.push(it.str);
      cur.end = Math.max(cur.end, it.x + it.w);
      if (!blank) cur.size = Math.max(cur.size, it.h);
    }
    if (it.eol) breakNext = true;
  }
  flush();
  return lines;
}

function joinLines(a: string, b: string): string {
  if (!a) return b;
  if (CJK.test(a.slice(-1)) || CJK.test(b[0] ?? "")) return a + b;
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // hyphenated line break
  return `${a} ${b}`;
}

/** Page lines → Markdown blocks (paragraphs from vertical gaps, headings from font size, bullet/numbered lists). */
function pageBlocks(lines: Line[], bodySize: number): string[] {
  const blocks: string[] = [];
  let para = "";
  let paraSize = 0;
  let prev: Line | null = null;
  const flush = () => {
    if (para) blocks.push(paraSize >= bodySize * 1.25 ? heading(paraSize >= bodySize * 1.8 ? 1 : 2, para) : textToMarkdown(para));
    para = "";
  };
  lines.forEach((line, i) => {
    // Lone page numbers at the top/bottom of a page.
    if ((i === 0 || i === lines.length - 1) && /^\d{1,4}$/.test(line.text)) return;
    const bullet = BULLET.exec(line.text);
    const numbered = /^(\d{1,3})[.)]\s+(.*)$/.exec(line.text);
    if (bullet && line.text.length > bullet[0].length && (bullet[0].trim() !== "-" || bullet[0].length > 1)) {
      flush();
      blocks.push(`- ${inlineText(line.text.slice(bullet[0].length))}`);
      prev = line;
      return;
    }
    if (numbered) {
      flush();
      blocks.push(`${numbered[1]}. ${inlineText(numbered[2]!)}`);
      prev = line;
      return;
    }
    const size = line.size || bodySize;
    const gap = prev ? prev.y - line.y : 0;
    const newPara =
      !prev ||
      gap > 1.6 * Math.max(size, prev.size || bodySize) ||
      gap < 0 ||
      Math.abs(size - (prev.size || bodySize)) > bodySize * 0.2 ||
      !para;
    if (newPara) {
      flush();
      para = line.text;
      paraSize = size;
    } else {
      para = joinLines(para, line.text);
    }
    prev = line;
  });
  flush();
  return mergeLists(blocks);
}

const JUNK_TITLE = /^(untitled|microsoft (word|powerpoint) - |document\d*$|slide \d+$|無標題)/i;

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  if (!isPdf(bytes)) throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", "檔案開頭沒有 PDF 標記。");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    if ((e as Error).name === "PasswordException") throw encrypted();
    throw corrupt("PDF ");
  }
  const warnings: string[] = [];
  try {
    const n = doc.numPages;
    if (n > PDF_MAX_PAGES) warnings.push(`PDF 共 ${n} 頁，只匯入前 ${PDF_MAX_PAGES} 頁。`);
    const pages: Line[][] = [];
    const sizes = new Map<number, number>();
    for (let p = 1; p <= Math.min(n, PDF_MAX_PAGES); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const t = raw.transform as number[];
        const h = Math.abs(raw.height || t[3] || 0);
        items.push({ str: raw.str, x: t[4] ?? 0, y: t[5] ?? 0, w: raw.width ?? 0, h, eol: !!raw.hasEOL });
        if (raw.str.trim() && h > 0) sizes.set(Math.round(h * 2) / 2, (sizes.get(Math.round(h * 2) / 2) ?? 0) + raw.str.length);
      }
      pages.push(lineOf(items));
      page.cleanup();
    }
    // Body text size: the size carrying the most characters.
    const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
    const blocks = pages.flatMap((lines) => pageBlocks(lines, bodySize));
    const meta = await doc.getMetadata().catch(() => null);
    const infoTitle = String((meta?.info as Record<string, unknown> | undefined)?.Title ?? "").trim();
    let title: string | null = infoTitle && !JUNK_TITLE.test(infoTitle) ? infoTitle : null;
    if (!title) {
      const first = pages.find((l) => l.length) ?? [];
      const big = first.reduce<Line | null>((m, l) => (!m || l.size > m.size ? l : m), null);
      if (big && big.size >= bodySize * 1.25 && big.text.length <= 200) title = big.text;
    }
    return { markdown: joinBlocks(blocks), title, pages: n, warnings };
  } finally {
    await task.destroy().catch(() => {});
  }
}
