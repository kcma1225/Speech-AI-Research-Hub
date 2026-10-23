/**
 * Moving a goal along its roadmap (docs/architecture.md "Workflows" → Goals). A stage starts as an ordinary workflow
 * run (`workflow_runs.goal_id` / `goal_stage`, the per-user queue applies) with the outputs of the stages it `uses`
 * as inputs (notes → `note_ids`, a LaTeX project → `project_id`). When the run ends (`goalAfterRun`, called by the
 * engine when its job stops, and by cancel), the stage records the run's outcome and artifacts; done / partial →
 * re-plan the rest (planner.ts) and start the next stage automatically; failed / cancelled by the user → the goal
 * waits (`awaiting_input`: 重試 / 略過 / 停止). The last stage ends the goal (`done`, or `partial` when a stage was
 * partial / skipped / failed), with a notice in the conversation and a notification.
 */
import { randomUUID } from "node:crypto";
import { insertEvent } from "../../agent/events.js";
import { messageView, type MessageRow } from "../../agent/views.js";
import { transaction, type Db, type Queryable } from "../../db.js";
import { CURRENT_USER_COLUMNS, toCurrentUser, type CurrentUser } from "../../lib/auth.js";
import { focusHref } from "../active.js";
import { insertWorkflows, announceRuns } from "../service.js";
import { getRun } from "../store.js";
import type { ModelPort, RunRow } from "../types.js";
import { capabilityOf, readinessOf } from "./capabilities.js";
import { replanAfter } from "./planner.js";
import { getGoal, goalLog, saveGoal } from "./store.js";
import { GOAL_FINISHED, type GoalRow, type Stage } from "./types.js";

const WAITING = new Set(["awaiting_plan_approval", "awaiting_input", "needs_pdf", "paused"]);
const WORKING = new Set(["queued", "planning", "running", "verifying"]);

export const newStageId = () => `s_${randomUUID().slice(0, 8)}`;

