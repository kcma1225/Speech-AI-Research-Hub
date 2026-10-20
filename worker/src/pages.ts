import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { JobInputError, tail, throwIfAborted } from "./errors.js";
import { run } from "./process.js";
import type { PageEntry, PageManifest, PageNotes, SlideSourceType } from "./types.js";

/**
 * Hub-owned files of a version live under `<outputPrefix>_hub/` (reserved: a deck may not write there).
 * Page images are WebP: `_hub/pages/<n>-thumb.webp` (480 px wide) and `_hub/pages/<n>-full.webp` (longer side
 * 1920 px, pdf/pptx only). The backend derives these keys from the page number, so keep the names in sync with
 * backend/src/lib/slides/pages.ts.
 */
export const HUB_DIR = "_hub/";
export const MANIFEST_NAME = `${HUB_DIR}pages.json`;
export const QUARTO_THUMBNAIL_NAME = `${HUB_DIR}thumbnail.png`;
export const RASTER_THUMBNAIL_NAME = `${HUB_DIR}thumbnail.webp`;
export const pageImageName = (index: number, size: "thumb" | "full") => `${HUB_DIR}pages/${index}-${size}.webp`;

export const PAGE_WIDTH = { thumb: 480, full: 1920, deckThumbnail: 960 } as const;
/** PDF/PPTX decks with more pages are refused (the player and storage are sized for meeting decks). */
export const MAX_PDF_PAGES = 500;
/** Quarto: at most this many slides are captured; the rest get no thumbnail (job still succeeds). */
export const MAX_QUARTO_PAGES = 300;

export function buildManifest(sourceType: SlideSourceType, size: { width: number; height: number }, pages: PageEntry[]): PageManifest {
  return {
    version: 1,
    sourceType,
    width: Math.round(size.width) || 16,
    height: Math.round(size.height) || 9,
    pages: pages.map(page => {
      const entry: PageEntry = { index: page.index, thumb: page.thumb };
      if (page.h !== undefined) entry.h = page.h;
      if (page.v !== undefined) entry.v = page.v;
      if (page.title) entry.title = page.title.slice(0, 300);
      if (page.full) entry.full = page.full;
      const notes = cleanNotes(page.notes);
      if (notes) entry.notes = notes;
      return entry;
    }),
  };
}

const NOTES_LIMIT = 20_000;
function cleanNotes(notes: PageNotes | undefined): PageNotes | undefined {
  if (!notes) return undefined;
  const text = notes.text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, NOTES_LIMIT);
  if (!text) return undefined;
  const html = notes.html?.trim().slice(0, NOTES_LIMIT * 2);
  return html ? { text, html } : { text };
}

export type PdfInfo = { pages: number; width: number; height: number; encrypted: boolean };

