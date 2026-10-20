import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prepareSource } from "../annotate.js";
import { JobAbortedError, JobInputError, tail, throwIfAborted } from "../errors.js";
import { printPdf, type PrintResult } from "../pdf.js";
import {
  buildManifest, HUB_DIR, MANIFEST_NAME, MAX_QUARTO_PAGES, notesHtml, notesText, pageImageName, QUARTO_THUMBNAIL_NAME, RASTER_THUMBNAIL_NAME, rasterisePdf,
} from "../pages.js";
import { convertPptx, pptxSlides, readPptx, type PptxSlideInfo } from "../pptx.js";
import { run } from "../process.js";
import { contentType } from "../storage.js";
import { STAGES, type PageEntry, type PageManifest, type SlideRenderResult } from "../types.js";
import { assertEntry, extractZip } from "../zip.js";
import type { Handler, HandlerContext } from "./context.js";

const uuidPart = "[0-9a-f-]{36}";
const payloadSchema = z.object({
  projectId: z.uuid(),
  versionId: z.uuid(),
  sourceKey: z.string().regex(new RegExp(`^slides/${uuidPart}/${uuidPart}/source\\.(zip|pdf|pptx)$`)),
  entry: z.string().max(500),
  // `output-<suffix>/` is a re-index render next to the published output.
  outputPrefix: z.string().regex(new RegExp(`^slides/${uuidPart}/${uuidPart}/output(-[a-z0-9]{1,40})?/$`)),
  sourceType: z.enum(["quarto", "pdf", "pptx"]).default("quarto"),
}).refine(
  payload => payload.sourceKey.endsWith(SOURCE_EXTENSION[payload.sourceType]) && (payload.sourceType !== "quarto" || payload.entry.length > 0),
);
const SOURCE_EXTENSION = { quarto: ".zip", pdf: ".pdf", pptx: ".pptx" } as const;
type Payload = z.infer<typeof payloadSchema>;

const RENDER_TIMEOUT_MS = 180_000;
const PDF_TIMEOUT_MS = 120_000;
/** Quarto per-slide capture: total time budget (slides beyond it get no thumbnail). */
const PAGES_BUDGET_MS = 90_000;
/** Files Quarto/Chrome leave behind that must never be served. */
const EXCLUDED_OUTPUTS = new Set(["pdf.log"]);

export const slideRender: Handler = async (raw, context) => {
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) throw new JobInputError("工作內容不正確。");
  if (payload.data.sourceType === "pdf") return renderPdf(payload.data, context);
  if (payload.data.sourceType === "pptx") return renderPptx(payload.data, context);
  return renderQuarto(payload.data, context);
};

