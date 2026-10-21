import type { FastifyInstance } from "fastify";
import { registerFinalizer } from "./queue.js";
import type { SlidePreviewPayload, SlidePreviewResult } from "../lib/slides/preview.js";
import { sourceKeys } from "../lib/slides/sources.js";

/** Entry HTML relative to the output prefix, if it is a plain relative `.html` path. */
export function validEntryHtml(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 300 || !/\.html?$/i.test(value)) return null;
  if (value.startsWith("/") || /[\\\0]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) return null;
  return value;
}

/**
 * Applies finished `slide_preview` jobs: success → `ready` and every older preview of the deck is deleted
 * (rows now, S3 after commit), so only the newest ready render is kept; failure/cancel → the preview is marked and
 * its own objects removed while the previous ready preview stays served. The source ZIP is always removed.
 */
export function registerSlidePreviewFinalizer(app: FastifyInstance) {
  registerFinalizer("slide_preview", async (job, { client }) => {
    const payload = job.payload as SlidePreviewPayload;
    const prefix = sourceKeys.previewPrefix(payload.deckId, payload.previewId);
    const row = (await client.query<{ id: string }>(
      "SELECT id FROM deck_previews WHERE id=$1 AND job_id=$2 FOR UPDATE",
      [payload.previewId, job.id],
    )).rows[0];
    if (!row) return () => app.storage.deletePrefix(prefix);
    const result = job.status === "succeeded" ? (job.result as SlidePreviewResult | null) : null;
    const entryHtml = validEntryHtml(result?.entryHtml);
    if (!entryHtml) {
      const status = job.status === "cancelled" ? "cancelled" : "failed";
      const error = status === "failed" ? (job.error ?? "預覽編譯失敗。").slice(-4000) : null;
      await client.query("UPDATE deck_previews SET status=$2,error=$3,finished_at=now() WHERE id=$1", [row.id, status, error]);
      return () => app.storage.deletePrefix(prefix);
    }
    await client.query("UPDATE deck_previews SET status='ready',entry_html=$2,error=NULL,finished_at=now() WHERE id=$1", [row.id, entryHtml]);
    // Older finished previews go; queued/running ones newer than this stay (they will replace this one).
    const older = await client.query<{ id: string }>(
      `DELETE FROM deck_previews p WHERE p.deck_id=$1 AND p.id<>$2 AND p.created_at<=(SELECT created_at FROM deck_previews WHERE id=$2)
         AND (p.status<>'queued' OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=p.job_id AND j.status IN ('queued','running')))
       RETURNING p.id`,
      [payload.deckId, row.id],
    );
    // A newer preview that is already ready makes this one obsolete too.
    const newer = (await client.query(
      "SELECT 1 FROM deck_previews WHERE deck_id=$1 AND id<>$2 AND status='ready' AND created_at>(SELECT created_at FROM deck_previews WHERE id=$2) LIMIT 1",
      [payload.deckId, row.id],
    )).rowCount;
    if (newer) await client.query("DELETE FROM deck_previews WHERE id=$1", [row.id]);
    const removed = [...older.rows.map(r => sourceKeys.previewPrefix(payload.deckId, r.id)), ...(newer ? [prefix] : [])];
    return async () => {
      if (!newer) await app.storage.delete(payload.sourceKey).catch(() => {});
      for (const stale of removed) await app.storage.deletePrefix(stale).catch(() => {});
    };
  });
}
