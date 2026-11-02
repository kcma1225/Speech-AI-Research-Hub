import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { toHttpError } from "../ai/platform/index.js";
import { currentUser, requireUser } from "../lib/auth.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import { projectById } from "../lib/slides/access.js";
import { answerQuestion, ASK_LIMITS, isQuestion } from "../lib/slides/ask.js";
import { deviceLabel, RemoteHub, type RemoteSession } from "../lib/slides/remote.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Phone remote sessions (lib/slides/remote.ts). */
    slideRemote: RemoteHub;
  }
}

/**
 * Phone remote (`/remote` PWA): `GET /api/slides/remote/sessions` lists the account's presentations;
 * `GET /api/slides/remote/host?version=` (WebSocket) is opened by the player while it presents a published
 * version; `GET /api/slides/remote/control/:id` (WebSocket) is the phone's. Auth like /api/collab: Origin must be
 * APP_ORIGIN and the session cookie valid; a phone only reaches its own account's sessions. Registered after notes
 * (@fastify/websocket).
 * `POST /api/slides/:id/ask` (SSE) is the phone's 「提問助手」 (lib/slides/ask.ts): `gate: true` first asks whether the
 * heard utterance is a question for the presenter (`skip` when not), then streams the answer (`delta` … `done`).
 */
const hostQuery = z.object({ version: z.uuid() });
const controlParams = z.object({ id: z.uuid() });
const deckParams = z.object({ id: z.uuid() });
const askInput = z.object({
  heard: z.string().trim().min(1).max(ASK_LIMITS.heard),
  transcript: z.string().max(ASK_LIMITS.transcript).default(""),
  page: z.number().int().min(1).max(10_000).nullable().default(null),
  gate: z.boolean().default(false),
});
/** Per account and minute: automatic checks (one per heard utterance) and answers. */
const ASK_PER_MINUTE = { gate: 40, answer: 12 };
/** Server → both sides ping (mobile networks and proxies drop silent sockets). */
const PING_MS = 25_000;
/** A presentation longer than this is a forgotten tab. */
const MAX_SESSION_MS = 8 * 60 * 60_000;

export default async function slideRemote(app: FastifyInstance) {
  const hub = new RemoteHub();
  app.decorate("slideRemote", hub);
  app.addHook("preClose", async () => hub.closeAll());
  const expectedOrigin = new URL(app.config.APP_ORIGIN).origin;

  const signedIn = async (request: FastifyRequest): Promise<{ status: number; error: string } | null> => {
    if (request.headers.origin !== expectedOrigin) return { status: 403, error: "請從本站重新連線。" };
    const user = await currentUser(request);
    if (!user) return { status: 401, error: "請重新登入。" };
    if (user.role === "admin") return { status: 403, error: "系統管理帳號不能使用工作區功能。" };
    return null;
  };

  /** Keeps a socket alive and closes it after the time limit; returns the cleanup. */
  const keepAlive = (socket: WebSocket) => {
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_MS);
    const limit = setTimeout(() => socket.close(1000, "time limit"), MAX_SESSION_MS);
    return () => {
      clearInterval(ping);
      clearTimeout(limit);
    };
  };

  const budget = new Map<string, { at: number; gate: number; answer: number }>();
  const spend = (userId: string, kind: "gate" | "answer") => {
    const now = Date.now();
    let b = budget.get(userId);
    if (!b || now - b.at > 60_000) budget.set(userId, (b = { at: now, gate: 0, answer: 0 }));
    if (b[kind] >= ASK_PER_MINUTE[kind]) throw new HttpError(429, kind === "gate" ? "自動偵測太頻繁，先暫停一下。" : "一分鐘內問太多題了，稍等一下再試。");
    b[kind]++;
  };

  app.post("/slides/:id/ask", async (request, reply: FastifyReply) => {
    const user = await requireUser(request);
    const { id } = parse(deckParams, request.params);
    const input = parse(askInput, request.body);
    if (!(await projectById(app.db, id))) throw notFound("簡報不存在。");
    spend(user.id, input.gate ? "gate" : "answer");
    const controller = new AbortController();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (event: string, data: object) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.on("close", () => controller.abort());
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    try {
      if (input.gate) {
        if (!(await isQuestion(app, input, { userId: user.id, signal: controller.signal }))) return void send("skip", {});
        spend(user.id, "answer");
        send("question", {});
      }
      await answerQuestion(app, id, input, { userId: user.id, signal: controller.signal, onDelta: (text) => send("delta", { text }) });
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = toHttpError(e);
      if (err instanceof HttpError) send("error", { error: err.message, ...err.extra });
      else {
        request.log.error({ err: e }, "remote ask failed");
        send("error", { error: "AI 回答時發生錯誤，請再試一次。" });
      }
    } finally {
      clearInterval(ping);
      send("done", {});
      res.end();
    }
  });

  app.get("/slides/remote/sessions", async (request, reply) => {
    const user = await requireUser(request);
    return reply.header("Cache-Control", "no-store").send({ sessions: hub.list(user.id) });
  });

  app.get(
    "/slides/remote/host",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const refused = await signedIn(request);
        if (refused) return reply.code(refused.status).send({ error: refused.error });
        const q = hostQuery.safeParse(request.query);
        if (!q.success) return reply.code(400).send({ error: "欄位內容不正確。" });
        const ok = (await app.db.query("SELECT 1 FROM slide_versions WHERE id=$1 AND status='published'", [q.data.version])).rowCount;
        if (!ok) return reply.code(404).send({ error: "找不到已發布的簡報版本。" });
      },
    },
    async (socket: WebSocket, request) => {
      const { version } = hostQuery.parse(request.query);
      const user = request.user!;
      const deck = (await app.db.query<{ deck_id: string }>("SELECT deck_id FROM slide_versions WHERE id=$1", [version])).rows[0]?.deck_id;
      const project = deck ? await projectById(app.db, deck) : null;
      if (!project) return socket.close(1008, "not found");
      const session = hub.open(user.id, { deckId: project.id, versionId: version, slug: project.slug, title: project.title, device: deviceLabel(request.headers["user-agent"]) }, socket);
      if (!session) return socket.close(1008, "too many sessions");
      const stop = keepAlive(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) hub.hostMessage(session, data.toString("utf8"));
      });
      socket.on("close", () => {
        stop();
        hub.close(session);
      });
    },
  );

  app.get(
    "/slides/remote/control/:id",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const refused = await signedIn(request);
        if (refused) return reply.code(refused.status).send({ error: refused.error });
        const p = controlParams.safeParse(request.params);
        const session = p.success ? hub.get(p.data.id) : null;
        // Another account's session answers like a missing one.
        if (!session || session.userId !== request.user!.id) return reply.code(404).send({ error: "這場簡報已經結束。" });
      },
    },
    (socket: WebSocket, request) => {
      const { id } = controlParams.parse(request.params);
      const session: RemoteSession | null = hub.get(id);
      if (!session || session.userId !== request.user!.id) return socket.close(1008, "ended");
      if (!hub.attach(session, socket)) return socket.close(1013, "full");
      const stop = keepAlive(socket);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) hub.controlMessage(session, socket, data.toString("utf8"));
      });
      socket.on("close", () => {
        stop();
        hub.detach(session, socket);
      });
    },
  );
}
