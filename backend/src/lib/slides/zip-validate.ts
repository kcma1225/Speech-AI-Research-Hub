import path from "node:path";
import yauzl from "yauzl";
import { badRequest } from "../http.js";

/** Extensions a deck ZIP may contain (docs/architecture.md "ZIP validation"). The worker enforces the same list. */
export const ALLOWED_EXTENSIONS = new Set([
  ".qmd", ".md", ".css", ".scss", ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".bib",
  ".csl", ".json", ".js", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".csv", ".mp4", ".webm", ".mp3", ".wav", ".m4a",
  // Pre-rendered output, notebooks and other harmless assets decks commonly ship with.
  ".html", ".htm", ".ipynb", ".xml", ".tsv", ".ico", ".bmp", ".avif", ".tif", ".tiff", ".ogg", ".mov", ".m4v",
]);
/** Tool/OS junk (e.g. macOS Finder adds __MACOSX and .DS_Store) is skipped, matching the worker's extractor. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "__MACOSX", "_site", ".quarto"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);
export const ZIP_LIMITS = { files: 2000, totalBytes: 500 * 1024 * 1024, fileBytes: 100 * 1024 * 1024, depth: 12 };

/** `skipped`: files with other extensions, left out of the deck instead of failing the upload (first 20 names). */
export type ZipScan = { qmd: string[]; files: number; bytes: number; skipped: string[]; skippedCount: number };

/** Normalises a ZIP entry name or user-supplied entry path; throws on anything that could escape the root. */
export function safeEntryName(name: string): string {
  const unsafe = badRequest("ZIP 包含不安全路徑。");
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw unsafe;
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some(part => part === ".." || part === "." || part === "")) throw unsafe;
  const normalized = path.posix.normalize(name);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) throw unsafe;
  return normalized;
}

/** Validates entry metadata of the ZIP at `zipPath` without extracting it. Throws HttpError(400) with a 繁中 message. */
export function scanZip(zipPath: string): Promise<ZipScan> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(badRequest("ZIP 檔案無法讀取。"));
      let files = 0;
      let bytes = 0;
      const qmd: string[] = [];
      const skipped: string[] = [];
      let skippedCount = 0;
      const fail = (cause: unknown) => {
        zip.close();
        if (cause instanceof Error && "status" in cause) return reject(cause);
        // yauzl's own fileName validation (strictFileNames) reports traversal, absolute paths and backslashes.
        const unsafe = /absolute path|invalid relative path|invalid characters in fileName/.test(String((cause as Error)?.message));
        reject(badRequest(unsafe ? "ZIP 包含不安全路徑。" : "ZIP 檔案無法讀取。"));
      };
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          const name = safeEntryName(entry.fileName);
          const parts = name.split("/");
          if (parts.some(part => part.startsWith(".env"))) throw badRequest("ZIP 包含禁止目錄或檔案。");
          if (parts.some(part => SKIPPED_DIRS.has(part)) || SKIPPED_FILES.has(parts[parts.length - 1]!)) {
            zip.readEntry();
            return;
          }
          if (parts.length > ZIP_LIMITS.depth) throw badRequest("ZIP 路徑層級過深。");
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) throw badRequest("ZIP 不可包含 symbolic link。");
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (entry.isEncrypted()) throw badRequest("ZIP 不可加密。");
          const extension = path.posix.extname(name).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(extension)) {
            // Unknown types are not extracted by the worker either; report them instead of rejecting the whole ZIP.
            if (skipped.length < 20) skipped.push(name);
            skippedCount++;
            zip.readEntry();
            return;
          }
          files++;
          bytes += entry.uncompressedSize;
          if (files > ZIP_LIMITS.files || bytes > ZIP_LIMITS.totalBytes || entry.uncompressedSize > ZIP_LIMITS.fileBytes) throw badRequest("ZIP 超過檔案數量或容量限制。");
          if (extension === ".qmd") qmd.push(name);
          zip.readEntry();
        } catch (cause) {
          fail(cause);
        }
      });
      zip.on("end", () => resolve({ qmd, files, bytes, skipped, skippedCount }));
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/** Picks the entry QMD: explicit choice if present, else root index.qmd, else the only QMD. */
export function chooseEntry(qmd: string[], selection: string | undefined): string {
  if (!qmd.length) throw badRequest("ZIP 未包含 QMD 檔案。");
  const choice = selection?.trim();
  if (choice) {
    const normalized = safeEntryName(choice);
    if (!qmd.includes(normalized)) throw badRequest("找不到指定入口 QMD。");
    return normalized;
  }
  if (qmd.includes("index.qmd")) return "index.qmd";
  if (qmd.length === 1) return qmd[0]!;
  throw badRequest(`ZIP 包含多個 QMD，請指定入口檔：${qmd.join("、")}`);
}
