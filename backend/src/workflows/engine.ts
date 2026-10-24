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
import { getWorkflowPlaybook, listWorkflowPlaybooks, type WorkflowPlaybook } from "./playbooks/registry.js";
import { verifyCriteria, verifyUnit } from "./verify.js";
import { fixLine, HARD_FIX_ROUNDS, ledgerReport, loadConv, loadLedger, nextMove, recordRound, STOP_LABEL, type Convergence, type StopReason, type UnitRound } from "./ledger.js";
import { finishNotice } from "./notify.js";
import { asksOf, blockedQuestion, pendingAsk } from "./questions.js";
import { autoApproval, autoApprovalNote } from "./autopilot.js";
import { promoteQueued } from "./queue.js";
import { runChecks } from "./checks.js";
import { artifactKindOf, fixedHeadings, persistStanding, prepareRequirements, requirementRepair, translateTitle, withRequirementCriteria } from "./requirements.js";
import { BRIEF_KIND_LABEL, BRIEF_KINDS, chooseDeliverable, clarifyDeliverable, clarifyOnce, playbookKind, prepareBrief, sameDeliverable, setChecklist, switchGuard } from "./brief.js";
import { route, routeInputOf, routeNote, saveRoute, splitBatch } from "./route.js";
import { budgetFor, WorkflowStop, type Criterion, type Ledger, type RunRow, type StepOutput, type StepReport, type StepRow, type Verdict, type WorkflowStatus } from "./types.js";

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
  let pb = getWorkflowPlaybook(initial.playbook);
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
      try {
        if (run.status === "planning") {
          pb = await planPhase(env, pb);
          continue;
        }
        if (run.status === "running" || run.status === "verifying") {
          await executePhase(env, pb);
          continue;
        }
      } catch (e) {
        // 「修改計畫」 on an auto-approved run that was working: it stopped between steps → plan again now.
        if (e instanceof WorkflowStop && e.reason === "paused" && env.state<boolean>("revise_requested")) {
          await deps.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [workflowId]);
          await env.setState({ revise_requested: false });
          await setStatus(env, "planning", { pause_requested: false });
          await env.note("依你的意見重新規劃（已寫入的草稿會保留）。");
          continue;
        }
        throw e;
      }
      break;
    }
  } catch (e) {
    // The job's signal fired (worker shutdown, lost lease, or the user's cancel): whatever the abort surfaced as — a
    // WorkflowStop, an aborted fetch, an AI error — it is never a failure of the run, even on the job's last attempt.
    const aborted = (e instanceof WorkflowStop && e.reason === "cancelled") || deps.signal.aborted;
    const userCancelled = aborted && (await env.refresh()).status === "cancelled";
    if (aborted && !userCancelled) {
      // Aborted by a worker shutdown / lost lease, not by the user: hand the job back; the next attempt resumes.
      await deps.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [workflowId]);
      throw new Error("workflow interrupted (worker shutdown); will resume");
    } else if (userCancelled && !(e instanceof WorkflowStop)) await onStop(env, pb, new WorkflowStop("cancelled", "已停止。"));
    else if (e instanceof WorkflowStop) await onStop(env, pb, e);
    else if (isLlmUnavailable(e)) {
      // The model being down is not the step's fault: give back the attempt the interrupted steps just started, so
      // an outage (job backoff, then resume) never burns the per-step attempt cap.
      await deps.db.query("UPDATE workflow_steps SET status='pending', attempts=GREATEST(attempts-1, 0) WHERE run_id=$1 AND status IN ('running','verifying')", [workflowId]);
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
    // A slot may have freed (the run waits for the user or ended): start the owner's next queued run.
    await promoteQueued(deps.db, initial.user_id).catch((e) => deps.log.warn({ err: e, workflowId }, "workflow queue promotion failed"));
    // A goal stage: the goal moves on when the run ended, or shows that it waits for the user (goals/advance.ts).
    if (initial.goal_id) await (await import("./goals/advance.js")).goalAfterRun(deps, workflowId).catch((e) => deps.log.warn({ err: e, workflowId }, "goal advance failed"));
  }
  return { status: (await env.refresh()).status };
}

// ---------------------------------------------------------------- planning

/** Switches the run to another playbook (its budget too, unless smaller than the run's). */
async function switchPlaybook(env: WorkflowEnv, next: WorkflowPlaybook) {
  const budget = budgetFor(next.id);
  await env.db.query("UPDATE workflow_runs SET playbook=$2, budget=(SELECT jsonb_object_agg(k, GREATEST((budget->>k)::numeric, (($3::jsonb)->>k)::numeric)) FROM jsonb_object_keys($3::jsonb) k), updated_at=now() WHERE id=$1", [env.run.id, next.id, JSON.stringify(budget)]);
  await env.refresh();
}

/**
 * A playbook switch that would change the Brief's deliverable kind (brief.ts `switchGuard`): asks the user. Returns true to
 * switch; false = plan again later (the user chose 「仍做簡報」, wrote what is missing, or stop → the run ends skipped).
 */
