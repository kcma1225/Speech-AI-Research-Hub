import webpush from "web-push";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db, Queryable } from "../db.js";

export type NotificationPayload = { kind: "media" | "slide" | "system"; title: string; body: string; url: string };

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

  /** Best-effort Web Push; expired subscriptions are removed. Never throws. */
  async push(userIds: string[], payload: NotificationPayload, tag?: string) {
    if (!userIds.length || !this.pushEnabled) return;
    try {
      const subs = await this.db.query<{ endpoint: string; p256dh: string; auth: string }>(
        "SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=ANY($1::uuid[])",
        [userIds],
      );
      const body = JSON.stringify({ ...payload, tag: tag ?? payload.kind });
      await Promise.all(subs.rows.map(async sub => {
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

  async notify(userIds: string[], payload: NotificationPayload, tag?: string) {
    await this.record(this.db, userIds, payload);
    await this.push(userIds, payload, tag);
  }
}

function safeHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}
