/** Suggestion target `study_summary` (target id = study id): plain text `studies.summary_md`, no Yjs. */
import { recordActivity } from "../studies/activity.js";
import { studyUrl } from "../studies/access.js";
import { registerSuggestionTarget } from "./targets.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

registerSuggestionTarget({
  type: "study_summary",
  async resolve(db, targetId) {
    if (!UUID.test(targetId)) return null;
    const row = (await db.query<{ id: string; slug: string; title: string }>("SELECT id, slug, title FROM studies WHERE id=$1", [targetId])).rows[0];
    return row ? { studyId: row.id, docName: null, title: row.title, url: studyUrl(row.slug) } : null;
  },
  async canEdit(db, user, target) {
    const role = (await db.query<{ role: string }>("SELECT role FROM study_members WHERE study_id=$1 AND user_id=$2", [target.studyId, user.id])).rows[0]?.role;
    return role === "owner" || role === "member";
  },
  async readText(db, targetId) {
    return (await db.query<{ summary_md: string }>("SELECT summary_md FROM studies WHERE id=$1", [targetId])).rows[0]?.summary_md ?? "";
  },
  async writeText(client, targetId, text, actorId) {
    await client.query("UPDATE studies SET summary_md=$2, updated_at=now(), updated_by=coalesce($3, updated_by) WHERE id=$1", [targetId, text, actorId]);
  },
  async afterApply(client, targetId, info) {
    await recordActivity(client, {
      studyId: targetId, actorId: info.actorId, kind: "summary_suggestion_applied", title: info.suggestion.title || "研究簡述", targetType: "study", targetId,
      metadata: { hunks: info.accepted, source: info.source },
    });
  },
});

export const studySummaryRegistered = true;
