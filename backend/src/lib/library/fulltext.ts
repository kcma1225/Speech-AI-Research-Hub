/**
 * Full text of a library PDF for reading tools (agent `read_paper`, AI deck drafts): every page through pdf.js (text
 * only; no canvas), rebuilt into lines, split into sections (abstract, numbered / Roman / well-known headings,
 * references, appendix) with page numbers kept. Cached per stored PDF as an S3 sidecar next to the file
 * (`<pdf key without .pdf>.text-v<N>.json`) plus a small in-process LRU, so repeated reads are cheap.
 *
 * pdf.js text of equations is often garbled (symbols out of order, missing sub/superscripts): callers tell the
 * model so, and `view_paper_pages` renders the page as an image when the model has vision.
 */
import type { Storage } from "../storage.js";
import { SourceError } from "./http.js";
import { isPdf } from "./pdf.js";

export const FULLTEXT_VERSION = 2;

export type PaperSection = {
  /** Stable within one extraction: `front`, `abstract`, `s1`, `s2`, … */
  id: string;
  /** "3.2" / "IV" / null (unnumbered). */
  number: string | null;
  title: string;
  /** 1 = top level, 2 = subsection, 3 = sub-subsection. */
  level: number;
  kind: "front" | "abstract" | "body" | "references" | "appendix";
  pageStart: number;
  pageEnd: number;
  /** Section text with 〔p. N〕 markers where a new page starts inside the section. */
  text: string;
};

export type PaperFullText = {
  version: number;
  numPages: number;
  chars: number;
  sections: PaperSection[];
};

type Item = { str: string; x: number; y: number; h: number; eol: boolean };

/** Lines of one page: pdf.js items joined in content order, a new line on EOL or a vertical jump. */
export function pageLines(items: Item[]): string[] {
  const lines: string[] = [];
  let cur = "";
  let lastY: number | null = null;
  let lastH = 10;
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
    cur = "";
  };
  for (const it of items) {
    if (lastY !== null && Math.abs(it.y - lastY) > Math.max(2, Math.min(lastH, it.h || lastH) * 0.6)) flush();
    cur += it.str;
    if (it.eol) {
      flush();
      lastY = null;
    } else {
      lastY = it.y;
      lastH = it.h || lastH;
    }
  }
  flush();
  return lines;
}

const KNOWN = /^(abstract|introduction|related work|background|preliminaries|method|methods|methodology|approach|proposed method|experiments?|experimental setup|evaluation|results|results and discussion|analysis|discussion|conclusions?|conclusion and future work|limitations|future work|acknowledge?ments?|references|bibliography|appendix(?:\s+[a-z])?)\b[.:]?$/i;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

type Heading = { number: string | null; title: string; level: number; kind: PaperSection["kind"] };

/** Heading detection with a monotonic section counter (rejects "2 shows that…" and equation numbers). */
export class HeadingDetector {
  private top = 0;
  private sub: number[] = [];
  private afterRefs = false;
  private sawRoman = false;

