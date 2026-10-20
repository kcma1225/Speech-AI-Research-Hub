import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** A file picked from a folder, with its path relative to that folder (forward slashes). */
export type FolderFile = { path: string; file: File };
export type Folder = { name: string; files: FolderFile[] };

// Mirrors backend/src/lib/slides/zip-validate.ts: junk is skipped there too, other types are rejected,
// so they are left out here (and reported) instead of failing the whole upload.
const ALLOWED = new Set([
  ".qmd", ".md", ".css", ".scss", ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".bib",
  ".csl", ".json", ".js", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".csv", ".mp4", ".webm", ".mp3", ".wav", ".m4a",
]);
const JUNK_DIRS = new Set([".git", "node_modules", "__MACOSX", "_site", ".quarto"]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
// Already-compressed media are stored, not deflated again.
const STORED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".mp3", ".m4a", ".woff", ".woff2", ".pdf"]);
export const FOLDER_LIMITS = { files: 2000, totalBytes: 500 * 1024 * 1024, fileBytes: 100 * 1024 * 1024, depth: 12 };

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};

/** "skip" = junk (silently dropped), "unsupported" = dropped and reported, "ok" = zipped. */
export function classify(path: string): "skip" | "unsupported" | "ok" {
  const parts = path.split("/");
  const base = parts.at(-1)!;
  if (parts.slice(0, -1).some(p => JUNK_DIRS.has(p)) || JUNK_FILES.has(base) || base.startsWith("._")) return "skip";
  if (base.startsWith(".env") || !ALLOWED.has(ext(base))) return "unsupported";
  return "ok";
}

/** A dropped directory (DataTransfer items), or null when the drop holds plain files. */
export async function droppedFolder(data: DataTransfer | null): Promise<Folder | null> {
  const item = data?.items?.[0];
  const entry = item?.webkitGetAsEntry?.();
  if (!entry?.isDirectory || data!.items.length !== 1) return null;
  const files: FolderFile[] = [];
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string, depth: number): Promise<void> => {
    if (depth > FOLDER_LIMITS.depth) return;
    const reader = dir.createReader();
    // readEntries returns at most ~100 entries per call: read until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) {
        const path = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isDirectory) {
          if (!JUNK_DIRS.has(child.name)) await walk(child as FileSystemDirectoryEntry, path, depth + 1);
        } else if (child.isFile) {
          files.push({ path, file: await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject)) });
        }
      }
    }
  };
  await walk(entry as FileSystemDirectoryEntry, "", 1);
  return { name: entry.name, files };
}

/** Files from a hidden `<input webkitdirectory>`: `webkitRelativePath` starts with the folder's name. */
export function pickedFolder(list: FileList | null): Folder | null {
  const all = Array.from(list ?? []);
  if (!all.length) return null;
  const name = all[0]!.webkitRelativePath.split("/")[0] || "slides";
  return { name, files: all.map(file => ({ path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name, file })) };
}

export class FolderError extends Error {
  constructor(readonly code: "empty" | "tooMany" | "tooLarge" | "fileTooLarge" | "zipTooLarge", readonly detail = "") {
    super(code);
  }
}

/**
 * Zips a folder in the browser (paths relative to the folder, so a root `index.qmd` stays at the root).
 * Runs on the main thread in small steps (the CSP allows no blob: workers). Returns the ZIP and the
 * paths left out because the server would reject their type.
 */
export async function zipFolder(folder: Folder, maxZipBytes: number, onProgress?: (fraction: number) => void): Promise<{ file: File; unsupported: string[] }> {
  const unsupported: string[] = [];
  const files = folder.files.filter(f => {
    const kind = classify(f.path);
    if (kind === "unsupported") unsupported.push(f.path);
    return kind === "ok";
  });
  if (!files.length) throw new FolderError("empty");
  if (files.length > FOLDER_LIMITS.files) throw new FolderError("tooMany", String(FOLDER_LIMITS.files));
  const big = files.find(f => f.file.size > FOLDER_LIMITS.fileBytes);
  if (big) throw new FolderError("fileTooLarge", big.path);
  const total = files.reduce((n, f) => n + f.file.size, 0);
  if (total > FOLDER_LIMITS.totalBytes) throw new FolderError("tooLarge");

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else {
      chunks.push(chunk as Uint8Array<ArrayBuffer>);
      size += chunk.length;
    }
  });
  let done = 0;
  for (const { path, file } of files) {
    const entry = STORED.has(ext(path)) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    entry.mtime = file.lastModified || Date.now();
    zip.add(entry);
    entry.push(new Uint8Array(await file.arrayBuffer()), true);
    done += file.size;
    onProgress?.(total ? done / total : 1);
    if (failure) throw failure;
    if (size > maxZipBytes) throw new FolderError("zipTooLarge");
    // Let the UI breathe between files.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  zip.end();
  if (failure) throw failure;
  if (size > maxZipBytes) throw new FolderError("zipTooLarge");
  return { file: new File(chunks, `${folder.name || "slides"}.zip`, { type: "application/zip" }), unsupported };
}
