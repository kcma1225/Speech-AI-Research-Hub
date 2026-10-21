import type { FastifyInstance } from "fastify";
import { registerFinalizer, type SlideRenderPayload, type SlideRenderResult } from "./queue.js";
import { slideUrls } from "../lib/slides/access.js";
import type { NotificationPayload } from "../lib/notify.js";
import type { Queryable } from "../db.js";
import { recordActivity } from "../lib/studies/activity.js";

/** The worker's thumbnail key, if it is a plain key inside this version's output prefix; otherwise none. */
export function validThumbnailKey(key: unknown, outputPrefix: string): string | null {
  if (typeof key !== "string" || key.length > 1024 || !key.startsWith(outputPrefix) || key.length === outputPrefix.length) return null;
  const rest = key.slice(outputPrefix.length);
  if (rest.split("/").some(part => !part || part === "." || part === "..") || /[\\\0]/.test(rest)) return null;
  return key;
}

/** The worker's page count, if it is an integer in 1..1000; otherwise none. */
export const validPageCount = (count: unknown): number | null => (Number.isInteger(count) && (count as number) >= 1 && (count as number) <= 1000 ? (count as number) : null);

/** Notification sent when a PPTX conversion lands in `review`. */
export const REVIEW_NOTICE_TITLE = "簡報轉換完成，請確認";

/**
 * Applies finished `slide_render` jobs. A normal render: publish (and activate unless a newer published
 * version is already active), or `review` for PPTX (no activation until POST …/publish), or mark failed.
 * A re-index (job output prefix ≠ the version's) swaps in the new output on success and deletes the old
 * prefix; on failure only its own output is removed and the version stays as it was. Jobs superseded by a
 * retry, or whose version was deleted, only get their output cleaned up.
 */
export function registerSlideFinalizer(app: FastifyInstance) {
  registerFinalizer("slide_render", async (job, { client }) => {
    const payload = job.payload as SlideRenderPayload;
    const version = (await client.query<{ id: string; version: number; deck_id: string; output_prefix: string; source_type: string; status: string; created_by: string | null; title: string; slug: string; study_id: string }>(
      `SELECT v.id,v.version,v.deck_id,v.output_prefix,v.source_type,v.status,v.created_by,p.title,p.slug,p.study_id FROM slide_versions v JOIN decks p ON p.id=v.deck_id
        WHERE v.id=$1 AND v.job_id=$2 FOR UPDATE OF v, p`,
      [payload.versionId, job.id],
    )).rows[0];
    const cleanup = () => app.storage.deletePrefix(payload.outputPrefix);
    if (!version) return cleanup;
    const result = job.status === "succeeded" ? (job.result as SlideRenderResult) : null;
    const pageFields = (prefix: string) => {
      const manifestKey = validThumbnailKey(result?.manifestKey, prefix);
      const pageCount = manifestKey ? validPageCount(result?.pageCount) : null;
      return { manifestKey: pageCount ? manifestKey : null, pageCount };
    };

    if (payload.outputPrefix !== version.output_prefix) {
      // Re-index of an already rendered version: the deck stays served from its old output until this succeeds.
      if (!result) return cleanup;
      const pages = pageFields(payload.outputPrefix);
      await client.query(
        `UPDATE slide_versions SET output_prefix=$2,entry_html=$3,pdf_key=$4,quarto_version=$5,shared_prefix=$6,thumbnail_key=$7,page_count=$8,manifest_key=$9
          WHERE id=$1`,
        [version.id, payload.outputPrefix, result.entryHtml, result.pdfKey, result.quartoVersion, result.sharedPrefix ?? null,
          validThumbnailKey(result.thumbnailKey, payload.outputPrefix), pages.pageCount, pages.manifestKey],
      );
      const previous = version.output_prefix;
      return async () => {
        await app.storage.deletePrefix(previous);
      };
    }

    let notice: NotificationPayload;
    if (result) {
      const pages = pageFields(version.output_prefix);
      const review = version.source_type === "pptx";
      await client.query(
        `UPDATE slide_versions SET status=$2,entry_html=$3,pdf_key=$4,quarto_version=$5,shared_prefix=$6,thumbnail_key=$7,page_count=$8,manifest_key=$9,
                published_at=CASE WHEN $2='published' THEN now() END,error=NULL
          WHERE id=$1`,
        [version.id, review ? "review" : "published", result.entryHtml, result.pdfKey, result.quartoVersion, result.sharedPrefix ?? null,
          validThumbnailKey(result.thumbnailKey, version.output_prefix), pages.pageCount, pages.manifestKey],
      );
      if (review) {
        notice = { kind: "slide", title: REVIEW_NOTICE_TITLE, body: `${version.title} · Version ${version.version}`, url: slideUrls.player(version.slug) };
      } else {
        await activateIfNewest(client, version);
        await recordDeckPublished(client, version, version.created_by);
        notice = { kind: "slide", title: "簡報編譯完成", body: `${version.title} · Version ${version.version}`, url: slideUrls.player(version.slug) };
      }
    } else {
      const error = job.status === "cancelled" ? "編譯已取消。" : job.error || "簡報編譯失敗。";
      await client.query("UPDATE slide_versions SET status='failed',error=$2,thumbnail_key=NULL,page_count=NULL,manifest_key=NULL WHERE id=$1", [version.id, error.slice(-4000)]);
      notice = { kind: "slide", title: "簡報編譯失敗", body: `${version.title} · Version ${version.version}`, url: slideUrls.player(version.slug) };
    }
    const recipients = version.created_by ? [version.created_by] : [];
    await app.notifier.record(client, recipients, notice);
    return async () => {
      if (!result) await cleanup();
      await app.notifier.push(recipients, notice, { pref: "slideRendered", tag: `slide-${version.id}` });
    };
  });
}

/** Makes `version` active unless an even newer version already is (the activation rule). */
export async function activateIfNewest(client: Queryable, version: { id: string; deck_id: string; version: number }) {
  await client.query(
    `UPDATE decks SET active_version_id=$1,updated_at=now()
      WHERE id=$2 AND (active_version_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM slide_versions WHERE id=decks.active_version_id AND version>$3))`,
    [version.id, version.deck_id, version.version],
  );
}

/** `deck_published` study activity for a version that just became published. */
export async function recordDeckPublished(client: Queryable, version: { id: string; deck_id: string; version: number }, actorId: string | null) {
  const deck = (await client.query<{ study_id: string; title: string; slug: string }>("SELECT study_id,title,slug FROM decks WHERE id=$1", [version.deck_id])).rows[0];
  if (!deck) return;
  await recordActivity(client, {
    studyId: deck.study_id, actorId, kind: "deck_published", title: `${deck.title} v${version.version}`,
    url: `/slides/${version.deck_id}`, targetType: "deck", targetId: version.deck_id, metadata: { versionId: version.id },
  });
}