  detect(line: string): Heading | null {
    const s = line.trim();
    if (s.length < 3 || s.length > 100) return null;
    const words = s.split(/\s+/).length;
    // "Abstract— We propose…" (IEEE) / "Abstract. We…" : abstract starts inline
    if (/^abstract\s*[—–\-:.]/i.test(s) || /^abstract$/i.test(s)) return { number: null, title: "Abstract", level: 1, kind: "abstract" };
    if (/^(references|bibliography)$/i.test(s)) {
      this.afterRefs = true;
      return { number: null, title: s, level: 1, kind: "references" };
    }
    if (/^appendix\b/i.test(s) && words <= 12) {
      this.afterRefs = true;
      return { number: null, title: s, level: 1, kind: "appendix" };
    }
    // a sentence, not a heading
    if (words > 14 || /[.,;:]$/.test(s)) return null;
    const num = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(\S.{1,90})$/.exec(s);
    if (num && /^[A-Z]/.test(num[2]!) && !/[.,;]$/.test(num[2]!) && num[2]!.split(/\s+/).length <= 12 && !/^\d/.test(num[2]!)) {
      const parts = num[1]!.split(".").map(Number);
      if (this.accept(parts)) return { number: num[1]!, title: num[2]!.trim(), level: parts.length, kind: this.afterRefs ? "appendix" : "body" };
    }
    const rom = /^([IVX]{1,5})\.\s+([A-Z][A-Za-z0-9 ,:&'’()\-–/]{2,90})$/.exec(s);
    if (rom && !/[.,;]$/.test(rom[2]!)) {
      const n = ROMAN.indexOf(rom[1]!) + 1;
      if (n > 0 && (n === this.top + 1 || (n === 1 && !this.sawRoman))) {
        this.sawRoman = true;
        this.top = n;
        this.sub = [];
        return { number: rom[1]!, title: rom[2]!.trim(), level: 1, kind: this.afterRefs ? "appendix" : "body" };
      }
    }
    if (this.sawRoman) {
      const sub = /^([A-H])\.\s+([A-Z][A-Za-z0-9 ,:&'’()\-–/]{2,80})$/.exec(s);
      if (sub && !/[.,;]$/.test(sub[2]!)) return { number: `${ROMAN[this.top - 1] ?? ""}.${sub[1]}`, title: sub[2]!.trim(), level: 2, kind: this.afterRefs ? "appendix" : "body" };
    }
    if (this.afterRefs) {
      const app = /^([A-H])(\.\d{1,2})?\.?\s+([A-Z][^.]{2,80})$/.exec(s);
      if (app && words <= 12) return { number: `${app[1]}${app[2] ?? ""}`, title: app[3]!.trim(), level: app[2] ? 2 : 1, kind: "appendix" };
    }
    if (KNOWN.test(s) && /^[A-Z]/.test(s) && words <= 6) {
      if (/^(acknowledge?ments?)/i.test(s)) return { number: null, title: s, level: 1, kind: "body" };
      return { number: null, title: s.replace(/[.:]$/, ""), level: 1, kind: this.afterRefs ? "appendix" : "body" };
    }
    return null;
  }

  private accept(parts: number[]): boolean {
    const [a, b, c] = parts as [number, number?, number?];
    if (a < 1 || a > 20) return false;
    if (parts.length === 1) {
      if (a === this.top + 1 || (this.top === 0 && a <= 2)) {
        this.top = a;
        this.sub = [];
        return true;
      }
      return false;
    }
    if (a !== this.top) return false;
    if (parts.length === 2) {
      const last = this.sub[0] ?? 0;
      if (b! === last + 1) {
        this.sub = [b!];
        return true;
      }
      return false;
    }
    const lastB = this.sub[0] ?? 0;
    const lastC = this.sub[1] ?? 0;
    if (b === lastB && c! === lastC + 1) {
      this.sub = [b!, c!];
      return true;
    }
    return false;
  }
}

/** Drops running headers/footers: short lines repeated on ≥ 3 pages, and bare page numbers. */
function boilerplate(pages: string[][]): Set<string> {
  const count = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const l of [...lines.slice(0, 3), ...lines.slice(-3)]) {
      const k = l.replace(/\d+/g, "#");
      if (k.length <= 80 && !seen.has(k)) {
        seen.add(k);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
  }
  const out = new Set<string>();
  if (pages.length >= 4) for (const [k, n] of count) if (n >= 3) out.add(k);
  return out;
}

/** Sections from per-page lines (pure; exported for tests). */
export function sectionize(pages: string[][]): PaperSection[] {
  const drop = boilerplate(pages);
  const det = new HeadingDetector();
  const sections: PaperSection[] = [];
  let cur: PaperSection = { id: "front", number: null, title: "Title and authors", level: 1, kind: "front", pageStart: 1, pageEnd: 1, text: "" };
  let n = 0;
  const push = () => {
    cur.text = cur.text.replace(/-\n(?=[a-z])/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (cur.text || cur.kind !== "front") sections.push(cur);
  };
  pages.forEach((lines, i) => {
    const page = i + 1;
    let startedPage = false;
    for (const raw of lines) {
      if (/^\d{1,3}$/.test(raw) || drop.has(raw.replace(/\d+/g, "#"))) continue;
      if (/^arXiv:\d{4}\.\d{4,5}/i.test(raw)) continue;
      const h = det.detect(raw);
      if (h) {
        push();
        const inline = h.kind === "abstract" ? raw.replace(/^abstract\s*[—–\-:.]?\s*/i, "") : "";
        cur = { id: h.kind === "abstract" ? "abstract" : `s${++n}`, number: h.number, title: h.title, level: h.level, kind: h.kind, pageStart: page, pageEnd: page, text: inline ? `${inline}\n` : "" };
        startedPage = true;
        continue;
      }
      if (!startedPage && cur.text) cur.text += `\n〔p. ${page}〕\n`;
      startedPage = true;
      cur.pageEnd = page;
      cur.text += `${raw}\n`;
    }
  });
  push();
  // Keep ids unique even with two abstracts (rare): suffix later ones.
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) s.id = `${s.id}_${seen.size}`;
    seen.add(s.id);
  }
  return sections;
}

/** Extracts every page (≤ `maxPages`, default 80) and sectionizes. Throws SourceError for unreadable PDFs. */
export async function extractFullText(data: Uint8Array, opts: { maxPages?: number } = {}): Promise<PaperFullText> {
  if (!isPdf(data)) throw new SourceError("pdf", 415, "檔案不是 PDF");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new SourceError("pdf", 422, (e as Error).name === "PasswordException" ? "PDF 有密碼保護，無法讀取" : "PDF 損毀或無法解析");
  }
  try {
    const pages: string[][] = [];
    const n = Math.min(doc.numPages, opts.maxPages ?? 80);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items) {
        if (!("str" in it) || typeof it.str !== "string") continue;
        const tr = (it as { transform: number[] }).transform;
        // Control characters (NUL bytes from some fonts) are not text: the reader, the model and Postgres choke on them.
        items.push({ str: it.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), x: tr[4] ?? 0, y: tr[5] ?? 0, h: Math.abs((it as { height?: number }).height || tr[3] || 0), eol: !!(it as { hasEOL?: boolean }).hasEOL });
      }
      pages.push(pageLines(items));
      page.cleanup();
    }
    const sections = sectionize(pages);
    return { version: FULLTEXT_VERSION, numPages: doc.numPages, chars: sections.reduce((a, s) => a + s.text.length, 0), sections };
  } finally {
    await task.destroy().catch(() => {});
  }
}

