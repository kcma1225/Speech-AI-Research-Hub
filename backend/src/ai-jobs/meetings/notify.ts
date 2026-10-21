/**
 * Notifications from ai-worker jobs: in-app rows always; Web Push when the process has a valid config with VAPID keys.
 */
import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db.js";
import { Notifier, type NotificationPayload } from "../../lib/notify.js";
import type { NotifyPref } from "../../lib/preferences.js";

const silent = { warn() {}, info() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silent; }, level: "silent" } as unknown as FastifyBaseLogger;
let notifier: Notifier | null | undefined;

function get(db: Db): Notifier | null {
  if (notifier === undefined) {
    try {
      notifier = new Notifier(db, silent, loadConfig());
    } catch {
      notifier = null;
    }
  }
  return notifier;
}

export async function notifyFromJob(db: Db, userIds: string[], payload: NotificationPayload, pref: NotifyPref) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await db.query(
    "INSERT INTO notifications(user_id,kind,title,body,url) SELECT u,$2,$3,$4,$5 FROM unnest($1::uuid[]) AS u",
    [ids, payload.kind, payload.title, payload.body.slice(0, 300), payload.url],
  );
  const n = get(db);
  if (n?.canPush) await n.push(ids, payload, { pref, tag: payload.url }).catch(() => {});
}
