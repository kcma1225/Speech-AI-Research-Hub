/**
 * 「復原」 for tool calls that ran without a consent card (autopilot or a conversation grant): deletes the task / note
 * the call created, or puts back the text a plain-text suggestion target had before an autopilot apply. Safe by
 * construction: only the conversation owner, only the creator of the object, only while it is unchanged since the call.
 */
import type pg from "pg";
import { transaction, type Db } from "../db.js";
import type { CurrentUser } from "../lib/auth.js";
import { conflict, forbidden, notFound } from "../lib/http.js";
import { disconnectNotes, forgetNoteDocs } from "../lib/notes/store.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import { suggestionTarget } from "../lib/suggestions/targets.js";
import type { AgentUndo } from "./tools/registry.js";

type Row = { id: string; status: string; approved_via: string | null; user_id: string; result: { undo?: AgentUndo; undone_at?: string } | null };

const CHANGED = "內容在那之後已被修改，無法自動復原；請到原處手動處理。";

export async function undoToolCall(db: Db, user: CurrentUser, callId: string): Promise<{ undone_at: string; disconnect: string[] }> {
  return transaction(db, async (client) => {
    const row = (await client.query<Row>(
      `SELECT t.id,t.status,t.approved_via,c.user_id,t.result FROM tool_calls t JOIN conversations c ON c.id=t.conversation_id
        WHERE t.id=$1 FOR UPDATE OF t`,
      [callId],
    )).rows[0];
    if (!row || row.user_id !== user.id) throw notFound("找不到這個操作。");
    const undo = row.result?.undo;
    if (row.status !== "done" || !undo || (row.approved_via !== "autopilot" && row.approved_via !== "conversation_grant")) throw conflict("這個操作不能復原。");
    if (row.result?.undone_at) throw conflict("這個操作已經復原過了。");
    const disconnect = await apply(client, user, undo);
    const at = new Date().toISOString();
    await client.query("UPDATE tool_calls SET result = result || jsonb_build_object('undone_at', $2::text) WHERE id=$1", [row.id, at]);
    return { undone_at: at, disconnect };
  });
}

async function apply(client: pg.PoolClient, user: CurrentUser, undo: AgentUndo): Promise<string[]> {
  if (undo.kind === "task") {
    const task = (await client.query<{ created_by: string | null; study_id: string; title: string; stamp: string }>(
      "SELECT created_by,study_id,title,updated_at::text AS stamp FROM tasks WHERE id=$1 FOR UPDATE",
      [undo.id],
    )).rows[0];
    if (!task) throw conflict("這個待辦已經不存在。");
    if (task.created_by !== user.id) throw forbidden("只能復原自己建立的待辦。");
    if (task.stamp !== undo.stamp) throw conflict(CHANGED);
    const access = await loadStudyAccess(client, task.study_id, user);
    if (!access.canEdit) throw forbidden("你已不是這個研究的成員。");
    await client.query("DELETE FROM tasks WHERE id=$1", [undo.id]);
    return [];
  }
  if (undo.kind === "note") {
    const note = (await client.query<{ created_by: string | null; study_id: string; stamp: string }>(
      "SELECT created_by,study_id,updated_at::text || '#' || version AS stamp FROM notes WHERE id=$1 FOR UPDATE",
      [undo.id],
    )).rows[0];
    if (!note) throw conflict("這篇筆記已經不存在。");
    if (note.created_by !== user.id) throw forbidden("只能復原自己建立的筆記。");
    if (note.stamp !== undo.stamp) throw conflict(CHANGED);
    const access = await loadStudyAccess(client, note.study_id, user);
    if (!access.canEdit) throw forbidden("你已不是這個研究的成員。");
    await forgetNoteDocs(client, [undo.id]);
    await client.query("DELETE FROM notes WHERE id=$1", [undo.id]);
    return [undo.id];
  }
  const target = suggestionTarget(undo.targetType);
  if (!target?.readText || !target.writeText) throw conflict("這個操作不能復原。");
  const resolved = await target.resolve(client, undo.targetId);
  if (!resolved || !(await target.canEdit(client, user, resolved))) throw forbidden("你沒有權限修改這份內容。");
  if (undo.targetType === "study_summary") await client.query("SELECT 1 FROM studies WHERE id=$1 FOR UPDATE", [undo.targetId]);
  if ((await target.readText(client, undo.targetId)) !== undo.after) throw conflict(CHANGED);
  await target.writeText(client, undo.targetId, undo.before, user.id);
  if (resolved.studyId) {
    await recordActivity(client, { studyId: resolved.studyId, actorId: user.id, kind: "agent_undo", title: `復原 AI 的修改：${resolved.title}`, targetType: undo.targetType, targetId: undo.targetId, metadata: {} });
  }
  return [];
}

/** Closes collab sessions of deleted notes (after commit). */
export const afterUndo = (ids: string[]) => {
  if (ids.length) disconnectNotes(ids);
};
