/**
 * Suggestion target `deck_source` (target id = `deck_sources.id`, a text file of a deck's Quarto tree). Plain text (no
 * Yjs): accepting writes `deck_sources.content`, bumps the file version and the tree revision.
 */
import { registerSuggestionTarget } from "../suggestions/targets.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SPA path of a deck's Quarto editor, optionally opened on one file. */
export const deckEditorUrl = (studySlug: string, deckId: string, fileId?: string) =>
  `/studies/${encodeURIComponent(studySlug)}/decks/${deckId}/edit${fileId ? `?file=${fileId}` : ""}`;

registerSuggestionTarget({
  type: "deck_source",
  async resolve(db, targetId) {
    if (!UUID.test(targetId)) return null;
    const row = (await db.query<{ path: string; version: number; deck_id: string; study_id: string; slug: string; title: string }>(
      `SELECT f.path,f.version,d.id AS deck_id,d.study_id,s.slug,d.title FROM deck_sources f JOIN decks d ON d.id=f.deck_id JOIN studies s ON s.id=d.study_id
        WHERE f.id=$1 AND f.kind='text'`,
      [targetId],
    )).rows[0];
    return row ? { studyId: row.study_id, docName: null, title: `${row.title} · ${row.path}`, url: deckEditorUrl(row.slug, row.deck_id, targetId), version: row.version } : null;
  },
  async canEdit(db, user, target) {
    const role = (await db.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [target.studyId, user.id])).rows[0]?.role;
    return role === "owner" || role === "member";
  },
  async readText(db, targetId) {
    return (await db.query<{ content: string | null }>("SELECT content FROM deck_sources WHERE id=$1", [targetId])).rows[0]?.content ?? "";
  },
  async writeText(client, targetId, text, actorId) {
    const row = (await client.query<{ deck_id: string }>(
      "UPDATE deck_sources SET content=$2,bytes=octet_length($2),version=version+1,updated_by=COALESCE($3,updated_by),updated_at=now() WHERE id=$1 AND kind='text' RETURNING deck_id",
      [targetId, text, actorId],
    )).rows[0];
    if (!row) return;
    await client.query("UPDATE deck_source_trees SET revision=revision+1,updated_by=COALESCE($2,updated_by),updated_at=now() WHERE deck_id=$1", [row.deck_id, actorId]);
    await client.query("UPDATE decks SET updated_at=now() WHERE id=$1", [row.deck_id]);
  },
});

export const deckSourceTargetRegistered = true;
