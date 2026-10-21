/**
 * Collaborative document namespaces. A document name is `<prefix>:<rest>` (e.g. `note:<noteId>`,
 * `latex:<projectId>:<fileId>`); the module that owns the prefix decides who may open it, what a brand-new
 * document contains and how its text is materialized into domain rows. Register at import/plugin time:
 *
 *   registerCollabNamespace({ prefix: "latex", authorize, seed, materialize });
 *
 * Registration is process-wide (like registerStudyCleanup); re-registering a prefix replaces it.
 */
import type pg from "pg";
import type { Db } from "../db.js";

export type CollabUser = { id: string; name: string; role: "student" | "professor" | "admin"; is_admin: boolean; is_owner: boolean };

export type DocAccess = {
  /** Read-only connections receive updates but every change they send is dropped by the server. */
  readOnly: boolean;
};

export type MaterializeInfo = {
  /** Users whose connections changed the document since the previous store (server-side changes excluded). */
  editors: string[];
  /** Origin of the latest change: a user id for editors, or the `actorId` of a server-side change. */
  lastActorId: string | null;
};

export type CollabNamespace = {
  /** Lower snake case, unique. */
  prefix: string;
  /**
   * Called for every connection to a document of this namespace (and again every minute while it stays open, so
   * membership changes take effect). Return null to refuse (the client gets "permission denied").
   */
  authorize(db: Db, user: CollabUser, rest: string): Promise<DocAccess | null>;
  /**
   * Text of a document that has **no Yjs state at all** yet (first open). Return null when the target does not
   * exist (the connection is refused). Never called once a `yjs_docs` row exists — a document is never rebuilt
   * from text. Modules should rather create the state when they create the target (`initialState`).
   */
  seed?(db: Db, rest: string): Promise<string | null>;
  /**
   * After every store (debounced ~2 s, max ~10 s, and on unload/shutdown), inside the transaction that saves
   * the Yjs state: copy the text to domain rows (search, export, compile…). Return "gone" when the target was
   * deleted: the state is then not saved (and any stored row is removed).
   */
  materialize?(client: pg.PoolClient, rest: string, text: string, info: MaterializeInfo): Promise<void | "gone">;
};

const namespaces = new Map<string, CollabNamespace>();

export function registerCollabNamespace(ns: CollabNamespace) {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(ns.prefix)) throw new Error(`invalid collab prefix ${ns.prefix}`);
  namespaces.set(ns.prefix, ns);
}

const NAME = /^([a-z][a-z0-9_]{0,31}):([A-Za-z0-9:_-]{1,200})$/;

/** Splits a document name into its namespace and the rest; null for unknown prefixes or malformed names. */
export function parseDocName(name: string): { ns: CollabNamespace; rest: string } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const ns = namespaces.get(m[1]!);
  return ns ? { ns, rest: m[2]! } : null;
}
