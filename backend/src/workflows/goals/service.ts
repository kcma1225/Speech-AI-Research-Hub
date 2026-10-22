/**
 * Goal commands (routes/goals.ts, the chat tools): create (plan → one stage = an ordinary workflow, more = a goal
 * awaiting roadmap approval), approve, edit the roadmap, retry / skip a stage, change the deliverable, cancel, delete.
 * Every command checks ownership; stage runs act with the owner's permissions like any workflow.
 */
import type { FastifyInstance } from "fastify";
import { transaction, type Queryable } from "../../db.js";
import type { CurrentUser } from "../../lib/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { aiFor } from "../../ai/platform/index.js";
import { platformPort } from "../llm.js";
import { getWorkflowPlaybook } from "../playbooks/registry.js";
import { announceRuns, cancelWorkflow, insertWorkflows, type CreateInput } from "../service.js";
import { conversationContext, studyFromText } from "../context.js";
import type { ModelPort, RunRow } from "../types.js";
import { capabilityOf, DELIVERABLE_LABEL, deliverableOf, readinessOf, type DeliverableKind } from "./capabilities.js";
import { goalNotice, moveOn, newStageId, nextPending, startStage } from "./advance.js";
import { MAX_STAGES, planGoal } from "./planner.js";
import { getGoal, goalLog, goalView, saveGoal } from "./store.js";
import { GOAL_ACTIVE, GOAL_FINISHED, type GoalPlan, type GoalRow, type Stage } from "./types.js";

/** Tests replace the planner's model (null = templates only). */
let modelOverride: ModelPort | null | undefined;
export const setGoalModel = (m: ModelPort | null | undefined) => {
  modelOverride = m;
};
export const goalModel = (app: FastifyInstance): ModelPort | null => (modelOverride !== undefined ? modelOverride : platformPort(aiFor(app)));

async function ownGoal(db: Queryable, user: CurrentUser, id: string, forUpdate = false) {
  const g = await getGoal(db, id, forUpdate);
  if (!g || g.user_id !== user.id) throw notFound("找不到這個目標。");
  return g;
}

const toStages = (plan: GoalPlan): Stage[] => {
  const ids = plan.stages.map(() => newStageId());
  return plan.stages.map((d, i) => ({
    id: ids[i]!, playbook: d.playbook, title: d.title, why: d.why, request: d.request, inputs: d.inputs ?? {},
    uses: (d.uses ?? []).map((u) => ids[u]!).filter(Boolean), status: "pending", run_id: null, artifacts: [], added_by: "plan",
  }));
};

/** Under autopilot the roadmap starts at once when every stage only drafts (no library import that waits anyway). */
const autoRoadmap = (autopilot: boolean, stages: Stage[]) => autopilot && stages.every((s) => getWorkflowPlaybook(s.playbook)?.autoApprovable && s.playbook !== "topic_research");

export type GoalInput = CreateInput & { deliverable?: DeliverableKind | null };
export type GoalStart = { kind: "workflow"; runs: RunRow[]; batchId: string | null } | { kind: "goal"; goal: GoalRow };

/**
 * Plans the request. One stage → creates that workflow exactly as `start_workflow` does (no roadmap card). More →
 * a goal (status `awaiting_approval`, or `running` under autopilot when every stage only drafts).
 */
