import { z } from "zod";
import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";
import { badRequest, notFound } from "../http.js";
import type { Notifier } from "../notify.js";
import { recordActivity } from "./activity.js";
import { studyUrl, type Study } from "./access.js";

export type TaskStatus = "open" | "done" | "dropped";
export type TaskSource = "manual" | "meeting" | "ai";

/** `YYYY-MM-DD` (validated as a real calendar date). */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value));

export const taskCreateInput = z.object({
  title: z.string().trim().min(1).max(300),
  detail_md: z.string().max(20000).optional(),
  assignee_id: z.uuid().nullable().optional(),
  due_on: dateOnly.nullable().optional(),
  status: z.enum(["open", "done", "dropped"]).optional(),
  source: z.enum(["manual", "meeting", "ai"]).optional(),
  source_ref: z.string().trim().min(1).max(200).nullable().optional(),
});
export const taskPatchInput = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  detail_md: z.string().max(20000).optional(),
  assignee_id: z.uuid().nullable().optional(),
  due_on: dateOnly.nullable().optional(),
  status: z.enum(["open", "done", "dropped"]).optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateInput>;
export type TaskPatchInput = z.infer<typeof taskPatchInput>;

/** Columns of a task object (alias `t`, joined users `au` assignee, `cu` creator). */
export const TASK_SELECT = `SELECT t.id,t.study_id,t.title,t.detail_md,t.assignee_id,
    CASE WHEN au.id IS NULL THEN NULL ELSE json_build_object('id',au.id,'name',au.name) END AS assignee,
    to_char(t.due_on,'YYYY-MM-DD') AS due_on,t.status,t.source,t.source_ref,t.completed_at,t.completed_by,
    t.created_by,cu.name AS creator_name,t.created_at,t.updated_at
  FROM tasks t LEFT JOIN users au ON au.id=t.assignee_id LEFT JOIN users cu ON cu.id=t.created_by`;

export type Task = {
  id: string;
  study_id: string;
  title: string;
  detail_md: string;
  assignee_id: string | null;
  assignee: { id: string; name: string } | null;
  due_on: string | null;
  status: TaskStatus;
  source: TaskSource;
  source_ref: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
};

export async function getTask(db: Queryable, studyId: string, taskId: string): Promise<Task | null> {
  return (await db.query<Task>(`${TASK_SELECT} WHERE t.id=$1 AND t.study_id=$2`, [taskId, studyId])).rows[0] ?? null;
}

async function assertAssignee(client: Queryable, studyId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const member = await client.query("SELECT 1 FROM study_members WHERE study_id=$1 AND user_id=$2", [studyId, assigneeId]);
  if (!member.rowCount) throw badRequest("負責人必須是研究成員。");
}

/** Post-commit side effect (push) to run after the transaction commits. */
export type AfterCommit = () => Promise<void>;

async function noticeAssignee(client: Queryable, notifier: Notifier, study: Study, actor: CurrentUser, task: { id: string; title: string }, assigneeId: string | null | undefined): Promise<AfterCommit | null> {
  if (!assigneeId || assigneeId === actor.id) return null;
  const notice = { kind: "task", title: `${actor.name} 指派了待辦給你`, body: `${study.title}：${task.title}`, url: studyUrl(study.slug, "tasks") };
  await notifier.record(client, [assigneeId], notice);
  return () => notifier.push([assigneeId], notice, { pref: "tasks", tag: `task-${task.id}` });
}

/**
 * Creates a task in `study` (caller has checked edit access). The assignee must be a study member.
 * Reusable by other modules (meeting drafts, AI tools: pass `source` / `source_ref`). Use the caller's transaction.
 */
export async function createTask(client: Queryable, notifier: Notifier, study: Study, actor: CurrentUser, input: TaskCreateInput): Promise<{ task: Task; after: AfterCommit | null }> {
  await assertAssignee(client, study.id, input.assignee_id);
  const status = input.status ?? "open";
  const id = (await client.query<{ id: string }>(
    `INSERT INTO tasks(study_id,title,detail_md,assignee_id,due_on,status,source,source_ref,created_by,completed_at,completed_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $6='done' THEN now() END,CASE WHEN $6='done' THEN $9::uuid END) RETURNING id`,
    [study.id, input.title, input.detail_md ?? "", input.assignee_id ?? null, input.due_on ?? null, status, input.source ?? "manual", input.source_ref ?? null, actor.id],
  )).rows[0]!.id;
  const task = (await getTask(client, study.id, id))!;
  if (status === "done") await recordActivity(client, { studyId: study.id, actorId: actor.id, kind: "task_done", title: task.title, url: studyUrl(study.slug, "tasks"), targetType: "task", targetId: id });
  else await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
  return { task, after: await noticeAssignee(client, notifier, study, actor, task, input.assignee_id) };
}

/** Partial update; `done` records `task_done` activity, a new assignee is notified. */
export async function updateTask(client: Queryable, notifier: Notifier, study: Study, actor: CurrentUser, taskId: string, input: TaskPatchInput): Promise<{ task: Task; after: AfterCommit | null }> {
  const current = (await client.query<{ status: TaskStatus; assignee_id: string | null }>(
    "SELECT status,assignee_id FROM tasks WHERE id=$1 AND study_id=$2 FOR UPDATE",
    [taskId, study.id],
  )).rows[0];
  if (!current) throw notFound("待辦不存在。");
  if (input.assignee_id !== undefined) await assertAssignee(client, study.id, input.assignee_id);
  const status = input.status ?? current.status;
  await client.query(
    `UPDATE tasks SET title=COALESCE($3,title),detail_md=COALESCE($4,detail_md),
            assignee_id=CASE WHEN $5::boolean THEN $6::uuid ELSE assignee_id END,
            due_on=CASE WHEN $7::boolean THEN $8::date ELSE due_on END,
            status=$9,
            completed_at=CASE WHEN $9='done' AND status<>'done' THEN now() WHEN $9<>'done' THEN NULL ELSE completed_at END,
            completed_by=CASE WHEN $9='done' AND status<>'done' THEN $10::uuid WHEN $9<>'done' THEN NULL ELSE completed_by END,
            updated_at=now()
      WHERE id=$1 AND study_id=$2`,
    [taskId, study.id, input.title ?? null, input.detail_md ?? null, input.assignee_id !== undefined, input.assignee_id ?? null,
      input.due_on !== undefined, input.due_on ?? null, status, actor.id],
  );
  const task = (await getTask(client, study.id, taskId))!;
  if (status === "done" && current.status !== "done") {
    await recordActivity(client, { studyId: study.id, actorId: actor.id, kind: "task_done", title: task.title, url: studyUrl(study.slug, "tasks"), targetType: "task", targetId: taskId });
  } else {
    await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
  }
  const reassigned = input.assignee_id !== undefined && input.assignee_id !== current.assignee_id;
  return { task, after: reassigned ? await noticeAssignee(client, notifier, study, actor, task, input.assignee_id) : null };
}
