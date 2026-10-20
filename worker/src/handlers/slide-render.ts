import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prepareSource } from "../annotate.js";
import { JobAbortedError, JobInputError, tail, throwIfAborted } from "../errors.js";
import { printPdf } from "../pdf.js";
import { run } from "../process.js";
import { contentType } from "../storage.js";
import { STAGES, type SlideRenderResult } from "../types.js";
import { assertEntry, extractZip } from "../zip.js";
import type { Handler, HandlerContext } from "./context.js";

const uuidPart = "[0-9a-f-]{36}";
const payloadSchema = z.object({
  projectId: z.uuid(),
  versionId: z.uuid(),
  sourceKey: z.string().regex(new RegExp(`^slides/${uuidPart}/${uuidPart}/source\\.zip$`)),
  entry: z.string().min(1).max(500),
  outputPrefix: z.string().regex(new RegExp(`^slides/${uuidPart}/${uuidPart}/output/$`)),
});

const RENDER_TIMEOUT_MS = 180_000;
const PDF_TIMEOUT_MS = 120_000;
/** Files Quarto/Chrome leave behind that must never be served. */
const EXCLUDED_OUTPUTS = new Set(["pdf.log"]);

export const slideRender: Handler = async (raw, context) => {
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) throw new JobInputError("工作內容不正確。");
  const { sourceKey, outputPrefix } = payload.data;
  const { storage, signal, workDir, progress, config } = context;
  const zipFile = path.join(workDir, "source.zip");
  const sourceDir = path.join(workDir, "source");
  const outputDir = path.join(workDir, "output");

  progress(STAGES.extract, 5);
  await storage.download(sourceKey, zipFile, signal);
  const scan = await extractZip(zipFile, sourceDir, signal);
  const entry = assertEntry(scan, payload.data.entry);
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

  progress(STAGES.pdf, 60);
  // Kept outside outputDir so it is not uploaded with the deck's own files.
  const thumbnailFile = path.join(workDir, THUMBNAIL_NAME);
  const captured = await exportPdf(outputDir, htmlFile, thumbnailFile, context);

  progress(STAGES.upload, 80);
  const files = await listFiles(outputDir);
  // offline-assets/ (MathJax, KaTeX, fonts: ~1.6k files) is identical for every render made by the same
  // worker image, so it is stored once under a content hash and shared by all versions.
  const shared = files.filter(relative => relative.startsWith(SHARED_DIR));
  const own = files.filter(relative => !relative.startsWith(SHARED_DIR));
  const sharedPrefix = `${SHARED_ROOT}${await hashTree(outputDir, shared)}/`;
  const sharedReady = shared.length === 0 || (await storage.exists(sharedPrefix + SHARED_MARKER));
  const pending = [
    ...own.map(relative => ({ relative, key: outputPrefix + relative })),
    ...(sharedReady ? [] : shared.map(relative => ({ relative, key: sharedPrefix + relative.slice(SHARED_DIR.length) }))),
  ];
  let uploaded = 0;
  // Each S3 PUT has noticeable latency; decks have hundreds of small assets.
  await mapConcurrent(pending, UPLOAD_CONCURRENCY, async ({ relative, key }) => {
    throwIfAborted(signal);
    await storage.uploadFile(key, path.join(outputDir, ...relative.split("/")), contentType(relative), signal);
    uploaded += 1;
    progress(STAGES.upload, 80 + Math.floor((uploaded / pending.length) * 19));
  });
  // Written last: a concurrent or crashed upload never leaves a marker over an incomplete set.
  if (!sharedReady) await storage.put(sharedPrefix + SHARED_MARKER, "", "text/plain");
  const thumbnailKey = await uploadThumbnail(thumbnailFile, thumbnailTarget(outputPrefix, own, captured), context);

  const version = await run("quarto", ["--version"], { timeoutMs: 30_000, signal, keepLog: 200 });
  progress(STAGES.done, 100);
  return {
    entryHtml,
    pdfKey: `${outputPrefix}slides.pdf`,
    quartoVersion: version.log.trim(),
    fileCount: files.length,
    sharedPrefix,
    ...(thumbnailKey ? { thumbnailKey } : {}),
  } satisfies SlideRenderResult;
};

/**
 * Bundles CDN math/fonts locally (prepare-pdf.py) and prints the deck with headless Chrome
 * (one retry for a blank/incomplete print), then screenshots the first slide in the same browser.
 * The worker has no internet, so anything still pointing at a CDN would render wrong.
 * Returns whether `thumbnailFile` was written; a thumbnail failure is only logged.
 */
async function exportPdf(outputDir: string, htmlFile: string, thumbnailFile: string, { config, signal, log }: HandlerContext): Promise<boolean> {
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
      const { thumbnailError } = await printPdf(pathToFileURL(htmlFile).href + "?print-pdf", pdf, {
        chromeBin: config.CHROME_BIN,
        profileDir: profile,
        timeoutMs: PDF_TIMEOUT_MS,
        signal,
        thumbnail: { url: pathToFileURL(htmlFile).href, output: thumbnailFile },
      });
      const header = await readFile(pdf).then(buffer => buffer.subarray(0, 5).toString("latin1"), () => "");
      const size = await stat(pdf).then(info => info.size, () => 0);
      if (header === "%PDF-" && size >= 10_000) {
        if (thumbnailError) log.warn({ err: thumbnailError }, "slide thumbnail failed; continuing without it");
        return !thumbnailError && (await exists(thumbnailFile));
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
export const THUMBNAIL_NAME = "_hub-thumbnail.png";

/**
 * Key for the generated thumbnail, or undefined when there is none to upload: not captured, or the
 * deck ships its own `_hub-thumbnail.png` at the output root (never overwrite a file the deck serves).
 */
export function thumbnailTarget(outputPrefix: string, ownFiles: readonly string[], captured: boolean): string | undefined {
  if (!captured || ownFiles.includes(THUMBNAIL_NAME)) return undefined;
  return outputPrefix + THUMBNAIL_NAME;
}

/** Best-effort upload; any failure other than an abort is logged and the thumbnail omitted. */
async function uploadThumbnail(file: string, key: string | undefined, { storage, signal, log }: HandlerContext): Promise<string | undefined> {
  if (!key) return undefined;
  try {
    await storage.uploadFile(key, file, "image/png", signal);
    return key;
  } catch (error) {
    throwIfAborted(signal);
    log.warn({ err: error, key }, "could not upload slide thumbnail; continuing without it");
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
