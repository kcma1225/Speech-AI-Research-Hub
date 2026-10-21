/**
 * In-process Hocuspocus 4 server (Yjs sync) behind the Fastify WebSocket route `/api/collab`.
 *
 * - Auth: the upgrade request carries the `hub_session` cookie and must come from APP_ORIGIN (checked by the
 *   route, see plugin.ts). Each document is then authorized by its namespace (registry.ts); non-editors get
 *   read-only connections. Every minute open sockets are re-checked (session still valid, access unchanged);
 *   a socket whose access changed is closed and the client reconnects with the new rights.
 * - Persistence: `yjs_docs` (whole-document state). Loading always applies the stored state; a document is only
 *   created from text (`seed`) when no row exists, and that state is saved before any client sees it.
 * - Server-side edits (`edit`) go through a Hocuspocus direct connection, so connected clients receive them.
 */
import { Hocuspocus, type Document } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import * as Y from "yjs";
import { transaction, type Db } from "../db.js";
import { parseDocName, type CollabUser } from "./registry.js";
import { docText, TEXT_FIELD } from "./text.js";

type SocketEntry = { ws: WebSocket; user: CollabUser; sessionHash: string; docs: Map<string, boolean> };
export type CollabContext = { user?: CollabUser; socket?: SocketEntry; actorId?: string | null };

export type CollabOptions = { debounce?: number; maxDebounce?: number; revalidateMs?: number };

/** All live servers in this process (study/target deletion closes documents everywhere). */
const live = new Set<CollabServer>();

