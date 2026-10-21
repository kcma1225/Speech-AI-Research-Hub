/**
 * The workflow engine (docs/architecture.md "Workflows"): planning → plan approval → dispatch of sub-agent steps
 * (parallel, bounded) → verification + bounded fix rounds → final verification against the objective (targeted
 * repair rounds) → commit + report. Every transition is persisted before the next model call, so a restarted job
 * continues from the rows. Runs inside the ai-worker job `ai_workflow` (or directly in tests).
 */
import { isLlmUnavailable } from "../ai/platform/index.js";
import { HttpError } from "../lib/http.js";
import { CURRENT_USER_COLUMNS, toCurrentUser } from "../lib/auth.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { WorkflowEnv, type EnvDeps } from "./env.js";
import { addUsage, emitRun, emitStep, getRun, getSteps, insertSteps, insertWorkflowEvent, stepView } from "./store.js";
import { getWorkflowPlaybook, type WorkflowPlaybook } from "./playbooks/registry.js";
import { actionable, verifyCriteria, verifyStep } from "./verify.js";
import { finishNotice } from "./notify.js";
import { WorkflowStop, type Criterion, type RunRow, type StepOutput, type StepRow, type WorkflowStatus } from "./types.js";

export class WorkflowInputError extends Error {}

async function setStatus(env: WorkflowEnv, status: WorkflowStatus, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(", ");
  await env.db.query(
    `UPDATE workflow_runs SET status=$2, updated_at=now()${sets ? `, ${sets}` : ""} WHERE id=$1 AND status NOT IN ('cancelled')`,
    [env.run.id, status, ...cols.map((c) => { const v = extra[c]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; })],
  );
  await emitRun(env.db, env.run.id);
  await env.refresh();
}

async function updateStep(env: WorkflowEnv, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  await env.db.query(
    `UPDATE workflow_steps SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")} WHERE id=$1`,
    [id, ...cols.map((c) => { const v = fields[c]; return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && c !== "depends_on" ? JSON.stringify(v) : v; })],
  );
  return emitStep(env.db, id);
}