export async function createGoal(app: FastifyInstance, user: CurrentUser, input: GoalInput): Promise<GoalStart> {
  if (user.role === "admin") throw forbidden("管理員帳號只能管理系統設定與使用者。");
  const conv = await conversationContext(app.db, input.conversationId, user.id);
  const ctx = { ...conv, ...(input.context ?? {}) } as Record<string, unknown>;
  let studyRef = input.inputs?.study ?? (ctx.studyId as string | undefined) ?? (ctx.studySlug as string | undefined);
  if (!studyRef) studyRef = (await studyFromText(app.db, user, input.request)) ?? undefined;
  const studyId = studyRef ? (await loadStudyAccess(app.db, studyRef, user)).study.id : null;
  const readiness = await readinessOf(app.db, studyId);
  const plan = await planGoal(goalModel(app), user.id, { request: input.request, readiness, inputs: (input.inputs ?? {}) as Record<string, unknown>, playbook: input.playbook, deliverable: input.deliverable });
  if (plan.stages.length === 1) {
    const only = plan.stages[0]!;
    const out = await transaction(app.db, (client) => insertWorkflows(client, user, { ...input, playbook: only.playbook, context: ctx }));
    await announceRuns(app.db, out.runs);
    return { kind: "workflow", runs: out.runs, batchId: out.batchId };
  }
  const stages = toStages(plan);
  const auto = autoRoadmap(!!input.autopilot, stages);
  const { goal, started } = await transaction(app.db, async (client) => {
    const row = (await client.query<GoalRow>(
      `INSERT INTO workflow_goals(user_id,study_id,conversation_id,tool_call_id,title,request,objective,deliverable,status,stages,autopilot,context,readiness,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_approval',$9,$10,$11,$12,$13) RETURNING *`,
      [user.id, studyId, input.conversationId ?? null, input.toolCallId ?? null, plan.title.slice(0, 160), input.request.slice(0, 4000), plan.objective, JSON.stringify(plan.deliverable), JSON.stringify(stages), !!input.autopilot, JSON.stringify(ctx), JSON.stringify(readiness), JSON.stringify({ template: plan.template, planner: plan.planner, replans: 0, rounds: {} })],
    )).rows[0]!;
    await goalLog(client, row.id, "plan", `擬好 ${stages.length} 個階段的路線圖（${plan.planner === "llm" ? "由規劃者依準備狀況排出" : "依常見做法的範本"}），最終成果：${plan.deliverable.label}。`);
    if (!auto) return { goal: row, started: [] as RunRow[] };
    await goalLog(client, row.id, "approved", "自動駕駛：每個階段都只寫草稿，路線圖自動開始。");
    const g = (await getGoal(client, row.id))!;
    return { goal: g, started: [await startStage(client, g, 0, user)] };
  });
  if (started.length) await announceRuns(app.db, started);
  else await goalNotice(app.db, goal);
  return { kind: "goal", goal: (await getGoal(app.db, goal.id))! };
}

/** 「開始」 on the roadmap card (edits first, then the first pending stage starts). */
export async function approveGoal(app: FastifyInstance, user: CurrentUser, id: string, edits?: StageEdit[]) {
  if (edits?.length) await editStages(app, user, id, edits);
  const started = await transaction(app.db, async (client) => {
    const g = await ownGoal(client, user, id, true);
    if (g.status !== "awaiting_approval") throw conflict("這個路線圖目前不能核准（可能已經開始或已結束）。");
    const idx = nextPending(g.stages);
    if (idx < 0) throw badRequest("路線圖沒有要執行的階段。");
    await saveGoal(client, g.id, { status: "running" });
    await goalLog(client, g.id, "approved", "路線圖已確認，各階段會依序自動執行。");
    return startStage(client, { ...g, status: "running" }, idx, user);
  });
  await announceRuns(app.db, [started]);
  return getGoal(app.db, id);
}

export type StageEdit = { id?: string; playbook?: string; title?: string; request?: string; why?: string; skip?: boolean };

/**
 * Edits the stages that have not started (order = the given list; missing ids are removed; items without id are
 * added; `skip` keeps a stage but skips it). Started / finished stages stay first, unchanged.
 */
