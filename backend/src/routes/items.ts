import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { cancelJob } from "../jobs/queue.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, idParams, parse } from "../lib/http.js";
import { markdownExcerpt } from "../lib/notes/excerpt.js";
import { activeMediaJob, escapeLike, itemAudioPrefix, isoDate, itemNotFound, requireNoteWriter } from "../lib/notes/items.js";
import { parseSrt } from "../lib/notes/srt.js";
import { NO_TAG, noteTags, ownerTags, setOwnerTags, tagIds, type Tag } from "../lib/notes/tag-store.js";

const MAX_SRT_BYTES = 5 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({
  tags: z.string().max(4000).optional(),
  q: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});
const createInput = z.object({
  title: z.string().trim().min(1).max(200),
  event_date: isoDate.optional(),
  content: z.string().max(2_000_000).default(""),
  tagIds: tagIds.default([]),
});
const updateInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(2_000_000).optional(),
  event_date: isoDate.optional(),
}).refine(value => Object.values(value).some(field => field !== undefined));
const tagsInput = z.object({ tagIds });

type Cursor = [eventDate: string, createdAt: string, id: string];
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every(part => typeof part === "string") && isoDate.safeParse(parsed[0]).success && uuidPattern.test(String(parsed[2]))) {
      return parsed as Cursor;
    }
  } catch {}
  throw badRequest("分頁參數不正確。");
}

type ListRow = {
  id: string; title: string; content: string; event_date: string; created_at_key: string; updated_at: string;
  audio_name: string | null; has_audio: boolean; has_transcript: boolean; tags: Tag[];
  created_by_name: string | null; updated_by_name: string | null;
};

type DetailRow = {
  id: string; title: string; content: string; event_date: string; created_at: string; updated_at: string;
  created_by: string; created_by_name: string | null; updated_by: string; updated_by_name: string | null;
  audio_key: string | null; audio_name: string | null; audio_bytes: string | null; audio_duration_seconds: number | null;
  transcript: unknown; transcript_name: string | null;
};

