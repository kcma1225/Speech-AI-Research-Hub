import type { FastifyInstance } from "fastify";
import { registerFinalizer, type SlideRenderPayload, type SlideRenderResult } from "./queue.js";
import { slideUrls } from "../lib/slides/access.js";
import type { NotificationPayload } from "../lib/notify.js";

/**
 * Applies finished `slide_render` jobs: publish (and activate unless a newer published version is
 * already active) or mark failed. Jobs superseded by a retry, or whose version was deleted, only
 * get their output cleaned up.
 */
export function registerSlideFinalizer(app: FastifyInstance) {
  registerFinalizer("slide_render", async (job, { client }) => {
    const payload = job.payload as SlideRenderPayload;
    const version = (await client.query<{ id: string; version: number; project_id: string; created_by: string | null; title: string; slug: string }>(
      `SELECT v.id,v.version,v.project_id,v.created_by,p.title,p.slug FROM slide_versions v JOIN slide_projects p ON p.id=v.project_id
        WHERE v.id=$1 AND v.job_id=$2 FOR UPDATE OF v, p`,
      [payload.versionId, job.id],
    )).rows[0];
    const cleanup = () => app.storage.deletePrefix(payload.outputPrefix);
    if (!version) return cleanup;

    let notice: NotificationPayload;
    if (job.status === "succeeded") {
      const result = job.result as SlideRenderResult;
      await client.query(
        "UPDATE slide_versions SET status='published',entry_html=$2,pdf_key=$3,quarto_version=$4,shared_prefix=$5,error=NULL WHERE id=$1",
        [version.id, result.entryHtml, result.pdfKey, result.quartoVersion, result.sharedPrefix ?? null],
      );
      await client.query(
        `UPDATE slide_projects SET active_version_id=$1,updated_at=now()
          WHERE id=$2 AND (active_version_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM slide_versions WHERE id=slide_projects.active_version_id AND version>$3))`,
        [version.id, version.project_id, version.version],
      );
      notice = { kind: "slide", title: "簡報編譯完成", body: `${version.title} · Version ${version.version}`, url: slideUrls.player(version.slug) };
    } else {
      const error = job.status === "cancelled" ? "編譯已取消。" : job.error || "簡報編譯失敗。";
      await client.query("UPDATE slide_versions SET status='failed',error=$2 WHERE id=$1", [version.id, error.slice(-4000)]);
      notice = { kind: "slide", title: "簡報編譯失敗", body: `${version.title} · Version ${version.version}`, url: slideUrls.player(version.slug) };
    }
    const recipients = version.created_by ? [version.created_by] : [];
    await app.notifier.record(client, recipients, notice);
    return async () => {
      if (job.status !== "succeeded") await cleanup();
      await app.notifier.push(recipients, notice, `slide-${version.id}`);
    };
  });
}
