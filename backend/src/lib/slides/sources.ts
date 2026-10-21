import path from "node:path";
import type { Queryable } from "../../db.js";
import { badRequest, conflict, HttpError, notFound } from "../http.js";
import type { Storage } from "../storage.js";
import { ALLOWED_EXTENSIONS } from "./zip-validate.js";
import { writeZip } from "./zip-write.js";

/**
 * In-app Quarto source trees (tables `deck_source_trees`, `deck_sources`). Text files live in the database,
 * binaries (images, fonts, PDFs…) in S3 under `slides/<deckId>/source/<fileId>`. Every change bumps the tree's
 * `revision`; previews and publishes pack the tree into a ZIP the worker validates like an uploaded one.
 */
export const sourceKeys = {
  binary: (deckId: string, fileId: string) => `slides/${deckId}/source/${fileId}`,
  sourcePrefix: (deckId: string) => `slides/${deckId}/source/`,
  previewPrefix: (deckId: string, previewId: string) => `slides/${deckId}/preview/${previewId}/`,
  previewSource: (deckId: string, previewId: string) => `slides/${deckId}/preview/${previewId}/source.zip`,
  previewOutput: (deckId: string, previewId: string) => `slides/${deckId}/preview/${previewId}/output/`,
};

export const SOURCE_LIMITS = { files: 200, textBytes: 512 * 1024, binaryBytes: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, depth: 8 };

/** Files edited as text in the editor; every other allowed extension is uploaded as a binary. */
export const TEXT_EXTENSIONS = new Set([".qmd", ".md", ".css", ".scss", ".yml", ".yaml", ".bib", ".csl", ".json", ".js", ".txt", ".csv"]);
const JUNK_SEGMENTS = new Set(["__MACOSX", ".git", "node_modules", "_site", ".quarto", "_freeze"]);

export const BINARY_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

export type SourceKind = "text" | "binary";

/**
 * Validates a source path (posix, relative). Returns the normalised path and its kind; 400 otherwise.
 * Rules mirror the ZIP validator: allowed extensions only, no `..`, backslashes, NUL, `.env*`, junk dirs or `_hub/`.
 */
export function sourcePath(raw: string): { path: string; kind: SourceKind } {
  const value = raw.trim().replace(/^\.\/+/, "");
  const invalid = () => badRequest("檔案路徑不正確：請使用英數、連字號、底線與 / 組成的相對路徑。");
  if (!value || value.length > 200 || /[\\\0\r\n]/.test(value) || value.startsWith("/")) throw invalid();
  const parts = value.split("/");
  if (parts.length > SOURCE_LIMITS.depth || parts.some(part => !part || part === "." || part === ".." || part.length > 80)) throw invalid();
  if (!parts.every(part => /^[\p{L}\p{N}._ -]+$/u.test(part)) || parts.some(part => part.startsWith(" ") || part.endsWith(" "))) throw invalid();
  if (parts.some(part => JUNK_SEGMENTS.has(part)) || parts[0] === "_hub" || parts.some(part => part.toLowerCase().startsWith(".env"))) throw invalid();
  const extension = path.posix.extname(value).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw badRequest(`不支援的檔案類型：${extension || "（無副檔名）"}`);
  return { path: value, kind: TEXT_EXTENSIONS.has(extension) ? "text" : "binary" };
}

