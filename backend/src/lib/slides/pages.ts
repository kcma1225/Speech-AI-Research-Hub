import type { PageManifest } from "../../jobs/queue.js";
import type { Storage } from "../storage.js";

/**
 * Page images written by the worker under `<output_prefix>_hub/` (worker/src/pages.ts): WebP,
 * `pages/<n>-thumb.webp` (480 px wide) and, for pdf/pptx, `pages/<n>-full.webp` (1920 px wide).
 */
export type PageSize = "thumb" | "full";
export const pageImageKey = (outputPrefix: string, index: number, size: PageSize) => `${outputPrefix}_hub/pages/${index}-${size}.webp`;
export const MAX_PAGES = 1000;

export type ClientPage = { index: number; h?: number; v?: number; title?: string; thumb: string; full?: string; notes?: { text: string; html?: string } };
export type ClientManifest = {
  version: 1;
  versionId: string;
  sourceType: PageManifest["sourceType"];
  width: number;
  height: number;
  pageCount: number;
  pages: ClientPage[];
};

const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

/**
 * Reads and validates `pages.json`; returns null when missing or malformed. Only known fields are kept
 * and `thumb`/`full` are replaced by `url(index, size)` (the stored relative keys are never exposed).
 */
export async function loadManifest(storage: Storage, manifestKey: string, versionId: string, url: (index: number, size: PageSize) => string): Promise<ClientManifest | null> {
  const buffer = await storage.getBuffer(manifestKey);
  if (!buffer || buffer.length > 20 * 1024 * 1024) return null;
  let raw: Partial<PageManifest>;
  try {
    raw = JSON.parse(buffer.toString("utf8")) as Partial<PageManifest>;
  } catch {
    return null;
  }
  if (raw?.version !== 1 || !Array.isArray(raw.pages) || !["quarto", "pdf", "pptx"].includes(raw.sourceType as string)) return null;
  const pages: ClientPage[] = [];
  for (const item of raw.pages.slice(0, MAX_PAGES)) {
    if (!item || !isInt(item.index, 1, MAX_PAGES)) continue;
    const page: ClientPage = { index: item.index, thumb: url(item.index, "thumb") };
    if (isInt(item.h, 0, 10_000)) page.h = item.h;
    if (isInt(item.v, 0, 10_000)) page.v = item.v;
    const title = str(item.title, 300);
    if (title) page.title = title;
    if (typeof item.full === "string") page.full = url(item.index, "full");
    const text = str(item.notes?.text, 20_000);
    if (text) {
      const html = str(item.notes?.html, 40_000);
      page.notes = html ? { text, html } : { text };
    }
    pages.push(page);
  }
  return {
    version: 1,
    versionId,
    sourceType: raw.sourceType!,
    width: isInt(raw.width, 1, 100_000) ? raw.width : 16,
    height: isInt(raw.height, 1, 100_000) ? raw.height : 9,
    pageCount: pages.length,
    pages,
  };
}
