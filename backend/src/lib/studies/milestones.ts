/**
 * Milestone updates shared by PATCH `/studies/:ref/milestones/:id` semantics and the agent's `update_milestone`:
 * `done: true` records `milestone_done` once (timeline), anything else only bumps `activity_at`.
 * The caller locks the study and checks edit access first.
 */
import type { Queryable } from "../../db.js";
import type { CurrentUser } from "../auth.js";
import { badRequest, notFound } from "../http.js";
import { studyUrl, type Study } from "./access.js";
import { recordActivity } from "./activity.js";
import { MILESTONE_SELECT, type Milestone } from "./queries.js";

export type MilestonePatch = { title?: string; due_on?: string | null; stage_id?: string | null; done?: boolean };

export async function assertStageOf(client: Queryable, studyId: string, stageId: string | null | undefined) {
  if (!stageId) return;
  const found = await client.query("SELECT 1 FROM study_stages WHERE id=$1 AND study_id=$2", [stageId, studyId]);
  if (!found.rowCount) throw badRequest("階段不存在。");
}

export async function getMilestone(client: Queryable, studyId: string, id: string): Promise<Milestone | null> {
  return (await client.query<Milestone>(`${MILESTONE_SELECT} WHERE m.id=$1 AND m.study_id=$2`, [id, studyId])).rows[0] ?? null;
}

/** Applies the patch; returns the milestone after it and whether it was marked done just now. */
export async function updateMilestone(client: Queryable, study: Pick<Study, "id" | "slug">, user: CurrentUser, id: string, input: MilestonePatch) {
  const current = (await client.query<{ done_at: string | null; title: string }>("SELECT done_at,title FROM milestones WHERE id=$1 AND study_id=$2 FOR UPDATE", [id, study.id])).rows[0];
  if (!current) throw notFound("里程碑不存在。");
  if (input.stage_id !== undefined) await assertStageOf(client, study.id, input.stage_id);
  await client.query(
    `UPDATE milestones SET title=COALESCE($3,title),
            due_on=CASE WHEN $4::boolean THEN $5::date ELSE due_on END,
            stage_id=CASE WHEN $6::boolean THEN $7::uuid ELSE stage_id END,
            done_at=CASE WHEN $8::boolean IS NULL THEN done_at WHEN $8 THEN COALESCE(done_at,now()) ELSE NULL END,
            done_by=CASE WHEN $8::boolean IS NULL THEN done_by WHEN $8 THEN COALESCE(done_by,$9) ELSE NULL END,
            updated_at=now()
      WHERE id=$1 AND study_id=$2`,
    [id, study.id, input.title ?? null, input.due_on !== undefined, input.due_on ?? null, input.stage_id !== undefined, input.stage_id ?? null, input.done ?? null, user.id],
  );
  const justDone = Boolean(input.done && !current.done_at);
  if (justDone) {
    await recordActivity(client, { studyId: study.id, actorId: user.id, kind: "milestone_done", title: input.title ?? current.title, url: studyUrl(study.slug), targetType: "milestone", targetId: id });
  } else {
    await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [study.id]);
  }
  return { milestone: (await getMilestone(client, study.id, id))!, previousTitle: current.title, justDone };
}
