import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { parse } from "../lib/http.js";

const removeInput = z.object({ id: z.uuid().optional() });
const readInput = z.object({ ids: z.array(z.uuid()).max(200).optional() });

const notifications: FastifyPluginAsync = async app => {
  app.get("/notifications", async (request, reply) => {
    const user = await requireUser(request);
    const result = await app.db.query(
      "SELECT id,kind,title,body,url,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
      [user.id],
    );
    reply.header("Cache-Control", "no-store");
    return { notifications: result.rows };
  });

  app.delete("/notifications", async request => {
    const user = await requireUser(request);
    const data = parse(removeInput, request.body ?? {});
    const result = data.id
      ? await app.db.query("DELETE FROM notifications WHERE id=$1 AND user_id=$2", [data.id, user.id])
      : await app.db.query("DELETE FROM notifications WHERE user_id=$1", [user.id]);
    return { removed: result.rowCount ?? 0 };
  });

  app.get("/notifications/unread", async (request, reply) => {
    const user = await requireUser(request);
    const result = await app.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL",
      [user.id],
    );
    reply.header("Cache-Control", "no-store");
    return { count: result.rows[0]!.count };
  });

  app.post("/notifications/read", async request => {
    const user = await requireUser(request);
    const data = parse(readInput, request.body ?? {});
    const result = data.ids
      ? await app.db.query("UPDATE notifications SET read_at=now() WHERE id=ANY($1::uuid[]) AND user_id=$2 AND read_at IS NULL", [data.ids, user.id])
      : await app.db.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [user.id]);
    return { updated: result.rowCount ?? 0 };
  });
};

export default notifications;