async function mayChangeTo(env: WorkflowEnv, pb: WorkflowPlaybook, to: string, why: string): Promise<boolean> {
  const d = await switchGuard(env, pb, to, why);
  if (d.ok) return true;
  if (d.action === "topic") {
    await env.db.query("UPDATE workflow_runs SET inputs = inputs || '{\"mode\":\"topic\"}'::jsonb, updated_at=now() WHERE id=$1", [env.run.id]);
    await env.refresh();
    await env.note("依你的選擇仍做簡報：用研究的文獻庫與筆記整理成主題簡報。");
  } else if (d.action === "stop") {
    const message = `依你的選擇先停下來：沒有改成其他成果（你要的是${env.brief()?.deliverable.label ?? "原本的成果"}）。`;
    await setStatus(env, "cancelled", { stop_reason: "skipped", question: null, report: { summary_md: message, done: [], issues: [message] }, finished_at: new Date().toISOString() });
    await env.note(message, "warn");
  } else await env.note("收到你的補充，依它重新規劃。");
  return false;
}

/** A playbook the user's choice / a redirect settled on: kept by later routing while it delivers the Brief's kind. */
async function pinRoute(env: WorkflowEnv, playbook: string, why: string) {
  const cur = env.route();
  if (!cur) return;
  await env.setState({ route: { ...cur, playbook, pinned: playbook, reason: `${why.slice(0, 160)}（改由「${getWorkflowPlaybook(playbook)?.title ?? playbook}」執行）` } });
}

/**
 * Routing at planning (route.ts), right after the Brief is built: the same pure decision as at creation, now with the
 * Brief's requirements and the study's readiness. Switches the playbook when the decision changed (always within the
 * Brief's deliverable), splits a per-paper batch whose study was only known now, and asks ONE card when it cannot decide
 * (one deck or one per paper; no playbook for the deliverable). Returns the playbook to plan with, or null when the run
 * stopped (split into a batch) or waits for the answer.
 */
async function routePhase(env: WorkflowEnv, pb: WorkflowPlaybook): Promise<WorkflowPlaybook | null> {
  for (let round = 0; round < 3; round++) {
    const b = env.brief();
    if (!b) return pb;
    const prev = env.route();
    const input = (await routeInputOf(env))!;
    const r = route(input);
    if (r.ask === "batch" && !env.run.batch_id) {
      const answer = await clarifyOnce(env, {
        id: "batch", title: "一份還是每篇各一份？", prompt: `你給了 ${(env.run.inputs.paper_ids as unknown[] | undefined)?.length ?? "幾"} 篇論文，要做成一份涵蓋它們的${b.deliverable.label}，還是每一篇論文各做一份？`,
        options: [{ value: "one", label: `合成一份${b.deliverable.label}` }, { value: "each", label: `每一篇論文各做一份${b.deliverable.label}` }], unspecified: "一份或每篇一份",
      });
      // The answer joined the user's words (a new Brief version): route again. Unanswered → one artifact.
      if (answer) continue;
    }
    if (r.ask === "producer") {
      const kinds = BRIEF_KINDS.filter((k) => k !== "other" && listWorkflowPlaybooks().some((p) => playbookKind(p.id) === k));
      const answer = await clarifyOnce(env, {
        id: "producer", title: `沒有工作流程能直接產生${b.deliverable.label}`, prompt: "要改做哪一種成果？（不會自動換成別的）",
        options: kinds.map((k) => ({ value: k, label: BRIEF_KIND_LABEL[k] })), unspecified: "成果種類",
      });
      const kind = BRIEF_KINDS.find((k) => k === answer?.value);
      if (kind && (await chooseDeliverable(env, kind))) continue;
      throw new WorkflowInputError(`目前沒有工作流程能產生「${b.deliverable.label}」。`);
    }
    // 「每一篇文獻」 whose study (or papers) were only known now: the batch creation would have made; this run ends.
    if (r.batch && !env.run.batch_id) {
      const message = await splitBatch(env, r.playbook);
      if (message) {
        await setStatus(env, "cancelled", { stop_reason: "skipped", question: null, report: { summary_md: message, done: [], issues: [message] }, finished_at: new Date().toISOString() });
        await env.note(message);
        return null;
      }
    }
    let next = pb;
    if (r.playbook !== pb.id) {
      const target = getWorkflowPlaybook(r.playbook);
      if (target && sameDeliverable(playbookKind(target.id), b.deliverable.kind)) {
        await switchPlaybook(env, target);
        next = target;
        await prepareBrief(env, next.id, (x) => prepareRequirements(env, next.id, x));
      }
    }
    const changed = !prev || prev.playbook !== next.id || prev.deck !== r.deck || prev.edit !== r.edit || prev.batch !== r.batch;
    const state = await saveRoute(env, { ...r, playbook: next.id });
    if (changed) await env.note(routeNote(state));
    return next;
  }
  return pb;
}

