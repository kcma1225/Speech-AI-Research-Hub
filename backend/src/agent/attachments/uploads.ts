/**
 * Files uploaded into an assistant conversation: documents go through the doc-import pipeline (extension allow list +
 * Magika content check + extraction to Markdown, cached in `agent_uploads.text_md`); images (PNG/JPEG/WebP, checked
 * by Magika, never by the client's type) are kept for vision models. Bytes live under the conversation's `agent/`
 * prefix, so deleting the conversation removes them.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Queryable } from "../../db.js";
import { detectContentType, DOC_IMPORT_ACCEPT, DOC_IMPORT_MAX_BYTES, importDocument, describeLabel } from "../../lib/doc-import/index.js";
import { HttpError } from "../../lib/http.js";

export const UPLOAD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = DOC_IMPORT_MAX_BYTES;
export const UPLOADS_PER_CONVERSATION = 50;
const IMAGE_TYPES: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
};
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const UPLOAD_ACCEPT = `${DOC_IMPORT_ACCEPT},.png,.jpg,.jpeg,.webp`;

export const uploadKey = (conversationId: string, uploadId: string, ext: string) => `agent/${conversationId}/uploads/${uploadId}.${ext}`;

export type UploadRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  kind: "document" | "image";
  filename: string;
  format: string;
  mime: string;
  bytes: string | number;
  sha256: string;
  object_key: string;
  text_md: string | null;
  chars: number;
  truncated: boolean;
  pages: number | null;
  detected: { label?: string; score?: number };
  warnings: string[];
  created_at: string;
};

export const uploadUrl = (id: string) => `/api/agent/uploads/${id}`;

export const uploadView = (r: UploadRow) => ({
  id: r.id,
  kind: "upload" as const,
  title: r.filename,
  upload_kind: r.kind,
  format: r.format,
  mime: r.mime,
  bytes: Number(r.bytes),
  chars: r.chars,
  truncated: r.truncated,
  pages: r.pages,
  warnings: r.warnings,
  url: uploadUrl(r.id),
  created_at: r.created_at,
});

const cleanName = (name: string) => (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255) || "file";

export type ValidatedUpload =
  | { kind: "image"; format: string; mime: string; ext: string; detected: { label: string; score: number } }
  | { kind: "document"; format: string; mime: string; ext: string; detected: { label: string; score: number }; text: string; chars: number; truncated: boolean; pages: number | null; warnings: string[] };

/**
 * Validates one file: image extensions must be a PNG/JPEG/WebP by content (Magika); everything else must pass the
 * doc-import rules (allow list, Magika label of that format, size, extractable text). Throws 413/415/422 with `code`.
 */
export async function validateUpload(bytes: Uint8Array, filename: string): Promise<ValidatedUpload> {
  const name = cleanName(filename);
  if (!bytes.byteLength) throw new HttpError(422, "檔案是空的。", { code: "empty" });
  if (IMAGE_EXT.test(name)) {
    if (bytes.byteLength > UPLOAD_IMAGE_MAX_BYTES) throw new HttpError(413, "圖片超過 10 MB。", { code: "too_large" });
    const detected = await detectContentType(bytes);
    const type = IMAGE_TYPES[detected.label];
    if (!type) throw new HttpError(415, "檔案內容與副檔名不符。", { code: "content_mismatch", hint: `偵測到：${describeLabel(detected.label)}` });
    return { kind: "image", format: detected.label, mime: type.mime, ext: type.ext, detected: { label: detected.label, score: detected.score } };
  }
  const doc = await importDocument(bytes, name);
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "bin").toLowerCase();
  return {
    kind: "document",
    format: doc.format,
    mime: "application/octet-stream",
    ext,
    detected: doc.detected,
    text: doc.markdown,
    chars: doc.chars,
    truncated: doc.truncated,
    pages: doc.pages ?? null,
    warnings: doc.warnings,
  };
}

/** Validates, stores and records an upload of `userId` in their conversation. */
export async function storeUpload(app: FastifyInstance, userId: string, conversationId: string, file: { name: string; bytes: Buffer }): Promise<UploadRow> {
  const count = (await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_uploads WHERE conversation_id=$1", [conversationId])).rows[0]!.n;
  if (count >= UPLOADS_PER_CONVERSATION) throw new HttpError(409, `一個對話最多上傳 ${UPLOADS_PER_CONVERSATION} 個檔案。`, { code: "too_many" });
  const checked = await validateUpload(file.bytes, file.name);
  const id = randomUUID();
  const key = uploadKey(conversationId, id, checked.ext);
  await app.storage.put(key, file.bytes, checked.kind === "image" ? checked.mime : "application/octet-stream");
  try {
    return (await app.db.query<UploadRow>(
      `INSERT INTO agent_uploads(id,conversation_id,user_id,kind,filename,format,mime,bytes,sha256,object_key,text_md,chars,truncated,pages,detected,warnings)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        id, conversationId, userId, checked.kind, cleanName(file.name), checked.format, checked.mime, file.bytes.length,
        createHash("sha256").update(file.bytes).digest("hex"), key,
        checked.kind === "document" ? checked.text : null, checked.kind === "document" ? checked.chars : 0,
        checked.kind === "document" ? checked.truncated : false, checked.kind === "document" ? checked.pages : null,
        JSON.stringify(checked.detected), JSON.stringify(checked.kind === "document" ? checked.warnings : []),
      ],
    )).rows[0]!;
  } catch (e) {
    await app.storage.delete(key).catch(() => undefined);
    throw e;
  }
}

/** An upload of the caller's own conversation (null otherwise). */
export async function ownUpload(db: Queryable, userId: string, id: string, conversationId?: string | null): Promise<UploadRow | null> {
  return (await db.query<UploadRow>(
    "SELECT u.* FROM agent_uploads u JOIN conversations c ON c.id=u.conversation_id WHERE u.id=$1 AND c.user_id=$2 AND ($3::uuid IS NULL OR u.conversation_id=$3)",
    [id, userId, conversationId ?? null],
  )).rows[0] ?? null;
}
