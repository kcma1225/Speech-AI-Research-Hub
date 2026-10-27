/**
 * 「從這個版本建立新版本」: the in-app source tree becomes the files of an earlier Quarto version (its stored source ZIP)
 * as a new revision. The versions themselves are untouched, so nothing is lost: the deck then has unpublished changes the
 * user edits or publishes as the next version.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import yauzl from "yauzl";
import { transaction, type Db } from "../../db.js";
import { badRequest, HttpError, notFound } from "../http.js";
import { keys, type Storage } from "../storage.js";
import { deleteSuggestionsOf } from "../suggestions/service.js";
import { BINARY_CONTENT_TYPES, SOURCE_LIMITS, sourceKeys, sourcePath, touchTree, type SourceKind } from "./sources.js";

type Entry = { path: string; kind: SourceKind; data: Buffer };

/** Reads the ZIP's files (directories skipped); paths the tree does not accept are skipped and reported. */
async function readZip(zip: Buffer): Promise<{ files: Entry[]; skipped: string[] }> {
  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(zip, { lazyEntries: true, validateEntrySizes: true }, (e, z) => (e || !z ? reject(e ?? new Error("zip")) : resolve(z))));
  const files: Entry[] = [];
  const skipped: string[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    zipfile.on("error", reject);
    zipfile.on("end", () => resolve());
    zipfile.on("entry", (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) return zipfile.readEntry();
      let target: { path: string; kind: SourceKind };
      try {
        target = sourcePath(entry.fileName);
      } catch {
        skipped.push(entry.fileName);
        return zipfile.readEntry();
      }
      const limit = target.kind === "text" ? SOURCE_LIMITS.textBytes : SOURCE_LIMITS.binaryBytes;
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > limit || total > SOURCE_LIMITS.totalBytes || files.length >= SOURCE_LIMITS.files) {
        zipfile.close();
        return reject(new HttpError(413, "這個版本的原始檔超過平台內編輯的大小限制，無法還原。"));
      }
      zipfile.openReadStream(entry, (e, stream) => {
        if (e || !stream) return reject(e ?? new Error("zip entry"));
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => {
          files.push({ ...target, data: Buffer.concat(chunks) });
          zipfile.readEntry();
        });
      });
    });
    zipfile.readEntry();
  });
  return { files, skipped };
}

export async function restoreVersionSource(db: Db, storage: Storage, deckId: string, versionId: string, userId: string): Promise<{ revision: number; version: number; skipped: string[] }> {
  const v = (await db.query<{ version: number; source_type: string; entry_qmd: string | null; status: string }>(
    "SELECT version, source_type, entry_qmd, status FROM slide_versions WHERE id=$1 AND deck_id=$2",
    [versionId, deckId],
  )).rows[0];
  if (!v) throw notFound("版本不存在。");
  if (v.source_type !== "quarto") throw badRequest("只有 Quarto 版本可以拿來建立新版本；PDF／PPTX 版本請改用「設為目前版本」。");
  if (v.status !== "published" && v.status !== "review") throw badRequest("這個版本沒有轉換成功，不能拿來建立新版本。");
  const zip = await storage.getBuffer(keys.slideSource(deckId, versionId, "zip"));
  if (!zip) throw notFound("這個版本的原始檔不見了。");
  const { files, skipped } = await readZip(zip);
  const entry = v.entry_qmd && files.some((f) => f.path === v.entry_qmd) ? v.entry_qmd : files.find((f) => f.path.endsWith(".qmd"))?.path;
  if (!entry) throw badRequest("這個版本的原始檔沒有 .qmd 檔。");
  // Binaries go to S3 first under new ids; the rows switch in one transaction; the old objects are removed after it.
  const uploaded: { id: string; key: string; file: Entry }[] = [];
  try {
    for (const file of files.filter((f) => f.kind === "binary")) {
      const id = randomUUID();
      const key = sourceKeys.binary(deckId, id);
      await storage.put(key, file.data, BINARY_CONTENT_TYPES[path.posix.extname(file.path).toLowerCase()] ?? "application/octet-stream");
      uploaded.push({ id, key, file });
    }
    const out = await transaction(db, async (client) => {
      await client.query("SELECT 1 FROM decks WHERE id=$1 FOR UPDATE", [deckId]);
      const tree = (await client.query("SELECT 1 FROM deck_source_trees WHERE deck_id=$1 FOR UPDATE", [deckId])).rowCount;
      if (!tree) await client.query("INSERT INTO deck_source_trees(deck_id,entry,origin,created_by,updated_by) VALUES($1,$2,'version',$3,$3)", [deckId, entry, userId]);
      // Text files at the same path keep their row (id = suggestion target, version bumped so an open editor reloads);
      // everything else is replaced, with the suggestions on removed files.
      const texts = new Map(files.filter((x) => x.kind === "text").map((x) => [x.path, x.data.toString("utf8")]));
      const current = (await client.query<{ id: string; path: string; kind: SourceKind; content: string | null; s3_key: string | null }>("SELECT id,path,kind,content,s3_key FROM deck_sources WHERE deck_id=$1 FOR UPDATE", [deckId])).rows;
      const oldKeys: string[] = [];
      for (const row of current) {
        const content = row.kind === "text" ? texts.get(row.path) : undefined;
        if (content !== undefined) {
          texts.delete(row.path);
          if (content !== row.content) await client.query("UPDATE deck_sources SET content=$2,bytes=$3,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1", [row.id, content, Buffer.byteLength(content, "utf8"), userId]);
          continue;
        }
        await client.query("DELETE FROM deck_sources WHERE id=$1", [row.id]);
        await deleteSuggestionsOf(client, "deck_source", row.id);
        if (row.s3_key) oldKeys.push(row.s3_key);
      }
      for (const [filePath, content] of texts) {
        await client.query("INSERT INTO deck_sources(deck_id,path,kind,content,bytes,content_type,updated_by) VALUES($1,$2,'text',$3,$4,'text/plain',$5)", [deckId, filePath, content, Buffer.byteLength(content, "utf8"), userId]);
      }
      for (const u of uploaded) {
        await client.query(
          "INSERT INTO deck_sources(id,deck_id,path,kind,s3_key,bytes,content_type,updated_by,version) VALUES($1,$2,$3,'binary',$4,$5,$6,$7,1)",
          [u.id, deckId, u.file.path, u.key, u.file.data.length, BINARY_CONTENT_TYPES[path.posix.extname(u.file.path).toLowerCase()] ?? "application/octet-stream", userId],
        );
      }
      await client.query("UPDATE deck_source_trees SET entry=$2 WHERE deck_id=$1", [deckId, entry]);
      return { revision: await touchTree(client, deckId, userId), oldKeys };
    });
    for (const key of out.oldKeys) await storage.delete(key).catch(() => {});
    return { revision: out.revision, version: v.version, skipped };
  } catch (error) {
    for (const u of uploaded) await storage.delete(u.key).catch(() => {});
    throw error;
  }
}