/** Plans the run; returns the playbook it ended up with (a switch to another playbook keeps the Brief's deliverable or asks). */
async function planPhase(env: WorkflowEnv, pb: WorkflowPlaybook): Promise<WorkflowPlaybook> {
  await env.deps.progress?.("planning", 5).catch(() => undefined);
  await env.note("理解目標並蒐集資料，準備工作計畫。");
  // The Brief first (brief.ts): deliverable, the user's own words, their explicit requirements (requirements.ts: playbooks
  // read them while planning — target language, edit kind, per-item fields) and what is unspecified; every sub-agent call
  // from here on gets it.
  await prepareBrief(env, pb.id, (b) => prepareRequirements(env, pb.id, b));
  // Two incompatible deliverables named at once (「做成簡報或筆記」): ask once; the choice is a new Brief version.
  await clarifyDeliverable(env);
  // The routing decision (route.ts) from this Brief: playbook, deck mode / edit kind, batch — or ONE question.
  const routed = await routePhase(env, pb);
  if (!routed) return pb;
  pb = routed;
  let res = await pb.plan(env);
  // The playbook hands over to a better-fitting one (a literature review with too few papers → topic research, the user's
  // choice): switch once and plan with it — only when it delivers the same kind, else the user decides.
  if (res.kind === "redirect") {
    const next = getWorkflowPlaybook(res.playbook);
    if (!next || next.id === pb.id) throw new WorkflowInputError(res.message);
    if (!(await mayChangeTo(env, pb, next.id, res.message))) return pb;
    await switchPlaybook(env, next);
    await env.note(res.message);
    pb = next;
    await pinRoute(env, next.id, res.message);
    await prepareBrief(env, pb.id, (b) => prepareRequirements(env, pb.id, b));
    res = await pb.plan(env);
  }
  // The user answered, yet the playbook would ask the very same question again (e.g. a reading note picked for a topic
  // survey keeps asking which paper): don't loop — the general workflow gathers what it needs (incl. online search). It
  // writes a note, so for a deck / LaTeX deliverable the user decides first (never a silent substitute).
  const asked = env.state<string>("plan_question");
  if (res.kind === "question" && pb.id !== "generic" && env.run.guidance.length > 0 && (asked === res.question || asked === undefined)) {
    const fallback = getWorkflowPlaybook("generic");
    if (fallback) {
      if (!(await mayChangeTo(env, pb, fallback.id, res.question))) return pb;
      await env.db.query("UPDATE workflow_runs SET playbook='generic', updated_at=now() WHERE id=$1", [env.run.id]);
      env.run.playbook = "generic";
      await env.note(`「${pb.title}」需要的資料還是不足（${res.question.slice(0, 60)}），改用一般流程：由 Agent 自己蒐集資料（包括線上搜尋論文）再規劃。`);
      pb = fallback;
      await pinRoute(env, "generic", "上一個流程需要的資料不足");
      await prepareBrief(env, pb.id, (b) => prepareRequirements(env, pb.id, b));
      res = await pb.plan(env);
    }
  }
  if (res.kind === "redirect") throw new WorkflowInputError(res.message);
  await env.refresh();
  if (env.run.status === "cancelled") throw new WorkflowStop("cancelled", "已停止。");
  if (res.kind === "question") {
    await env.setState({ plan_question: res.question });
    await setStatus(env, "awaiting_input", { question: res.question });
    await finishNotice(env, "awaiting_input");
    return pb;
  }
  if (res.kind === "needs_pdf") {
    await setStatus(env, "needs_pdf", { question: res.message });
    await env.note(res.message, "warn");
    await finishNotice(env, "needs_pdf");
    return pb;
  }
  if (res.kind === "skip") {
    await setStatus(env, "cancelled", { stop_reason: "skipped", question: null, report: { summary_md: res.message, done: [], issues: [res.message] }, finished_at: new Date().toISOString() });
    await env.note(res.message, "warn");
    return pb;
  }
  await env.db.query("DELETE FROM workflow_steps WHERE run_id=$1", [env.run.id]);
  await insertSteps(env.db, env.run.id, res.steps);
  // Every requirement is a criterion and is shown on the plan card (「你的要求」).
  const reqs = env.requirements();
  const kind = artifactKindOf(pb.id);
  res.plan = { ...res.plan, requirements: reqs };
  // Notes: the title in the target language; the playbook's fixed section headings are localized at commit instead.
  const noteTitle = env.state<string>("note_title");
  if (kind !== "deck" && noteTitle) {
    const t = await translateTitle(env, noteTitle);
    if (t !== noteTitle) await env.setState({ note_title: t });
  }
  const allow = kind === "doc" ? fixedHeadings(env) : [];
  await env.setState({ req_allow: allow });
  const criteria: Criterion[] = withRequirementCriteria(res.criteria, reqs, kind, undefined, allow).map((c) => ({ ...c, status: "pending" }));
  // The acceptance checklist of the Brief = these criteria (same ids; verification reads `checklistOf`).
  await setChecklist(env, criteria);
  await env.db.query(
    "UPDATE workflow_runs SET objective=$2, criteria=$3, plan=$4, title=CASE WHEN $5::text IS NULL THEN title ELSE $5 END, study_id=coalesce($6, study_id), question=NULL, updated_at=now() WHERE id=$1",
    [env.run.id, res.objective, JSON.stringify(criteria), JSON.stringify(res.plan), res.title?.slice(0, 160) ?? null, res.studyId ?? null],
  );
  for (const s of await getSteps(env.db, env.run.id)) await insertWorkflowEvent(env.db, env.run.id, "step", { step: stepView(s) });
  await env.refresh();
  // Autopilot (完全自動): plans are approved automatically, also with overwrites or after reading others' content (autopilot.ts).
  const decision = autoApproval({ autopilot: env.run.autopilot, autoApprovable: pb.autoApprovable, writes: res.plan.writes ?? [], tainted: env.run.tainted, manual: !!env.state<boolean>("manual_approval"), goal: !!env.run.goal_id });
  if (decision.auto) {
    await env.setState({ auto_approved: { at: new Date().toISOString(), tainted: env.run.tainted } });
    await env.note(autoApprovalNote(decision, env.run.taint_sources));
    await setStatus(env, "running");
    return pb;
  }
  const why = autoApprovalNote(decision);
  if (why) await env.note(why);
  await env.setState({ auto_approved: null });
  await setStatus(env, "awaiting_plan_approval");
  await finishNotice(env, "awaiting_plan_approval");
  return pb;
}

