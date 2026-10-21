import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { CurrentUser } from "./lib/auth.js";
import { workspaceGuard } from "./lib/auth.js";
import { HttpError } from "./lib/http.js";
import { Notifier } from "./lib/notify.js";
import type { Storage } from "./lib/storage.js";
import health from "./routes/health.js";
import auth from "./routes/auth.js";
import users from "./routes/users.js";
import invitations from "./routes/invitations.js";
import notifications from "./routes/notifications.js";
import push from "./routes/push.js";
import slides from "./routes/slides.js";
import slideReviews from "./routes/slide-reviews.js";
import slideView from "./routes/slide-view.js";
import slidePages from "./routes/slide-pages.js";
import dashboard from "./routes/dashboard.js";
import studies from "./routes/studies.js";
import jobs from "./routes/jobs.js";
import oidc from "./routes/oidc.js";
import aiPlatform from "./routes/ai-status.js";
import { OIDC_TOKEN_ROUTE } from "./lib/oidc/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    storage: Storage;
    notifier: Notifier;
  }
  interface FastifyRequest {
    user: CurrentUser | null;
    userLoaded: boolean;
  }
}

export type AppDeps = { config: Config; db: Db; storage: Storage };

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(deps: AppDeps, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true, // only nginx can reach the backend
    bodyLimit: 1024 * 1024,
    logger: { level: deps.config.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization"] },
    ...options,
  });

  app.decorate("config", deps.config);
  app.decorate("db", deps.db);
  app.decorate("storage", deps.storage);
  app.decorate("notifier", new Notifier(deps.db, app.log, deps.config));
  app.decorateRequest("user", null);
  app.decorateRequest("userLoaded", false);

  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fields: 20, fieldSize: 64 * 1024 } });

  // CSRF: browser writes must come from our own origin. nginx forwards the Origin header unchanged.
  const expectedOrigin = new URL(deps.config.APP_ORIGIN).origin;
  app.addHook("onRequest", async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    // Aldine's server calls the OIDC token endpoint without our Origin. It authenticates with the client
    // secret and never reads cookies, so there is nothing to forge; only this exact route is exempt.
    if (request.method === "POST" && request.routeOptions.url === OIDC_TOKEN_ROUTE) return;
    // MCP (routes/mcp.ts) authenticates with a bearer token only (never the cookie) and checks Origin itself.
    if (request.method === "POST" && request.routeOptions.url === "/api/mcp") return;
    if (request.headers.origin !== expectedOrigin) return reply.code(403).send({ error: "請從本站重新送出。" });
  });
  // Admin accounts are system-only: research-workspace API routes refuse them (lib/auth.ts ADMIN_ALLOWED).
  app.addHook("onRequest", workspaceGuard);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message, ...error.extra });
    if (error instanceof ZodError) return reply.code(400).send({ error: "欄位內容不正確。" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      if (status === 413) return reply.code(413).send({ error: "檔案超過大小限制。" });
      return reply.code(status).send({ error: "請求內容不正確。" });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "伺服器發生錯誤，請稍後再試。" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "找不到資料。" }));

  await app.register(health, { prefix: "/api" });
  await app.register(auth, { prefix: "/api" });
  await app.register(users, { prefix: "/api" });
  await app.register(invitations, { prefix: "/api" });
  await app.register(notifications, { prefix: "/api" });
  await app.register(push, { prefix: "/api" });
  await app.register(slides, { prefix: "/api" });
  await app.register(slideReviews, { prefix: "/api" });
  await app.register(slideView, { prefix: "/api" });
  await app.register(slidePages, { prefix: "/api" });
  await app.register(studies, { prefix: "/api" });
  await app.register(dashboard, { prefix: "/api" });
  await app.register(jobs, { prefix: "/api" });
  await app.register(oidc, { prefix: "/api" });
  await app.register(aiPlatform, { prefix: "/api" });
  await app.register((await import("./routes/notes.js")).default); // notes + /api/collab (root level: app.collab, @fastify/websocket; register WS users after it)
  await app.register((await import("./routes/papers.js")).default, { prefix: "/api" }); // library (M4)

  await app.register((await import("./routes/search.js")).default, { prefix: "/api" }); // search (M8)
  await app.register((await import("./routes/meetings.js")).default, { prefix: "/api" }); // meetings (M6; WS /api/meetings/:id/live, after notes)
  await app.register((await import("./routes/latex.js")).default, { prefix: "/api" }); // LaTeX editor (M7; after notes: app.collab)
  await app.register((await import("./routes/vision-review.js")).default, { prefix: "/api" }); // AI 檢查排版 (slides + LaTeX; after latex: app.collab)
  await app.register((await import("./routes/agent.js")).default, { prefix: "/api" }); // agent + memories + MCP (M3)
  await app.register((await import("./routes/agent-attachments.js")).default, { prefix: "/api" }); // assistant attachments (uploads + picker)
  await app.register((await import("./routes/doc-import.js")).default, { prefix: "/api" }); // document import (Magika) + Markdown images
  await app.register((await import("./routes/workflows.js")).default, { prefix: "/api" }); // orchestrator → sub-agent workflows (engine in ai-worker)

  return app;
}
