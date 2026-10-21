import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { currentUser, SESSION_COOKIE, sha256 } from "../lib/auth.js";
import { CollabServer, type CollabOptions } from "./server.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Collaboration server (src/collab). Registered at the root by routes/notes.ts. */
    collab: CollabServer;
  }
}

/** Collab server bound to an app's database pool (also usable from plugins registered before notes). */
const byDb = new WeakMap<object, CollabServer>();
export function collabFor(app: Pick<FastifyInstance, "db" | "log">, opts?: CollabOptions): CollabServer {
  let server = byDb.get(app.db);
  if (!server) byDb.set(app.db, (server = new CollabServer(app.db, app.log, opts)));
  return server;
}

/** Path of the collaboration WebSocket (HocuspocusProvider `url`: `ws(s)://<host>/api/collab`). */
export const COLLAB_PATH = "/api/collab";

/**
 * Registers @fastify/websocket (once, at the level of `app`; other modules that need WebSocket routes register
 * after notes in app.ts and simply declare `{ websocket: true }`), decorates `app.collab` and adds the
 * `GET /api/collab` upgrade route: Origin must equal APP_ORIGIN (cross-site WebSocket hijacking; the global CSRF
 * hook only covers unsafe methods) and the session cookie must be valid.
 */
export async function registerCollab(app: FastifyInstance, opts: CollabOptions = {}) {
  const server = collabFor(app, opts);
  app.decorate("collab", server);
  const expectedOrigin = new URL(app.config.APP_ORIGIN).origin;

  // Runs before @fastify/websocket's own preClose (registration order): save documents, then close sockets.
  app.addHook("preClose", async () => {
    await server.close();
    byDb.delete(app.db);
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  /** null when the upgrade may proceed, else the HTTP error to answer with. */
  const refuse = async (request: FastifyRequest): Promise<{ status: number; error: string } | null> => {
    if (request.headers.origin !== expectedOrigin) return { status: 403, error: "請從本站重新連線。" };
    if (!(await currentUser(request))) return { status: 401, error: "請重新登入。" };
    return null;
  };

  app.get(
    COLLAB_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const refused = await refuse(request);
        if (refused) return reply.code(refused.status).send({ error: refused.error });
      },
    },
    (socket, request) => {
      const user = request.user!;
      const token = request.cookies[SESSION_COOKIE] ?? "";
      const headers = new Headers();
      for (const name of ["user-agent", "origin"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const fetchRequest = new Request(new URL(request.url, expectedOrigin), { headers });
      server.handle(socket, fetchRequest, { id: user.id, name: user.name, role: user.role, is_admin: user.is_admin, is_owner: user.is_owner }, sha256(token));
    },
  );
}
