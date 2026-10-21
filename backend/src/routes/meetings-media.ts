import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { cancelJob } from "../jobs/queue.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, notFound, parse } from "../lib/http.js";
import type { StoredObject } from "../lib/storage.js";
import { meetingKeys } from "../lib/meetings/keys.js";
import {
  assembleRecording, CHUNK_MAX_BYTES, enqueueTranscode, isMediaFile, MAX_PARTS, MAX_SEQ, mayKeepVideo, MEDIA_EXTENSIONS,
} from "../lib/meetings/media.js";
import { mediaView, refreshStatus, requireMeeting, requireMeetingEditor, type MediaRow } from "../lib/meetings/store.js";

/**
 * Meeting media (child plugin of meetings.ts): file uploads (audio/video → worker extracts + transcodes the audio),
 * browser recordings uploaded in ~10 s chunks (survive crashes/reloads: a reload continues in a new part), and
 * playback streams with Range support.
 */

const idParams = z.object({ id: z.uuid() });
const mediaParams = z.object({ id: z.uuid(), mediaId: z.uuid() });
const chunkParams = z.object({ id: z.uuid(), mediaId: z.uuid(), part: z.coerce.number().int().min(0).max(MAX_PARTS - 1), seq: z.coerce.number().int().min(0).max(MAX_SEQ) });
const recordingInput = z.object({ mime: z.string().trim().max(100).optional(), file_name: z.string().trim().max(200).optional() });

const AUDIO_TYPES: Record<string, string> = {
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
};

async function sendRange(reply: FastifyReply, get: () => Promise<StoredObject | null>, contentType: string) {
  let object: StoredObject | null;
  try {
    object = await get();
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) return reply.code(416).send({ error: "範圍不正確。" });
    throw error;
  }
  if (!object) throw notFound("檔案不存在。");
  reply.header("Content-Type", contentType).header("Accept-Ranges", "bytes").header("Cache-Control", "private, max-age=300").header("X-Content-Type-Options", "nosniff");
  if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
  if (object.contentRange) reply.code(206).header("Content-Range", object.contentRange);
  return reply.send(object.body);
}

