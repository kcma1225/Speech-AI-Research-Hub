import puppeteer, { type Browser } from "puppeteer-core";
import { JobAbortedError, abortReason } from "./errors.js";

export type PrintOptions = { chromeBin: string; profileDir: string; timeoutMs: number; signal: AbortSignal };

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
 * captured the page before Reveal finished and produced a blank PDF.
 */
export async function printPdf(url: string, output: string, { chromeBin, profileDir, timeoutMs, signal }: PrintOptions) {
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
    const page = await browser.newPage();
    // Offline worker: any network request would hang until timeout, so refuse it outright.
    await page.setRequestInterception(true);
    page.on("request", request => (request.url().startsWith("file:") || request.url().startsWith("data:") ? request.continue() : request.abort()));
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(READY, { timeout: timeoutMs, polling: 100 });
    await page.evaluate(MATHJAX_IDLE);
    // Let Reveal's final layout pass and font swaps settle.
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.pdf({ path: output, printBackground: true, preferCSSPageSize: true, timeout: timeoutMs });
  } catch (error) {
    if (signal.aborted) throw new JobAbortedError(abortReason(signal));
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
}