async function renderQuarto(payload: Payload, context: HandlerContext): Promise<SlideRenderResult> {
  const { sourceKey, outputPrefix } = payload;
  const { storage, signal, workDir, progress, config, log } = context;
  const zipFile = path.join(workDir, "source.zip");
  const sourceDir = path.join(workDir, "source");
  const outputDir = path.join(workDir, "output");

  progress(STAGES.extract, 5);
  await storage.download(sourceKey, zipFile, signal);
  const scan = await extractZip(zipFile, sourceDir, signal);
  const entry = assertEntry(scan, payload.entry);
  const entryHtml = await prepareSource(sourceDir, entry, config.ANNOTATE_DIR);
  throwIfAborted(signal);

  progress(STAGES.render, 20);
  await mkdir(outputDir, { recursive: true });
  const entryDir = path.join(sourceDir, ...path.posix.dirname(entry).split("/"));
  const render = await run("quarto", ["render", path.posix.basename(entry), "--to", "revealjs", "--output-dir", outputDir, "--no-execute"], {
    cwd: entryDir,
    timeoutMs: RENDER_TIMEOUT_MS,
    signal,
  });
  if (render.timedOut) throw new JobInputError(`簡報編譯逾時（${RENDER_TIMEOUT_MS / 1000} 秒）。\n${tail(render.log)}`);
  if (render.code !== 0) throw new JobInputError(tail(render.log) || "簡報編譯失敗。");
  const htmlFile = path.join(outputDir, entryHtml);
  if (!(await exists(htmlFile))) throw new JobInputError(`編譯後找不到 ${entryHtml}。\n${tail(render.log)}`);
  // Checked before the slow PDF step; re-listed afterwards because prepare-pdf.py adds offline-assets/.
  assertNoReserved(await listFiles(outputDir));

  progress(STAGES.pdf, 55);
  // Kept outside outputDir so they are not uploaded with the deck's own files.
  const hubDir = path.join(workDir, "hub");
  const pagesDir = path.join(hubDir, "pages");
  await mkdir(pagesDir, { recursive: true });
  const thumbnailFile = path.join(hubDir, "thumbnail.png");
  const captured = await exportPdf(outputDir, htmlFile, thumbnailFile, pagesDir, context);

  progress(STAGES.upload, 80);
  const files = await listFiles(outputDir);
  // offline-assets/ (MathJax, KaTeX, fonts: ~1.6k files) is identical for every render made by the same
  // worker image, so it is stored once under a content hash and shared by all versions.
  const shared = files.filter(relative => relative.startsWith(SHARED_DIR));
  const own = files.filter(relative => !relative.startsWith(SHARED_DIR));
  const sharedPrefix = `${SHARED_ROOT}${await hashTree(outputDir, shared)}/`;
  const sharedReady = shared.length === 0 || (await storage.exists(sharedPrefix + SHARED_MARKER));
  const pending = [
    ...own.map(relative => ({ file: path.join(outputDir, ...relative.split("/")), key: outputPrefix + relative, type: contentType(relative) })),
    ...(sharedReady ? [] : shared.map(relative => ({ file: path.join(outputDir, ...relative.split("/")), key: sharedPrefix + relative.slice(SHARED_DIR.length), type: contentType(relative) }))),
  ];
  await uploadAll(pending, context, 80, 95);
  // Written last: a concurrent or crashed upload never leaves a marker over an incomplete set.
  if (!sharedReady) await storage.put(sharedPrefix + SHARED_MARKER, "", "text/plain");

  // Hub files (thumbnail, page thumbs, manifest) are best effort: the deck itself is complete.
  const thumbnailKey = captured.thumbnail ? await uploadBestEffort(thumbnailFile, outputPrefix + QUARTO_THUMBNAIL_NAME, "image/png", context) : undefined;
  let pages: { pageCount: number; manifestKey: string } | undefined;
  if (captured.pages?.length) {
    try {
      progress(STAGES.pages, 96);
      const entries: PageEntry[] = captured.pages.map(slide => {
        const page: PageEntry = { index: slide.index, h: slide.h, thumb: pageImageName(slide.index, "thumb") };
        if (slide.v !== undefined) page.v = slide.v;
        if (slide.title) page.title = slide.title;
        if (slide.notes) {
          const text = notesText(slide.notes);
          if (text) page.notes = { text, html: notesHtml(slide.notes) };
        }
        return page;
      });
      await uploadAll(captured.pages.map(slide => ({ file: slide.file, key: outputPrefix + pageImageName(slide.index, "thumb"), type: "image/webp" })), context);
      const size = captured.deckSize && captured.deckSize.width > 0 && captured.deckSize.height > 0 ? captured.deckSize : { width: 16, height: 9 };
      pages = await uploadManifest(buildManifest("quarto", size, entries), outputPrefix, context);
    } catch (error) {
      throwIfAborted(signal);
      log.warn({ err: error }, "could not upload slide pages; continuing without them");
    }
  }

  const version = await run("quarto", ["--version"], { timeoutMs: 30_000, signal, keepLog: 200 });
  progress(STAGES.done, 100);
  return {
    entryHtml,
    pdfKey: `${outputPrefix}slides.pdf`,
    quartoVersion: version.log.trim(),
    fileCount: files.length,
    sharedPrefix,
    ...(thumbnailKey ? { thumbnailKey } : {}),
    ...(pages ?? {}),
  };
}

/** PDF deck: the uploaded PDF is the download; pages are rasterised from it. */
async function renderPdf(payload: Payload, context: HandlerContext): Promise<SlideRenderResult> {
  const { storage, signal, workDir, progress } = context;
  progress(STAGES.prepare, 5);
  const pdfFile = path.join(workDir, "source.pdf");
  await storage.download(payload.sourceKey, pdfFile, signal);
  if ((await readHead(pdfFile, 5)) !== "%PDF-") throw new JobInputError("檔案不是 PDF。");
  const pages = await rasterise(pdfFile, "pdf", [], 10, payload, context);
  progress(STAGES.done, 100);
  return { entryHtml: null, pdfKey: payload.sourceKey, quartoVersion: null, fileCount: pages.fileCount, sharedPrefix: null, ...pages.result };
}

