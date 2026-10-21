import { writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { JobAbortedError, abortReason } from "./errors.js";
import type { NotesNode } from "./pages.js";

export type PrintOptions = {
  chromeBin: string;
  profileDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Also screenshot the first slide (normal, non-print view) in the same browser after the PDF. */
  thumbnail?: { url: string; output: string };
  /**
   * After the thumbnail, also capture every slide (Reveal order, vertical slides included, all fragments
   * shown) as `<dir>/<n>-thumb.webp` (480 px wide) with its title and speaker notes. Best effort: stops
   * after `maxSlides` slides or `budgetMs`; requires `thumbnail`.
   */
  pages?: { dir: string; maxSlides: number; budgetMs: number };
};

/** A captured slide: 1-based `index`, Reveal indices, first heading, `aside.notes` as a tree (see pages.ts). */
export type CapturedSlide = { index: number; h: number; v?: number; title?: string; notes?: NotesNode[]; file: string };

/**
 * `thumbnailError` is set when a requested thumbnail could not be captured; the PDF itself succeeded.
 * `pages`: captured slides (possibly fewer than the deck has, see `pagesTruncated`); `pagesError` when capture failed.
 * `deckSize`: Reveal's configured slide size (0 when it uses percentages).
 */
export type PrintResult = {
  thumbnailError?: unknown;
  pages?: CapturedSlide[];
  pagesTruncated?: boolean;
  pagesError?: unknown;
  /** Time spent capturing the slides (after the PDF and thumbnail). */
  pagesMs?: number;
  deckSize?: { width: number; height: number };
};

export const THUMBNAIL_SIZE = { width: 960, height: 540 } as const;

/** Hides Reveal chrome and the annotate toolbar so the thumbnail shows only the slide. */
export const THUMBNAIL_CSS = `.reveal .controls, .reveal .progress, .reveal .slide-number, .slide-menu-button,
.slide-chalkboard-buttons, .annotate-dock, .annotate-cursor, .annotate-laser-dot, #MathJax_Message { display: none !important; }`;

/** Jumps to the first slide without transitions (a deck may open on a #/hash or restore a position). */
const FIRST_SLIDE = `(() => {
  const reveal = window.Reveal;
  if (reveal && reveal.configure) reveal.configure({ transition: "none", backgroundTransition: "none" });
  if (reveal && reveal.slide) reveal.slide(0, 0, 0);
  return true;
})()`;

/**
 * Page-side readiness check (evaluated in the browser, so kept as a string: the worker is not
 * compiled against DOM types). Ready when fonts are loaded, images are decoded and, for Reveal
 * decks, Reveal finished its print-pdf layout (it wraps every slide in `.pdf-page`).
 */
const READY = `(() => {
  if (document.readyState !== "complete" || document.fonts.status !== "loaded") return false;
  if (![...document.images].every(img => img.complete)) return false;
  const reveal = window.Reveal;
  if (reveal && !(reveal.isReady && reveal.isReady())) return false;
  if (reveal && document.documentElement.classList.contains("print-pdf") && !document.querySelector(".pdf-page")) return false;
  return true;
})()`;

/** MathJax v2 typesets asynchronously; wait for its queue to drain. No-op without MathJax. */
const MATHJAX_IDLE = `new Promise(resolve => {
  const hub = window.MathJax && window.MathJax.Hub;
  if (hub && hub.Queue) hub.Queue(() => resolve(true)); else resolve(true);
})`;

/**
 * Prints `url` (a file:// URL of a Reveal deck with `?print-pdf`) to `output` once the page is
 * actually laid out. Replaces Chrome's `--virtual-time-budget` CLI print, which sometimes
 * captured the page before Reveal finished and produced a blank PDF. With `thumbnail`, the same
 * browser then screenshots the first slide at 960 px wide in the deck's aspect ratio (16:9 fallback) (best effort, see `PrintResult`).
 */
export async function printPdf(url: string, output: string, { chromeBin, profileDir, timeoutMs, signal, thumbnail, pages }: PrintOptions): Promise<PrintResult> {
  if (signal.aborted) throw new JobAbortedError(abortReason(signal));
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(onAbort, timeoutMs + (thumbnail ? THUMBNAIL_TIMEOUT_MS : 0) + (pages ? pages.budgetMs + 10_000 : 0));
  try {
    browser = await puppeteer.launch({
      executablePath: chromeBin,
      headless: "shell",
      pipe: true,
      userDataDir: profileDir,
      env: { ...process.env, FONTCONFIG_PATH: "/etc/fonts" },
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--allow-file-access-from-files", "--no-first-run"],
      timeout: 30_000,
    });
    const page = await openSettled(browser, url, timeoutMs);
    await page.pdf({ path: output, printBackground: true, preferCSSPageSize: true, timeout: timeoutMs });
    await page.close();
    if (!thumbnail) return {};
    // Best effort: a missing thumbnail must never cost the PDF (the caller logs and omits it).
    try {
      const view = await openSettled(browser, thumbnail.url, THUMBNAIL_TIMEOUT_MS, async page => {
        await page.setViewport({ ...THUMBNAIL_SIZE, deviceScaleFactor: 1 });
      });
      // Match the deck's own aspect ratio (Quarto decks are often 16:10 or 3:2) so the slide fills the image.
      const deckSize = (await view.evaluate(DECK_SIZE)) as { width: number; height: number };
      const size = thumbnailSize(deckSize);
      if (size.height !== THUMBNAIL_SIZE.height) {
        await view.setViewport({ ...size, deviceScaleFactor: 1 });
        await view.evaluate(RELAYOUT);
      }
      await view.evaluate(FIRST_SLIDE);
      await view.addStyleTag({ content: THUMBNAIL_CSS });
      await new Promise(resolve => setTimeout(resolve, 300));
      await writeFile(thumbnail.output, await view.screenshot({ type: "png", clip: { x: 0, y: 0, ...size } }));
      if (!pages) return { deckSize };
      try {
        return { deckSize, ...(await captureSlides(view, size, pages)) };
      } catch (error) {
        if (signal.aborted) throw new JobAbortedError(abortReason(signal));
        return { deckSize, pagesError: error };
      }
    } catch (error) {
      if (signal.aborted) throw new JobAbortedError(abortReason(signal));
      return { thumbnailError: error };
    }
  } catch (error) {
    if (signal.aborted) throw new JobAbortedError(abortReason(signal));
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
}

const THUMBNAIL_TIMEOUT_MS = 30_000;

/**
 * Lists the deck's slides in Reveal order with title and notes, and shows all fragments. Runs in the page,
 * so it returns plain data only; the notes tree is serialised (and filtered) in Node by pages.ts.
 */
export const SLIDE_LIST = `(() => {
  const reveal = window.Reveal;
  if (!reveal || !reveal.getSlides || !reveal.getIndices) return null;
  reveal.configure({ transition: "none", backgroundTransition: "none", fragments: false, autoSlide: 0 });
  const tree = (node, depth) => {
    if (depth > 20) return [];
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child.nodeValue);
      else if (child.nodeType === 1) {
        const tag = child.localName;
        if (tag === "script" || tag === "style") continue;
        const entry = { tag, children: tree(child, depth + 1) };
        if (tag === "a" && child.getAttribute("href")) entry.href = child.getAttribute("href");
        out.push(entry);
      }
    }
    return out;
  };
  return reveal.getSlides().map(slide => {
    const indices = reveal.getIndices(slide);
    const heading = slide.querySelector("h1, h2, h3");
    const notes = slide.querySelector("aside.notes");
    return {
      h: indices.h,
      v: indices.v,
      title: heading ? heading.textContent.replace(/\\s+/g, " ").trim() : "",
      notes: notes ? tree(notes, 0) : null,
    };
  });
})()`;

export const GOTO_SLIDE = (h: number, v: number) => `new Promise(resolve => {
  window.Reveal.slide(${h}, ${v});
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 40)));
})`;

const PAGE_THUMB_WIDTH = 480;

/** Screenshots every slide of the already-settled `view` page at `size`, scaled to 480 px wide WebP. */
async function captureSlides(view: Page, size: { width: number; height: number }, options: NonNullable<PrintOptions["pages"]>) {
  const started = Date.now();
  const listed = (await view.evaluate(SLIDE_LIST)) as unknown;
  if (!Array.isArray(listed)) throw new Error("Reveal API unavailable");
  const scale = PAGE_THUMB_WIDTH / size.width;
  const pages: CapturedSlide[] = [];
  let truncated = listed.length > options.maxSlides;
  for (const raw of listed.slice(0, options.maxSlides)) {
    if (Date.now() - started > options.budgetMs) {
      truncated = true;
      break;
    }
    const item = (raw ?? {}) as { h?: unknown; v?: unknown; title?: unknown; notes?: unknown };
    const h = Number.isInteger(item.h) ? (item.h as number) : 0;
    const v = Number.isInteger(item.v) ? (item.v as number) : undefined;
    await view.evaluate(GOTO_SLIDE(h, v ?? 0));
    const index = pages.length + 1;
    const file = path.join(options.dir, `${index}-thumb.webp`);
    await writeFile(file, await view.screenshot({ type: "webp", quality: 80, clip: { x: 0, y: 0, ...size, scale } }));
    const slide: CapturedSlide = { index, h, file };
    if (v !== undefined) slide.v = v;
    if (typeof item.title === "string" && item.title.trim()) slide.title = item.title.trim().slice(0, 300);
    if (Array.isArray(item.notes)) slide.notes = item.notes as NotesNode[];
    pages.push(slide);
  }
  return { pages, pagesTruncated: truncated, pagesMs: Date.now() - started };
}
export const DECK_SIZE = `(() => { const c = window.Reveal?.getConfig?.() ?? {}; return { width: Number(c.width) || 0, height: Number(c.height) || 0 }; })()`;
export const RELAYOUT = `new Promise(r => { window.Reveal?.layout?.(); setTimeout(r, 200); })`;

/** 960 px wide at the deck's aspect ratio; falls back to 16:9 and clamps to 4:3 … 21:9. */
export function thumbnailSize(deck: { width: number; height: number }): { width: number; height: number } {
  const { width } = THUMBNAIL_SIZE;
  // Percentage sizes ("100%") arrive as 0, so only real pixel ratios get past this.
  if (!(deck.width > 0 && deck.height > 0)) return { ...THUMBNAIL_SIZE };
  const height = Math.round(width * Math.min(3 / 4, Math.max(9 / 21, deck.height / deck.width)));
  return { width, height };
}

/**
 * Opens `url` in a new offline page and waits until it is fully laid out (fonts, images, Reveal,
 * MathJax). `setup` runs before navigation (e.g. to set the viewport).
 */
export async function openSettled(browser: Browser, url: string, timeoutMs: number, setup?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await browser.newPage();
  // A deck calling alert()/confirm() would block the page (and its load event) until the timeout.
  page.on("dialog", dialog => void dialog.dismiss().catch(() => {}));
  await setup?.(page);
  // Offline worker: any network request would hang until timeout, so refuse it outright.
  await page.setRequestInterception(true);
  page.on("request", request => (request.url().startsWith("file:") || request.url().startsWith("data:") ? request.continue() : request.abort()));
  await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  await page.waitForFunction(READY, { timeout: timeoutMs, polling: 100 });
  await page.evaluate(MATHJAX_IDLE);
  // Let Reveal's final layout pass and font swaps settle.
  await new Promise(resolve => setTimeout(resolve, 500));
  return page;
}