export type SourceTree = {
  deck_id: string;
  entry: string;
  origin: string;
  revision: number;
  published_revision: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type SourceFile = {
  id: string;
  path: string;
  kind: SourceKind;
  bytes: number;
  content_type: string | null;
  version: number;
  updated_by: string | null;
  updated_at: string;
  updated_by_name?: string | null;
  content?: string;
};

const FILE_COLUMNS = "f.id,f.path,f.kind,f.bytes,f.content_type,f.version,f.updated_by,f.updated_at";

export async function loadTree(db: Queryable, deckId: string, forUpdate = false): Promise<SourceTree | null> {
  const result = await db.query<SourceTree>(
    `SELECT deck_id,entry,origin,revision,published_revision,created_by,updated_by,created_at,updated_at FROM deck_source_trees WHERE deck_id=$1${forUpdate ? " FOR UPDATE" : ""}`,
    [deckId],
  );
  return result.rows[0] ?? null;
}

export async function requireTree(db: Queryable, deckId: string, forUpdate = false) {
  const tree = await loadTree(db, deckId, forUpdate);
  if (!tree) throw notFound("這份簡報還沒有平台內的原始檔。");
  return tree;
}

/** Files of a tree, sorted by path. `withContent` includes text contents (binaries never). */
export async function listFiles(db: Queryable, deckId: string, withContent = true): Promise<SourceFile[]> {
  const result = await db.query<SourceFile>(
    `SELECT ${FILE_COLUMNS}${withContent ? ",f.content" : ""},u.name AS updated_by_name FROM deck_sources f LEFT JOIN users u ON u.id=f.updated_by
      WHERE f.deck_id=$1 ORDER BY f.path`,
    [deckId],
  );
  return result.rows.map(row => {
    if (row.content === null || row.content === undefined) delete row.content;
    return row;
  });
}

export async function fileById(db: Queryable, deckId: string, fileId: string, forUpdate = false): Promise<(SourceFile & { s3_key: string | null; content: string | null }) | null> {
  const result = await db.query<SourceFile & { s3_key: string | null; content: string | null }>(
    `SELECT ${FILE_COLUMNS},f.content,f.s3_key FROM deck_sources f WHERE f.deck_id=$1 AND f.id=$2${forUpdate ? " FOR UPDATE" : ""}`,
    [deckId, fileId],
  );
  return result.rows[0] ?? null;
}

/** Bumps the tree revision (call inside the transaction of every file change). */
export async function touchTree(client: Queryable, deckId: string, userId: string) {
  const row = (await client.query<{ revision: number }>(
    "UPDATE deck_source_trees SET revision=revision+1,updated_by=$2,updated_at=now() WHERE deck_id=$1 RETURNING revision",
    [deckId, userId],
  )).rows[0];
  if (!row) throw notFound("這份簡報還沒有平台內的原始檔。");
  await client.query("UPDATE decks SET updated_at=now(),updated_by=$2 WHERE id=$1", [deckId, userId]);
  return row.revision;
}

/** Creates the tree with its first text files (the deck row must exist and have no tree yet). */
export async function createTree(client: Queryable, deckId: string, userId: string, origin: string, files: { path: string; content: string }[], entry = "index.qmd") {
  await client.query(
    "INSERT INTO deck_source_trees(deck_id,entry,origin,created_by,updated_by) VALUES($1,$2,$3,$4,$4)",
    [deckId, entry, origin, userId],
  );
  for (const file of files) await insertText(client, deckId, sourcePath(file.path).path, file.content, userId);
}

async function insertText(client: Queryable, deckId: string, filePath: string, content: string, userId: string) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > SOURCE_LIMITS.textBytes) throw new HttpError(413, `文字檔不可超過 ${SOURCE_LIMITS.textBytes / 1024} KB。`);
  return (await client.query<SourceFile>(
    `INSERT INTO deck_sources AS f(deck_id,path,kind,content,bytes,content_type,updated_by) VALUES($1,$2,'text',$3,$4,'text/plain',$5)
     RETURNING ${FILE_COLUMNS}`,
    [deckId, filePath, content, bytes, userId],
  )).rows[0]!;
}

async function checkQuota(client: Queryable, deckId: string, addBytes: number, replacingId?: string) {
  const usage = (await client.query<{ files: number; bytes: string }>(
    "SELECT count(*)::int AS files, COALESCE(sum(bytes),0)::bigint AS bytes FROM deck_sources WHERE deck_id=$1 AND ($2::uuid IS NULL OR id<>$2)",
    [deckId, replacingId ?? null],
  )).rows[0]!;
  if (usage.files + 1 > SOURCE_LIMITS.files) throw badRequest(`最多 ${SOURCE_LIMITS.files} 個檔案。`);
  if (Number(usage.bytes) + addBytes > SOURCE_LIMITS.totalBytes) throw new HttpError(413, `原始檔總大小不可超過 ${SOURCE_LIMITS.totalBytes / 1024 / 1024} MB。`);
}

/**
 * Creates or replaces a text file at `path`. `baseVersion` (the version the editor loaded) guards against
 * overwriting someone else's save: a mismatch is 409. Returns the file (without content) and the new revision.
 */
