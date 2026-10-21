/**
 * Draft Markdown images (`/studies/new`): uploaded with scope `draft` before the study exists, so `study_id` is NULL
 * and only the uploader can read them (key `md-images/_drafts/<user>/<id>.<ext>`). Creating the study claims the
 * drafts its summary references: inside the create transaction the objects are copied under the study's prefix and
 * the rows re-keyed; the old draft objects are deleted after commit (`afterCommit`), or the copies when it rolls back
 * (`onRollback`). The image URL (`/api/md-images/<id>`) never changes. Unclaimed drafts expire after a day.
 */
import type { Queryable } from "../../db.js";
import { keys, type Storage } from "../storage.js";

export const DRAFT_TTL_HOURS = 24;
const URL_RE = /\/api\/md-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Image ids referenced by Markdown (`![](/api/md-images/<id>)`, also inside HTML). */
export function referencedImageIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(URL_RE)].map((m) => m[1]!.toLowerCase()))];
}

export async function claimDraftImages(client: Queryable, storage: Storage, userId: string, studyId: string, markdown: string) {
  const ids = referencedImageIds(markdown);
  const moved: { from: string; to: string }[] = [];
  const done = { afterCommit: async () => {}, onRollback: async () => {} };
  if (!ids.length) return done;
  const rows = (await client.query<{ id: string; object_key: string; mime: string }>(
    "SELECT id, object_key, mime FROM md_images WHERE id = ANY($1::uuid[]) AND study_id IS NULL AND created_by=$2 FOR UPDATE",
    [ids, userId],
  )).rows;
  try {
    for (const row of rows) {
      const ext = row.object_key.split(".").pop() ?? "bin";
      const to = keys.mdImage(studyId, row.id, ext);
      const body = await storage.getBuffer(row.object_key);
      if (!body) continue; // object gone (swept): the row goes with the sweep below
      await storage.put(to, body, row.mime);
      moved.push({ from: row.object_key, to });
      await client.query("UPDATE md_images SET study_id=$2, object_key=$3 WHERE id=$1", [row.id, studyId, to]);
    }
  } catch (e) {
    await Promise.all(moved.map((m) => storage.delete(m.to).catch(() => {})));
    throw e;
  }
  done.afterCommit = async () => {
    await Promise.all(moved.map((m) => storage.delete(m.from).catch(() => {})));
  };
  done.onRollback = async () => {
    await Promise.all(moved.map((m) => storage.delete(m.to).catch(() => {})));
  };
  return done;
}

/** Deletes drafts older than the TTL (rows, then objects). Best effort; called on draft uploads. */
export async function sweepDraftImages(db: Queryable, storage: Storage) {
  const gone = (await db.query<{ object_key: string }>(
    `DELETE FROM md_images WHERE study_id IS NULL AND created_at < now() - make_interval(hours => $1) RETURNING object_key`,
    [DRAFT_TTL_HOURS],
  )).rows;
  await Promise.all(gone.map((r) => storage.delete(r.object_key).catch(() => {})));
  return gone.length;
}