/** PPTX deck: LibreOffice → slides.pdf (the download) → pages; speaker notes and titles from the PPTX XML. */
async function renderPptx(payload: Payload, context: HandlerContext): Promise<SlideRenderResult> {
  const { storage, signal, workDir, progress, log } = context;
  progress(STAGES.prepare, 5);
  const pptxFile = path.join(workDir, "deck.pptx");
  await storage.download(payload.sourceKey, pptxFile, signal);
  if ((await readHead(pptxFile, 4)) !== "PK\x03\x04") throw new JobInputError("檔案不是有效的 PPTX 簡報（可能已加密或為舊版 .ppt）。");
  const parts = await readPptx(pptxFile);
  const slides = pptxSlides(parts);
  parts.clear();

  progress(STAGES.convert, 10);
  const started = Date.now();
  const { pdf, version } = await convertPptx(pptxFile, workDir, signal);
  log.info({ ms: Date.now() - started }, "pptx converted");
  throwIfAborted(signal);
  const pages = await rasterise(pdf, "pptx", slides, 40, payload, context);
  await storage.uploadFile(`${payload.outputPrefix}slides.pdf`, pdf, "application/pdf", signal);
  progress(STAGES.done, 100);
  return {
    entryHtml: null,
    pdfKey: `${payload.outputPrefix}slides.pdf`,
    quartoVersion: null,
    fileCount: pages.fileCount + 1,
    sharedPrefix: null,
    ...pages.result,
    ...(version ? { converter: version.slice(0, 200) } : {}),
  };
}

/**
 * Rasterises `pdfFile` and uploads pages, deck thumbnail and manifest. `slides` (pptx) supplies titles
 * and notes; they are attached only when their count matches the PDF's pages (otherwise the mapping is unknown).
 */
async function rasterise(pdfFile: string, sourceType: "pdf" | "pptx", slides: PptxSlideInfo[], from: number, payload: Payload, context: HandlerContext) {
  const { progress, log, workDir, signal } = context;
  const { outputPrefix } = payload;
  progress(STAGES.pages, from);
  const raster = await rasterisePdf(pdfFile, path.join(workDir, "pages"), {
    signal,
    onPage: (done, total) => progress(STAGES.pages, from + Math.floor((done / total) * (80 - from))),
  });
  const withNotes = slides.length === raster.pages.length;
  if (sourceType === "pptx" && !withNotes) log.warn({ slides: slides.length, pages: raster.pages.length }, "pptx slide count differs from PDF pages; notes omitted");
  const entries: PageEntry[] = raster.pages.map(page => {
    const entry: PageEntry = { index: page.index, thumb: pageImageName(page.index, "thumb"), full: pageImageName(page.index, "full") };
    const slide = withNotes ? slides[page.index - 1] : undefined;
    if (slide?.title) entry.title = slide.title;
    if (slide?.notes) entry.notes = { text: slide.notes };
    return entry;
  });
  progress(STAGES.upload, 80);
  await uploadAll([
    ...raster.pages.flatMap(page => [
      { file: page.full, key: outputPrefix + pageImageName(page.index, "full"), type: "image/webp" },
      { file: page.thumb, key: outputPrefix + pageImageName(page.index, "thumb"), type: "image/webp" },
    ]),
    { file: raster.deckThumbnail, key: outputPrefix + RASTER_THUMBNAIL_NAME, type: "image/webp" },
  ], context, 80, 98);
  const manifest = await uploadManifest(buildManifest(sourceType, raster.info, entries), outputPrefix, context);
  return { result: { thumbnailKey: outputPrefix + RASTER_THUMBNAIL_NAME, ...manifest }, fileCount: raster.pages.length * 2 + 2 };
}

async function uploadManifest(manifest: PageManifest, outputPrefix: string, { storage }: HandlerContext) {
  const manifestKey = outputPrefix + MANIFEST_NAME;
  await storage.put(manifestKey, JSON.stringify(manifest), "application/json");
  return { pageCount: manifest.pages.length, manifestKey };
}

/** Uploads files concurrently, reporting progress between `from` and `to` percent. */
async function uploadAll(items: { file: string; key: string; type: string }[], { storage, signal, progress }: HandlerContext, from?: number, to?: number) {
  let uploaded = 0;
  // Each S3 PUT has noticeable latency; decks have hundreds of small assets.
  await mapConcurrent(items, UPLOAD_CONCURRENCY, async ({ file, key, type }) => {
    throwIfAborted(signal);
    await storage.uploadFile(key, file, type, signal);
    uploaded += 1;
    if (from !== undefined && to !== undefined) progress(STAGES.upload, from + Math.floor((uploaded / items.length) * (to - from)));
  });
}

/** A deck must not write into the hub's reserved `_hub/` directory of its output. */
export function assertNoReserved(files: readonly string[]) {
  if (files.some(relative => relative === HUB_DIR.slice(0, -1) || relative.startsWith(HUB_DIR))) {
    throw new JobInputError("簡報輸出不可使用保留目錄 _hub/，請重新命名該資料夾。");
  }
}

async function readHead(file: string, bytes: number) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    await handle.close();
  }
}

