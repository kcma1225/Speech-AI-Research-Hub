import { randomUUID } from "node:crypto";
import { Transform, pipeline } from "node:stream";
import type { FastifyPluginAsync } from "fastify";
import { transaction } from "../db.js";
import { registerMediaFinalizer } from "../jobs/media-finalizer.js";
import { cancelJob, enqueueJob, type JobStatus } from "../jobs/queue.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, HttpError, idParams, notFound, parse } from "../lib/http.js";
import { itemNotFound, requireNoteWriter } from "../lib/notes/items.js";
import { keys } from "../lib/storage.js";

const MEDIA_EXTENSIONS = /\.(mp4|m4a|mov|webm|mkv|mp3|wav|aac|ogg|opus|flac)$/i;
const jobNotFound = () => notFound("找不到處理工作。");

type JobRow = {
  id: string; item_id: string; status: JobStatus; stage: string; progress: number;
  duration_seconds: number | null; error: string | null; file_name: string; created_at: string; created_by: string | null;
};

const JOB_COLUMNS = `id,payload->>'itemId' AS item_id,status,stage,progress,(result->>'durationSeconds')::double precision AS duration_seconds,
  error,payload->>'fileName' AS file_name,created_at,created_by`;

/** v1-compatible status names for the media job center. */
const publicStatus = (status: JobStatus) =>
  status === "queued" || status === "running" ? "processing" : status === "succeeded" ? "completed" : status;

const presentJob = ({ created_by: _, ...job }: JobRow) => ({ ...job, status: publicStatus(job.status) });

const routes: FastifyPluginAsync = async app => {
  registerMediaFinalizer(app);
  const maxBytes = app.config.MAX_MEDIA_BYTES;
  const maxLabel = `${Math.floor(maxBytes / 1024 / 1024)} MB`;

  app.post("/items/:id/media", async (request, reply) => {
    const user = await requireNoteWriter(request);
    const { id: itemId } = parse(idParams, request.params, "筆記不存在。");
    if (!request.isMultipart()) throw badRequest("請選擇媒體檔。");
    const exists = await app.db.query("SELECT 1 FROM items WHERE id=$1", [itemId]);
    if (!exists.rowCount) throw itemNotFound();

    const file = await request.file({ limits: { fileSize: maxBytes }, throwFileSizeLimit: false });
    if (!file) throw badRequest("上傳中斷，請重新選擇檔案。");
    if (!(/^(audio|video)\//.test(file.mimetype) || MEDIA_EXTENSIONS.test(file.filename))) {
      file.file.resume();
      throw new HttpError(415, "請上傳影音檔。");
    }

    // The S3 key uses a fresh upload id; the job id is assigned by the database when enqueued.
    const uploadId = randomUUID();
    const sourceKey = keys.mediaUpload(uploadId);
    const outputKey = keys.itemAudio(itemId, uploadId);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    pipeline(file.file, counter, () => {});
    const discard = () => app.storage.delete(sourceKey).catch(() => {});
    try {
      await app.storage.put(sourceKey, counter, file.mimetype || "application/octet-stream");
    } catch (error) {
      await discard();
      request.log.error({ err: error }, "media upload to storage failed");
      throw new HttpError(500, "媒體上傳失敗。");
    }
    if (file.file.truncated) {
      await discard();
      throw new HttpError(413, `媒體檔不得超過 ${maxLabel}。`);
    }
    if (!bytes) {
      await discard();
      throw badRequest("請選擇媒體檔。");
    }

    const fileName = file.filename.slice(0, 255) || "media";
    const jobId = await transaction(app.db, async client => {
      const item = await client.query("SELECT id FROM items WHERE id=$1 FOR SHARE", [itemId]);
      if (!item.rowCount) return null;
      return enqueueJob(client, "media_transcode", { itemId, sourceKey, outputKey, fileName }, user.id);
    });
    if (!jobId) {
      await discard();
      throw itemNotFound();
    }
    return reply.code(202).send({ jobId });
  });

  app.get("/media/:id", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(idParams, request.params, "檔案不存在。");
    const key = (await app.db.query<{ audio_key: string | null }>("SELECT audio_key FROM items WHERE id=$1", [id])).rows[0]?.audio_key;
    if (!key) throw notFound("檔案不存在。");
    const range = request.headers.range;
    if (range !== undefined && (!/^bytes=(\d+-\d*|-\d+)$/.test(range))) return reply.code(416).send();
    let object;
    try {
      object = await app.storage.get(key, range);
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) return reply.code(416).send();
      throw error;
    }
    if (!object) throw notFound("檔案不存在。");
    reply
      .header("Content-Type", "audio/mp4")
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
    if (object.etag) reply.header("ETag", object.etag);
    if (range && object.contentRange) reply.code(206).header("Content-Range", object.contentRange);
    return reply.send(object.body);
  });

  app.get("/media-jobs", async (request, reply) => {
    const user = await requireUser(request);
    const result = await app.db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE kind='media_transcode' AND created_by=$1 ORDER BY created_at DESC LIMIT 20`,
      [user.id],
    );
    return reply.header("Cache-Control", "no-store").send({ jobs: result.rows.map(presentJob) });
  });

  app.get("/media-jobs/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到處理工作。");
    const job = (await app.db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id=$1 AND kind='media_transcode'`, [id])).rows[0];
    if (!job || job.created_by !== user.id) throw jobNotFound();
    return reply.header("Cache-Control", "no-store").send({ job: presentJob(job) });
  });

  app.delete("/media-jobs/:id", async request => {
    const user = await requireUser(request);
    if (user.role === "professor") throw forbidden();
    const { id } = parse(idParams, request.params, "找不到處理工作。");
    const cancelled = await transaction(app.db, async client => {
      const job = (await client.query<{ created_by: string | null }>(
        "SELECT created_by FROM jobs WHERE id=$1 AND kind='media_transcode' FOR UPDATE",
        [id],
      )).rows[0];
      if (!job || job.created_by !== user.id) throw jobNotFound();
      return cancelJob(client, id);
    });
    if (!cancelled) throw conflict("無法取消；工作可能已完成。");
    return { ok: true };
  });
};

export default routes;
