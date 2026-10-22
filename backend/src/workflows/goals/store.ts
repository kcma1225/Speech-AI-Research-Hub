/** Goal rows: load / save, history lines, the API view (docs/architecture.md "Workflows" → Goals). */
import type { Queryable } from "../../db.js";
import { getWorkflowPlaybook } from "../playbooks/registry.js";
import type { RunRow } from "../types.js";
import { readinessLines } from "./capabilities.js";
import { stageGaps } from "./planner.js";
import { GOAL_FINISHED, type GoalRow, type Stage } from "./types.js";

export async function getGoal(db: Queryable, id: string, forUpdate = false): Promise<GoalRow | null> {
  return (await db.query<GoalRow>(`SELECT * FROM workflow_goals WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
}

const JSON_COLS = new Set(["stages", "deliverable", "readiness", "state", "report", "history", "context"]);

export async function saveGoal(db: Queryable, id: string, patch: Partial<Pick<GoalRow, "status" | "stages" | "current" | "question" | "report" | "finished_at" | "readiness" | "state" | "deliverable" | "objective" | "title" | "request" | "study_id">>) {
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (!cols.length) return;
  await db.query(
    `UPDATE workflow_goals SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")}, updated_at=now() WHERE id=$1`,
    [id, ...cols.map((c) => (JSON_COLS.has(c) && patch[c] != null ? JSON.stringify(patch[c]) : patch[c]))],
  );
}

/** Appends a timeline line (kept to the newest 60). */
export async function goalLog(db: Queryable, id: string, kind: string, text: string) {
  await db.query(
    `UPDATE workflow_goals SET history = (SELECT coalesce(jsonb_agg(h ORDER BY n), '[]'::jsonb) FROM (
        SELECT h, n FROM jsonb_array_elements(history || jsonb_build_array(jsonb_build_object('at', now(), 'kind', $2::text, 'text', $3::text))) WITH ORDINALITY AS x(h, n)
        ORDER BY n DESC LIMIT 60) t), updated_at=now() WHERE id=$1`,
    [id, kind, text.slice(0, 600)],
  );
}

const NEEDS_YOU_RUN = new Set(["awaiting_plan_approval", "awaiting_input", "needs_pdf"]);

export type StageView = Stage & { playbook_title: string; playbook_title_en: string; run_status: string | null; gaps: string[] };

export async function goalView(db: Queryable, g: GoalRow) {
  const ids = g.stages.map((s) => s.run_id).filter((x): x is string => !!x);
  const runs = ids.length ? (await db.query<Pick<RunRow, "id" | "status" | "artifacts" | "question">>("SELECT id, status, artifacts, question FROM workflow_runs WHERE id = ANY($1::uuid[])", [ids])).rows : [];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const study = g.study_id ? (await db.query<{ id: string; slug: string; title: string }>("SELECT id, slug, title FROM studies WHERE id=$1", [g.study_id])).rows[0] ?? null : null;
  const stages: StageView[] = g.stages.map((s) => {
    const pb = getWorkflowPlaybook(s.playbook);
    const run = s.run_id ? byId.get(s.run_id) : undefined;
    // A waiting stage the user answered works again (and vice versa) until its job reports back.
    const live = run && (s.status === "running" || s.status === "waiting") ? (NEEDS_YOU_RUN.has(run.status) || run.status === "paused" ? "waiting" : "running") : s.status;
    return {
      ...s,
      status: live,
      artifacts: run?.artifacts?.length ? run.artifacts : s.artifacts,
      playbook_title: pb?.title ?? s.playbook,
      playbook_title_en: pb?.titleEn ?? s.playbook,
      run_status: run?.status ?? (s.run_id ? "deleted" : null),
      gaps: s.status === "pending" && g.readiness ? stageGaps(s.playbook, g.readiness, s.inputs) : [],
    };
  });
  const cur = stages[g.current];
  // What the user should do: approve the roadmap, decide about a failed stage, or the current stage's own card.
  const stageWaits = g.status === "running" && !!cur?.run_status && NEEDS_YOU_RUN.has(cur.run_status);
  const action = g.status === "awaiting_approval" ? "approve_plan" : g.status === "awaiting_input" ? "answer" : stageWaits ? (cur!.run_status === "awaiting_plan_approval" ? "approve_plan" : "answer") : null;
  return {
    id: g.id,
    title: g.title,
    request: g.request,
    objective: g.objective,
    deliverable: g.deliverable,
    status: g.status,
    needs_you: !!action,
    action,
    question: g.question ?? (stageWaits ? cur?.title ?? null : null),
    stages,
    current: g.current,
    autopilot: g.autopilot,
    readiness: g.readiness ? readinessLines(g.readiness) : [],
    planner: g.state?.planner ?? "template",
    history: (g.history ?? []).slice(-20),
    report: g.report,
    conversation_id: g.conversation_id,
    tool_call_id: g.tool_call_id,
    study,
    finished: GOAL_FINISHED.includes(g.status),
    created_at: g.created_at,
    updated_at: g.updated_at,
    finished_at: g.finished_at,
  };
}
export type GoalView = Awaited<ReturnType<typeof goalView>>;