// ---------------------------------------------------------------- execution

const settled = (s: StepRow) => s.status === "passed" || s.status === "skipped";

function depsReady(step: StepRow, steps: StepRow[]) {
  return step.depends_on.every((k) => {
    const d = steps.find((x) => x.key === k);
    if (!d) return true;
    // Integration and final steps also run after a failed task (they integrate what passed; the report says what did not).
    if (settled(d) || (step.kind !== "task" && (d.status === "failed" || d.status === "cancelled"))) return true;
    // A task that failed verification but produced output still feeds later steps (its best attempt, with the issues kept
    // for the report and for later fix rounds such as visual QA) — one strict check must not leave the user with nothing.
    return d.status === "failed" && Boolean((d.output as { text?: string } | null)?.text?.trim());
  });
}

async function executePhase(env: WorkflowEnv, pb: WorkflowPlaybook) {
  // Sliding window: a free slot is refilled as soon as any step settles (no waiting for the slowest of a batch).
  const inFlight = new Map<string, Promise<void>>();
  const drain = async () => {
    const results = await Promise.allSettled(inFlight.values());
    inFlight.clear();
    return results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  };
  for (;;) {
    try {
      await env.checkpoint({ allowPause: true });
    } catch (e) {
      // Pause / cancel: let the running steps finish their round first.
      await drain();
      throw e;
    }
    if (env.run.status !== "running" && env.run.status !== "verifying") {
      await drain();
      return;
    }
    const steps = await getSteps(env.db, env.run.id);
    const pending = steps.filter((s) => s.status === "pending" && !inFlight.has(s.id));
    const ready = pending.filter((s) => depsReady(s, steps));
    const tasks = ready.filter((s) => s.kind !== "final");
    const free = Math.max(1, env.run.budget.concurrency) - inFlight.size;
    if (tasks.length && free > 0) {
      const start = tasks.slice(0, free);
      if (start.length > 1 || inFlight.size) await env.note(`派出子任務：${start.map((s) => s.title).join("、")}${inFlight.size ? `（另有 ${inFlight.size} 個進行中）` : ""}`);
      for (const s of start) {
        const p = executeStep(env, pb, s).finally(() => inFlight.delete(s.id));
        // Keep the rejection for the race below; mark it handled so it never surfaces as unhandled.
        p.catch(() => undefined);
        inFlight.set(s.id, p);
      }
      continue;
    }
    if (inFlight.size) {
      // Wait for the first step to settle, then look for newly ready work; a failure stops the phase after the others.
      const settled = await Promise.race([...inFlight.values()].map((p) => p.then(() => null, (e: unknown) => e)));
      if (settled !== null) {
        await drain();
        throw settled;
      }
      continue;
    }
    if (!ready.length) {
      const blocked = pending.filter((s) => !depsReady(s, steps));
      if (blocked.length) {
        for (const s of blocked) await updateStep(env, s.id, { status: "skipped", error: "前置步驟沒有通過驗收，略過。", finished_at: new Date().toISOString() });
        continue;
      }
      return finish(env, pb, null);
    }
    const finals = ready.filter((s) => s.kind === "final");
    await finalStep(env, pb, finals[0]!);
  }
}

/** Attempts a step may take: its fix rounds + 3 (one first try, one resume after an interruption / a question). */
export const attemptCap = (step: Pick<StepRow, "max_rounds">, maxFixRounds: number) => (step.max_rounds ?? maxFixRounds) + 3;

/** Fix rounds of a step in one session: its own `max_rounds`, else the run's (2 by default); never more than 3. */
export const fixRoundCap = (step: Pick<StepRow, "max_rounds" | "round">, maxFixRounds: number, since = 0) =>
  Math.max(0, Math.min((step.max_rounds ?? since + maxFixRounds) - since, HARD_FIX_ROUNDS));

/** Fix request after a BLOCKED that will not be asked (again). */
export const BEST_EFFORT_ISSUE = (blocker: string) =>
  `你上次回覆 BLOCKED（${blocker.slice(0, 200)}）。不要再回覆 BLOCKED：只用提供的資料完成完整的產出，資料沒有的部分寫「資料未提供」或省略，不要編造。`;

const fixIssues = (step: StepRow) => (Array.isArray(step.inputs?.fix_issues) ? (step.inputs.fix_issues as string[]) : []);

const STOP_ERROR: Record<StopReason, (n: number) => string> = {
  converged: () => "",
  cap: (n) => `修正 ${n} 輪後仍未通過驗收。`,
  same_failure: () => "同樣的問題在修正後再次出現，停止修正。",
  no_improvement: () => "修正後沒有比之前的版本好，停止修正。",
  unfixable: () => "剩下的問題無法修正。",
  unchanged: () => "修正後內容沒有任何改變，停止修正。",
  blocked: () => "子任務一直回報缺少資料。",
};

/**
 * Runs a step until it passes or stops (docs/architecture.md "Workflows" → Convergence): every round is checked (and
 * judged on its scoped checklist when the checks pass) and scored; a failing round gets a fix round unless the same
 * failures repeat, the score did not beat the best version, or the session's fix rounds are used up (2 by default,
 * hard cap 3). A unit that stops without passing keeps its best-scoring version, not the last one.
 */
