import { createHmac, randomUUID } from "node:crypto";
import { transaction, type Db, type Queryable } from "../../db.js";
import { cancelJob, enqueueJob } from "../../jobs/queue.js";
import type { Storage } from "../storage.js";
import { safeEqual } from "./access.js";
import { packTree, sourceKeys } from "./sources.js";

/**
 * Quick previews of an in-app source tree: job kind `slide_preview` (worker: Quarto → HTML only, no PDF or pages,
 * claimed after every other slide job). Rows in `deck_previews`; the finalizer keeps only the newest ready one.
 */
export type SlidePreviewPayload = { deckId: string; previewId: string; sourceKey: string; entry: string; outputPrefix: string; /** Also capture `_hub/shots/` (AI layout review). */ shots?: boolean };
export type PreviewShots = { count: number; total?: number; width?: number; height?: number; truncated?: boolean; error?: string };
export type SlidePreviewResult = { entryHtml: string; fileCount: number; quartoVersion: string | null; shots?: PreviewShots };

export type PreviewStatus = "queued" | "ready" | "failed" | "cancelled";
export type PreviewRow = {
  id: string;
  deck_id: string;
  revision: number;
  status: PreviewStatus;
  job_id: string | null;
  entry_html: string | null;
  output_prefix: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const PREVIEW_TTL_SECONDS = 12 * 60 * 60;
const signature = (secret: string, deckId: string, previewId: string, expires: number) =>
  createHmac("sha256", secret).update(`slide-preview|${deckId}|${previewId}|${expires}`).digest("base64url");

/** Path capability for the preview iframe: `p.<expiry>.<hmac>` (12 h). Never `public` or the share key: drafts stay internal. */
export function previewToken(secret: string, deckId: string, previewId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + PREVIEW_TTL_SECONDS;
  return `p.${expires}.${signature(secret, deckId, previewId, expires)}`;
}

export function validPreviewToken(secret: string, token: string, deckId: string, previewId: string, now = Date.now()) {
  const match = /^p\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires < now / 1000) return false;
  return safeEqual(match[2], signature(secret, deckId, previewId, expires));
}

export const previewViewUrl = (slug: string, token: string, previewId: string, entryHtml: string) =>
  `/api/slides/view/${encodeURIComponent(slug)}/${encodeURIComponent(token)}/preview/${previewId}/${entryHtml.split("/").map(encodeURIComponent).join("/")}`;

const PREVIEW_COLUMNS = "p.id,p.deck_id,p.revision,p.status,p.job_id,p.entry_html,p.output_prefix,p.error,p.created_at,p.finished_at";

/** Newest preview (any status) and newest ready preview of a deck, with live job stage/progress. */
export async function previewState(db: Queryable, deckId: string) {
  const latest = (await db.query<PreviewRow & { job_status: string | null; stage: string | null; progress: number | null }>(
    `SELECT ${PREVIEW_COLUMNS},j.status AS job_status,j.stage,j.progress FROM deck_previews p LEFT JOIN jobs j ON j.id=p.job_id
      WHERE p.deck_id=$1 ORDER BY p.created_at DESC LIMIT 1`,
    [deckId],
  )).rows[0] ?? null;
  const ready = latest?.status === "ready"
    ? latest
    : (await db.query<PreviewRow>(`SELECT ${PREVIEW_COLUMNS} FROM deck_previews p WHERE p.deck_id=$1 AND p.status='ready' ORDER BY p.created_at DESC LIMIT 1`, [deckId])).rows[0] ?? null;
  return { latest, ready };
}

/**
 * Packs the tree and queues a preview of its current revision. A queued or ready preview of the same revision is
 * reused (`reused: true`); older previews still queued are cancelled (a running one finishes and is then replaced).
 * `createdBy` is recorded on the preview row; the job itself is a system job so it stays out of the jobs tray.
 */
export async function enqueuePreview(db: Db, storage: Storage, deckId: string, createdBy: string | null, opts: { shots?: boolean } = {}): Promise<{ preview: PreviewRow; reused: boolean }> {
  const current = await previewState(db, deckId);
  const tree = (await db.query<{ revision: number }>("SELECT revision FROM deck_source_trees WHERE deck_id=$1", [deckId])).rows[0];
  const same = current.latest && tree && current.latest.revision === tree.revision && (current.latest.status === "queued" || current.latest.status === "ready");
  // A preview without screenshots is not reused when they are asked for (AI layout review).
  const hasShots = async () =>
    !opts.shots || Boolean((await db.query<{ shots: boolean | null }>("SELECT (payload->>'shots')::boolean AS shots FROM jobs WHERE id=$1", [current.latest!.job_id])).rows[0]?.shots);
  if (same && (await hasShots())) return { preview: current.latest!, reused: true };

  const { zip, tree: packed } = await packTree(db, storage, deckId);
  const previewId = randomUUID();
  const payload: SlidePreviewPayload = {
    deckId,
    previewId,
    sourceKey: sourceKeys.previewSource(deckId, previewId),
    entry: packed.entry,
    outputPrefix: sourceKeys.previewOutput(deckId, previewId),
    ...(opts.shots ? { shots: true } : {}),
  };
  await storage.put(payload.sourceKey, zip, "application/zip");
  try {
    const preview = await transaction(db, async client => {
      const stale = await client.query<{ id: string; job_id: string | null }>(
        `SELECT p.id,p.job_id FROM deck_previews p JOIN jobs j ON j.id=p.job_id WHERE p.deck_id=$1 AND p.status='queued' AND j.status='queued' FOR UPDATE OF p`,
        [deckId],
      );
      for (const row of stale.rows) if (row.job_id) await cancelJob(client, row.job_id);
      const jobId = await enqueueJob(client, "slide_preview", payload, null, 1);
      return (await client.query<PreviewRow>(
        `INSERT INTO deck_previews AS p(id,deck_id,revision,job_id,output_prefix,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${PREVIEW_COLUMNS}`,
        [previewId, deckId, packed.revision, jobId, payload.outputPrefix, createdBy],
      )).rows[0]!;
    });
    return { preview, reused: false };
  } catch (error) {
    await storage.deletePrefix(sourceKeys.previewPrefix(deckId, previewId)).catch(() => {});
    throw error;
  }
}