/** Loads the owner; null when the account is gone/disabled. */
async function loadOwner(env: EnvDeps, userId: string) {
  const row = (await env.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL`, [userId])).rows[0];
  return row ? toCurrentUser(row) : null;
}

/**
 * Advances one workflow until it has to wait or ends. `lastAttempt`: an unexpected error fails the run instead of
 * leaving it for the next attempt.
 */
export async function runWorkflow(deps: EnvDeps, workflowId: string, opts: { lastAttempt?: boolean } = {}): Promise<{ status: WorkflowStatus | "missing" }> {
  const initial = await getRun(deps.db, workflowId);
  if (!initial) return { status: "missing" };
  const user = await loadOwner(deps, initial.user_id);
  const env = new WorkflowEnv(deps, initial, user ?? ({ id: initial.user_id } as never));
  if (!user || user.role === "admin") {
    await setStatus(env, "failed", { error: { error: "帳號已停用，工作流程無法繼續。", code: "forbidden" }, finished_at: new Date().toISOString() });
    return { status: "failed" };
  }
  const pb = getWorkflowPlaybook(initial.playbook);
  if (!pb) {
    await setStatus(env, "failed", { error: { error: "找不到這個工作流程類型。", code: "invalid_input" }, finished_at: new Date().toISOString() });
    return { status: "failed" };
  }
  // Recovery: a step interrupted by a crash/restart starts its round again.
  await deps.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [workflowId]);
  await deps.db.query("UPDATE workflow_runs SET started_at=coalesce(started_at, now()) WHERE id=$1", [workflowId]);
  try {
    for (let guard = 0; guard < 50; guard++) {
      const run = await env.refresh();
      if (run.status === "planning") {
        await planPhase(env, pb);
        continue;
      }
      if (run.status === "running" || run.status === "verifying") {
        await executePhase(env, pb);
        continue;
      }
      break;
    }
  } catch (e) {
    if (e instanceof WorkflowStop && e.reason === "cancelled" && (await env.refresh()).status !== "cancelled") {
      // Aborted by a worker shutdown / lost lease, not by the user: hand the job back; the next attempt resumes.
      await deps.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [workflowId]);
      throw new Error("workflow interrupted (worker shutdown); will resume");
    } else if (e instanceof WorkflowStop) await onStop(env, pb, e);
    else if (isLlmUnavailable(e)) {
      await env.note("模型暫時無法使用，等它恢復後會自動繼續。", "warn");
      throw e;
    } else if (e instanceof WorkflowInputError || e instanceof HttpError || opts.lastAttempt) {
      const message = e instanceof WorkflowInputError || e instanceof HttpError ? e.message : "工作流程發生錯誤，已停止。";
      deps.log.warn({ err: e, workflowId }, "workflow failed");
      await setStatus(env, "failed", { error: { error: message, code: "workflow_error" }, finished_at: new Date().toISOString() });
      await finishNotice(env, "failed");
    } else throw e;
  } finally {
    await env.saveActive().catch(() => undefined);
  }
  return { status: (await env.refresh()).status };
}

// ---------------------------------------------------------------- planning

async function planPhase(env: WorkflowEnv, pb: WorkflowPlaybook) {
  await env.deps.progress?.("planning", 5).catch(() => undefined);
  await env.note("理解目標並蒐集資料，準備工作計畫。");
  const res = await pb.plan(env);
  await env.refresh();
  if (env.run.status === "cancelled") throw new WorkflowStop("cancelled", "已停止。");
  if (res.kind === "question") {
    await setStatus(env, "awaiting_input", { question: res.question });
    await finishNotice(env, "awaiting_input");
    return;
  }
  await env.db.query("DELETE FROM workflow_steps WHERE run_id=$1", [env.run.id]);
  await insertSteps(env.db, env.run.id, res.steps);
  const criteria: Criterion[] = res.criteria.map((c) => ({ ...c, status: "pending" }));
  await env.db.query(
    "UPDATE workflow_runs SET objective=$2, criteria=$3, plan=$4, title=CASE WHEN $5::text IS NULL THEN title ELSE $5 END, study_id=coalesce($6, study_id), question=NULL, updated_at=now() WHERE id=$1",
    [env.run.id, res.objective, JSON.stringify(criteria), JSON.stringify(res.plan), res.title?.slice(0, 160) ?? null, res.studyId ?? null],
  );
  for (const s of await getSteps(env.db, env.run.id)) await insertWorkflowEvent(env.db, env.run.id, "step", { step: stepView(s) });
  await env.refresh();
  const auto = env.run.autopilot && pb.autoApprovable && !env.run.tainted;
  if (auto) {
    await env.note("自動駕駛：這個計畫只會寫入新的草稿，已自動核准。");
    await setStatus(env, "running");
    return;
  }
  await setStatus(env, "awaiting_plan_approval");
  await finishNotice(env, "awaiting_plan_approval");
}

// ---------------------------------------------------------------- execution

const settled = (s: StepRow) => s.status === "passed" || s.status === "skipped";

function depsReady(step: StepRow, steps: StepRow[]) {
  return step.depends_on.every((k) => {
    const d = steps.find((x) => x.key === k);
    if (!d) return true;
    // Integration and final steps also run after a failed task (they integrate what passed; the report says what did not).
    return settled(d) || (step.kind !== "task" && (d.status === "failed" || d.status === "cancelled"));
  });
}

async function executePhase(env: WorkflowEnv, pb: WorkflowPlaybook) {
  for (;;) {
    await env.checkpoint({ allowPause: true });
    if (env.run.status !== "running" && env.run.status !== "verifying") return;
    const steps = await getSteps(env.db, env.run.id);
    const pending = steps.filter((s) => s.status === "pending");
    const ready = pending.filter((s) => depsReady(s, steps));
    if (!ready.length) {
      const blocked = pending.filter((s) => !depsReady(s, steps));
      if (blocked.length) {
        for (const s of blocked) await updateStep(env, s.id, { status: "skipped", error: "前置步驟沒有通過驗收，略過。", finished_at: new Date().toISOString() });
        continue;
      }
      return finish(env, pb, null);
    }
    const finals = ready.filter((s) => s.kind === "final");
    const batch = ready.filter((s) => s.kind !== "final").slice(0, Math.max(1, env.run.budget.concurrency));
    if (!batch.length) {
      await finalStep(env, pb, finals[0]!);
      continue;
    }
    if (batch.length > 1) await env.note(`平行派出 ${batch.length} 個子任務：${batch.map((s) => s.title).join("、")}`);
    const results = await Promise.allSettled(batch.map((s) => executeStep(env, pb, s)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
  }
}

const fixIssues = (step: StepRow) => (Array.isArray(step.inputs?.fix_issues) ? (step.inputs.fix_issues as string[]) : []);

async function executeStep(env: WorkflowEnv, pb: WorkflowPlaybook, initial: StepRow) {
  let step = initial;
  for (;;) {
    await env.checkpoint();
    const run = env.run;
    if (run.usage.steps >= run.budget.max_steps) throw new WorkflowStop("budget_steps", `已達步驟上限（${run.budget.max_steps} 步）。`);
    await addUsage(env.db, run.id, { steps: 1 });
    const t0 = Date.now();
    step = (await updateStep(env, step.id, { status: "running", attempts: step.attempts + 1, started_at: new Date().toISOString(), error: null }))!;
    await env.activity(step.key, step.role, step.round > 0 ? `修正第 ${step.round} 輪` : "開始");
    await env.deps.progress?.(`step:${step.key}`, 30).catch(() => undefined);
    const issues = fixIssues(step);
    const fix = step.round > 0 && step.output && issues.length ? { previous: step.output, issues } : null;
    let out: StepOutput;
    try {
      out = await pb.execute(env, step, fix);
    } catch (e) {
      if (e instanceof WorkflowStop || isLlmUnavailable(e) || !(e instanceof WorkflowInputError || e instanceof HttpError)) throw e;
      await updateStep(env, step.id, { status: "failed", error: e.message.slice(0, 500), finished_at: new Date().toISOString(), ms: step.ms + (Date.now() - t0) });
      await env.note(`「${step.title}」無法完成：${e.message}`, "warn");
      return;
    }
    if (out.text && out.text.length > 200_000) out = { ...out, text: out.text.slice(0, 200_000) };
    // A sub-agent that lacks required data says so instead of inventing content: the run asks the user.
    const blocked = /^\s*BLOCKED[:：]\s*(.+)/.exec(out.text ?? "");
    if (blocked) {
      await updateStep(env, step.id, { status: "pending", output: out, ms: step.ms + (Date.now() - t0) });
      throw new WorkflowStop("blocked", `「${step.title}」無法繼續：${blocked[1]!.trim().slice(0, 300)}`);
    }
    // No progress: a fix round that returns the same output as before stops fixing this step.
    if (fix && (out.text ?? "") === (fix.previous.text ?? "") && out.text) {
      await updateStep(env, step.id, { status: "failed", output: out, ms: step.ms + (Date.now() - t0), finished_at: new Date().toISOString(), error: "修正後內容沒有任何改變，停止修正。" });
      await env.note(`「${step.title}」的修正沒有進展，停止修正。`, "warn");
      return;
    }
    step = (await updateStep(env, step.id, { status: "verifying", output: out }))!;
    const verdict = await verifyStep(env, step, out);
    const history = [...step.history, { round: step.round, verdict, summary: out.summary.slice(0, 300) }].slice(-8);
    await insertWorkflowEvent(env.db, run.id, "verdict", { step_key: step.key, round: step.round, verdict });
    const ms = step.ms + (Date.now() - t0);
    if (verdict.verdict === "pass") {
      await updateStep(env, step.id, { status: "passed", verdict, history, finished_at: new Date().toISOString(), ms, inputs: { ...step.inputs, fix_issues: [] } });
      return;
    }
    const maxRounds = step.max_rounds ?? run.budget.max_fix_rounds;
    const problems = verdict.issues.filter(actionable).map((i) => (i.where ? `${i.where}：${i.text}` : i.text));
    if (step.round < maxRounds) {
      await addUsage(env.db, run.id, { fix_rounds: 1 });
      await env.note(`「${step.title}」未通過驗收（${problems.length} 個問題），派出第 ${step.round + 1} 輪修正。`);
      step = (await updateStep(env, step.id, { status: "pending", verdict, history, round: step.round + 1, ms, inputs: { ...step.inputs, fix_issues: problems } }))!;
      continue;
    }
    await updateStep(env, step.id, { status: "failed", verdict, history, ms, finished_at: new Date().toISOString(), error: `修正 ${maxRounds} 輪後仍未通過驗收。` });
    await env.note(`「${step.title}」修正 ${maxRounds} 輪後仍未通過驗收，會在報告中列出。`, "warn");
    return;
  }
}

/** Transitive dependents of the given keys. */
function dependents(steps: StepRow[], keys: Set<string>) {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps) {
      if (out.has(s.key) || keys.has(s.key)) continue;
      if (s.depends_on.some((d) => keys.has(d) || out.has(d))) {
        out.add(s.key);
        grew = true;
      }
    }
  }
  return out;
}

export const MAX_FINAL_ROUNDS = 2;

async function finalStep(env: WorkflowEnv, pb: WorkflowPlaybook, step: StepRow) {
  await setStatus(env, "verifying");
  await addUsage(env.db, env.run.id, { steps: 1 });
  const t0 = Date.now();
  await updateStep(env, step.id, { status: "running", attempts: step.attempts + 1, started_at: new Date().toISOString() });
  const { text, data } = await pb.finalText(env);
  const criteria = await verifyCriteria(env, text, data);
  await env.db.query("UPDATE workflow_runs SET criteria=$2, updated_at=now() WHERE id=$1", [env.run.id, JSON.stringify(criteria)]);
  await env.refresh();
  const failing = criteria.filter((c) => c.status === "fail");
  const verdict = { verdict: failing.length ? ("revise" as const) : ("pass" as const), issues: failing.map((c) => ({ severity: "high" as const, text: `${c.text}：${c.reason ?? "未達成"}` })), checks: criteria.map((c) => ({ id: c.id, ok: c.status === "pass", detail: c.reason ?? "" })) };
  await insertWorkflowEvent(env.db, env.run.id, "verdict", { step_key: step.key, round: step.round, verdict });
  const history = [...step.history, { round: step.round, verdict, summary: failing.length ? `${failing.length} 項未達成` : "全部達成" }].slice(-8);
  if (!failing.length) {
    await updateStep(env, step.id, { status: "passed", verdict, history, ms: step.ms + (Date.now() - t0), finished_at: new Date().toISOString() });
    await setStatus(env, "running");
    return;
  }
  if (env.run.final_rounds < MAX_FINAL_ROUNDS && pb.repair) {
    const reopen = await pb.repair(env, failing);
    const steps = await getSteps(env.db, env.run.id);
    const targets = reopen.filter((r) => steps.some((s) => s.key === r.key && s.kind !== "final"));
    if (targets.length) {
      await env.note(`最終驗收有 ${failing.length} 項未達成，針對 ${targets.length} 個步驟派出修正。`);
      for (const r of targets) {
        const s = steps.find((x) => x.key === r.key)!;
        await updateStep(env, s.id, { status: "pending", round: s.round + 1, max_rounds: s.round + 2, inputs: { ...s.inputs, fix_issues: r.issues } });
      }
      for (const key of dependents(steps, new Set(targets.map((t) => t.key)))) {
        const s = steps.find((x) => x.key === key)!;
        if (s.kind === "final") continue;
        await updateStep(env, s.id, { status: "pending", inputs: { ...s.inputs, fix_issues: [] } });
      }
      await addUsage(env.db, env.run.id, { fix_rounds: 1 });
      await env.db.query("UPDATE workflow_runs SET final_rounds=final_rounds+1 WHERE id=$1", [env.run.id]);
      await updateStep(env, step.id, { status: "pending", verdict, history, round: step.round + 1, ms: step.ms + (Date.now() - t0) });
      await setStatus(env, "running");
      return;
    }
  }
  await updateStep(env, step.id, { status: "failed", verdict, history, ms: step.ms + (Date.now() - t0), finished_at: new Date().toISOString(), error: `${failing.length} 項驗收標準未達成。` });
  await setStatus(env, "running");
}

// ---------------------------------------------------------------- end states

async function onStop(env: WorkflowEnv, pb: WorkflowPlaybook, stop: WorkflowStop) {
  await env.refresh();
  if (stop.reason === "cancelled" || env.run.status === "cancelled") {
    await env.db.query("UPDATE workflow_steps SET status='cancelled', finished_at=now() WHERE run_id=$1 AND status IN ('pending','running','verifying')", [env.run.id]);
    for (const s of await getSteps(env.db, env.run.id)) if (s.status === "cancelled") await insertWorkflowEvent(env.db, env.run.id, "step", { step: stepView(s) });
    await env.db.query("UPDATE workflow_runs SET stop_reason='cancelled', finished_at=coalesce(finished_at, now()) WHERE id=$1", [env.run.id]);
    await emitRun(env.db, env.run.id);
    await finishNotice(env, "cancelled");
    return;
  }
  if (stop.reason === "paused") {
    await env.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [env.run.id]);
    await setStatus(env, "paused", { pause_requested: false });
    await env.note("已暫停；按「繼續」會從目前的步驟接著做。");
    return;
  }
  if (stop.reason === "blocked") {
    await env.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [env.run.id]);
    await setStatus(env, "awaiting_input", { question: `${stop.message}\n請在補充指示提供需要的資料，或調整要求後按「繼續」。` });
    await finishNotice(env, "awaiting_input");
    return;
  }
  if (stop.reason === "access") {
    await setStatus(env, "failed", { error: { error: stop.message, code: "forbidden" }, finished_at: new Date().toISOString() });
    await finishNotice(env, "failed");
    return;
  }
  // Budget exhausted or a conflicting edit: skip the rest, keep what passed, end partial.
  await env.db.query("UPDATE workflow_steps SET status='skipped', error=$2, finished_at=now() WHERE run_id=$1 AND status IN ('pending','running','verifying')", [env.run.id, stop.message]);
  for (const s of await getSteps(env.db, env.run.id)) if (s.status === "skipped") await insertWorkflowEvent(env.db, env.run.id, "step", { step: stepView(s) });
  await env.note(stop.message, "warn");
  await finish(env, pb, stop);
}

async function finish(env: WorkflowEnv, pb: WorkflowPlaybook, stop: WorkflowStop | null) {
  await env.refresh();
  const steps = await getSteps(env.db, env.run.id);
  const criteria = env.run.criteria;
  const allPass = !stop && criteria.length > 0 && criteria.every((c) => c.status === "pass") && steps.every((s) => s.status === "passed" || (s.status === "skipped" && !s.error));
  const outcome = allPass ? "done" : "partial";
  let commitLine: string | null = null;
  try {
    commitLine = (await pb.commit?.(env, outcome)) ?? null;
  } catch (e) {
    if (e instanceof WorkflowStop) throw e;
    if (isLlmUnavailable(e)) throw e;
    env.deps.log.warn({ err: e, workflowId: env.run.id }, "workflow commit failed");
    commitLine = `寫入成果時發生錯誤：${(e as Error).message ?? ""}`.slice(0, 300);
  }
  await env.refresh();
  const report = buildReport(env.run, steps, outcome, stop, commitLine);
  await setStatus(env, outcome, { report, stop_reason: stop?.reason ?? null, finished_at: new Date().toISOString() });
  await finishNotice(env, outcome);
}

export function buildReport(run: RunRow, steps: StepRow[], outcome: "done" | "partial", stop: WorkflowStop | null, commitLine: string | null) {
  const passed = steps.filter((s) => s.status === "passed");
  const fixed = steps.filter((s) => s.history.length > 1 && s.kind !== "final");
  const done = passed.filter((s) => s.kind !== "final").map((s) => `${s.title}${s.history.length > 1 ? `（經 ${s.history.length - 1} 輪修正後通過）` : ""}`);
  const issues: string[] = [];
  for (const c of run.criteria) if (c.status !== "pass") issues.push(`未達成：${c.text}${c.reason ? `（${c.reason}）` : ""}`);
  for (const s of steps) if (s.status === "failed") issues.push(`「${s.title}」未通過驗收：${(s.verdict?.issues ?? []).filter((i) => i.severity !== "low").map((i) => i.text).slice(0, 3).join("；") || s.error || ""}`);
  if (stop) issues.push(stop.message);
  const ok = run.criteria.filter((c) => c.status === "pass").length;
  const lines = [
    outcome === "done" ? `**已完成**，${run.criteria.length} 項驗收標準全部通過。` : `**部分完成**：${ok}/${run.criteria.length} 項驗收標準通過，尚有問題需要處理。`,
    "",
    `- 完成的步驟：${done.length} 個${fixed.length ? `（其中 ${fixed.length} 個經過修正）` : ""}`,
    ...(commitLine ? [`- ${commitLine}`] : []),
    ...(run.artifacts.length ? ["", "成果：", ...run.artifacts.map((a) => `- [${a.title}](${a.url})`)] : []),
    ...(issues.length ? ["", "待處理：", ...issues.map((i) => `- ${i}`)] : []),
  ];
  return { summary_md: lines.join("\n"), done, issues };
}

/** Re-checks that the owner may still edit the study (before each write). */
export async function requireEditor(env: WorkflowEnv, studyId: string) {
  const access = await loadStudyAccess(env.db, studyId, env.user);
  if (!access.canEdit) throw new WorkflowStop("access", `你已經不是〈${access.study.title}〉的成員，工作流程不能再寫入。`);
  return access;
}