export const fulltextKey = (pdfKey: string) => `${pdfKey.replace(/\.pdf$/i, "")}.text-v${FULLTEXT_VERSION}.json`;

const memo = new Map<string, PaperFullText>();
const MEMO_MAX = 8;

/** Cached full text of a stored PDF (memory → S3 sidecar → extract + write the sidecar). Null when the PDF is gone. */
export async function paperFullText(storage: Storage, pdfKey: string): Promise<PaperFullText | null> {
  const hit = memo.get(pdfKey);
  if (hit) {
    memo.delete(pdfKey);
    memo.set(pdfKey, hit);
    return hit;
  }
  const sideKey = fulltextKey(pdfKey);
  let ft: PaperFullText | null = null;
  const cached = await storage.getBuffer(sideKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.toString("utf8")) as PaperFullText;
      if (parsed.version === FULLTEXT_VERSION && Array.isArray(parsed.sections)) ft = parsed;
    } catch {
      /* re-extract */
    }
  }
  if (!ft) {
    const pdf = await storage.getBuffer(pdfKey);
    if (!pdf) return null;
    ft = await extractFullText(pdf);
    await storage.put(sideKey, Buffer.from(JSON.stringify(ft)), "application/json").catch(() => {});
  }
  memo.set(pdfKey, ft);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return ft;
}

/** Tests: forget the in-process cache. */
export const clearFullTextMemo = () => memo.clear();

/**
 * Compact paper body for one-shot prompts (deck drafts): abstract and body sections in order, each clipped so the
 * whole fits `budget` chars; references dropped; appendix only when room is left.
 */
export function digest(ft: PaperFullText, budget = 24_000, opts: { focus?: RegExp } = {}): string {
  const body = ft.sections.filter((s) => s.kind === "abstract" || s.kind === "body");
  // `focus`: sections whose title matches (e.g. experiments / results) get three times their share of the budget.
  const weight = (s: (typeof body)[number]) => s.text.length * (opts.focus?.test(s.title) ? 3 : 1);
  const total = body.reduce((a, s) => a + weight(s), 0) || 1;
  const parts: string[] = [];
  for (const s of body) {
    const share = Math.max(600, Math.floor((weight(s) / total) * budget));
    const head = `## ${s.number ? `${s.number} ` : ""}${s.title}（p. ${s.pageStart}${s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ""}）`;
    parts.push(`${head}\n${s.text.length > share ? `${s.text.slice(0, share)}…` : s.text}`);
  }
  const out = parts.join("\n\n");
  return out.length > budget ? `${out.slice(0, budget)}…` : out;
}