async function executeStep(env: WorkflowEnv, pb: WorkflowPlaybook, initial: StepRow) {
  let step = initial;
  for (;;) {
    await env.checkpoint();
    const run = env.run;
    if (run.usage.steps >= run.budget.max_steps) throw new WorkflowStop("budget_steps", `已達步驟上限（${run.budget.max_steps} 步）。`);
    // Per-step attempt cap: a step never loops (BLOCKED / resumes / fix rounds) past its fix rounds + 3.
    const cap = attemptCap(step, run.budget.max_fix_rounds);
    if (step.attempts >= cap) {
      await updateStep(env, step.id, { status: "failed", error: `嘗試 ${step.attempts} 次仍未完成，停止重試。`, finished_at: new Date().toISOString() });
      await env.note(`「${step.title}」嘗試 ${step.attempts} 次仍未完成，停止重試，會在報告中列出。`, "warn");
      return;
    }
    // A session starts with a fresh draft, a final repair (seeded with the version before it) or the user's 繼續改.
    const prevConv = loadConv(step.inputs?.conv);
    let conv: Convergence = prevConv?.own ? { ...prevConv, own: false } : { since: step.round, rounds: [], ...(prevConv?.best && step.inputs?.repair_seed ? { best: { ...prevConv.best, seed: true } } : {}) };
    await addUsage(env.db, run.id, { steps: 1 });
    const t0 = Date.now();
    step = (await updateStep(env, step.id, { status: "running", attempts: step.attempts + 1, started_at: new Date().toISOString(), error: null }))!;
    env.trackStep(step.id, step.key, step.round);
    env.stepSources.delete(step.id);
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
    const maxRounds = fixRoundCap(step, run.budget.max_fix_rounds, conv.since);
    // A sub-agent that lacks required data says so instead of inventing content: the run asks the user.
    const blocked = /^\s*BLOCKED[:：]\s*(.+)/.exec(out.text ?? "");
    if (blocked) {
      const blocker = blocked[1]!.trim();
      const prior = Object.values(asksOf(env.run.state)).filter((a) => a.id.startsWith(`blocked_${step.key}_`));
      // At most one question per step, never under autopilot: afterwards (or instead) the writer must produce
      // best-effort content with 「資料未提供」; a repeated BLOCKED is a failed attempt (fix round), not a loop.
      if (!prior.length && !env.run.autopilot) {
        await updateStep(env, step.id, { status: "pending", output: out, ms: step.ms + (Date.now() - t0) });
        await env.activity(step.key, "orchestrator", "缺少資料，準備向你提問");
        await blockedQuestion(env, step, blocker);
      }
      const ms = step.ms + (Date.now() - t0);
      const repeated = (step.output?.text ?? "").trim() === (out.text ?? "").trim();
      if (step.round - conv.since >= maxRounds || (repeated && step.round > 0)) {
        await stopUnit(env, step, conv, "blocked", { out, ms, error: `子任務一直回報缺少資料：${blocker.slice(0, 200)}` });
        await env.note(`「${step.title}」一直回報缺少資料（${blocker.slice(0, 80)}），停止重試，會在報告中列出。`, "warn");
        return;
      }
      await addUsage(env.db, run.id, { fix_rounds: 1 });
      await env.note(env.run.autopilot && !prior.length ? `自動駕駛：「${step.title}」缺少資料（${blocker.slice(0, 80)}），改用現有資料盡力完成，缺的標「資料未提供」。` : `「${step.title}」仍回報缺少資料，改用現有資料盡力完成。`);
      step = (await updateStep(env, step.id, { status: "pending", output: out, ms, round: step.round + 1, inputs: { ...step.inputs, fix_issues: [BEST_EFFORT_ISSUE(blocker)], conv: { ...conv, own: true } } }))!;
      continue;
    }
    // No progress: a fix round that returns the same output as before stops fixing this step.
    if (fix && (out.text ?? "") === (fix.previous.text ?? "") && out.text) {
      // Same text, but a check-only step can still pass now (the screenshot QA re-scored the pages: `out.data`).
      const checks = step.verify?.judge ? null : runChecks(step.verify?.checks ?? [], out.text, out.data ?? null);
      if (checks?.length && checks.every((c) => c.ok)) {
        const verdict = { verdict: "pass" as const, issues: [], checks };
        const history = [...step.history, { round: step.round, verdict, summary: out.summary.slice(0, 300) }].slice(-8);
        await insertWorkflowEvent(env.db, run.id, "verdict", { step_key: step.key, round: step.round, verdict });
        await updateStep(env, step.id, { status: "passed", output: out, verdict, history, finished_at: new Date().toISOString(), ms: step.ms + (Date.now() - t0), inputs: { ...step.inputs, fix_issues: [], conv: { ...conv, stop: "converged" } } });
        return;
      }
      await stopUnit(env, step, conv, "unchanged", { out, ms: step.ms + (Date.now() - t0), ledger: loadLedger(step.inputs?.ledger) });
      await env.note(`「${step.title}」的修正沒有進展，停止修正。`, "warn");
      return;
    }
    step = (await updateStep(env, step.id, { status: "verifying", output: out }))!;
    // Checks first, then the scoped checklist (verify.ts); the same fixed list every round, never a fresh review.
    const v = await verifyUnit(env, step, out, { fresh: !fix });
    const { verdict, ledger } = v;
    const history = [...step.history, { round: step.round, verdict, summary: out.summary.slice(0, 300) }].slice(-8);
    await insertWorkflowEvent(env.db, run.id, "verdict", { step_key: step.key, round: step.round, verdict, score: `${v.score}/${v.total}` });
    const ms = step.ms + (Date.now() - t0);
    const r: UnitRound = { round: step.round, score: v.score, total: v.total, failures: v.failures, ms: Date.now() - t0 };
    if (verdict.verdict === "pass") {
      conv = { ...recordRound(conv, r, out, verdict), stop: "converged" };
      await updateStep(env, step.id, { status: "passed", verdict, history, finished_at: new Date().toISOString(), ms, inputs: { ...step.inputs, fix_issues: [], ledger, conv: slimConv(conv), repair_seed: false } });
      if (v.notes.length) await env.note(`「${step.title}」通過驗收；${v.notes.length} 項來源沒有的資料列入報告（資料未提供），不要求修正。`);
      return;
    }
    const stop = nextMove(conv, r, maxRounds);
    conv = recordRound(conv, r, out, verdict);
    if (stop) {
      await stopUnit(env, { ...step, history }, conv, stop, { out, verdict, ledger, ms, maxRounds: step.round - conv.since });
      await env.note(`「${step.title}」${STOP_LABEL[stop]}，停止修正${conv.best && conv.best.round !== step.round ? `，保留分數較高的第 ${conv.best.round} 輪版本（${conv.best.score}/${conv.best.total}）` : ""}，會在報告中列出。`, "warn");
      return;
    }
    // Failed checks first, then the open checklist problems (with their ids and quoted text).
    const problems = [...verdict.checks.filter((c) => !c.ok).map((c) => c.detail), ...ledger.items.filter((i) => i.status === "open").map(fixLine)];
    await addUsage(env.db, run.id, { fix_rounds: 1 });
    await env.note(`「${step.title}」未通過驗收（${problems.length} 個問題，${v.score}/${v.total}），派出第 ${step.round + 1} 輪修正。`);
    step = (await updateStep(env, step.id, { status: "pending", verdict, history, round: step.round + 1, ms, inputs: { ...step.inputs, fix_issues: problems, ledger, conv: slimConv({ ...conv, own: true }) } }))!;
  }
}