const routes: FastifyPluginAsync = async app => {
  app.get("/items", async (request, reply) => {
    await requireUser(request);
    const query = parse(listQuery, request.query);
    const search = (query.q ?? "").trim().slice(0, 200);
    // Omitted `tags` = every option selected; empty = none; `none` = untagged notes.
    const selected = query.tags === undefined ? null : query.tags.split(",").filter(value => value === NO_TAG || uuidPattern.test(value));
    const ids = selected?.filter(value => value !== NO_TAG) ?? [];
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const result = await app.db.query<ListRow>(
      `SELECT i.id,i.title,left(i.content,4000) AS content,to_char(i.event_date,'YYYY-MM-DD') AS event_date,
              i.created_at::text AS created_at_key,i.updated_at,i.audio_name,
              (i.audio_key IS NOT NULL) AS has_audio,(i.transcript IS NOT NULL) AS has_transcript,
              cu.name AS created_by_name,uu.name AS updated_by_name,
              COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name) ORDER BY lower(t.name))
                          FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id),'[]') AS tags
         FROM items i
         LEFT JOIN users cu ON cu.id=i.created_by
         LEFT JOIN users uu ON uu.id=i.updated_by
        WHERE ($1='' OR i.title ILIKE $1 OR i.content ILIKE $1)
          AND ($2::boolean
               OR EXISTS (SELECT 1 FROM item_tags x WHERE x.item_id=i.id AND x.tag_id=ANY($3::uuid[]))
               OR ($4::boolean AND NOT EXISTS (SELECT 1 FROM item_tags x WHERE x.item_id=i.id)))
          AND ($5::date IS NULL OR (i.event_date,i.created_at,i.id) < ($5::date,$6::timestamptz,$7::uuid))
        ORDER BY i.event_date DESC,i.created_at DESC,i.id DESC
        LIMIT $8`,
      [search ? `%${escapeLike(search)}%` : "", selected === null, ids, selected?.includes(NO_TAG) ?? true,
        cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, query.limit + 1],
    );
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const items = rows.map(row => ({
      id: row.id,
      title: row.title,
      excerpt: markdownExcerpt(row.content) || row.audio_name || "",
      event_date: row.event_date,
      tags: row.tags,
      has_audio: row.has_audio,
      has_transcript: row.has_transcript,
      updated_at: row.updated_at,
      created_by_name: row.created_by_name,
      updated_by_name: row.updated_by_name,
    }));
    const nextCursor = result.rows.length > query.limit && last ? encodeCursor([last.event_date, last.created_at_key, last.id]) : null;
    return reply.header("Cache-Control", "no-store").send({ items, nextCursor });
  });

  app.get("/items/:id", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    const row = (await app.db.query<DetailRow>(
      `SELECT i.id,i.title,i.content,to_char(i.event_date,'YYYY-MM-DD') AS event_date,i.created_at,i.updated_at,
              i.created_by,cu.name AS created_by_name,i.updated_by,uu.name AS updated_by_name,
              i.audio_key,i.audio_name,i.audio_bytes,i.audio_duration_seconds,i.transcript,i.transcript_name
         FROM items i LEFT JOIN users cu ON cu.id=i.created_by LEFT JOIN users uu ON uu.id=i.updated_by
        WHERE i.id=$1`,
      [id],
    )).rows[0];
    if (!row) throw itemNotFound();
    const [tags, mediaJob] = await Promise.all([ownerTags(app.db, noteTags, id), activeMediaJob(app.db, id)]);
    const item = {
      id: row.id,
      title: row.title,
      content: row.content,
      event_date: row.event_date,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: { id: row.created_by, name: row.created_by_name },
      updated_by: { id: row.updated_by, name: row.updated_by_name },
      tags,
      audio: row.audio_key
        ? { name: row.audio_name, bytes: row.audio_bytes === null ? null : Number(row.audio_bytes), duration_seconds: row.audio_duration_seconds, url: `/api/media/${row.id}` }
        : null,
      transcript: row.transcript ?? null,
      transcript_name: row.transcript_name,
      media_job: mediaJob,
    };
    return reply.header("Cache-Control", "no-store").send({ item });
  });

  app.post("/items", async (request, reply) => {
    const user = await requireNoteWriter(request);
    const input = parse(createInput, request.body, "請輸入筆記名稱。");
    const id = await transaction(app.db, async client => {
      const itemId = (await client.query<{ id: string }>(
        `INSERT INTO items(title,content,event_date,created_by,updated_by)
         VALUES($1,$2,COALESCE($3::date,(now() AT TIME ZONE 'Asia/Taipei')::date),$4,$4) RETURNING id`,
        [input.title, input.content, input.event_date ?? null, user.id],
      )).rows[0]!.id;
      await setOwnerTags(client, noteTags, itemId, input.tagIds);
      return itemId;
    });
    return reply.code(201).send({ id });
  });

  app.patch("/items/:id", async request => {
    const user = await requireNoteWriter(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    const input = parse(updateInput, request.body);
    const result = await app.db.query(
      `UPDATE items SET title=COALESCE($1,title),content=COALESCE($2,content),event_date=COALESCE($3::date,event_date),
              updated_by=$4,updated_at=now() WHERE id=$5`,
      [input.title ?? null, input.content ?? null, input.event_date ?? null, user.id, id],
    );
    if (!result.rowCount) throw itemNotFound();
    return { ok: true };
  });

  app.delete("/items/:id", async request => {
    await requireNoteWriter(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    const deleted = await transaction(app.db, async client => {
      const item = await client.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [id]);
      if (!item.rowCount) return false;
      const jobs = await client.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='media_transcode' AND status IN ('queued','running') AND payload->>'itemId'=$1",
        [id],
      );
      // Cancelled jobs clean their own uploads in the media finalizer.
      for (const job of jobs.rows) await cancelJob(client, job.id);
      await client.query("DELETE FROM items WHERE id=$1", [id]);
      return true;
    });
    if (!deleted) throw itemNotFound();
    await app.storage.deletePrefix(itemAudioPrefix(id)).catch(error => request.log.warn({ err: error, itemId: id }, "failed to delete item audio"));
    return { ok: true };
  });

  app.put("/items/:id/tags", async request => {
    const user = await requireNoteWriter(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    const input = parse(tagsInput, request.body, "標籤資料不正確。");
    const tags = await transaction(app.db, async client => {
      const item = await client.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [id]);
      if (!item.rowCount) return null;
      await setOwnerTags(client, noteTags, id, input.tagIds);
      await client.query("UPDATE items SET updated_by=$1,updated_at=now() WHERE id=$2", [user.id, id]);
      return ownerTags(client, noteTags, id);
    });
    if (!tags) throw itemNotFound();
    return { tags };
  });

  app.post("/items/:id/transcript", async request => {
    const user = await requireNoteWriter(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    if (!request.isMultipart()) throw badRequest("請選擇 SRT 逐字稿。");
    const file = await request.file({ limits: { fileSize: MAX_SRT_BYTES }, throwFileSizeLimit: false });
    if (!file) throw badRequest("請選擇 SRT 逐字稿。");
    if (!/\.srt$/i.test(file.filename)) {
      file.file.resume();
      throw new HttpError(415, "逐字稿須為 .srt 檔。");
    }
    const buffer = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, "逐字稿不得超過 5 MB。");
    if (!buffer.length) throw badRequest("請選擇 SRT 逐字稿。");
    const cues = parseSrt(buffer.toString("utf8"));
    if (!cues.length) throw new HttpError(422, "無法解析 SRT 內容，請確認格式。");
    const exists = await app.db.query("SELECT 1 FROM items WHERE id=$1", [id]);
    if (!exists.rowCount) throw itemNotFound();
    const result = await app.db.query(
      "UPDATE items SET transcript=$1,transcript_name=$2,updated_by=$3,updated_at=now() WHERE id=$4 AND audio_key IS NOT NULL RETURNING id",
      [JSON.stringify(cues), file.filename.slice(0, 200), user.id, id],
    );
    if (!result.rowCount) throw conflict("此筆記沒有錄音檔，無法加入逐字稿。");
    return { ok: true, count: cues.length };
  });

  app.delete("/items/:id/transcript", async request => {
    const user = await requireNoteWriter(request);
    const { id } = parse(idParams, request.params, "筆記不存在。");
    const result = await app.db.query(
      "UPDATE items SET transcript=NULL,transcript_name=NULL,updated_by=$1,updated_at=now() WHERE id=$2",
      [user.id, id],
    );
    if (!result.rowCount) throw itemNotFound();
    return { ok: true };
  });
};

export default routes;

