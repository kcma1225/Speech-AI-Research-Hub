import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { conflict, parse } from "../lib/http.js";

const subscriptionInput = z.object({
  subscription: z.object({
    endpoint: z.url().max(2000).refine(value => value.startsWith("https://")),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
});
const removeInput = z.object({ endpoint: z.string().min(1).max(2000) });

const push: FastifyPluginAsync = async app => {
  app.get("/push", async (request, reply) => {
    const user = await requireUser(request);
    const count = (await app.db.query<{ count: number }>("SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id=$1", [user.id])).rows[0]!.count;
    reply.header("Cache-Control", "no-store");
    return { enabled: app.notifier.canPush, publicKey: app.config.VAPID_PUBLIC_KEY || null, subscribed: count > 0 };
  });

  app.post("/push", async (request, reply) => {
    const user = await requireUser(request);
    const { subscription } = parse(subscriptionInput, request.body, "訂閱資料不正確。");
    await app.db.query(
      `INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,user_agent) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent`,
      [subscription.endpoint, user.id, subscription.keys.p256dh, subscription.keys.auth, request.headers["user-agent"]?.slice(0, 300) ?? null],
    );
    return reply.code(201).send({ ok: true });
  });

  app.delete("/push", async request => {
    const user = await requireUser(request);
    const { endpoint } = parse(removeInput, request.body);
    await app.db.query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2", [endpoint, user.id]);
    return { ok: true };
  });

  app.post("/push/test", async request => {
    const user = await requireUser(request);
    if (!app.notifier.canPush) throw conflict("伺服器尚未設定推播金鑰。");
    const count = (await app.db.query<{ count: number }>("SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id=$1", [user.id])).rows[0]!.count;
    if (!count) throw conflict("此帳號尚未在任何裝置開啟推播。");
    await app.notifier.push([user.id], { kind: "system", title: "測試通知", body: "推播已開啟，這台裝置會收到處理完成通知。", url: "/" }, "test");
    return { ok: true, devices: count };
  });
};

export default push;
