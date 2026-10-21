/**
 * Notes domain helpers: queries, versions, the `note:<id>` collab namespace and the `note` suggestion target.
 * Notes are edited in real time through Yjs (doc `note:<id>`); `notes.content_md` is the materialized copy.
 */
import type pg from "pg";
import type { Db, Queryable } from "../../db.js";
import { registerCollabNamespace, type CollabUser } from "../../collab/registry.js";
import { initialState } from "../../collab/text.js";
import { markdownExcerpt } from "../text/excerpt.js";
import { recordActivity, touchStudy } from "../studies/activity.js";
import { studyUrl } from "../studies/access.js";
import { registerSuggestionTarget, type SuggestionSource } from "../suggestions/targets.js";
import { closeDocumentEverywhere } from "../../collab/server.js";

export type NoteKind = "research" | "experiment" | "reading" | "meeting" | "custom";
export const NOTE_KINDS: NoteKind[] = ["research", "experiment", "reading", "meeting", "custom"];

export const noteDocName = (noteId: string) => `note:${noteId}`;
export const noteUrl = (slug: string, noteId: string) => `/studies/${encodeURIComponent(slug)}/notes/${noteId}`;

/** Auto snapshots: at most one per this interval while a note is being edited. */
export const AUTO_VERSION_MS = 10 * 60_000;

export type NoteRow = {
  id: string;
  study_id: string;
  template_id: string | null;
  template_name: string | null;
  kind: NoteKind;
  title: string;
  content_md: string;
  event_date: string | null;
  version: number;
  created_by: string | null;
  creator_name: string | null;
  updated_by: string | null;
  updater_name: string | null;
  created_at: string;
  updated_at: string;
};
export type NoteCard = Omit<NoteRow, "content_md"> & { excerpt: string; pending_suggestions: number };

export const NOTE_SELECT = `SELECT n.id,n.study_id,n.template_id,t.name AS template_name,n.kind,n.title,n.content_md,
  to_char(n.event_date,'YYYY-MM-DD') AS event_date,n.version,n.created_by,cu.name AS creator_name,n.updated_by,uu.name AS updater_name,
  n.created_at,n.updated_at
  FROM notes n LEFT JOIN note_templates t ON t.id=n.template_id
  LEFT JOIN users cu ON cu.id=n.created_by LEFT JOIN users uu ON uu.id=n.updated_by`;

export async function findNote(db: Queryable, id: string, forUpdate = false): Promise<NoteRow | null> {
  return (await db.query<NoteRow>(`${NOTE_SELECT} WHERE n.id=$1${forUpdate ? " FOR UPDATE OF n" : ""}`, [id])).rows[0] ?? null;
}

// ---------------------------------------------------------------- list + search hook

export type NoteListFilter = { q?: string; templateId?: string; kind?: NoteKind; authorId?: string; limit?: number };

/**
 * Search hook: the search module may register a provider that returns note ids ranked for `q` (semantic search),
 * or null to fall back to keyword search (ILIKE on title + content).
 */
export type NoteSearchProvider = (db: Queryable, studyId: string, q: string, limit: number) => Promise<string[] | null>;
let searchProvider: NoteSearchProvider | null = null;
export const setNoteSearchProvider = (provider: NoteSearchProvider | null) => void (searchProvider = provider);

