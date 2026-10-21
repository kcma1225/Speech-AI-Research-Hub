import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { JobInputError, tail, throwIfAborted } from "../errors.js";
import { run } from "../process.js";
import { contentType } from "../storage.js";
import { STAGES, type SlidePreviewResult } from "../types.js";
import { assertEntry, extractZip } from "../zip.js";
import type { Handler } from "./context.js";
import { assertNoReserved, mapConcurrent } from "./slide-render.js";
import { captureShots, SHOTS_DIR, SHOTS_MANIFEST } from "../shots.js";

const uuidPart = "[0-9a-f-]{36}";
const payloadSchema = z.object({
  deckId: z.uuid(),
  previewId: z.uuid(),
  sourceKey: z.string().regex(new RegExp(`^slides/${uuidPart}/preview/${uuidPart}/source\\.zip$`)),
  entry: z.string().min(1).max(500),
  outputPrefix: z.string().regex(new RegExp(`^slides/${uuidPart}/preview/${uuidPart}/output/$`)),
  /** Also capture slide screenshots for the AI layout review (see shots.ts). */
  shots: z.boolean().optional(),
});

const PREVIEW_TIMEOUT_MS = 90_000;
const UPLOAD_CONCURRENCY = 16;

/**
 * `slide_preview`: quick render of an in-app source tree for the editor — Quarto → revealjs HTML only.
 * No PDF, page images, thumbnail, annotate plugin or offline-asset bundling (math/fonts load from the CDN the
 * sandbox CSP allows). Claimed after every other slide job (see Queue.claim).
 */
export const slidePreview: Handler = async (raw, context): Promise<SlidePreviewResult> => {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new JobInputError("工作內容不正確。");
  const payload = parsed.data;
  const { storage, signal, workDir, progress } = context;
  const zipFile = path.join(workDir, "source.zip");
  const sourceDir = path.join(workDir, "source");
  const outputDir = path.join(workDir, "output");

  progress(STAGES.extract, 10);
  await storage.download(payload.sourceKey, zipFile, signal);
  const scan = await extractZip(zipFile, sourceDir, signal);
  const entry = assertEntry(scan, payload.entry);
  // A tree is one deck, not a Quarto project.
  await rm(path.join(sourceDir, "_quarto.yml"), { force: true });
  await rm(path.join(sourceDir, "_quarto.yaml"), { force: true });
  const entryHtml = path.posix.basename(entry, path.posix.extname(entry)) + ".html";
  throwIfAborted(signal);

  progress(STAGES.render, 30);
  await mkdir(outputDir, { recursive: true });
  const entryDir = path.join(sourceDir, ...path.posix.dirname(entry).split("/"));
  const render = await run("quarto", ["render", path.posix.basename(entry), "--to", "revealjs", "--output-dir", outputDir, "--no-execute"], {
    cwd: entryDir,
    timeoutMs: PREVIEW_TIMEOUT_MS,
    signal,
  });
  if (render.timedOut) throw new JobInputError(`預覽編譯逾時（${PREVIEW_TIMEOUT_MS / 1000} 秒）。\n${tail(render.log)}`);
  if (render.code !== 0) throw new JobInputError(tail(render.log) || "預覽編譯失敗。");
  if (!(await stat(path.join(outputDir, entryHtml)).then(() => true, () => false))) throw new JobInputError(`編譯後找不到 ${entryHtml}。\n${tail(render.log)}`);

  progress(STAGES.upload, 70);
  const entries = await readdir(outputDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter(item => item.isFile())
    .map(item => path.relative(outputDir, path.join(item.parentPath, item.name)).split(path.sep).join("/"))
    .filter(relative => relative !== "pdf.log")
    .sort();
  assertNoReserved(files);
  let uploaded = 0;
  await mapConcurrent(files, UPLOAD_CONCURRENCY, async relative => {
    throwIfAborted(signal);
    await storage.uploadFile(payload.outputPrefix + relative, path.join(outputDir, ...relative.split("/")), contentType(relative), signal);
    uploaded += 1;
    progress(STAGES.upload, 70 + Math.floor((uploaded / files.length) * 28));
  });
  const version = await run("quarto", ["--version"], { timeoutMs: 30_000, signal, keepLog: 200 });
  const shots = payload.shots ? await previewShots(outputDir, path.join(outputDir, entryHtml), payload.outputPrefix, context) : undefined;
  progress(STAGES.done, 100);
  return { entryHtml, fileCount: files.length, quartoVersion: version.log.trim() || null, ...(shots ? { shots } : {}) };
};

/**
 * Best effort: screenshots of every slide (≤ 20, 1280 px WebP) for the AI layout review. Runs after the deck is
 * uploaded; the local copy is then switched to offline assets (prepare-pdf.py: KaTeX/MathJax/fonts from the image,
 * the worker has no internet) so math and fonts look as in the published deck. A failure only drops the shots.
 */
async function previewShots(outputDir: string, htmlFile: string, outputPrefix: string, context: Parameters<Handler>[1]): Promise<SlidePreviewResult["shots"]> {
  const { config, signal, storage, progress, log, workDir } = context;
  progress(STAGES.pages, 85);
  try {
    const prepare = await run("python3", [config.PREPARE_PDF_SCRIPT, outputDir, htmlFile], { timeoutMs: 60_000, signal, env: { ...process.env, SLIDE_ASSETS_DIR: config.SLIDE_ASSETS_DIR } });
    if (prepare.code !== 0) throw new Error(tail(prepare.log, 500));
    const dir = path.join(workDir, "shots");
    const profileDir = path.join(workDir, "chrome-shots");
    await mkdir(dir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const started = Date.now();
    const { shots, manifest } = await captureShots(pathToFileURL(htmlFile).href, dir, { chromeBin: config.CHROME_BIN, profileDir, signal });
    progress(STAGES.upload, 95);
    await mapConcurrent(shots, UPLOAD_CONCURRENCY, async shot => {
      await storage.uploadFile(`${outputPrefix}${SHOTS_DIR}${shot.index}.webp`, shot.file, "image/webp", signal);
    });
    const manifestFile = path.join(dir, "shots.json");
    await writeFile(manifestFile, JSON.stringify(manifest));
    await storage.uploadFile(outputPrefix + SHOTS_MANIFEST, manifestFile, "application/json", signal);
    log.info({ shots: shots.length, truncated: manifest.truncated, ms: Date.now() - started }, "preview shots captured");
    return { count: shots.length, total: manifest.total, width: manifest.width, height: manifest.height, truncated: manifest.truncated };
  } catch (error) {
    throwIfAborted(signal);
    log.warn({ err: error }, "preview shots failed; preview kept without them");
    return { count: 0, error: "無法擷取投影片畫面。" };
  }
}

/** Removes partially uploaded preview output after cancel/failure. */
export async function cleanupPreview(raw: unknown, removePrefix: (prefix: string) => Promise<void>) {
  const payload = payloadSchema.safeParse(raw);
  if (payload.success) await removePrefix(payload.data.outputPrefix);
}
