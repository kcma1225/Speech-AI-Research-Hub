import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { JobInputError, throwIfAborted } from "./errors.js";
import { isSafeProjectPath, type LatexSnapshotManifest } from "./shared/contract.js";
import type { Storage } from "./storage.js";

/** Build output directory inside the project dir; never part of the snapshot. */
export const OUT_DIR = ".out";

/** `files`: path → `<key>|<size>|<mtimeMs>` of the copy in `src`. */
type CacheState = { files: Record<string, string>; compiler?: string; rootFile?: string; lastUsed: number };

/**
 * Per-project working directories `WORK_DIR/projects/<projectId>/src` that survive between compiles
 * so latexmk can reuse `.aux`/`.bbl` (incremental builds). Each sync downloads only files whose S3
 * key changed and deletes files that left the snapshot. Directories are mode 0700; in the sandbox a
 * compile sees only its own `src`.
 */
export class ProjectCache {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly root: string, private readonly maxProjects: number) {}

  dir(projectId: string) {
    return path.join(this.root, "projects", projectId);
  }

  srcDir(projectId: string) {
    return path.join(this.dir(projectId), "src");
  }

  /** Runs `task` while holding the per-project lock (compiles of one project never overlap). */
  async withProject<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(projectId, chained);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(projectId) === chained) this.locks.delete(projectId);
    }
  }

  private async readState(projectId: string): Promise<CacheState> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(projectId), "state.json"), "utf8")) as CacheState;
    } catch {
      return { files: {}, lastUsed: 0 };
    }
  }

  async writeState(projectId: string, state: CacheState) {
    await writeFile(path.join(this.dir(projectId), "state.json"), JSON.stringify(state), { mode: 0o600 });
  }

  /**
   * Makes `src` match the manifest. Returns the previous state (to detect compiler/root changes).
   * Throws JobInputError for unsafe paths, duplicates, keys outside the project or size limits.
   */
  async sync(
    projectId: string,
    manifest: LatexSnapshotManifest,
    options: { storage: Storage; signal: AbortSignal; maxFiles: number; maxBytes: number; keyPrefix: string },
  ): Promise<{ previous: CacheState; downloaded: number }> {
    validateManifest(manifest, options);
    const dir = this.dir(projectId);
    const src = this.srcDir(projectId);
    await mkdir(src, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await chmod(src, 0o700);
    const previous = await this.readState(projectId);
    const wanted = new Map(manifest.files.map(file => [file.path, file]));

    // Remove files (and symlinks or anything else) that are not in the snapshot; keep .out.
    await prune(src, "", wanted);

    let downloaded = 0;
    let total = 0;
    const files: Record<string, string> = {};
    for (const file of manifest.files) {
      throwIfAborted(options.signal);
      const target = path.join(src, ...file.path.split("/"));
      // Cached copy is reused only when its key matches and nothing (e.g. a compile) touched it since.
      const info = await lstat(target).catch(() => null);
      const fingerprint = info?.isFile() ? `${file.key}|${info.size}|${Math.trunc(info.mtimeMs)}` : null;
      if (fingerprint === null || previous.files[file.path] !== fingerprint) {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temp = path.join(dir, `download-${process.pid}-${Math.random().toString(36).slice(2)}`);
        try {
          const bytes = await options.storage.download(file.key, temp, options.signal);
          if (file.sha256 && (await sha256(temp)) !== file.sha256) throw new JobInputError(`檔案內容與清單不符：${file.path}`);
          await rm(target, { force: true, recursive: true });
          await rename(temp, target);
          total += bytes;
          downloaded++;
        } finally {
          await rm(temp, { force: true });
        }
        const fresh = await stat(target);
        files[file.path] = `${file.key}|${fresh.size}|${Math.trunc(fresh.mtimeMs)}`;
      } else {
        total += info!.size;
        files[file.path] = fingerprint;
      }
      if (total > options.maxBytes) throw new JobInputError("專案檔案總大小超過上限。");
    }
    await this.writeState(projectId, { ...previous, files, lastUsed: Date.now() });
    return { previous, downloaded };
  }

  /** Deletes least recently used project caches beyond `maxProjects` (skipping locked ones). */
  async evict(keep: string) {
    const base = path.join(this.root, "projects");
    const ids = await readdir(base).catch(() => [] as string[]);
    if (ids.length <= this.maxProjects) return;
    const states = await Promise.all(ids.map(async id => ({ id, lastUsed: (await this.readState(id)).lastUsed })));
    states.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const { id } of states.slice(0, ids.length - this.maxProjects)) {
      if (id === keep || this.locks.has(id)) continue;
      await rm(path.join(base, id), { recursive: true, force: true });
    }
  }
}

export function validateManifest(manifest: LatexSnapshotManifest, options: { maxFiles: number; maxBytes: number; keyPrefix: string }) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new JobInputError("專案檔案清單格式錯誤。");
  if (manifest.files.length > options.maxFiles) throw new JobInputError(`專案檔案數超過上限（${options.maxFiles}）。`);
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let declared = 0;
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || typeof file.key !== "string") throw new JobInputError("專案檔案清單格式錯誤。");
    if (!isSafeProjectPath(file.path)) throw new JobInputError(`不安全的檔案路徑：${file.path.slice(0, 200)}`);
    if (!file.key.startsWith(options.keyPrefix) || file.key.includes("..")) throw new JobInputError("檔案不屬於此專案。");
    if (seen.has(file.path)) throw new JobInputError(`檔案路徑重複：${file.path}`);
    seen.add(file.path);
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    declared += typeof file.size === "number" ? file.size : 0;
  }
  for (const dir of dirs) if (seen.has(dir)) throw new JobInputError(`檔案與資料夾同名：${dir}`);
  if (declared > options.maxBytes) throw new JobInputError("專案檔案總大小超過上限。");
}

async function prune(root: string, relative: string, wanted: Map<string, unknown>) {
  const dir = path.join(root, relative);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && entry.name === OUT_DIR) {
      if (!entry.isDirectory()) await rm(path.join(dir, entry.name), { force: true });
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await prune(root, rel, wanted);
      await rmdir(full).catch(() => {});
    } else if (!entry.isFile() || !wanted.has(rel)) {
      await rm(full, { force: true, recursive: true });
    }
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", chunk => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
