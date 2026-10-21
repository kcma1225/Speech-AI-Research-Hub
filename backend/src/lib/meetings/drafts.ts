/**
 * Per-study meeting drafts: edit, dismiss, reopen and confirm. Confirming writes a 會議筆記 note (system template of kind
 * `meeting`) and the tasks (source `meeting`, source_ref = meeting id) into that study, records activity and notifies the
 * study's other members. Only owners/members of the draft's study may do any of this (advisors / professors cannot).
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import type { Notifier } from "../notify.js";
import { createNote, noteUrl } from "../notes/store.js";
import { loadStudyAccess } from "../studies/access.js";
import { recordActivity } from "../studies/activity.js";
import { createTask, dateOnly, type AfterCommit } from "../studies/tasks.js";
import { formatClock, taipeiDate, taipeiDateTime } from "./time.js";
import { meetingUrl, refreshStatus, type DraftRow, type Evidence, type MeetingRow, type ProposedTask } from "./store.js";

export const proposedTaskInput = z.object({
  id: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(4000).default(""),
  assignee_id: z.uuid().nullable().default(null),
  due: dateOnly.nullable().default(null),
});

export const draftPatchInput = z.object({
  summary_md: z.string().max(30000).optional(),
  feedback_md: z.string().max(30000).optional(),
  proposed_tasks: z.array(proposedTaskInput).max(50).optional(),
});

export const confirmInput = z.object({
  summary_md: z.string().max(30000).optional(),
  feedback_md: z.string().max(30000).optional(),
  /** Tasks to create (default: the draft's proposed tasks). */
  tasks: z.array(proposedTaskInput).max(50).optional(),
  note_title: z.string().trim().min(1).max(200).optional(),
});

export const withTaskIds = (tasks: z.infer<typeof proposedTaskInput>[]): ProposedTask[] =>
  tasks.map(t => ({ id: t.id ?? randomUUID(), title: t.title, detail: t.detail, assignee_id: t.assignee_id, due: t.due }));

async function lockDraft(client: Queryable, meetingId: string, draftId: string) {
  const draft = (await client.query<DraftRow>("SELECT * FROM meeting_study_drafts WHERE id=$1 AND meeting_id=$2 FOR UPDATE", [draftId, meetingId])).rows[0];
  if (!draft) throw notFound("草稿不存在。");
  return draft;
}

/** The caller must be an owner/member of the draft's study. */
async function studyEditor(client: Queryable, studyId: string, user: CurrentUser) {
  const access = await loadStudyAccess(client, studyId, user);
  if (!access.canEdit) throw forbidden("只有該研究的成員可以處理這份草稿。");
  return access;
}

export async function patchDraft(client: Queryable, meetingId: string, draftId: string, user: CurrentUser, input: z.infer<typeof draftPatchInput>) {
  const draft = await lockDraft(client, meetingId, draftId);
  await studyEditor(client, draft.study_id, user);
  if (draft.status !== "pending") throw conflict("這份草稿已經處理過了。");
  if (input.proposed_tasks) await checkAssignees(client, draft.study_id, input.proposed_tasks);
  await client.query(
    `UPDATE meeting_study_drafts SET summary_md=COALESCE($2,summary_md), feedback_md=COALESCE($3,feedback_md),
        proposed_tasks=COALESCE($4,proposed_tasks), origin='edited', edited_by=$5, updated_at=now() WHERE id=$1`,
    [draftId, input.summary_md ?? null, input.feedback_md ?? null, input.proposed_tasks ? JSON.stringify(withTaskIds(input.proposed_tasks)) : null, user.id],
  );
}

export async function setDraftStatus(client: Queryable, meetingId: string, draftId: string, user: CurrentUser, to: "dismissed" | "pending") {
  const draft = await lockDraft(client, meetingId, draftId);
  await studyEditor(client, draft.study_id, user);
  if (to === "dismissed" && draft.status !== "pending") throw conflict("這份草稿已經處理過了。");
  if (to === "pending" && draft.status !== "dismissed") throw conflict("只有略過的草稿可以重新開啟。");
  await client.query("UPDATE meeting_study_drafts SET status=$2, confirmed_by=$3, confirmed_at=$4, updated_at=now() WHERE id=$1", [draftId, to, to === "dismissed" ? user.id : null, to === "dismissed" ? new Date() : null]);
  await refreshStatus(client, meetingId);
}

async function checkAssignees(client: Queryable, studyId: string, tasks: { assignee_id: string | null }[]) {
  const ids = [...new Set(tasks.map(t => t.assignee_id).filter((v): v is string => Boolean(v)))];
  if (!ids.length) return;
  const r = await client.query("SELECT user_id FROM study_members WHERE study_id=$1 AND user_id = ANY($2)", [studyId, ids]);
  if (r.rowCount !== ids.length) throw badRequest("負責人必須是研究成員。");
}