const likeEscape = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listNotes(db: Queryable, studyId: string, filter: NoteListFilter = {}): Promise<{ notes: NoteCard[]; search_mode: "semantic" | "keyword" | null }> {
  const where = ["n.study_id=$1"];
  const params: unknown[] = [studyId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filter.templateId) add("n.template_id=?", filter.templateId);
  if (filter.kind) add("n.kind=?", filter.kind);
  if (filter.authorId) add("n.created_by=?", filter.authorId);
  const limit = Math.min(filter.limit ?? 300, 500);
  let ranked: string[] | null = null;
  let mode: "semantic" | "keyword" | null = null;
  const q = filter.q?.trim();
  if (q) {
    ranked = searchProvider ? await searchProvider(db, studyId, q, limit).catch(() => null) : null;
    if (ranked) {
      mode = "semantic";
      add("n.id = ANY(?)", ranked);
    } else {
      mode = "keyword";
      params.push(`%${likeEscape(q)}%`);
      const k = `$${params.length}`;
      where.push(`(n.title ILIKE ${k} ESCAPE '\\' OR n.content_md ILIKE ${k} ESCAPE '\\')`);
    }
  }
  params.push(limit);
  const rows = (
    await db.query<NoteRow & { pending_suggestions: number }>(
      `${NOTE_SELECT.replace("n.content_md,", "left(n.content_md, 2000) AS content_md,")}
         ,LATERAL (SELECT count(*)::int AS pending_suggestions FROM suggestions s WHERE s.target_type='note' AND s.target_id=n.id::text AND s.status='pending') ps
       WHERE ${where.join(" AND ")}
       ORDER BY coalesce(n.event_date, n.created_at::date) DESC, n.updated_at DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  let notes = rows.map(({ content_md, ...rest }) => ({ ...rest, excerpt: markdownExcerpt(content_md, 160) }));
  if (ranked) {
    const order = new Map(ranked.map((id, i) => [id, i]));
    notes = notes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  return { notes, search_mode: mode };
}

// ---------------------------------------------------------------- create / versions

export async function createNote(
  client: pg.PoolClient,
  input: { studyId: string; studySlug: string; title: string; templateId: string | null; kind: NoteKind; contentMd: string; eventDate: string | null; actorId: string; author?: "user" | "ai" },
): Promise<string> {
  const id = (
    await client.query<{ id: string }>(
      `INSERT INTO notes(study_id,template_id,kind,title,content_md,event_date,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [input.studyId, input.templateId, input.kind, input.title, input.contentMd, input.eventDate, input.actorId],
    )
  ).rows[0]!.id;
  // The Yjs state exists from the start, so the document is never seeded from text later.
  const state = initialState(input.contentMd);
  await client.query("INSERT INTO yjs_docs(name,state,size) VALUES($1,$2,$3)", [noteDocName(id), Buffer.from(state), state.length]);
  await addVersion(client, id, { kind: "initial", label: "", content: input.contentMd, author: input.author ?? "user", actorId: input.actorId });
  await recordActivity(client, {
    studyId: input.studyId, actorId: input.actorId, kind: "note_created", title: input.title, url: noteUrl(input.studySlug, id), targetType: "note", targetId: id,
  });
  return id;
}

export type VersionKind = "initial" | "auto" | "manual" | "suggestion" | "autopilot" | "restore";

export async function addVersion(client: Queryable, noteId: string, v: { kind: VersionKind; label: string; content: string; author: "user" | "ai"; actorId: string | null }) {
  const version = (await client.query<{ version: number }>("UPDATE notes SET version=version+1 WHERE id=$1 RETURNING version", [noteId])).rows[0]?.version;
  if (!version) return null;
  return (
    await client.query<{ id: string; version: number }>(
      "INSERT INTO note_versions(note_id,version,kind,label,content_md,author,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,version",
      [noteId, version, v.kind, v.label.slice(0, 200), v.content, v.author, v.actorId],
    )
  ).rows[0]!;
}

async function latestVersion(client: Queryable, noteId: string) {
  return (await client.query<{ content_md: string; created_at: Date }>("SELECT content_md,created_at FROM note_versions WHERE note_id=$1 ORDER BY version DESC LIMIT 1", [noteId])).rows[0] ?? null;
}

/** Deletes a note's Yjs state and suggestions (rows cascade from notes) and disconnects its editors. */
export async function forgetNoteDocs(client: Queryable, noteIds: string[]) {
  if (!noteIds.length) return;
  await client.query("DELETE FROM yjs_docs WHERE name = ANY($1)", [noteIds.map(noteDocName)]);
  await client.query("DELETE FROM suggestions WHERE target_type='note' AND target_id = ANY($1)", [noteIds]);
}
export const disconnectNotes = (noteIds: string[]) => noteIds.forEach((id) => closeDocumentEverywhere(noteDocName(id)));

// ---------------------------------------------------------------- collab namespace + suggestion target

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function noteAccess(db: Queryable, noteId: string, user: Pick<CollabUser, "id">) {
  if (!UUID.test(noteId)) return null;
  const row = (
    await db.query<{ study_id: string; slug: string; title: string; version: number; role: string | null }>(
      `SELECT n.study_id, s.slug, n.title, n.version, m.role FROM notes n JOIN studies s ON s.id=n.study_id
         LEFT JOIN study_members m ON m.study_id=n.study_id AND m.user_id=$2 WHERE n.id=$1`,
      [noteId, user.id],
    )
  ).rows[0];
  return row ? { ...row, canEdit: row.role === "owner" || row.role === "member" } : null;
}

registerCollabNamespace({
  prefix: "note",
  // Everyone signed in reads every study; only owner/member edit.
  async authorize(db, user, rest) {
    const access = await noteAccess(db, rest, user);
    return access ? { readOnly: !access.canEdit } : null;
  },
  // Only for notes created without a state (e.g. inserted by another module): seed once from content_md.
  async seed(db, rest) {
    if (!UUID.test(rest)) return null;
    return (await db.query<{ content_md: string }>("SELECT content_md FROM notes WHERE id=$1", [rest])).rows[0]?.content_md ?? null;
  },
  async materialize(client, rest, text, info) {
    const note = (
      await client.query<{ study_id: string; changed: boolean }>(
        `UPDATE notes SET content_md=$2, updated_at=CASE WHEN content_md IS DISTINCT FROM $2 THEN now() ELSE updated_at END,
                updated_by=CASE WHEN content_md IS DISTINCT FROM $2 THEN coalesce($3::uuid, updated_by) ELSE updated_by END
          WHERE id=$1 RETURNING study_id, true AS changed`,
        [rest, text, info.lastActorId],
      )
    ).rows[0];
    if (!note) return "gone";
    if (!info.editors.length) return;
    await touchStudy(client, note.study_id, info.lastActorId);
    const last = await latestVersion(client, rest);
    if (last && last.content_md === text) return;
    if (!last || Date.now() - new Date(last.created_at).getTime() >= AUTO_VERSION_MS) {
      await addVersion(client, rest, { kind: "auto", label: "", content: text, author: "user", actorId: info.lastActorId });
    }
  },
});

const versionLabel = (source: SuggestionSource, n: number) =>
  source === "autopilot" ? `自動駕駛套用建議 · ${n} 處` : source === "ai" ? `接受 AI 建議 · ${n} 處` : `接受建議 · ${n} 處`;

registerSuggestionTarget({
  type: "note",
  async resolve(db, targetId) {
    if (!UUID.test(targetId)) return null;
    const row = (await db.query<{ study_id: string; slug: string; title: string; version: number }>(
      "SELECT n.study_id, s.slug, n.title, n.version FROM notes n JOIN studies s ON s.id=n.study_id WHERE n.id=$1",
      [targetId],
    )).rows[0];
    return row ? { studyId: row.study_id, docName: noteDocName(targetId), title: row.title, url: noteUrl(row.slug, targetId), version: row.version } : null;
  },
  async canEdit(db, user, target) {
    const role = (await db.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [target.studyId, user.id])).rows[0]?.role;
    return role === "owner" || role === "member";
  },
  async afterApply(client, targetId, info) {
    await client.query("UPDATE notes SET content_md=$2, updated_at=now(), updated_by=coalesce($3, updated_by) WHERE id=$1", [targetId, info.text, info.actorId]);
    await addVersion(client, targetId, {
      kind: info.source === "autopilot" ? "autopilot" : "suggestion",
      label: versionLabel(info.source, info.accepted),
      content: info.text,
      author: info.suggestion.source === "user" ? "user" : "ai",
      actorId: info.actorId,
    });
  },
});

/** Ensures this module's registrations ran (import side effects). */
export const notesRegistered = true;
export type { Db };