export async function saveText(client: Queryable, deckId: string, rawPath: string, content: string, userId: string, baseVersion?: number) {
  const { path: filePath, kind } = sourcePath(rawPath);
  if (kind !== "text") throw badRequest("這個檔案類型請以上傳方式加入。");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > SOURCE_LIMITS.textBytes) throw new HttpError(413, `文字檔不可超過 ${SOURCE_LIMITS.textBytes / 1024} KB。`);
  const existing = (await client.query<{ id: string; kind: SourceKind; version: number; content: string | null }>(
    "SELECT id,kind,version,content FROM deck_sources WHERE deck_id=$1 AND path=$2 FOR UPDATE",
    [deckId, filePath],
  )).rows[0];
  let file: SourceFile;
  if (existing) {
    if (existing.kind !== "text") throw conflict("同名的檔案已存在。");
    if (baseVersion !== undefined && baseVersion !== existing.version) throw conflict("檔案已被其他人修改，請重新載入後再儲存。");
    if (existing.content === content) {
      const tree = await requireTree(client, deckId);
      return { file: (await fileById(client, deckId, existing.id))!, revision: tree.revision, changed: false };
    }
    await checkQuota(client, deckId, bytes, existing.id);
    file = (await client.query<SourceFile>(
      `UPDATE deck_sources AS f SET content=$2,bytes=$3,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING ${FILE_COLUMNS}`,
      [existing.id, content, bytes, userId],
    )).rows[0]!;
  } else {
    if (baseVersion !== undefined && baseVersion > 0) throw conflict("檔案已被其他人刪除或改名，請重新載入。");
    await checkQuota(client, deckId, bytes);
    file = await insertText(client, deckId, filePath, content, userId);
  }
  return { file, revision: await touchTree(client, deckId, userId), changed: true };
}

/** Records an uploaded binary (already stored at `s3Key`) at `path`, replacing a binary with the same path. Returns the replaced S3 key for cleanup. */
export async function saveBinary(client: Queryable, deckId: string, fileId: string, filePath: string, s3Key: string, bytes: number, contentType: string, userId: string) {
  if (bytes > SOURCE_LIMITS.binaryBytes) throw new HttpError(413, `檔案不可超過 ${SOURCE_LIMITS.binaryBytes / 1024 / 1024} MB。`);
  const existing = (await client.query<{ id: string; kind: SourceKind; s3_key: string | null }>(
    "SELECT id,kind,s3_key FROM deck_sources WHERE deck_id=$1 AND path=$2 FOR UPDATE",
    [deckId, filePath],
  )).rows[0];
  if (existing && existing.kind !== "binary") throw conflict("同名的檔案已存在。");
  await checkQuota(client, deckId, bytes, existing?.id);
  if (existing) await client.query("DELETE FROM deck_sources WHERE id=$1", [existing.id]);
  const file = (await client.query<SourceFile>(
    `INSERT INTO deck_sources AS f(id,deck_id,path,kind,s3_key,bytes,content_type,updated_by,version) VALUES($1,$2,$3,'binary',$4,$5,$6,$7,$8)
     RETURNING ${FILE_COLUMNS}`,
    [fileId, deckId, filePath, s3Key, bytes, contentType, userId, 1],
  )).rows[0]!;
  return { file, replacedKey: existing?.s3_key ?? null, revision: await touchTree(client, deckId, userId) };
}

/** Packs the tree into a ZIP (text from the DB, binaries from S3). Throws 400 when the entry file is missing. */
export async function packTree(db: Queryable, storage: Storage, deckId: string): Promise<{ zip: Buffer; tree: SourceTree; fileCount: number }> {
  const tree = await requireTree(db, deckId);
  const files = (await db.query<{ path: string; kind: SourceKind; content: string | null; s3_key: string | null }>(
    "SELECT path,kind,content,s3_key FROM deck_sources WHERE deck_id=$1 ORDER BY path",
    [deckId],
  )).rows;
  if (!files.some(file => file.path === tree.entry)) throw badRequest(`找不到入口檔 ${tree.entry}。`);
  const entries = [];
  for (const file of files) {
    if (file.kind === "text") entries.push({ path: file.path, data: Buffer.from(file.content ?? "", "utf8") });
    else {
      const data = file.s3_key ? await storage.getBuffer(file.s3_key) : null;
      if (!data) throw new HttpError(500, `檔案 ${file.path} 遺失，請重新上傳。`);
      entries.push({ path: file.path, data });
    }
  }
  return { zip: writeZip(entries), tree, fileCount: entries.length };
}