/** Markdown of the confirmed meeting note. Evidence links open the meeting at that time (`?t=<seconds>`). */
export function composeNote(meeting: Pick<MeetingRow, "id" | "title" | "held_at">, parts: { summary: string; feedback: string; tasks: ProposedTask[]; evidence: Evidence[]; names: Map<string, string> }) {
  const lines: string[] = [];
  lines.push(`> 來自會議「${meeting.title}」（${taipeiDateTime(meeting.held_at)}）· [開啟會議](${meetingUrl(meeting.id)})`, "");
  lines.push("## 摘要", "", parts.summary.trim() || "（無）", "");
  lines.push("## 回饋", "", parts.feedback.trim() || "（無）", "");
  lines.push("## 待辦", "");
  if (parts.tasks.length) {
    for (const t of parts.tasks) {
      const meta = [t.assignee_id ? `負責：${parts.names.get(t.assignee_id) ?? "成員"}` : null, t.due ? `期限：${t.due}` : null].filter(Boolean).join("，");
      lines.push(`- [ ] ${t.title}${meta ? `（${meta}）` : ""}`);
    }
  } else lines.push("（無）");
  lines.push("");
  if (parts.evidence.length) {
    lines.push("## 逐字稿片段", "");
    for (const e of parts.evidence) lines.push(`- [${formatClock(e.start)}](${meetingUrl(meeting.id, `?t=${Math.floor(e.start)}`)}) 「${e.quote.replace(/\s+/g, " ").trim()}」`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function confirmDraft(
  client: pg.PoolClient,
  notifier: Notifier,
  meeting: MeetingRow,
  draftId: string,
  user: CurrentUser,
  input: z.infer<typeof confirmInput>,
): Promise<{ noteId: string; noteUrl: string; taskIds: string[]; after: AfterCommit[] }> {
  const draft = await lockDraft(client, meeting.id, draftId);
  const access = await studyEditor(client, draft.study_id, user);
  if (draft.status !== "pending") throw conflict("這份草稿已經處理過了。");
  const study = access.study;
  const summary = input.summary_md ?? draft.summary_md;
  const feedback = input.feedback_md ?? draft.feedback_md;
  const tasks = input.tasks ? withTaskIds(input.tasks) : draft.proposed_tasks;
  await checkAssignees(client, study.id, tasks);

  const members = (await client.query<{ id: string; name: string }>("SELECT u.id,u.name FROM study_members sm JOIN users u ON u.id=sm.user_id WHERE sm.study_id=$1", [study.id])).rows;
  const names = new Map(members.map(m => [m.id, m.name]));
  const template = (await client.query<{ id: string }>("SELECT id FROM note_templates WHERE scope='system' AND kind='meeting' ORDER BY position, created_at LIMIT 1")).rows[0];
  const title = input.note_title ?? `會議筆記 ${taipeiDate(meeting.held_at)} ${meeting.title}`.slice(0, 200);
  const content = composeNote(meeting, { summary, feedback, tasks, evidence: draft.evidence, names });
  const noteId = await createNote(client, {
    studyId: study.id, studySlug: study.slug, title, templateId: template?.id ?? null, kind: "meeting", contentMd: content,
    eventDate: taipeiDate(meeting.held_at), actorId: user.id,
  });

  const after: AfterCommit[] = [];
  const taskIds: string[] = [];
  for (const t of tasks) {
    const created = await createTask(client, notifier, study, user, {
      title: t.title, detail_md: t.detail, assignee_id: t.assignee_id, due_on: t.due, source: "meeting", source_ref: meeting.id,
    });
    taskIds.push(created.task.id);
    if (created.after) after.push(created.after);
  }

  await client.query(
    `UPDATE meeting_study_drafts SET status='confirmed', summary_md=$2, feedback_md=$3, proposed_tasks=$4, confirmed_by=$5, confirmed_at=now(),
        note_id=$6, task_ids=$7, updated_at=now() WHERE id=$1`,
    [draft.id, summary, feedback, JSON.stringify(tasks), user.id, noteId, taskIds],
  );
  const url = noteUrl(study.slug, noteId);
  await recordActivity(client, {
    studyId: study.id, actorId: user.id, kind: "meeting_confirmed", title: meeting.title, url, targetType: "meeting", targetId: meeting.id,
    metadata: { noteId, tasks: taskIds.length },
  });
  const others = members.map(m => m.id).filter(id => id !== user.id);
  const notice = { kind: "meeting", title: `${user.name} 確認了會議紀錄`, body: `${study.title}：${meeting.title}（${taskIds.length} 項待辦）`, url };
  await notifier.record(client, others, notice);
  after.push(() => notifier.push(others, notice, { pref: "tasks", tag: `meeting-draft-${draft.id}` }));
  await refreshStatus(client, meeting.id);
  return { noteId, noteUrl: url, taskIds, after };
}
