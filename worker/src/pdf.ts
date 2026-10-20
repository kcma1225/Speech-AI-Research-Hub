import { writeFile } from "node:fs/promises";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { JobAbortedError, abortReason } from "./errors.js";

export type PrintOptions = {
  chromeBin: string;
  profileDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Also screenshot the first slide (normal, non-print view) in the same browser after the PDF. */
  thumbnail?: { url: string; output: string };
};

/** `thumbnailError` is set when a requested thumbnail could not be captured; the PDF itself succeeded. */
export type PrintResult = { thumbnailError?: unknown };

export const THUMBNAIL_SIZE = { width: 960, height: 540 } as const;

/** Hides Reveal chrome and the annotate toolbar so the thumbnail shows only the slide. */
const THUMBNAIL_CSS = `.reveal .controls, .reveal .progress, .reveal .slide-number, .slide-menu-button,
.slide-chalkboard-buttons, .annotate-dock, .annotate-cursor, .annotate-laser-dot { display: none !important; }`;

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
export async function printPdf(url: string, output: string, { chromeBin, profileDir, timeoutMs, signal, thumbnail }: PrintOptions): Promise<PrintResult> {
  if (signal.aborted) throw new JobAbortedError(abortReason(signal));
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(onAbort, timeoutMs);
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
      const size = thumbnailSize((await view.evaluate(DECK_SIZE)) as { width: number; height: number });
      if (size.height !== THUMBNAIL_SIZE.height) {
        await view.setViewport({ ...size, deviceScaleFactor: 1 });
        await view.evaluate(RELAYOUT);
      }
      await view.evaluate(FIRST_SLIDE);
      await view.addStyleTag({ content: THUMBNAIL_CSS });
      await new Promise(resolve => setTimeout(resolve, 300));
      await writeFile(thumbnail.output, await view.screenshot({ type: "png", clip: { x: 0, y: 0, ...size } }));
      return {};
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
const DECK_SIZE = `(() => { const c = window.Reveal?.getConfig?.() ?? {}; return { width: Number(c.width) || 0, height: Number(c.height) || 0 }; })()`;
const RELAYOUT = `new Promise(r => { window.Reveal?.layout?.(); setTimeout(r, 200); })`;

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
async function openSettled(browser: Browser, url: string, timeoutMs: number, setup?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await browser.newPage();
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
