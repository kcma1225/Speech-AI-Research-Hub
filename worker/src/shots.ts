import { writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { JobAbortedError, abortReason } from "./errors.js";
import { SLIDE_METRICS, type SlideMetrics } from "./layout-metrics.js";
import { DECK_SIZE, GOTO_SLIDE, openSettled, RELAYOUT, SLIDE_LIST, THUMBNAIL_CSS } from "./pdf.js";

/**
 * Slide screenshots for the AI layout review (`slide_preview` with `shots: true`): every slide (Reveal order,
 * fragments shown) at `SHOT_WIDTH` px wide in the deck's aspect ratio, WebP, at most `MAX_SHOTS` slides.
 * Files `<dir>/<n>.webp`; uploaded as `<outputPrefix>_hub/shots/<n>.webp` + `_hub/shots.json`.
 */
export const SHOT_WIDTH = 1280;
export const MAX_SHOTS = 20;
export const SHOTS_DIR = "_hub/shots/";
export const SHOTS_MANIFEST = "_hub/shots.json";

export type Shot = { index: number; h: number; v?: number; title?: string; file: string; metrics?: SlideMetrics };
export type ShotsManifest = { version: 1; width: number; height: number; total: number; truncated: boolean; pages: Array<Omit<Shot, "file">> };

export type ShotOptions = { chromeBin: string; profileDir: string; signal: AbortSignal; timeoutMs?: number; budgetMs?: number; maxSlides?: number; width?: number };

/** Height for `width` at the deck's aspect ratio (16:9 fallback, clamped to 4:3 … 21:9). */
export function shotSize(deck: { width: number; height: number }, width = SHOT_WIDTH) {
  const ratio = deck.width > 0 && deck.height > 0 ? Math.min(3 / 4, Math.max(9 / 21, deck.height / deck.width)) : 9 / 16;
  return { width, height: Math.round(width * ratio) };
}

export async function captureShots(url: string, dir: string, opts: ShotOptions): Promise<{ shots: Shot[]; manifest: ShotsManifest }> {
  const { signal } = opts;
  if (signal.aborted) throw new JobAbortedError(abortReason(signal));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const budgetMs = opts.budgetMs ?? 30_000;
  const maxSlides = opts.maxSlides ?? MAX_SHOTS;
  let browser: Browser | undefined;
  const onAbort = () => void browser?.close().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(onAbort, timeoutMs + budgetMs + 10_000);
  try {
    browser = await puppeteer.launch({
      executablePath: opts.chromeBin,
      headless: "shell",
      pipe: true,
      userDataDir: opts.profileDir,
      env: { ...process.env, FONTCONFIG_PATH: "/etc/fonts" },
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--allow-file-access-from-files", "--no-first-run"],
      timeout: 30_000,
    });
    const initial = shotSize({ width: 0, height: 0 }, opts.width);
    const view = await openSettled(browser, url, timeoutMs, async page => {
      await page.setViewport({ ...initial, deviceScaleFactor: 1 });
    });
    const size = shotSize((await view.evaluate(DECK_SIZE)) as { width: number; height: number }, opts.width);
    if (size.height !== initial.height) {
      await view.setViewport({ ...size, deviceScaleFactor: 1 });
      await view.evaluate(RELAYOUT);
    }
    await view.addStyleTag({ content: THUMBNAIL_CSS });
    const listed = (await view.evaluate(SLIDE_LIST)) as unknown;
    if (!Array.isArray(listed)) throw new Error("Reveal API unavailable");
    const started = Date.now();
    const shots: Shot[] = [];
    let truncated = listed.length > maxSlides;
    for (const raw of listed.slice(0, maxSlides)) {
      if (Date.now() - started > budgetMs) {
        truncated = true;
        break;
      }
      const item = (raw ?? {}) as { h?: unknown; v?: unknown; title?: unknown };
      const h = Number.isInteger(item.h) ? (item.h as number) : 0;
      const v = Number.isInteger(item.v) ? (item.v as number) : undefined;
      await view.evaluate(GOTO_SLIDE(h, v ?? 0));
      const index = shots.length + 1;
      const file = path.join(dir, `${index}.webp`);
      await writeFile(file, await view.screenshot({ type: "webp", quality: 82, clip: { x: 0, y: 0, ...size } }));
      const shot: Shot = { index, h, file };
      const metrics = (await view.evaluate(SLIDE_METRICS).catch(() => null)) as SlideMetrics | null;
      if (metrics) shot.metrics = metrics;
      if (v !== undefined && v > 0) shot.v = v;
      if (typeof item.title === "string" && item.title.trim()) shot.title = item.title.trim().slice(0, 200);
      shots.push(shot);
    }
    const manifest: ShotsManifest = { version: 1, ...size, total: listed.length, truncated, pages: shots.map(({ file: _file, ...rest }) => rest) };
    return { shots, manifest };
  } catch (error) {
    if (signal.aborted) throw new JobAbortedError(abortReason(signal));
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
}