async function loadMedia(app: FastifyInstance, meetingId: string, mediaId: string, forUpdate = false) {
  const m = (await app.db.query<MediaRow>(`SELECT * FROM meeting_media WHERE id=$1 AND meeting_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [mediaId, meetingId])).rows[0];
  if (!m) throw notFound("錄音不存在。");
  return m;
}

export default async function meetingMedia(app: FastifyInstance) {
  // Raw recorder chunks (PUT …/chunks/:part/:seq). Scoped to this plugin.
  for (const type of ["audio/webm", "audio/ogg", "audio/mp4", "video/webm", "application/octet-stream"]) {
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: CHUNK_MAX_BYTES }, (_request, body, done) => done(null, body));
  }

  /** Upload an audio or video file (streamed to S3). Video: the worker extracts the audio; small playable videos are kept. */
  app.post("/meetings/:id/media", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    await requireMeetingEditor(app.db, id, user);
    if (!request.isMultipart()) throw badRequest("請以表單上傳檔案。");
    const file = await request.file({ limits: { fileSize: app.config.MAX_MEDIA_BYTES, files: 1 } });
    if (!file) throw badRequest("請選擇錄音或錄影檔。");
    const fileName = (file.filename || "media").slice(0, 300);
    if (!isMediaFile(fileName)) {
      file.file.resume();
      throw badRequest(`不支援的檔案類型。請上傳 ${MEDIA_EXTENSIONS.join("、")}。`);
    }
    const mediaId = (await app.db.query<{ id: string }>(
      "INSERT INTO meeting_media(meeting_id,kind,status,file_name,mime,created_by) VALUES($1,'upload','processing',$2,$3,$4) RETURNING id",
      [id, fileName, file.mimetype?.slice(0, 100) ?? "", user.id],
    )).rows[0]!.id;
    const key = meetingKeys.mediaSource(mediaId);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await Promise.all([pipeline(file.file, counter), app.storage.put(key, counter, file.mimetype || "application/octet-stream")]);
      if (file.file.truncated) throw new HttpError(413, "檔案超過大小限制。");
      if (!bytes) throw badRequest("檔案是空的。");
    } catch (error) {
      await app.db.query("DELETE FROM meeting_media WHERE id=$1", [mediaId]);
      await app.storage.delete(key).catch(() => {});
      throw error;
    }
    await transaction(app.db, async client => {
      await client.query("SELECT 1 FROM meetings WHERE id=$1 FOR UPDATE", [id]);
      await client.query("UPDATE meeting_media SET bytes=$2 WHERE id=$1", [mediaId, bytes]);
      await enqueueTranscode(client, { id: mediaId, meeting_id: id, file_name: fileName }, [key], mayKeepVideo(fileName, bytes), user.id);
      await refreshStatus(client, id);
    });
    const media = await loadMedia(app, id, mediaId);
    return reply.code(202).send({ media: mediaView(media) });
  });

  /** Starts a browser recording; chunks follow with PUT …/chunks/:part/:seq. */
  app.post("/meetings/:id/recordings", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const input = parse(recordingInput, request.body ?? {});
    await requireMeetingEditor(app.db, id, user);
    const media = (await app.db.query<MediaRow>(
      "INSERT INTO meeting_media(meeting_id,kind,status,file_name,mime,created_by) VALUES($1,'recording','recording',$2,$3,$4) RETURNING *",
      [id, input.file_name || "網頁錄音", input.mime || "audio/webm", user.id],
    )).rows[0]!;
    await transaction(app.db, client => refreshStatus(client, id));
    return reply.code(201).send({ media: mediaView(media) });
  });

  /** Idempotent: re-sending the same part/seq overwrites it (client retries after network errors). */
  app.put("/meetings/:id/recordings/:mediaId/chunks/:part/:seq", async (request) => {
    const user = await requireUser(request);
    const { id, mediaId, part, seq } = parse(chunkParams, request.params);
    await requireMeetingEditor(app.db, id, user);
    const media = await loadMedia(app, id, mediaId);
    if (media.kind !== "recording" || media.status !== "recording") throw conflict("這段錄音已經結束。");
    const body = request.body;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest("錄音片段是空的。");
    await app.storage.put(meetingKeys.recordingChunk(id, mediaId, part, seq), body, "audio/webm");
    await app.db.query(
      `UPDATE meeting_media SET parts = jsonb_set(parts, ARRAY[$2::text], to_jsonb(GREATEST(COALESCE((parts->>$2::text)::int, -1), $3::int))),
              bytes = bytes + $4, updated_at = now() WHERE id=$1`,
      [mediaId, String(part), seq, body.length],
    );
    return { ok: true, part, seq };
  });

  /** Ends a recording: concatenates the chunks (per part) and queues the transcode. */
  app.post("/meetings/:id/recordings/:mediaId/finish", async (request, reply) => {
    const user = await requireUser(request);
    const { id, mediaId } = parse(mediaParams, request.params);
    const { duration_sec } = parse(z.object({ duration_sec: z.number().min(0).max(24 * 3600).optional() }), request.body ?? {});
    await requireMeetingEditor(app.db, id, user);
    // Claim the recording so two finish calls cannot both assemble it.
    const claimed = await app.db.query<MediaRow>("UPDATE meeting_media SET status='processing', updated_at=now() WHERE id=$1 AND meeting_id=$2 AND kind='recording' AND status='recording' RETURNING *", [mediaId, id]);
    const media = claimed.rows[0];
    if (!media) {
      await loadMedia(app, id, mediaId);
      throw conflict("這段錄音已經結束。");
    }
    const parts = Object.keys(media.parts ?? {}).map(Number).filter(n => Number.isInteger(n));
    let assembled;
    try {
      assembled = await assembleRecording(app.storage, id, mediaId, parts);
    } catch (error) {
      await app.db.query("UPDATE meeting_media SET status='recording' WHERE id=$1", [mediaId]);
      throw error;
    }
    if (!assembled.sources.length) {
      await transaction(app.db, async client => {
        await client.query("DELETE FROM meeting_media WHERE id=$1", [mediaId]);
        await refreshStatus(client, id);
      });
      throw badRequest("沒有收到任何錄音內容。");
    }
    await transaction(app.db, async client => {
      await client.query("SELECT 1 FROM meetings WHERE id=$1 FOR UPDATE", [id]);
      await client.query("UPDATE meeting_media SET bytes=$2, duration_sec=COALESCE($3,duration_sec) WHERE id=$1", [mediaId, assembled.bytes, duration_sec ?? null]);
      await enqueueTranscode(client, { id: mediaId, meeting_id: id, file_name: media.file_name }, assembled.sources, false, user.id);
      await refreshStatus(client, id);
    });
    await app.storage.deletePrefix(meetingKeys.recordingPrefix(id, mediaId)).catch(error => app.log.warn({ err: error }, "could not delete recording chunks"));
    return reply.code(202).send({ media: mediaView(await loadMedia(app, id, mediaId)) });
  });

  app.delete("/meetings/:id/media/:mediaId", async (request) => {
    const user = await requireUser(request);
    const { id, mediaId } = parse(mediaParams, request.params);
    const media = await transaction(app.db, async client => {
      await requireMeetingEditor(client, id, user, true);
      const m = (await client.query<MediaRow>("DELETE FROM meeting_media WHERE id=$1 AND meeting_id=$2 RETURNING *", [mediaId, id])).rows[0];
      if (!m) throw notFound("錄音不存在。");
      if (m.job_id) await cancelJob(client, m.job_id);
      await refreshStatus(client, id);
      return m;
    });
    for (const prefix of [meetingKeys.mediaUploadPrefix(mediaId), meetingKeys.recordingPrefix(id, mediaId)]) await app.storage.deletePrefix(prefix).catch(() => {});
    if (media.audio_key) await app.storage.delete(media.audio_key).catch(() => {});
    return { ok: true };
  });

  app.get("/meetings/:id/media/:mediaId/audio", async (request, reply) => {
    await requireUser(request);
    const { id, mediaId } = parse(mediaParams, request.params);
    await requireMeeting(app.db, id);
    const media = await loadMedia(app, id, mediaId);
    if (!media.audio_key || media.status !== "ready") throw notFound("錄音還沒處理完成。");
    return sendRange(reply, () => app.storage.get(media.audio_key!, request.headers.range), "audio/mp4");
  });

  app.get("/meetings/:id/media/:mediaId/video", async (request, reply) => {
    await requireUser(request);
    const { id, mediaId } = parse(mediaParams, request.params);
    await requireMeeting(app.db, id);
    const media = await loadMedia(app, id, mediaId);
    if (!media.video_key || media.status !== "ready") throw notFound("沒有保留影片。");
    const ext = /\.([a-z0-9]+)$/i.exec(media.file_name)?.[1]?.toLowerCase() ?? "mp4";
    return sendRange(reply, () => app.storage.get(media.video_key!, request.headers.range), AUDIO_TYPES[ext] ?? "video/mp4");
  });
}