export async function editStages(app: FastifyInstance, user: CurrentUser, id: string, list: StageEdit[]) {
  await transaction(app.db, async (client) => {
    const g = await ownGoal(client, user, id, true);
    if (!GOAL_ACTIVE.includes(g.status) || g.status === "planning") throw conflict("這個目標已經結束，不能修改路線圖。");
    const fixed = g.stages.filter((s) => s.status !== "pending" && !(s.status === "skipped" && s.added_by !== "replan" && !s.run_id));
    const editable = new Map(g.stages.filter((s) => !fixed.includes(s)).map((s) => [s.id, s]));
    const next: Stage[] = [];
    for (const e of list) {
      const old = e.id ? editable.get(e.id) : undefined;
      if (e.id && !old) continue;
      const playbook = e.playbook ?? old?.playbook;
      if (!playbook || !getWorkflowPlaybook(playbook) || !capabilityOf(playbook)) throw badRequest(`不認得的工作流程：${playbook ?? ""}`);
      const request = (e.request ?? old?.request ?? "").trim();
      if (!request) throw badRequest("每個階段都要寫要求。");
      next.push({
        ...(old ?? { id: newStageId(), inputs: {}, uses: [], run_id: null, artifacts: [], added_by: "user" as const, why: "" }),
        playbook, title: (e.title ?? old?.title ?? getWorkflowPlaybook(playbook)!.title).slice(0, 80), request: request.slice(0, 2000),
        why: (e.why ?? old?.why ?? "").slice(0, 300), status: e.skip ? "skipped" : "pending",
      } as Stage);
    }
    if (fixed.length + next.length > MAX_STAGES) throw badRequest(`路線圖最多 ${MAX_STAGES} 個階段。`);
    // A new stage uses every earlier stage's output (the planner's hand-over is kept for existing ones).
    const all = [...fixed, ...next].map((s, i, arr) => (s.added_by === "user" && !s.uses.length ? { ...s, uses: arr.slice(0, i).map((x) => x.id) } : s));
    const known = new Set(all.map((s) => s.id));
    const stages = all.map((s) => ({ ...s, uses: s.uses.filter((u) => known.has(u)) }));
    await saveGoal(client, g.id, { stages });
    await goalLog(client, g.id, "edit", `你修改了路線圖：${stages.map((s) => `${s.title}${s.status === "skipped" ? "（略過）" : ""}`).join(" → ")}`);
  });
  // A running goal whose current stage finished meanwhile (nothing running) picks up the edited roadmap.
  const g = await getGoal(app.db, id);
  if (g?.status === "running" && !g.stages.some((s) => s.status === "running" || s.status === "waiting")) await moveOn(app.db, id);
  return getGoal(app.db, id);
}

/** After a failed / stopped stage: 重試 (a new run of that stage), 略過 (skip it and go on). */
export async function resumeGoal(app: FastifyInstance, user: CurrentUser, id: string, action: "retry" | "skip") {
  const started = await transaction(app.db, async (client) => {
    const g = await ownGoal(client, user, id, true);
    if (g.status !== "awaiting_input") throw conflict("這個目標目前不需要你決定。");
    const idx = g.current;
    const stages = g.stages.map((s, i) => (i === idx ? { ...s, status: action === "retry" ? ("pending" as const) : ("skipped" as const) } : s));
    await saveGoal(client, g.id, { stages, status: "running", question: null });
    await goalLog(client, g.id, action, action === "retry" ? `重試「${g.stages[idx]?.title}」。` : `略過「${g.stages[idx]?.title}」，繼續下一個階段。`);
    return action === "retry" ? startStage(client, { ...g, stages, status: "running" }, idx, user) : null;
  });
  if (started) await announceRuns(app.db, [started]);
  else await moveOn(app.db, id);
  return getGoal(app.db, id);
}

/**
 * The user changed the deliverable / objective mid-way (「最後要給我一個 latex 論文」): the stages that ran stay (their
 * outputs are inputs of the new roadmap), the rest is re-planned for the new deliverable; the new roadmap waits for
 * the user's approval unless a stage is running (it then continues with the new roadmap).
 */
export async function updateGoal(app: FastifyInstance, user: CurrentUser, id: string, input: { request: string; deliverable?: DeliverableKind | null }) {
  const g = await ownGoal(app.db, user, id);
  if (g.status === "cancelled") throw conflict("這個目標已經停止，請開始一個新的。");
  // The same deliverable again (「最後要給我一個 latex 論文」 while the paper goal waits): the roadmap already ends with it.
  const kind = input.deliverable ?? deliverableOf(input.request);
  if ((!kind || kind === g.deliverable.kind) && !GOAL_FINISHED.includes(g.status)) {
    await goalLog(app.db, g.id, "update", `你再次確認最終成果是「${g.deliverable.label}」，路線圖不變。`);
    return (await getGoal(app.db, id))!;
  }
  const readiness = await readinessOf(app.db, g.study_id);
  const request = `${g.request}\n\n（使用者更新了目標）${input.request}`.slice(0, 4000);
  const plan = await planGoal(goalModel(app), user.id, { request: input.request.length > 20 ? `${input.request}\n（原本的目標：${g.request.slice(0, 600)}）` : `${g.request}\n${input.request}`, readiness, deliverable: input.deliverable });
  await transaction(app.db, async (client) => {
    const cur = await ownGoal(client, user, id, true);
    const kept = cur.stages.filter((s) => s.status !== "pending");
    const keptIds = kept.filter((s) => s.artifacts.length).map((s) => s.id);
    // Stages the new plan would repeat although they already produced their output are not run again.
    const fresh = toStages(plan).filter((s, i, arr) => i === arr.length - 1 || !kept.some((k) => k.playbook === s.playbook && (k.status === "done" || k.status === "partial")));
    const stages = [...kept, ...fresh.map((s) => ({ ...s, uses: [...keptIds, ...s.uses], added_by: "replan" as const }))].slice(0, MAX_STAGES);
    const working = kept.some((s) => s.status === "running" || s.status === "waiting");
    const status = working ? "running" : "awaiting_approval";
    await saveGoal(client, cur.id, { request, deliverable: plan.deliverable, objective: plan.objective, title: plan.title.slice(0, 160), stages, readiness, status, question: null, report: null, finished_at: null });
    await goalLog(client, cur.id, "update", `最終成果改為「${plan.deliverable.label}」，重新排了剩下的 ${fresh.length} 個階段${working ? "（目前的階段完成後接著做）" : "，請確認後按「開始」"}。`);
  });
  const after = (await getGoal(app.db, id))!;
  if (after.status === "awaiting_approval") await goalNotice(app.db, after);
  return after;
}

