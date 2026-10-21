import type { FastifyInstance } from "fastify";
import { requireUser } from "../lib/auth.js";
import { registerFinalizer } from "../jobs/queue.js";
import { aiFor } from "../ai/platform/index.js";
import { REINDEX_JOB } from "../ai/embedding/switch.js";
import aiAdmin from "./ai-admin.js";

/**
 * AI status for every signed-in user: role → { state, message_zh } (no providers, models or errors), plus an SSE
 * stream that pushes on change. Also starts the AI platform runtime in this process (except in tests) and
 * finalizes failed re-index jobs. Registers the admin API (routes/ai-admin.ts) as a child plugin.
 */
export default async function aiStatus(app: FastifyInstance) {
  const platform = aiFor(app);
  await app.register(aiAdmin);
  const background = app.config.NODE_ENV !== "test" && process.env.AI_PLATFORM_BACKGROUND !== "0";
  app.addHook("onReady", async () => {
    if (background) await platform.start();
  });
  app.addHook("onClose", async () => {
    await platform.stop();
  });

  registerFinalizer(REINDEX_JOB, async (job, { client }) => {
    if (job.status === "succeeded") return;
    const spaceId = (job.payload as { spaceId?: string })?.spaceId;
    if (!spaceId) return;
    await client.query(
      "UPDATE embedding_spaces SET status='failed', error=$2 WHERE id=$1 AND status='building'",
      [spaceId, job.status === "cancelled" ? "已取消。" : (job.error ?? "重算失敗。")],
    );
  });

  app.get("/ai/status", async request => {
    await requireUser(request);
    return platform.status();
  });

  app.get("/ai/status/stream", async (request, reply) => {
    await requireUser(request);
    const initial = await platform.status();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let last = "";
    const send = (s: unknown) => {
      const data = JSON.stringify(s);
      if (data === last) return;
      last = data;
      res.write(`event: status\ndata: ${data}\n\n`);
    };
    res.write("retry: 5000\n\n");
    send(initial);
    const off = platform.onStatus(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const close = () => {
      off();
      clearInterval(ping);
    };
    request.raw.on("close", close);
    res.on("error", close);
  });
}
