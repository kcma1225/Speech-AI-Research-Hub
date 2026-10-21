import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { detectContentType } from "../lib/doc-import/index.js";
import { badRequest, forbidden, HttpError, notFound, parse } from "../lib/http.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { registerStudyCleanup } from "../lib/studies/cleanup.js";
import { keys } from "../lib/storage.js";

/**
 * Images in Markdown documents (note editor, study summary): upload by button, paste or drop. The content type
 * comes from Magika (PNG, JPEG, GIF, WebP only; SVG and anything else is refused), never from the client.
 * Readers: everyone signed in (every study is readable); writers: study editors.
 */
export const MD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  gif: { mime: "image/gif", ext: "gif" },
  webp: { mime: "image/webp", ext: "webp" },
};
const scopeSchema = z.string().regex(/^(study|note):[0-9a-f-]{36}$/i, "請指定圖片所屬的研究或筆記。");
const imageParams = z.object({ id: z.uuid() });

export default async function mdImages(app: FastifyInstance) {
  registerStudyCleanup("md-images", async (_client, studyId) => async () => {
    await app.storage.deletePrefix(keys.mdImagePrefix(studyId)).catch((e) => app.log.warn({ err: e, studyId }, "md-images cleanup failed"));
  });

  app.post("/md-images", async (request, reply) => {
    const user = await requireUser(request);
    if (!request.isMultipart()) throw badRequest("請選擇圖片。");
    let scope: string | null = null;
    let file: { name: string; bytes: Buffer } | null = null;
    for await (const part of request.parts({ limits: { fileSize: MD_IMAGE_MAX_BYTES, files: 1 } })) {
      if (part.type === "field") {
        if (part.fieldname === "scope" && typeof part.value === "string") scope = part.value;
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      if (part.file.truncated) throw new HttpError(413, "圖片超過 10 MB。", { code: "too_large" });
      file = { name: (part.filename || "image").slice(0, 200), bytes: Buffer.concat(chunks) };
    }
    const target = parse(scopeSchema, scope ?? "");
    if (!file || !file.bytes.length) throw badRequest("請選擇圖片。");
    const [kind, id] = target.split(":") as ["study" | "note", string];
    let studyId: string;
    let noteId: string | null = null;
    if (kind === "note") {
      const note = (await app.db.query<{ study_id: string }>("SELECT study_id FROM notes WHERE id=$1", [id])).rows[0];
      if (!note) throw notFound("筆記不存在。");
      studyId = note.study_id;
      noteId = id;
    } else studyId = id;
    const access = await loadStudyAccess(app.db, studyId, user);
    if (!access.canEdit) throw forbidden("只有研究成員可以上傳圖片。");

    const detected = await detectContentType(file.bytes);
    const type = TYPES[detected.label];
    if (!type) throw new HttpError(415, "只能上傳 PNG、JPEG、GIF 或 WebP 圖片。", { code: "content_mismatch", hint: `偵測到：${detected.label}` });

    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    // The same picture pasted twice into one study reuses the stored copy.
    const existing = (await app.db.query<{ id: string }>("SELECT id FROM md_images WHERE study_id=$1 AND sha256=$2 LIMIT 1", [access.study.id, sha256])).rows[0];
    if (existing) return reply.code(200).send({ image: { id: existing.id, url: `/api/md-images/${existing.id}` } });

    const imageId = randomUUID();
    const objectKey = keys.mdImage(access.study.id, imageId, type.ext);
    await app.storage.put(objectKey, file.bytes, type.mime);
    try {
      await app.db.query(
        "INSERT INTO md_images(id,study_id,note_id,object_key,mime,bytes,sha256,original_name,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [imageId, access.study.id, noteId, objectKey, type.mime, file.bytes.length, sha256, file.name, user.id],
      );
    } catch (e) {
      await app.storage.delete(objectKey).catch(() => {});
      throw e;
    }
    return reply.code(201).send({ image: { id: imageId, url: `/api/md-images/${imageId}` } });
  });

  app.get("/md-images/:id", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(imageParams, request.params);
    const row = (await app.db.query<{ object_key: string; mime: string; bytes: number }>("SELECT object_key, mime, bytes FROM md_images WHERE id=$1", [id])).rows[0];
    if (!row) throw notFound("圖片不存在。");
    const object = await app.storage.get(row.object_key);
    if (!object) throw notFound("圖片不存在。");
    return reply
      .header("Content-Type", row.mime)
      .header("Content-Length", String(object.contentLength ?? row.bytes))
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Content-Disposition", "inline")
      .send(object.body);
  });
}