async function ownerOf(db: Queryable, userId: string): Promise<CurrentUser | null> {
  const row = (await db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL`, [userId])).rows[0];
  return row ? toCurrentUser(row) : null;
}

/** Inputs of a stage: its own + the artifacts of the stages it uses. */
export function stageInputs(goal: GoalRow, stage: Stage): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ...(goal.study_id ? { study: goal.study_id } : {}), ...stage.inputs };
  const notes = new Set<string>(Array.isArray(stage.inputs.note_ids) ? (stage.inputs.note_ids as string[]) : []);
  for (const id of stage.uses) {
    const used = goal.stages.find((s) => s.id === id);
    for (const a of used?.artifacts ?? []) {
      if (a.kind === "note" && a.role !== "suggestion") notes.add(a.id);
      if (a.kind === "latex_project" && !inputs.project_id) inputs.project_id = a.id;
      if (a.kind === "deck" && !inputs.deck_id) inputs.deck_id = a.id;
    }
  }
  if (notes.size) inputs.note_ids = [...notes].slice(-6);
  return inputs;
}

/** Starts stage `idx` as a workflow run (inside `client`'s transaction). Returns the run. */
export async function startStage(client: Queryable, goal: GoalRow, idx: number, owner: CurrentUser): Promise<RunRow> {
  const stage = goal.stages[idx]!;
  const total = goal.stages.filter((s) => s.status !== "skipped").length;
  const request = `${stage.request}\n\n（目標「${goal.title}」的第 ${idx + 1}/${total} 個階段${stage.why ? `：${stage.why}` : ""}；最終成果：${goal.deliverable.label}）`.slice(0, 4000);
  // The stage's Brief: the goal's user words (verbatim; the stage request is the planner's paraphrase) and the stage's
  // own deliverable — the playbook is fixed, so no fallback can turn e.g. the LaTeX stage into a note without asking.
  const out = await insertWorkflows(client, owner, { request, playbook: stage.playbook, conversationId: goal.conversation_id, toolCallId: null, context: goal.context, inputs: stageInputs(goal, stage) as never, autopilot: goal.autopilot, userWords: goal.brief?.user_words?.length ? goal.brief.user_words : [goal.request] });
  const run = out.runs[0]!;
  await client.query("UPDATE workflow_runs SET goal_id=$2, goal_stage=$3 WHERE id = ANY($1::uuid[])", [out.runs.map((r) => r.id), goal.id, stage.id]);
  const stages = goal.stages.map((s, i) => (i === idx ? { ...s, status: "running" as const, run_id: run.id, artifacts: [], summary: undefined, issues: undefined } : s));
  const rounds = { ...(goal.state.rounds ?? {}), [stage.playbook]: (goal.state.rounds?.[stage.playbook] ?? 0) + 1 };
  await saveGoal(client, goal.id, { stages, current: idx, status: "running", question: null, state: { ...goal.state, rounds } });
  goal.stages = stages;
  goal.current = idx;
  goal.status = "running";
  await goalLog(client, goal.id, "stage", `開始第 ${idx + 1} 個階段「${stage.title}」${run.status === "queued" ? "（排隊中）" : ""}。`);
  return { ...run, goal_id: goal.id, goal_stage: stage.id };
}

/** Index of the next stage to run (pending, after the finished ones). */
export const nextPending = (stages: Stage[]) => stages.findIndex((s) => s.status === "pending");

/**
 * Starts the next pending stage or finishes the goal. `model` re-plans first after a finished stage (`afterIdx`).
 * Takes the goal lock itself; a goal that changed meanwhile (cancelled, a stage already running) is left alone.
 */
export async function moveOn(db: Db, goalId: string, opts: { model?: ModelPort | null; afterIdx?: number | null } = {}) {
  const pre = await getGoal(db, goalId);
  if (!pre || pre.status !== "running") return;
  let replan: Awaited<ReturnType<typeof replanAfter>> = null;
  let readiness = pre.readiness;
  if (opts.afterIdx != null) {
    readiness = await readinessOf(db, pre.study_id);
    replan = await replanAfter(opts.model ?? null, pre, opts.afterIdx, readiness, newStageId).catch(() => null);
  }
  const started: RunRow[] = [];
  let finished: GoalRow | null = null;
  await transaction(db, async (client) => {
    const g = await getGoal(client, goalId, true);
    if (!g || g.status !== "running" || g.stages.some((s) => s.status === "running" || s.status === "waiting")) return;
    // The roadmap may have been edited meanwhile: apply the re-plan only over the same pending stages.
    const samePending = (a: Stage[], b: Stage[]) => a.filter((s) => s.status === "pending").map((s) => s.id).join() === b.filter((s) => s.status === "pending").map((s) => s.id).join();
    if (replan && samePending(pre.stages, g.stages)) {
      g.stages = replan.stages;
      await saveGoal(client, g.id, { stages: g.stages, state: { ...g.state, replans: (g.state.replans ?? 0) + 1 } });
      await goalLog(client, g.id, "replan", replan.note);
    }
    if (readiness) await saveGoal(client, g.id, { readiness });
    g.readiness = readiness;
    const idx = nextPending(g.stages);
    if (idx < 0) {
      finished = await finishGoal(client, g);
      return;
    }
    const owner = await ownerOf(client, g.user_id);
    if (!owner) {
      await saveGoal(client, g.id, { status: "failed", finished_at: new Date().toISOString(), question: null });
      return;
    }
    started.push(await startStage(client, g, idx, owner));
  });
  if (started.length) await announceRuns(db, started);
  if (finished) await goalNotice(db, finished);
}

/** End state + report: done when every stage that ran is done (stages switched off on the roadmap do not count), else partial; failed when the deliverable stage produced nothing. */
async function finishGoal(client: Queryable, g: GoalRow): Promise<GoalRow> {
  const ran = g.stages.filter((s) => s.status !== "skipped" && s.status !== "cancelled");
  const last = [...g.stages].reverse().find((s) => s.status !== "skipped" && s.status !== "cancelled") ?? null;
  const producesDeliverable = !!last && capabilityOf(last.playbook)?.produces === g.deliverable.kind && last.artifacts.length > 0;
  // A stage skipped after it ran (failed, then 略過) leaves the goal partial; one switched off on the roadmap does not.
  const allDone = ran.length > 0 && ran.every((s) => s.status === "done") && g.stages.every((s) => s.status !== "failed" && !(s.status === "skipped" && s.run_id));
  const status = !last || !last.artifacts.length ? "failed" : allDone && producesDeliverable ? "done" : "partial";
  const issues: string[] = [];
  for (const s of g.stages) {
    if (s.status === "partial") issues.push(`「${s.title}」部分完成${s.issues?.length ? `：${s.issues.slice(0, 2).join("；")}` : ""}`);
    if (s.status === "failed") issues.push(`「${s.title}」沒有完成`);
    if (s.status === "skipped" && s.run_id) issues.push(`「${s.title}」沒有完成，已略過`);
  }
  if (!producesDeliverable) issues.push(`沒有產生最終成果「${g.deliverable.label}」${g.deliverable.note ? `（${g.deliverable.note}）` : ""}`);
  const done = g.stages.filter((s) => s.status === "done" || s.status === "partial").map((s) => `${s.title}${s.status === "partial" ? "（部分完成）" : ""}`);
  const artifacts = g.stages.flatMap((s) => s.artifacts.filter((a) => a.role !== "suggestion"));
  const deliverableLinks = last?.artifacts.filter((a) => a.role !== "suggestion") ?? [];
  const summary = [
    status === "done" ? `**已完成**：${g.deliverable.label}。` : status === "partial" ? `**部分完成**：${g.deliverable.label}${producesDeliverable ? "已產生，但有階段沒有完全通過驗收" : "沒有完整產生"}。` : `**沒有完成**：${g.deliverable.label}沒有產生。`,
    "",
    ...(deliverableLinks.length ? ["最終成果：", ...deliverableLinks.map((a) => `- [${a.title}](${a.url})`), ""] : []),
    `階段：${g.stages.map((s, i) => `${i + 1}. ${s.title}（${STATUS_ZH[s.status]}）`).join("；")}`,
    ...(artifacts.length > deliverableLinks.length ? ["", "過程中的成果：", ...artifacts.filter((a) => !deliverableLinks.includes(a)).map((a) => `- [${a.title}](${a.url})`)] : []),
    ...(issues.length ? ["", "待處理：", ...issues.map((i) => `- ${i}`)] : []),
  ].join("\n");
  const report = { summary_md: summary, done, issues };
  await saveGoal(client, g.id, { status, report, finished_at: new Date().toISOString(), question: null });
  await goalLog(client, g.id, status, status === "done" ? "目標完成。" : status === "partial" ? "目標部分完成。" : "目標沒有完成。");
  return { ...g, status, report };
}

export const STATUS_ZH: Record<Stage["status"], string> = { pending: "待開始", running: "進行中", waiting: "等你處理", done: "完成", partial: "部分完成", failed: "失敗", skipped: "略過", cancelled: "已停止" };

/**
 * Called when a stage's run stopped (its job ended — waiting for the user, finished or failed — or it was cancelled).
 * Records the outcome on the stage and moves on / waits.
 */
export async function goalAfterRun(deps: { db: Db; model?: ModelPort | null }, runId: string) {
  const run = await getRun(deps.db, runId);
  if (!run?.goal_id) return;
  let next: "move_on" | "wait" | null = null;
  let idx = -1;
  let waitGoal: GoalRow | null = null;
  await transaction(deps.db, async (client) => {
    const g = await getGoal(client, run.goal_id!, true);
    if (!g || GOAL_FINISHED.includes(g.status)) return;
    idx = g.stages.findIndex((s) => s.run_id === run.id);
    if (idx < 0) return;
    const stage = g.stages[idx]!;
    const patch: Partial<Stage> = {};
    if (WAITING.has(run.status)) patch.status = "waiting";
    else if (WORKING.has(run.status)) patch.status = "running";
    else if (run.status === "done" || run.status === "partial") {
      Object.assign(patch, { status: run.status, artifacts: run.artifacts, summary: (run.report?.summary_md ?? "").split("\n")[0]!.replace(/\*\*/g, "").slice(0, 300), issues: (run.report?.issues ?? []).slice(0, 5).map((i) => i.slice(0, 300)) });
      next = "move_on";
    } else if (run.status === "cancelled" && run.stop_reason === "skipped") {
      Object.assign(patch, { status: "skipped", summary: run.report?.summary_md?.slice(0, 300) });
      next = "move_on";
    } else if (run.status === "failed" || run.status === "cancelled") {
      Object.assign(patch, { status: run.status === "failed" ? "failed" : "cancelled", artifacts: run.artifacts, summary: (run.error?.error ?? run.report?.summary_md ?? "").slice(0, 300) });
      next = "wait";
    }
    if (!patch.status || (patch.status === stage.status && !next)) return;
    const stages = g.stages.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    // The goal adopts the study the first stage settled on.
    await saveGoal(client, g.id, { stages, ...(run.study_id && !g.study_id ? { study_id: run.study_id } : {}) });
    if (next === "move_on") await goalLog(client, g.id, "stage_done", `「${stage.title}」${STATUS_ZH[patch.status!]}${patch.artifacts?.length ? `：${patch.artifacts.map((a) => a.title).join("、")}` : ""}。`);
    if (next === "wait") {
      const question = `「${stage.title}」${patch.status === "failed" ? "沒有完成" : "已停止"}${patch.summary ? `（${patch.summary.slice(0, 120)}）` : ""}。要重試這個階段、略過它繼續，還是停止整個目標？`;
      await saveGoal(client, g.id, { status: "awaiting_input", question });
      await goalLog(client, g.id, "stage_failed", question);
      waitGoal = { ...g, stages, status: "awaiting_input", question };
    }
  });
  if (next === "move_on") await moveOn(deps.db, run.goal_id, { model: deps.model ?? null, afterIdx: idx });
  if (waitGoal) await goalNotice(deps.db, waitGoal);
}

// ---------------------------------------------------------------- notices

const NOTICE: Record<string, (t: string) => { notice: string; title: string }> = {
  awaiting_approval: (t) => ({ notice: `目標「${t}」的路線圖已擬好，請確認後按「開始」。`, title: "目標路線圖待確認" }),
  awaiting_input: (t) => ({ notice: `目標「${t}」有一個階段沒有完成，需要你決定怎麼繼續。`, title: "目標需要你決定" }),
  done: (t) => ({ notice: `目標「${t}」已完成。`, title: "目標已完成" }),
  partial: (t) => ({ notice: `目標「${t}」已結束，但有階段沒有完全完成。`, title: "目標部分完成" }),
  failed: (t) => ({ notice: `目標「${t}」沒有完成。`, title: "目標沒有完成" }),
};

/** Notice in the conversation (`goal_<status>`) + an in-app notification with a deep link to the goal card. */
export async function goalNotice(db: Queryable, g: Pick<GoalRow, "id" | "title" | "status" | "user_id" | "conversation_id">) {
  const t = NOTICE[g.status]?.(g.title || "目標");
  if (!t) return;
  const url = focusHref(g.conversation_id, `goal:${g.id}`);
  try {
    if (g.conversation_id) {
      const m = (await db.query<MessageRow>(
        "INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'notice',$2,$3) RETURNING *",
        [g.conversation_id, JSON.stringify([{ type: "notice", kind: `goal_${g.status}`, goalId: g.id }]), t.notice],
      )).rows[0]!;
      await insertEvent(db, g.conversation_id, null, "message", { message: messageView(m) });
    }
    await db.query("INSERT INTO notifications(user_id,kind,title,body,url) VALUES($1,'workflow',$2,$3,$4)", [g.user_id, t.title, (g.title || t.notice).slice(0, 300), url]);
  } catch {
    // Notices are best effort.
  }
}
