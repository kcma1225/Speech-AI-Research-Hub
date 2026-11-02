import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { currentUser, requireUser } from "../lib/auth.js";
import { projectById } from "../lib/slides/access.js";
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
 */
const hostQuery = z.object({ version: z.uuid() });
const controlParams = z.object({ id: z.uuid() });
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