export class CollabServer {
  readonly hocuspocus: Hocuspocus<CollabContext>;
  private sockets = new Set<SocketEntry>();
  private editors = new Map<string, Set<string>>();
  private lastActor = new Map<string, string | null>();
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly db: Db,
    readonly log: Pick<FastifyBaseLogger, "warn" | "error" | "info">,
    opts: CollabOptions = {},
  ) {
    this.hocuspocus = new Hocuspocus<CollabContext>({
      name: "hub-collab",
      quiet: true,
      debounce: opts.debounce ?? 2000,
      maxDebounce: opts.maxDebounce ?? 10_000,
      timeout: 60_000,
      unloadImmediately: true,
      onAuthenticate: async ({ documentName, context, connectionConfig }) => {
        const user = context.user;
        const parsed = parseDocName(documentName);
        if (!user || !parsed) throw new Error("forbidden");
        const access = await parsed.ns.authorize(this.db, user, parsed.rest);
        if (!access) throw new Error("forbidden");
        connectionConfig.readOnly = access.readOnly;
        context.socket?.docs.set(documentName, access.readOnly);
      },
      onDisconnect: async ({ documentName, context }) => {
        context?.socket?.docs.delete(documentName);
      },
      onLoadDocument: async ({ documentName, document }) => {
        const state = await this.loadState(documentName);
        if (!state) throw new Error("document not found");
        Y.applyUpdate(document, state);
        return document;
      },
      onChange: async ({ documentName, context, transactionOrigin }) => {
        const origin = transactionOrigin as { source?: string; context?: CollabContext } | undefined;
        const actor = origin?.source === "local" ? (origin.context?.actorId ?? null) : (context?.user?.id ?? null);
        if (origin?.source !== "local" && context?.user) {
          let set = this.editors.get(documentName);
          if (!set) this.editors.set(documentName, (set = new Set()));
          set.add(context.user.id);
        }
        this.lastActor.set(documentName, actor);
      },
      onStoreDocument: async ({ documentName, document }) => {
        await this.store(documentName, document);
      },
    });
    live.add(this);
    this.timer = setInterval(() => void this.revalidate().catch((e) => this.log.warn({ err: e }, "collab revalidate failed")), opts.revalidateMs ?? 60_000);
    this.timer.unref();
  }

  // ---------------------------------------------------------------- persistence

  /** Stored state, or (first open only) the namespace seed saved as the document's first state. */
  private async loadState(name: string): Promise<Uint8Array | null> {
    const row = (await this.db.query<{ state: Buffer }>("SELECT state FROM yjs_docs WHERE name=$1", [name])).rows[0];
    if (row) return new Uint8Array(row.state);
    const parsed = parseDocName(name);
    const text = parsed?.ns.seed ? await parsed.ns.seed(this.db, parsed.rest) : null;
    if (text === null || text === undefined) return null;
    const doc = new Y.Doc();
    if (text) doc.getText(TEXT_FIELD).insert(0, text);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    // Another process may have created it meanwhile: whatever is stored wins.
    await this.db.query("INSERT INTO yjs_docs(name,state,size) VALUES($1,$2,$3) ON CONFLICT (name) DO NOTHING", [name, Buffer.from(state), state.length]);
    const stored = (await this.db.query<{ state: Buffer }>("SELECT state FROM yjs_docs WHERE name=$1", [name])).rows[0];
    return stored ? new Uint8Array(stored.state) : null;
  }

  private async store(name: string, document: Y.Doc) {
    const parsed = parseDocName(name);
    const state = Y.encodeStateAsUpdate(document);
    const text = docText(document);
    const editors = [...(this.editors.get(name) ?? [])];
    const lastActorId = this.lastActor.get(name) ?? editors.at(-1) ?? null;
    this.editors.delete(name);
    await transaction(this.db, async (client) => {
      const result = parsed?.ns.materialize ? await parsed.ns.materialize(client, parsed.rest, text, { editors, lastActorId }) : undefined;
      if (result === "gone") {
        await client.query("DELETE FROM yjs_docs WHERE name=$1", [name]);
        return;
      }
      await client.query(
        `INSERT INTO yjs_docs(name,state,size) VALUES($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET state=EXCLUDED.state, size=EXCLUDED.size, updated_at=now()`,
        [name, Buffer.from(state), state.length],
      );
    });
  }

  // ---------------------------------------------------------------- sockets

  /** Attaches an authenticated WebSocket (the route checked Origin and session). */
  handle(ws: WebSocket, request: Request, user: CollabUser, sessionHash: string) {
    const entry: SocketEntry = { ws, user, sessionHash, docs: new Map() };
    this.sockets.add(entry);
    const client = this.hocuspocus.handleConnection(ws as unknown as globalThis.WebSocket, request, { user, socket: entry });
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      client.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on("pong", () => client.touch());
    ws.on("close", (code: number, reason: Buffer) => {
      this.sockets.delete(entry);
      client.handleClose({ code, reason: reason.toString() });
    });
    ws.on("error", () => ws.terminate());
  }

  /** Re-checks sessions and per-document access of open sockets; closes those that changed. */
  async revalidate() {
    if (this.closed || !this.sockets.size) return;
    const hashes = [...new Set([...this.sockets].map((s) => s.sessionHash))];
    const valid = new Set(
      (
        await this.db.query<{ token_hash: string }>(
          "SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash = ANY($1) AND s.expires_at>now() AND u.disabled_at IS NULL",
          [hashes],
        )
      ).rows.map((r) => r.token_hash),
    );
    for (const entry of this.sockets) {
      let close = !valid.has(entry.sessionHash);
      for (const [name, readOnly] of entry.docs) {
        if (close) break;
        const parsed = parseDocName(name);
        const access = parsed ? await parsed.ns.authorize(this.db, entry.user, parsed.rest).catch(() => null) : null;
        if (!access || access.readOnly !== readOnly) close = true;
      }
      if (close) entry.ws.close(4401, "access changed");
    }
  }

  // ---------------------------------------------------------------- server-side access

  /** The loaded document, if any client (or a server edit) has it open. */
  loaded(name: string): Document | undefined {
    return this.hocuspocus.documents.get(name);
  }

  /**
   * Current text of a document: the live copy when loaded, else the stored state; null when the document has no
   * state yet (never opened and not created).
   */
  async readDoc<T>(name: string, read: (doc: Y.Doc) => T): Promise<T | null> {
    const doc = this.loaded(name);
    if (doc) return read(doc);
    return readStoredDoc(this.db, name, read);
  }

  /**
   * Runs `change` in one Yjs transaction on the live document (loading it if needed) and stores it before
   * resolving, so every connected client gets the change and it is durable. `actorId` is reported to the
   * namespace's `materialize` as the last actor. The callback's return value is passed through.
   */
  async edit<T>(name: string, actorId: string | null, change: (doc: Y.Doc, text: Y.Text) => T): Promise<T> {
    if (this.closed) throw new Error("collab server closed");
    const connection = await this.hocuspocus.openDirectConnection(name, { actorId });
    let result!: T;
    try {
      await connection.transact((doc) => {
        result = change(doc, doc.getText(TEXT_FIELD));
      });
    } finally {
      await connection.disconnect();
    }
    return result;
  }

  /** Sends a stateless message (JSON) to every client of `name`, e.g. `{type:"suggestions"}`. */
  broadcast(name: string, payload: Record<string, unknown>) {
    this.loaded(name)?.broadcastStateless(JSON.stringify(payload));
  }

  /** Disconnects every client of `name` (after the target was deleted or its access changed). */
  closeDocument(name: string) {
    this.hocuspocus.closeConnections(name);
  }

  /** Saves every pending document, then closes all sockets (clients reconnect to the next server). */
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    live.delete(this);
    const docs = [...this.hocuspocus.documents.values()];
    this.hocuspocus.flushPendingStores();
    for (const doc of docs) {
      const id = `onStoreDocument-${doc.name}`;
      for (let i = 0; i < 500 && (this.hocuspocus.debouncer.isCurrentlyExecuting(id) || this.hocuspocus.debouncer.isDebounced(id)); i++) await new Promise((r) => setTimeout(r, 10));
      await doc.saveMutex.waitForUnlock();
    }
    for (const entry of this.sockets) entry.ws.close(1012, "server restart");
    this.sockets.clear();
  }
}

/** Reads a stored document without loading it into the server (any process; null when there is no state). */
export async function readStoredDoc<T>(db: Pick<Db, "query">, name: string, read: (doc: Y.Doc) => T): Promise<T | null> {
  const row = (await db.query<{ state: Buffer }>("SELECT state FROM yjs_docs WHERE name=$1", [name])).rows[0];
  if (!row) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(row.state));
    return read(doc);
  } finally {
    doc.destroy();
  }
}

/** Closes `name` on every collab server in this process (no-op where it is not open). */
export function closeDocumentEverywhere(name: string) {
  for (const server of live) server.closeDocument(name);
}