/**
 * Bundles CDN math/fonts locally (prepare-pdf.py) and prints the deck with headless Chrome
 * (one retry for a blank/incomplete print), then, in the same browser, screenshots the first slide
 * and every slide (page thumbnails, titles, notes). The worker has no internet, so anything still
 * pointing at a CDN would render wrong. Thumbnail and page failures are only logged.
 */
async function exportPdf(outputDir: string, htmlFile: string, thumbnailFile: string, pagesDir: string, { config, signal, log }: HandlerContext): Promise<{ thumbnail: boolean } & Pick<PrintResult, "pages" | "deckSize">> {
  const prepare = await run("python3", [config.PREPARE_PDF_SCRIPT, outputDir, htmlFile], {
    timeoutMs: 60_000,
    signal,
    env: { ...process.env, SLIDE_ASSETS_DIR: config.SLIDE_ASSETS_DIR },
  });
  if (prepare.code !== 0) throw new JobInputError(`PDF 匯出失敗：${tail(prepare.log, 2000)}`);

  const pdf = path.join(outputDir, "slides.pdf");
  let failure = "";
  for (let attempt = 1; attempt <= PDF_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    await rm(pdf, { force: true });
    const profile = path.join(path.dirname(outputDir), `chrome-profile-${attempt}`);
    await mkdir(profile, { recursive: true });
    try {
      await rm(thumbnailFile, { force: true });
      const started = Date.now();
      const result = await printPdf(pathToFileURL(htmlFile).href + "?print-pdf", pdf, {
        chromeBin: config.CHROME_BIN,
        profileDir: profile,
        timeoutMs: PDF_TIMEOUT_MS,
        signal,
        thumbnail: { url: pathToFileURL(htmlFile).href, output: thumbnailFile },
        pages: { dir: pagesDir, maxSlides: MAX_QUARTO_PAGES, budgetMs: PAGES_BUDGET_MS },
      });
      const header = await readFile(pdf).then(buffer => buffer.subarray(0, 5).toString("latin1"), () => "");
      const size = await stat(pdf).then(info => info.size, () => 0);
      if (header === "%PDF-" && size >= 10_000) {
        if (result.thumbnailError) log.warn({ err: result.thumbnailError }, "slide thumbnail failed; continuing without it");
        if (result.pagesError) log.warn({ err: result.pagesError }, "slide page capture failed; continuing without pages");
        if (result.pages) log.info({ pages: result.pages.length, truncated: result.pagesTruncated ?? false, ms: Date.now() - started, captureMs: result.pagesMs }, "pdf, thumbnail and slide pages captured");
        return {
          thumbnail: !result.thumbnailError && (await exists(thumbnailFile)),
          ...(result.pages ? { pages: result.pages } : {}),
          ...(result.deckSize ? { deckSize: result.deckSize } : {}),
        };
      }
      failure = `輸出檔案不完整（${size} bytes）`;
    } catch (error) {
      if (error instanceof JobAbortedError) throw error;
      failure = (error as Error).message;
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  throw new JobInputError(`PDF 匯出失敗：${tail(failure, 2000)}`);
}

const PDF_ATTEMPTS = 2;

/** Best-effort upload; any failure other than an abort is logged and the file omitted. */
async function uploadBestEffort(file: string, key: string, type: string, { storage, signal, log }: HandlerContext): Promise<string | undefined> {
  try {
    await storage.uploadFile(key, file, type, signal);
    return key;
  } catch (error) {
    throwIfAborted(signal);
    log.warn({ err: error, key }, "could not upload hub file; continuing without it");
    return undefined;
  }
}

/** Relative posix paths of every output file, excluding logs. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter(relative => !EXCLUDED_OUTPUTS.has(relative))
    .sort();
}

const exists = (file: string) => stat(file).then(() => true, () => false);

const UPLOAD_CONCURRENCY = 16;
const SHARED_DIR = "offline-assets/";
const SHARED_ROOT = "slides/_shared/";
const SHARED_MARKER = ".complete";

/** Stable hash of a set of files (paths + contents), used as the shared-assets key. */
export async function hashTree(root: string, relatives: readonly string[]): Promise<string> {
  const tree = createHash("sha256");
  for (const relative of [...relatives].sort()) {
    const content = await readFile(path.join(root, ...relative.split("/")));
    tree.update(relative).update("\0").update(createHash("sha256").update(content).digest()).update("\0");
  }
  return tree.digest("hex").slice(0, 32);
}

/** Runs `work` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Removes partially uploaded output after cancel/failure. */
export async function cleanupSlides(raw: unknown, removePrefix: (prefix: string) => Promise<void>) {
  const payload = payloadSchema.safeParse(raw);
  if (payload.success) await removePrefix(payload.data.outputPrefix);
}