export async function cancelGoal(app: FastifyInstance, user: CurrentUser, id: string) {
  const runIds = await transaction(app.db, async (client) => {
    const g = await ownGoal(client, user, id, true);
    if (GOAL_FINISHED.includes(g.status)) throw conflict("這個目標已經結束了。");
    const stages = g.stages.map((s) => (s.status === "pending" || s.status === "running" || s.status === "waiting" ? { ...s, status: "cancelled" as const } : s));
    await saveGoal(client, g.id, { status: "cancelled", stages, question: null, finished_at: new Date().toISOString() });
    await goalLog(client, g.id, "cancelled", "已停止目標；已經寫入的草稿會保留。");
    return g.stages.filter((s) => s.run_id && (s.status === "running" || s.status === "waiting")).map((s) => s.run_id!);
  });
  for (const r of runIds) await cancelWorkflow(app, user, r).catch(() => undefined);
  return getGoal(app.db, id);
}

/** Deletes a goal (stopping it first); its runs stay as ordinary workflows (and their drafts). */
export async function deleteGoal(app: FastifyInstance, user: CurrentUser, id: string) {
  const g = await ownGoal(app.db, user, id);
  if (!GOAL_FINISHED.includes(g.status)) await cancelGoal(app, user, id);
  await app.db.query("DELETE FROM workflow_goals WHERE id=$1", [id]);
}

export async function goalsOf(db: Queryable, user: CurrentUser, q: { conversation?: string; active?: boolean; limit?: number }) {
  const rows = (await db.query<GoalRow>(
    `SELECT * FROM workflow_goals WHERE user_id=$1 AND ($2::uuid IS NULL OR conversation_id=$2) AND ($3::boolean IS NOT TRUE OR status = ANY($4)) ORDER BY created_at DESC LIMIT $5`,
    [user.id, q.conversation ?? null, !!q.active, GOAL_ACTIVE, q.limit ?? 30],
  )).rows;
  return Promise.all(rows.map((g) => goalView(db, g)));
}

export async function goalDetail(db: Queryable, user: CurrentUser, id: string) {
  return goalView(db, await ownGoal(db, user, id));
}

/** The conversation's newest unfinished goal (deliverable changes update it instead of starting unrelated runs). */
export async function activeConversationGoal(db: Queryable, userId: string, conversationId: string | null) {
  if (!conversationId) return null;
  return (await db.query<GoalRow>("SELECT * FROM workflow_goals WHERE conversation_id=$1 AND user_id=$2 AND status <> 'cancelled' AND (status = ANY($3) OR finished_at > now() - interval '7 days') ORDER BY created_at DESC LIMIT 1", [conversationId, userId, GOAL_ACTIVE])).rows[0] ?? null;
}

/** The `start_*` tool result for a goal (the tool row renders the GoalCard on `goal_id`). */
export const goalResult = (g: GoalRow) => ({ goal_id: g.id, status: g.status, deliverable: g.deliverable.kind, stages: g.stages.map((s) => ({ playbook: s.playbook, title: s.title, status: s.status })) });

export { DELIVERABLE_LABEL };
