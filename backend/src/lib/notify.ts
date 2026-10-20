import webpush from "web-push";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db, Queryable } from "../db.js";
import type { NotifyPref } from "./preferences.js";

export type NotificationPayload = { kind: "media" | "slide" | "system"; title: string; body: string; url: string };
/**
 * `pref`: the `preferences.notify` flag that gates the Web Push (users who turned it off get no push).
 * `null` = always push (e.g. the explicit push test). In-app notifications are recorded regardless.
 */
export type PushOptions = { pref: NotifyPref | null; tag?: string };

export class Notifier {
  private readonly pushEnabled: boolean;
  constructor(private readonly db: Db, private readonly log: FastifyBaseLogger, config: Config) {
    this.pushEnabled = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
    if (this.pushEnabled) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  }

  get canPush() {
    return this.pushEnabled;
  }

  /** Inserts in-app notifications using `client` (so it can join a transaction). Call `push` after commit. */
  async record(client: Queryable, userIds: string[], payload: NotificationPayload) {
    if (!userIds.length) return;
    await client.query(
      "INSERT INTO notifications(user_id,kind,title,body,url) SELECT u,$2,$3,$4,$5 FROM unnest($1::uuid[]) AS u",
      [userIds, payload.kind, payload.title, payload.body.slice(0, 300), payload.url],
    );
  }

  /** Push subscriptions of `userIds` that want a push for `pref`. A missing flag means on; only `false` opts out. */
  async subscriptionsFor(userIds: string[], pref: NotifyPref | null) {
    const result = await this.db.query<{ endpoint: string; p256dh: string; auth: string }>(
      `SELECT s.endpoint,s.p256dh,s.auth FROM push_subscriptions s JOIN users u ON u.id=s.user_id
        WHERE s.user_id=ANY($1::uuid[]) AND u.disabled_at IS NULL
          AND ($2::text IS NULL OR (u.preferences->'notify'->$2::text) IS DISTINCT FROM 'false'::jsonb)`,
      [userIds, pref],
    );
    return result.rows;
  }

  /** Best-effort Web Push to users whose `options.pref` is on; expired subscriptions are removed. Never throws. */
  async push(userIds: string[], payload: NotificationPayload, options: PushOptions) {
    if (!userIds.length || !this.pushEnabled) return;
    try {
      const subs = await this.subscriptionsFor(userIds, options.pref);
      const body = JSON.stringify({ ...payload, tag: options.tag ?? payload.kind });
      await Promise.all(subs.map(async sub => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 3600, urgency: "high" });
        } catch (error) {
          const code = (error as { statusCode?: number }).statusCode;
          this.log.warn({ host: safeHost(sub.endpoint), code }, "web push failed");
          if (code === 404 || code === 410) await this.db.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [sub.endpoint]).catch(() => {});
        }
      }));
    } catch (error) {
      this.log.warn({ err: error }, "web push dispatch failed");
    }
  }

  async notify(userIds: string[], payload: NotificationPayload, options: PushOptions) {
    await this.record(this.db, userIds, payload);
    await this.push(userIds, payload, options);
  }
}

function safeHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}
