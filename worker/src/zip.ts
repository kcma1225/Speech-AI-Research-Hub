import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { JobInputError } from "./errors.js";

/** Same rules as the backend's pre-upload check (docs/architecture.md "ZIP validation"). */
export const ALLOWED_EXTENSIONS = new Set([
  ".qmd", ".md", ".css", ".scss", ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".bib",
  ".csl", ".json", ".js", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".csv", ".mp4", ".webm", ".mp3", ".wav", ".m4a",
  // Pre-rendered output, notebooks and other harmless assets decks commonly ship with.
  ".html", ".htm", ".ipynb", ".xml", ".tsv", ".ico", ".bmp", ".avif", ".tif", ".tiff", ".ogg", ".mov", ".m4v",
]);
/** Directories never extracted. Their content is skipped rather than validated. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "__MACOSX", "_site", ".quarto"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);
export const LIMITS = { files: 2000, totalBytes: 500 * 1024 * 1024, fileBytes: 100 * 1024 * 1024, depth: 12 };

export type ZipScan = { qmd: string[]; files: number; bytes: number };

/** Validates a ZIP entry name; returns its normalized posix path or throws JobInputError. */
export function safeEntryName(name: string): string {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new JobInputError("ZIP 包含不安全路徑。");
  const trimmed = name.replace(/\/$/, "");
  if (!trimmed || trimmed.split("/").some(part => part === ".." || part === "." || part === "")) throw new JobInputError("ZIP 包含不安全路徑。");
  return trimmed;
}

/** Classifies an entry: `skip` (ignored junk), or a validated relative path. Throws for forbidden content. */
export function classifyEntry(name: string, isDirectory: boolean, mode: number, size: number): { skip: true } | { skip: false; path: string } {
  const normalized = safeEntryName(name);
  const parts = normalized.split("/");
  if (parts.some(part => SKIPPED_DIRS.has(part))) return { skip: true };
  if (parts.some(part => part.startsWith(".env"))) throw new JobInputError("ZIP 不可包含 .env 檔案。");
  if (parts.length > LIMITS.depth) throw new JobInputError("ZIP 路徑層級過深。");
  if ((mode & 0o170000) === 0o120000) throw new JobInputError("ZIP 不可包含 symbolic link。");
  if (isDirectory) return { skip: true };
  if (SKIPPED_FILES.has(parts[parts.length - 1]!)) return { skip: true };
  const extension = path.posix.extname(normalized).toLowerCase();
  // Same as the backend: unknown types are left out, not fatal.
  if (!ALLOWED_EXTENSIONS.has(extension)) return { skip: true };
  if (size > LIMITS.fileBytes) throw new JobInputError("ZIP 超過檔案數量或容量限制。");
  return { skip: false, path: normalized };
}

function open(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) =>
      error || !zip ? reject(new JobInputError("無法讀取 ZIP 檔。")) : resolve(zip),
    ),
  );
}

/**
 * Extracts `zipFile` into `target` (which must be empty or absent), streaming each entry.
 * Enforces every validation rule while extracting, so nothing unsafe is ever written.
 */
export async function extractZip(zipFile: string, target: string, signal?: AbortSignal): Promise<ZipScan> {
  await mkdir(target, { recursive: true });
  const root = path.resolve(target);
  const zip = await open(zipFile);
  const scan: ZipScan = { qmd: [], files: 0, bytes: 0 };
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error instanceof JobInputError ? error : new JobInputError("ZIP 檔案損毀或無法解壓縮。"));
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (signal?.aborted) throw signal.reason;
          const isDirectory = entry.fileName.endsWith("/");
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = classifyEntry(entry.fileName, isDirectory, mode, entry.uncompressedSize);
          if (kind.skip) return;
          scan.files += 1;
          scan.bytes += entry.uncompressedSize;
          if (scan.files > LIMITS.files || scan.bytes > LIMITS.totalBytes) throw new JobInputError("ZIP 超過檔案數量或容量限制。");
          const output = path.resolve(root, ...kind.path.split("/"));
          if (!output.startsWith(root + path.sep)) throw new JobInputError("ZIP 包含不安全路徑。");
          if (kind.path.toLowerCase().endsWith(".qmd")) scan.qmd.push(kind.path);
          await mkdir(path.dirname(output), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((ok, ko) =>
            zip.openReadStream(entry, (error, readable) => (error || !readable ? ko(error) : ok(readable))),
          );
          // flag "wx": a duplicate entry name must not overwrite an earlier file.
          await pipeline(stream, createWriteStream(output, { flags: "wx" }));
        })().then(() => zip.readEntry(), error => {
          zip.close();
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return fail(new JobInputError("ZIP 含有重複的檔名。"));
          fail(error);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return scan;
}

/** The backend chose `entry`; re-check it against what was actually extracted. */
export function assertEntry(scan: ZipScan, entry: string): string {
  const normalized = safeEntryName(entry);
  if (!normalized.toLowerCase().endsWith(".qmd") || !scan.qmd.includes(normalized)) throw new JobInputError("找不到指定入口 QMD。");
  return normalized;
}
