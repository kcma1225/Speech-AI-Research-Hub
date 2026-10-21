import type { Queryable } from "../../db.js";

/**
 * Core activity kinds. Modules may record their own (lower snake case, e.g. `note_created`, `meeting_confirmed`);
 * the dashboard shows every kind with its `title` and `url`.
 */
export type CoreActivityKind =
  | "study_created"
  | "stage_changed"
  | "milestone_done"
  | "task_done"
  | "deck_published"
  | "member_added";

export type ActivityInput = {
  studyId: string;
  actorId: string | null;
  kind: CoreActivityKind | (string & {});
  /** Human-readable subject, e.g. the task title or `<deck> v3` (≤ 300 chars, truncated). */
  title: string;
  /** SPA path to open (e.g. `/studies/<slug>?tab=tasks`). */
  url?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends to the study timeline and bumps `studies.activity_at`. Call it with the transaction client of the
 * change it describes, so both commit together.
 */
export async function recordActivity(client: Queryable, input: ActivityInput) {
  await client.query(
    `INSERT INTO study_activity(study_id,actor_id,kind,target_type,target_id,title,url,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.studyId, input.actorId, input.kind, input.targetType ?? null, input.targetId ?? null, input.title.slice(0, 300), input.url ?? null, JSON.stringify(input.metadata ?? {})],
  );
  await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [input.studyId]);
}

/** Marks the study as recently changed without a timeline entry (e.g. a summary edit). */
export async function touchStudy(client: Queryable, studyId: string, userId: string | null) {
  await client.query("UPDATE studies SET activity_at=now(),updated_at=now(),updated_by=COALESCE($2,updated_by) WHERE id=$1", [studyId, userId]);
}