/** Parses `pdfinfo` output (page count, first page size in points, encryption). */
export function parsePdfInfo(text: string): PdfInfo {
  const pages = Number(/^Pages:\s+(\d+)/m.exec(text)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(text);
  const encrypted = /^Encrypted:\s+yes/m.test(text);
  return { pages, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, encrypted };
}

export type RasterContext = { signal: AbortSignal; onPage?: (done: number, total: number) => void };
export type RasterPage = { index: number; thumb: string; full: string };
export type RasterResult = { info: PdfInfo; pages: RasterPage[]; deckThumbnail: string };

const BATCH = 10;
const CWEBP_CONCURRENCY = 2;

/**
 * Renders every page of `pdfFile` into `outDir` as WebP: `<n>-full.webp` (longer side 1920 px, i.e. 1920 px wide
 * for landscape slides) and `<n>-thumb.webp` (480 px wide), plus `thumbnail.webp` (960 px wide) of page 1. Pages are rendered with
 * pdftoppm in batches of 10 to PNG and each PNG is removed right after conversion, so scratch space
 * (tmpfs, counted as memory) stays small.
 */
export async function rasterisePdf(pdfFile: string, outDir: string, { signal, onPage }: RasterContext): Promise<RasterResult> {
  const infoRun = await run("pdfinfo", [pdfFile], { timeoutMs: 60_000, signal });
  if (infoRun.code !== 0) {
    if (/Incorrect password|encrypted/i.test(infoRun.log)) throw new JobInputError("PDF 已加密，請移除密碼後再上傳。");
    throw new JobInputError(`無法讀取 PDF：${tail(infoRun.log, 500)}`);
  }
  const info = parsePdfInfo(infoRun.log);
  if (info.pages < 1) throw new JobInputError("PDF 沒有任何頁面。");
  if (info.pages > MAX_PDF_PAGES) throw new JobInputError(`PDF 超過 ${MAX_PDF_PAGES} 頁。`);

  await mkdir(outDir, { recursive: true });
  const pngDir = path.join(outDir, "png");
  const pages: RasterPage[] = [];
  let deckThumbnail = "";
  for (let first = 1; first <= info.pages; first += BATCH) {
    throwIfAborted(signal);
    const last = Math.min(info.pages, first + BATCH - 1);
    await rm(pngDir, { recursive: true, force: true });
    await mkdir(pngDir);
    // Longer side = 1920 px: landscape slides come out 1920 px wide, portrait pages are not blown up to 1920×2716.
    const render = await run("pdftoppm", ["-png", "-f", String(first), "-l", String(last), "-scale-to", String(PAGE_WIDTH.full), pdfFile, path.join(pngDir, "p")], {
      timeoutMs: 180_000,
      signal,
    });
    if (render.timedOut) throw new JobInputError("PDF 頁面轉換逾時。");
    if (render.code !== 0) throw new JobInputError(`PDF 頁面轉換失敗：${tail(render.log, 1000)}`);
    // pdftoppm zero-pads the page number to the width of the total page count: p-01.png, p-001.png, …
    const rendered = (await readdir(pngDir))
      .map(name => ({ name, index: Number(/^p-(\d+)\.png$/.exec(name)?.[1]) }))
      .filter(file => Number.isInteger(file.index) && file.index >= first && file.index <= last)
      .sort((a, b) => a.index - b.index);
    if (rendered.length !== last - first + 1) throw new JobInputError("PDF 頁面轉換不完整。");
    await mapLimit(rendered, CWEBP_CONCURRENCY, async ({ name, index }) => {
      const png = path.join(pngDir, name);
      const full = path.join(outDir, `${index}-full.webp`);
      const thumb = path.join(outDir, `${index}-thumb.webp`);
      await cwebp(png, full, null, 85, signal);
      await cwebp(png, thumb, PAGE_WIDTH.thumb, 80, signal);
      if (index === 1) {
        deckThumbnail = path.join(outDir, "thumbnail.webp");
        await cwebp(png, deckThumbnail, PAGE_WIDTH.deckThumbnail, 82, signal);
      }
      await rm(png, { force: true });
      pages.push({ index, thumb, full });
      onPage?.(pages.length, info.pages);
    });
  }
  await rm(pngDir, { recursive: true, force: true });
  pages.sort((a, b) => a.index - b.index);
  return { info, pages, deckThumbnail };
}

async function cwebp(input: string, output: string, width: number | null, quality: number, signal: AbortSignal) {
  const args = ["-quiet", "-q", String(quality), "-m", "4", ...(width ? ["-resize", String(width), "0"] : []), input, "-o", output];
  const result = await run("cwebp", args, { timeoutMs: 60_000, signal });
  if (result.code !== 0) throw new Error(`cwebp failed: ${tail(result.log, 500)}`);
}

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/** Node of a notes fragment as collected in the page (see pdf.ts NOTES_TREE); serialised by `notesHtml`. */
export type NotesNode = string | { tag: string; href?: string; children: NotesNode[] };

const ALLOWED_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "code", "br", "a"]);
const TAG_ALIASES: Record<string, string> = { b: "strong", i: "em" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * Serialises a notes tree to minimal HTML: only p/ul/ol/li/strong/em/code/br/a[href] (http, https, mailto);
 * other elements are unwrapped (their text kept), all text is escaped. Clients must still sanitise.
 */
export function notesHtml(nodes: readonly NotesNode[], depth = 0): string {
  if (depth > 20) return "";
  let html = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      html += escapeHtml(node);
      continue;
    }
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) continue;
    const tag = TAG_ALIASES[String(node.tag).toLowerCase()] ?? String(node.tag).toLowerCase();
    const inner = notesHtml(node.children, depth + 1);
    if (!ALLOWED_TAGS.has(tag)) {
      html += inner;
    } else if (tag === "br") {
      html += "<br>";
    } else if (tag === "a") {
      const href = typeof node.href === "string" && /^(https?:|mailto:)/i.test(node.href.trim()) ? node.href.trim() : null;
      html += href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    } else {
      html += `<${tag}>${inner}</${tag}>`;
    }
  }
  return html;
}

const BLOCKS = new Set(["p", "li", "div", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]);

/** Plain text of a notes tree: block elements become paragraphs, `<br>` a line break, list items get "• ". */
export function notesText(nodes: readonly NotesNode[], depth = 0): string {
  if (depth > 20) return "";
  let text = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      text += node.replace(/\s+/g, " ");
      continue;
    }
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) continue;
    const tag = String(node.tag).toLowerCase();
    if (tag === "br") {
      text += "\n";
      continue;
    }
    const inner = notesText(node.children, depth + 1);
    if (tag === "li") text += `\n• ${inner.trim()}`;
    else if (BLOCKS.has(tag)) text += `\n\n${inner.trim()}\n\n`;
    else text += inner;
  }
  return depth === 0 ? text.split("\n").map(line => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}
