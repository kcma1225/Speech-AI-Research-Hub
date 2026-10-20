import type { FastifyInstance } from "fastify";
import type { NotificationPayload } from "../lib/notify.js";
import { registerFinalizer, type MediaTranscodePayload, type MediaTranscodeResult } from "./queue.js";

/**
 * Applies finished `media_transcode` jobs: attach the new audio to its note (replacing the old file)
 * and notify the uploader; on failure or cancel, remove the upload and any partial output.
 */
export function registerMediaFinalizer(app: FastifyInstance) {
  registerFinalizer("media_transcode", async (job, { client }) => {
    const payload = job.payload as MediaTranscodePayload;
    const removeObjects = (keys: (string | null | undefined)[]) => async () => {
      for (const key of new Set(keys.filter((key): key is string => Boolean(key)))) {
        await app.storage.delete(key).catch(error => app.log.warn({ err: error, key, jobId: job.id }, "failed to delete media object"));
      }
    };

    if (job.status !== "succeeded") {
      let notice: NotificationPayload | null = null;
      if (job.status === "failed" && job.created_by) {
        notice = { kind: "media", title: "影音處理失敗", body: payload.fileName, url: `/items/${payload.itemId}` };
        await app.notifier.record(client, [job.created_by], notice);
      }
      const cleanup = removeObjects([payload.sourceKey, payload.outputKey]);
      return async () => {
        await cleanup();
        if (notice && job.created_by) await app.notifier.push([job.created_by], notice, `media-${job.id}`);
      };
    }

    const result = job.result as MediaTranscodeResult;
    const item = (await client.query<{ audio_key: string | null }>("SELECT audio_key FROM items WHERE id=$1 FOR UPDATE", [payload.itemId])).rows[0];
    // Note deleted while transcoding: the output has nowhere to go.
    if (!item) return removeObjects([payload.sourceKey, result.outputKey, payload.outputKey]);

    await client.query(
      `UPDATE items SET audio_key=$1,audio_name=$2,audio_bytes=$3,audio_duration_seconds=$4,
              updated_by=COALESCE($5,updated_by),updated_at=now() WHERE id=$6`,
      [result.outputKey, payload.fileName.slice(0, 255), result.bytes, result.durationSeconds, job.created_by, payload.itemId],
    );
    const notice: NotificationPayload = { kind: "media", title: "影音處理完成", body: payload.fileName, url: `/items/${payload.itemId}` };
    if (job.created_by) await app.notifier.record(client, [job.created_by], notice);
    const previous = item.audio_key && item.audio_key !== result.outputKey ? item.audio_key : null;
    const cleanup = removeObjects([previous, payload.sourceKey]);
    return async () => {
      await cleanup();
      if (job.created_by) await app.notifier.push([job.created_by], notice, `media-${job.id}`);
    };
  });
}