/** The best version's output is only needed while the unit may still stop; a passed unit drops it. */
const slimConv = (c: Convergence): Convergence => (c.stop === "converged" && c.best ? { ...c, best: { ...c.best, output: { summary: c.best.output.summary } } } : c);

/** Ends a unit that did not pass: its best-scoring version becomes the step's output (not the last round). */
async function stopUnit(env: WorkflowEnv, step: StepRow, conv: Convergence, stop: StopReason, o: { out: StepOutput; verdict?: Verdict; ledger?: Ledger; ms: number; error?: string; maxRounds?: number }) {
  const best = conv.best;
  const keep = best && best.round !== step.round && best.output?.text !== undefined ? best : null;
  const ledger = o.ledger ? { ...o.ledger, items: o.ledger.items.map((i) => (i.status === "open" ? { ...i, status: "unresolved" as const, note: `${STOP_LABEL[stop]}，列入報告` } : i)) } : undefined;
  await updateStep(env, step.id, {
    status: "failed",
    output: keep ? keep.output : o.out,
    ...(keep?.verdict ? { verdict: keep.verdict } : o.verdict ? { verdict: o.verdict } : {}),
    history: step.history,
    ms: o.ms,
    finished_at: new Date().toISOString(),
    error: o.error ?? STOP_ERROR[stop](o.maxRounds ?? step.round),
    inputs: { ...step.inputs, ...(ledger ? { ledger } : {}), conv: { ...conv, stop, own: false }, repair_seed: false },
  });
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

/** Final repair: at most one round, and only for criteria whose failure is evidence-backed (checks, verified judged NOs). */
export const MAX_FINAL_ROUNDS = 1;

async function finalStep(env: WorkflowEnv, pb: WorkflowPlaybook, step: StepRow) {
  await setStatus(env, "verifying");
  await addUsage(env.db, env.run.id, { steps: 1 });
  const t0 = Date.now();
  await updateStep(env, step.id, { status: "running", attempts: step.attempts + 1, started_at: new Date().toISOString() });
  env.trackStep(step.id, step.key, step.round);
  const { text, data } = await pb.finalText(env);
  const criteria = await verifyCriteria(env, text, data, step.id);
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
  // The same failures the last repair already targeted are not repaired again (no zero-sum re-runs).
  const targeted = new Set(env.state<string[]>("repaired_criteria") ?? []);
  const fresh = failing.filter((c) => !targeted.has(c.id));
  if (env.run.final_rounds < MAX_FINAL_ROUNDS && fresh.length) {
    let reopen = pb.repair ? await pb.repair(env, fresh) : [];
    const steps = await getSteps(env.db, env.run.id);
    // Requirement criteria the playbook does not map itself: reopen the writers whose own output fails them.
    if (!pb.handlesRequirements) {
      for (const r of requirementRepair(fresh, steps)) {
        const same = reopen.find((x) => x.key === r.key);
        if (same) same.issues = [...same.issues, ...r.issues];
        else reopen = [...reopen, r];
      }
    }
    const targets = reopen.filter((r) => steps.some((s) => s.key === r.key && s.kind !== "final"));
    if (targets.length) {
      await env.note(`最終驗收有 ${failing.length} 項未達成，針對 ${targets.length} 個步驟派出一輪修正（只修有證據的問題）。`);
      for (const r of targets) {
        const s = steps.find((x) => x.key === r.key)!;
        // One repair round (+ the unit's own fix when it breaks a check); the version before it is the baseline to beat.
        await updateStep(env, s.id, { status: "pending", round: s.round + 1, max_rounds: s.round + 2, inputs: { ...s.inputs, fix_issues: r.issues, repair_seed: true } });
      }
      for (const key of dependents(steps, new Set(targets.map((t) => t.key)))) {
        const s = steps.find((x) => x.key === key)!;
        if (s.kind === "final") continue;
        await updateStep(env, s.id, { status: "pending", inputs: { ...s.inputs, fix_issues: [] } });
      }
      await addUsage(env.db, env.run.id, { fix_rounds: 1 });
      await env.setState({ repaired_criteria: [...targeted, ...fresh.map((c) => c.id)] });
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
  if (stop.reason === "ask") {
    await env.db.query("UPDATE workflow_steps SET status='pending' WHERE run_id=$1 AND status IN ('running','verifying')", [env.run.id]);
    const card = pendingAsk(env.run.state);
    await setStatus(env, "awaiting_input", { question: card?.title ?? stop.message });
    await env.note(`等待你回答：${card?.title ?? stop.message}`);
    await finishNotice(env, "awaiting_input");
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

/**
 * Done = no stop, every criterion passes (「資料未提供」 notes and dropped, unverifiable critiques allowed) and no step's
 * kept version fails a deterministic check (or never produced a verified version). A step that stopped only on judged
 * items is a report item, not a reason for 部分完成 — "every step passed" is not required. A run without criteria is
 * done when every step passed.
 */
export function outcomeOf(criteria: Criterion[], steps: Pick<StepRow, "status" | "error" | "verdict" | "kind">[], stop: WorkflowStop | null, covered: Record<string, string> = {}): "done" | "partial" {
  if (stop) return "partial";
  if (!criteria.length) return steps.length && steps.every((s) => s.status === "passed" || (s.status === "skipped" && !s.error)) ? "done" : "partial";
  // A failing step check that a passing criterion re-checks on the shipped artifact is superseded (eval
  // deck_followup_expand / deck_add_page: a writer's page check failed, later steps fixed the page, every criterion
  // passed — and the run still ended partial).
  const isCovered = (id: string) => criteria.some((c) => c.status === "pass" && (c.check?.id === id || covered[id] === c.id));
  const brokenStep = steps.some((s) => s.kind !== "final" && s.status === "failed" && (!s.verdict || s.verdict.checks.some((c) => !c.ok && !isCovered(c.id))));
  return criteria.every((c) => c.status === "pass") && !brokenStep ? "done" : "partial";
}

async function finish(env: WorkflowEnv, pb: WorkflowPlaybook, stop: WorkflowStop | null) {
  await env.refresh();
  const steps = await getSteps(env.db, env.run.id);
  const outcome = outcomeOf(env.run.criteria, steps, stop, pb.coveredChecks);
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
  // The artifact keeps the run's standing requirements (language, audience, tone): the next edit inherits them.
  await persistStanding(env).catch((e) => env.deps.log.warn({ err: e, workflowId: env.run.id }, "workflow preferences not saved"));
  const report = buildReport(env.run, steps, outcome, stop, commitLine);
  // Autopilot: one more 繼續改 round only for failures no repair has targeted yet — never for unchanged failures.
  const unmet = env.run.criteria.filter((c) => c.status === "fail");
  const targeted = new Set(env.state<string[]>("repaired_criteria") ?? []);
  const untried = unmet.filter((c) => !targeted.has(c.id));
  const autoMore = outcome === "partial" && !stop && env.run.autopilot && untried.length > 0 && !env.state<boolean>("auto_continued");
  await setStatus(env, outcome, { report, stop_reason: stop?.reason ?? null, finished_at: new Date().toISOString() });
  if (autoMore) {
    await env.setState({ auto_continued: true });
    const { continueRun } = await import("./service.js");
    await continueRun(env.db, env.run.id, `修正未達成的驗收標準：${untried.map((c) => `${c.text}${c.reason ? `（${c.reason.slice(0, 160)}）` : ""}`).join("；")}`.slice(0, 2000));
    // The autopilot round repairs only the untried failures: the ones a repair already tried stay excluded.
    await env.setState({ repaired_criteria: [...targeted] });
    await env.note(`自動駕駛：還有 ${untried.length} 項驗收標準未達成（之前沒有修正過），自動再修一輪。`);
    await env.refresh();
    return;
  }
  await finishNotice(env, outcome);
}

const minutes = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分鐘` : `${Math.max(1, Math.round(ms / 1000))} 秒`);

/** Per step: time, fix rounds of the last session, the version kept and why the unit stopped (P4 observability). */
export function stepReports(steps: StepRow[]): StepReport[] {
  return steps.filter((s) => s.kind !== "final" && (s.attempts > 0 || s.ms > 0)).map((s) => {
    const conv = loadConv(s.inputs?.conv);
    const rounds = conv ? Math.max(0, (conv.rounds.at(-1)?.round ?? s.round) - conv.since) : s.round;
    const best = conv?.best;
    const kept = !!best && s.status === "failed" && best.round !== conv?.rounds.at(-1)?.round;
    return {
      key: s.key, title: s.title, status: s.status, ms: s.ms, rounds,
      ...(best ? { best_round: best.round, best_score: `${best.score}/${best.total}` } : {}),
      ...(kept ? { kept_best: true } : {}),
      ...(conv?.stop ? { stop: conv.stop, stop_label: STOP_LABEL[conv.stop] } : {}),
    };
  });
}

export function buildReport(run: RunRow, steps: StepRow[], outcome: "done" | "partial", stop: WorkflowStop | null, commitLine: string | null) {
  const passed = steps.filter((s) => s.status === "passed");
  const fixed = steps.filter((s) => s.history.length > 1 && s.kind !== "final");
  const done = passed.filter((s) => s.kind !== "final").map((s) => `${s.title}${s.history.length > 1 ? `（經 ${s.history.length - 1} 輪修正後通過）` : ""}`);
  const issues: string[] = [];
  // A criterion the final verification never reached (budget / stop) or could not judge is 「未驗收」, not failed.
  for (const c of run.criteria) if (c.status !== "pass") issues.push(`${c.status === "fail" ? "未達成" : "未驗收"}：${c.text}${c.reason ? `（${c.reason}）` : ""}`);
  for (const s of steps) if (s.status === "failed") issues.push(`「${s.title}」未通過驗收：${(s.verdict?.issues ?? []).filter((i) => i.severity !== "low").map((i) => i.text).slice(0, 3).join("；") || s.error || ""}`);
  // Issue ledgers: problems a passed step could not fix within its rounds are report items too.
  const ledger = ledgerReport(run, steps);
  for (const s of steps) {
    if (s.status !== "passed" || s.kind === "final") continue;
    const left = ((s.inputs?.ledger as { items?: { status: string; text: string; where?: string }[] } | undefined)?.items ?? []).filter((i) => i.status === "unresolved");
    for (const i of left.slice(0, 3)) issues.push(`仍未解決（「${s.title}」${i.where ? `${i.where}` : ""}）：${i.text.slice(0, 200)}`);
  }
  if (stop) issues.push(stop.message);
  const ok = run.criteria.filter((c) => c.status === "pass").length;
  // Student-owned pages autopilot filled (student-input.ts): acceptable for the run, but the student must confirm them.
  const aiFilled = Array.isArray(run.state?.ai_filled) ? (run.state.ai_filled as string[]) : [];
  const confirm = aiFilled.map((t) => `「${t}」是 AI 代填（標示「AI 代填，待你確認」），請確認或按「修改答案」換成你自己的看法。`);
  const per = stepReports(steps);
  const stopped = per.filter((p) => p.stop && p.stop !== "converged");
  const lines = [
    outcome === "done" ? `**已完成**，${run.criteria.length} 項驗收標準全部通過${ledger.notes?.length ? `（${ledger.notes.length} 項來源沒有的資料列為備註）` : ""}。` : `**部分完成**：${ok}/${run.criteria.length} 項驗收標準通過，尚有問題需要處理。`,
    "",
    `- 完成的步驟：${done.length} 個${fixed.length ? `（其中 ${fixed.length} 個經過修正）` : ""}`,
    ...(ledger.fixed.length || ledger.unresolved.length || ledger.invalid.length ? [`- 驗收問題：已修正 ${ledger.fixed.length} 個、仍未解決 ${ledger.unresolved.length} 個、判定無效 ${ledger.invalid.length} 個`] : []),
    ...(stopped.length ? [`- 停止修正的步驟：${stopped.map((p) => `${p.title}（${p.stop_label}${p.kept_best ? `，保留第 ${p.best_round} 輪的較佳版本` : ""}）`).join("、")}`] : []),
    ...(commitLine ? [`- ${commitLine}`] : []),
    ...(run.artifacts.length ? ["", "成果：", ...run.artifacts.map((a) => `- [${a.title}](${a.url})`)] : []),
    ...(confirm.length ? ["", "待你確認：", ...confirm.map((i) => `- ${i}`)] : []),
    ...(issues.length ? ["", "待處理：", ...issues.map((i) => `- ${i}`)] : []),
    ...(ledger.notes?.length ? ["", "資料未提供（來源沒有，沒有要求補上）：", ...ledger.notes.slice(0, 10).map((i) => `- ${i}`)] : []),
    ...(per.length ? ["", "各步驟：", ...per.map((p) => `- ${p.title}：${minutes(p.ms)}${p.rounds ? `，修正 ${p.rounds} 輪` : ""}${p.best_score ? `，${p.kept_best ? `保留第 ${p.best_round} 輪版本` : "最終版本"} ${p.best_score}` : ""}${p.stop_label ? `（${p.stop_label}）` : ""}`)] : []),
  ];
  return { summary_md: lines.join("\n"), done, issues, ...(confirm.length ? { confirm } : {}), ledger, steps: per };
}

/** Re-checks that the owner may still edit the study (before each write). */
export async function requireEditor(env: WorkflowEnv, studyId: string) {
  const access = await loadStudyAccess(env.db, studyId, env.user);
  if (!access.canEdit) throw new WorkflowStop("access", `你已經不是〈${access.study.title}〉的成員，工作流程不能再寫入。`);
  return access;
}
