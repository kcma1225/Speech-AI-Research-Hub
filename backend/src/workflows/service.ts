/**
 * Workflow commands used by the routes and the chat tools: create (from the API, the composer or `start_workflow`),
 * approve / revise the plan, pause / resume / 繼續改, cancel, guidance, objective edits, publish, delete.
 * Every command checks ownership; the engine re-checks study write access before every write.
 */
import type { FastifyInstance } from "fastify";
import { transaction, type Queryable } from "../db.js";
import { insertEvent } from "../agent/events.js";
import { envelope } from "../agent/prompt.js";
import { conversationView, messageView, runView as agentRunView, toolCallView, type ConversationRow, type MessageRow, type RunRow as AgentRunRow, type ToolCallRow } from "../agent/views.js";
import type { CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/http.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { cancelJob } from "../jobs/queue.js";
import { enqueueWorkflow } from "./jobs.js";
import { emitRun, getRun, getSteps, insertSteps, insertWorkflowEvent, runView, stepView } from "./store.js";
import { detectPlaybook, getWorkflowPlaybook } from "./playbooks/index.js";
import { WorkflowEnv } from "./env.js";
import { asksOf, cardAnswersText, validateCardAnswers } from "./questions.js";
import { DEFAULT_BUDGET, FINISHED_STATUSES, type Criterion, type RunRow, type StepRow } from "./types.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { batchPapers, batchRequest, conversationContext, studyFromText } from "./context.js";
import { lockUserSlots, MAX_ACTIVE_PER_USER, promoteAllQueued, promoteQueued, slotUsage } from "./queue.js";

export { MAX_ACTIVE_PER_USER } from "./queue.js";

export type WorkflowInputs = { study?: string; paper_id?: string; deck_id?: string; project_id?: string; note_ids?: string[]; paper_ids?: string[]; pages?: number; mode?: "progress" | "paper_report" };
export type CreateInput = { request: string; playbook?: string; conversationId?: string | null; toolCallId?: string | null; context?: Record<string, unknown> | null; inputs?: WorkflowInputs; autopilot?: boolean };

async function ownRun(db: Queryable, user: CurrentUser, id: string, forUpdate = false) {
  const r = await getRun(db, id, forUpdate);
  if (!r || r.user_id !== user.id) throw notFound("找不到這個工作流程。");
  return r;
}

const titleFrom = (request: string) => request.replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * Creates the run(s) and enqueues their jobs. Inside `client`'s transaction. The study / paper are inherited from the
 * inputs, the page context, the conversation, or a study named in the request (context.ts); a per-paper request for
 * 「每一篇文獻」 becomes a **batch** (one run per paper, shared `batch_id`). Runs over the per-user working limit get
 * status `queued` and start automatically when a slot frees (queue.ts).
 */
export async function insertWorkflows(client: Queryable, user: CurrentUser, input: CreateInput): Promise<{ runs: RunRow[]; batchId: string | null }> {
  if (user.role === "admin") throw forbidden("管理員帳號只能管理系統設定與使用者。");
  const inputs = { ...(input.inputs ?? {}) };
  const conv = await conversationContext(client, input.conversationId, user.id);
  const ctx = { ...conv, ...(input.context ?? {}) } as Record<string, unknown>;
  let studyRef = inputs.study ?? (ctx.studyId as string | undefined) ?? (ctx.studySlug as string | undefined);
  if (!inputs.paper_id && typeof ctx.paperId === "string") inputs.paper_id = ctx.paperId;
  if (!inputs.deck_id && typeof ctx.deckId === "string" && /簡報|投影片|slide|deck/i.test(input.request)) inputs.deck_id = ctx.deckId;
  if (!studyRef && !inputs.paper_id) studyRef = (await studyFromText(client, user, input.request)) ?? undefined;
  let studyId: string | null = null;
  if (studyRef) studyId = (await loadStudyAccess(client, studyRef, user)).study.id;
  if (studyId && !inputs.study) inputs.study = studyId;
  const playbook = input.playbook && getWorkflowPlaybook(input.playbook) ? input.playbook : detectPlaybook(input.request, inputs as Record<string, unknown>);
  const items = await batchPapers(client, { playbook, request: input.request, studyId, paperId: inputs.paper_id, paperIds: inputs.paper_ids });
  await lockUserSlots(client, user.id);
  const usage = await slotUsage(client, user.id);
  let working = usage.working;
  let queuedBefore = usage.queued;
  const batchId = items ? randomUUID() : null;
  const specs = items
    ? items.map((it, i) => ({ request: batchRequest(input.request, it, i, items.length), inputs: { ...inputs, paper_id: it.paper_id, paper_ids: undefined, ...(playbook === "slides" ? { mode: "paper_report" as const } : {}) }, title: `${titleFrom(it.title)}`, index: i }))
    : [{ request: input.request, inputs, title: titleFrom(input.request), index: null as number | null }];
  const runs: RunRow[] = [];
  for (const sp of specs) {
    // FIFO: once anything waits, later runs wait behind it.
    const status = working >= MAX_ACTIVE_PER_USER || queuedBefore > 0 ? "queued" : "planning";
    if (status === "planning") working++;
    else queuedBefore++;
    const row = (await client.query<RunRow>(
      `INSERT INTO workflow_runs(user_id,study_id,conversation_id,tool_call_id,playbook,title,request,inputs,context,autopilot,budget,status,batch_id,batch_index)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [user.id, studyId, input.conversationId ?? null, input.toolCallId ?? null, playbook, sp.title, sp.request.slice(0, 4000), JSON.stringify(sp.inputs), JSON.stringify(ctx), !!input.autopilot, JSON.stringify(DEFAULT_BUDGET), status, batchId, sp.index],
    )).rows[0]!;
    await enqueueWorkflow(client, row.id, user.id, row.title);
    runs.push((await getRun(client, row.id))!);
  }
  return { runs, batchId };
}

/** One run (no batch expansion is skipped: a batch request returns its first run). */
export async function insertWorkflow(client: Queryable, user: CurrentUser, input: CreateInput): Promise<RunRow> {
  return (await insertWorkflows(client, user, input)).runs[0]!;
}

async function announce(app: { db: Db }, runs: RunRow[]) {
  for (const run of runs) {
    await emitRun(app.db, run.id);
    await insertWorkflowEvent(app.db, run.id, "log", { level: "info", text: run.status === "queued" ? `排隊中：同時最多 ${MAX_ACTIVE_PER_USER} 個工作流程在執行，前面的完成或停下來等你時會自動開始。` : "已收到任務，主要 Agent 開始規劃。" });
  }
}

export async function createWorkflow(app: FastifyInstance, user: CurrentUser, input: CreateInput) {
  return (await createWorkflows(app, user, input)).runs[0]!;
}

export async function createWorkflows(app: FastifyInstance, user: CurrentUser, input: CreateInput) {
  const out = await transaction(app.db, (client) => insertWorkflows(client, user, input));
  await announce(app, out.runs);
  return out;
}

/** The `start_workflow` tool result (one run or a batch). */
export function startResult(out: { runs: RunRow[]; batchId: string | null }) {
  const first = out.runs[0]!;
  if (!out.batchId) return { workflow_id: first.id, status: first.status, playbook: first.playbook };
  return { batch_id: out.batchId, workflow_ids: out.runs.map((r) => r.id), workflows: out.runs.map((r) => ({ id: r.id, title: r.title, status: r.status, paper_id: r.inputs.paper_id })), status: "batch", playbook: first.playbook };
}

/**
 * 「交給 Agent」 / `/agent`: appends the user message and a synthetic `start_workflow` call (assistant tool_use + its
 * result + the tool message: a valid transcript, no model call) to the conversation, then creates the workflow.
 */
export async function startFromChat(app: FastifyInstance, user: CurrentUser, input: CreateInput & { conversationId: string }) {
  const out = await transaction(app.db, async (client) => {
    const conv = (await client.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [input.conversationId, user.id])).rows[0];
    if (!conv) throw notFound("找不到這個對話。");
    if (conv.mode !== "chat") throw badRequest("這個對話不能啟動工作流程。");
    const busy = (await client.query("SELECT 1 FROM agent_runs WHERE conversation_id=$1 AND status IN ('running','awaiting_approval','awaiting_llm')", [conv.id])).rowCount;
    if (busy) throw conflict("AI 正在回覆中，請先按「停止」或等它完成。");
    const ctx = input.context ?? (conv.context as Record<string, unknown>) ?? {};
    const msg = (await client.query<MessageRow>(
      "INSERT INTO agent_messages(conversation_id,role,content,text,page_context) VALUES($1,'user',$2,$3,$4) RETURNING *",
      [conv.id, JSON.stringify([{ type: "text", text: `（交給 Agent）${input.request}` }]), input.request, Object.keys(ctx).length ? JSON.stringify(ctx) : null],
    )).rows[0]!;
    const agentRun = (await client.query<AgentRunRow>("INSERT INTO agent_runs(conversation_id,user_id,status,max_steps,stop_reason,finished_at) VALUES($1,$2,'done',25,'workflow',now()) RETURNING *", [conv.id, user.id])).rows[0]!;
    await client.query("UPDATE agent_messages SET run_id=$2 WHERE id=$1", [msg.id, agentRun.id]);
    const callId = `wf_${agentRun.id.slice(0, 8)}`;
    const args = { request: input.request, ...(input.playbook ? { playbook: input.playbook } : {}) };
    const intro = "好的，我把這件事交給工作流程：先擬出目標、驗收標準與計畫給你確認，確認後才開始寫入草稿。";
    const am = (await client.query<MessageRow>(
      "INSERT INTO agent_messages(conversation_id,run_id,role,content,text) VALUES($1,$2,'assistant',$3,$4) RETURNING *",
      [conv.id, agentRun.id, JSON.stringify([{ type: "text", text: intro }, { type: "tool_use", id: callId, name: "start_workflow", input: args }]), intro],
    )).rows[0]!;
    const tc = (await client.query<ToolCallRow>(
      `INSERT INTO tool_calls(run_id,conversation_id,message_id,step,position,provider_call_id,tool,args,risk,status,summary)
       VALUES($1,$2,$3,0,0,$4,'start_workflow',$5,'read','running',$6) RETURNING *`,
      [agentRun.id, conv.id, am.id, callId, JSON.stringify(args), `交給 Agent：${titleFrom(input.request)}`],
    )).rows[0]!;
    const created = await insertWorkflows(client, user, { ...input, context: ctx, toolCallId: tc.id, autopilot: input.autopilot ?? conv.autopilot });
    const run = created.runs[0]!;
    const data = startResult(created);
    const text = envelope("start_workflow", JSON.stringify({ ...data, message: created.batchId ? `已拆成 ${created.runs.length} 個工作流程（每篇一個），超過同時上限的會排隊自動開始。不要描述結果，等工作流程回報。` : "工作流程已開始規劃；計畫卡片已顯示給使用者，確認後才會執行。不要描述結果，等工作流程回報。" }), { untrusted: false });
    await client.query("UPDATE tool_calls SET status='done', result=$2, result_text=$3, finished_at=now() WHERE id=$1", [tc.id, JSON.stringify({ data, links: [], source: null, untrusted: false }), text]);
    await client.query("INSERT INTO agent_messages(conversation_id,run_id,role,content) VALUES($1,$2,'tool',$3)", [conv.id, agentRun.id, JSON.stringify([{ type: "tool_result", tool_use_id: callId, content: text }])]);
    const conversation = (await client.query<ConversationRow>("UPDATE conversations SET updated_at=now(), title=CASE WHEN title='' THEN $2 ELSE title END WHERE id=$1 RETURNING *", [conv.id, titleFrom(input.request).slice(0, 40)])).rows[0]!;
    const call = (await client.query<ToolCallRow>("SELECT * FROM tool_calls WHERE id=$1", [tc.id])).rows[0]!;
    return { run, runs: created.runs, msg, am, call, agentRun, conversation };
  });
  for (const [type, data] of [
    ["message", { message: messageView(out.msg) }],
    ["message", { message: messageView(out.am) }],
    ["tool_call", { toolCall: toolCallView(out.call, { provenance: [] }) }],
    ["run", { run: agentRunView(out.agentRun) }],
    ["conversation", { conversation: conversationView(out.conversation) }],
  ] as const) await insertEvent(app.db, input.conversationId, out.agentRun.id, type, data as Record<string, unknown>);
  await announce(app, out.runs);
  return out.run;
}

// ---------------------------------------------------------------- plan approval

type ApproveInput = { objective?: string; criteria?: { id?: string; text: string }[]; steps?: { key: string; title?: string; instructions?: string; skip?: boolean }[]; outline?: { title: string; points: string[] }[] };

export async function approveWorkflow(app: FastifyInstance, user: CurrentUser, id: string, edits: ApproveInput) {
  const r = await ownRun(app.db, user, id);
  if (r.status !== "awaiting_plan_approval") throw conflict("這個計畫目前不能核准（可能已經開始或已結束）。");
  const pb = getWorkflowPlaybook(r.playbook);
  // Outline edits may re-derive the later steps (slides: writer groups follow the pages).
  let outline = r.plan?.outline;
  let replacement: import("./types.js").StepSpec[] | undefined;
  if (edits.outline?.length && pb?.applyEdits) {
    const env = new WorkflowEnv({ db: app.db, storage: app.storage, app, model: null as never, log: app.log, signal: new AbortController().signal, jobId: null }, r, user);
    const res = await pb.applyEdits(env, { outline: edits.outline, steps: edits.steps }, outline);
    outline = res.outline ?? outline;
    replacement = res.steps;
  }
  await transaction(app.db, async (client) => {
    const locked = await ownRun(client, user, id, true);
    if (locked.status !== "awaiting_plan_approval") throw conflict("這個計畫目前不能核准。");
    let criteria: Criterion[] = locked.criteria;
    if (edits.criteria) {
      criteria = edits.criteria.slice(0, 12).map((c, i) => {
        const old = c.id ? locked.criteria.find((x) => x.id === c.id) : undefined;
        if (old) return { ...old, text: c.text.slice(0, 300) || old.text, status: "pending" as const };
        return { id: `u${i + 1}`, kind: "judge" as const, text: c.text.slice(0, 300), status: "pending" as const };
      }).filter((c) => c.text.trim());
    }
    if (outline && pb?.id === "slides" && edits.outline?.length) {
      const n = outline.length;
      criteria = criteria.map((c) => (c.id === "pages" ? { ...c, text: `簡報正好 ${n} 頁，頁面順序與確認的大綱一致`, check: { id: "slide_count", params: { expected: n } } } : c));
    }
    const plan = locked.plan ? { ...locked.plan, ...(outline ? { outline } : {}) } : null;
    if (replacement) {
      const keep = (await getSteps(client, id)).filter((s) => s.status === "passed" && (s.key === "research" || s.key === "outline"));
      await client.query("DELETE FROM workflow_steps WHERE run_id=$1 AND NOT (key = ANY($2))", [id, keep.map((s) => s.key)]);
      if (keep.find((s) => s.key === "outline") && outline) await client.query("UPDATE workflow_steps SET output = output || jsonb_build_object('summary', $2::text) WHERE run_id=$1 AND key='outline'", [id, `${outline.length} 頁大綱（已由使用者修改）`]);
      await insertSteps(client, id, replacement, keep.length);
    }
    for (const s of edits.steps ?? []) {
      const sets: string[] = [];
      const vals: unknown[] = [id, s.key];
      if (s.title?.trim()) (vals.push(s.title.slice(0, 200)), sets.push(`title=$${vals.length}`));
      if (s.instructions?.trim()) (vals.push(s.instructions.slice(0, 4000)), sets.push(`instructions=$${vals.length}`));
      if (s.skip) sets.push("status='skipped'");
      if (sets.length) await client.query(`UPDATE workflow_steps SET ${sets.join(", ")} WHERE run_id=$1 AND key=$2 AND status='pending' AND kind='task'`, vals);
    }
    await client.query("UPDATE workflow_runs SET status='running', objective=coalesce($2, objective), criteria=$3, plan=$4, updated_at=now() WHERE id=$1", [id, edits.objective?.trim() ? edits.objective.slice(0, 1000) : null, JSON.stringify(criteria), plan ? JSON.stringify(plan) : null]);
    await enqueueWorkflow(client, id, user.id, locked.title);
  });
  for (const s of await getSteps(app.db, id)) await insertWorkflowEvent(app.db, id, "step", { step: stepView(s) });
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: "計畫已核准，開始派出子任務。" });
  return emitRun(app.db, id);
}

/**
 * 「修改」: re-plan with the user's feedback — at plan approval, or on a plan autopilot approved (while it runs or is
 * paused: the drafts written so far stay and are reused; the new plan then waits for the user's approval).
 */
export async function revisePlan(app: FastifyInstance, user: CurrentUser, id: string, feedback: string) {
  await transaction(app.db, async (client) => {
    const r = await ownRun(client, user, id, true);
    const autoApproved = !!(r.state?.auto_approved as { at?: string } | null | undefined)?.at && ["running", "verifying", "paused"].includes(r.status);
    if (!["awaiting_plan_approval", "awaiting_input"].includes(r.status) && !autoApproved) throw conflict("只有在確認計畫時才能修改計畫。");
    const guidance = [...r.guidance, { at: new Date().toISOString(), text: feedback.slice(0, 2000), applied: false }];
    if (r.status === "running" || r.status === "verifying") {
      // Working: stop after the current sub-agent call(s), then the engine re-plans (engine.ts, revise_requested).
      await client.query("UPDATE workflow_runs SET pause_requested=true, guidance=$2, state = state || '{\"revise_requested\":true,\"manual_approval\":true}'::jsonb, updated_at=now() WHERE id=$1", [id, JSON.stringify(guidance)]);
      return;
    }
    await client.query(
      "UPDATE workflow_runs SET status='planning', guidance=$2, question=NULL, pause_requested=false, state = state || $3::jsonb, updated_at=now() WHERE id=$1",
      [id, JSON.stringify(guidance), JSON.stringify(autoApproved || r.autopilot ? { manual_approval: true } : {})],
    );
    await enqueueWorkflow(client, id, user.id, r.title);
  });
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: "依你的意見重新規劃。" });
  return emitRun(app.db, id);
}

// ---------------------------------------------------------------- run control

export async function pauseWorkflow(app: FastifyInstance, user: CurrentUser, id: string) {
  const r = await ownRun(app.db, user, id);
  if (!["running", "verifying", "planning"].includes(r.status)) throw conflict("只有執行中的工作流程可以暫停。");
  await app.db.query("UPDATE workflow_runs SET pause_requested=true, updated_at=now() WHERE id=$1", [id]);
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: "會在目前的子任務完成後暫停。" });
  return emitRun(app.db, id);
}

/** Reopens failed steps for one more round (繼續改) and their dependents. */
async function reopenForMore(client: Queryable, id: string) {
  const steps = await getSteps(client, id);
  const failed = steps.filter((s) => s.status === "failed" || s.status === "skipped" || s.status === "cancelled");
  const keys = new Set(failed.map((s) => s.key));
  for (const s of failed) {
    const issues = (s.verdict?.issues ?? []).filter((i) => i.severity !== "low").map((i) => i.text);
    await client.query("UPDATE workflow_steps SET status='pending', error=NULL, round=CASE WHEN $3 THEN round+1 ELSE round END, max_rounds=round+2, inputs = inputs || jsonb_build_object('fix_issues', $2::jsonb) WHERE id=$1", [s.id, JSON.stringify(issues), issues.length > 0 && !!s.output]);
  }
  // Dependents (integrate/final) run again after the fixes.
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps) if (!keys.has(s.key) && s.depends_on.some((d) => keys.has(d))) (keys.add(s.key), (grew = true));
  }
  for (const s of steps) if (keys.has(s.key) && !failed.includes(s)) await client.query("UPDATE workflow_steps SET status='pending', error=NULL WHERE id=$1", [s.id]);
  const final = steps.find((s) => s.kind === "final");
  if (final && final.status !== "pending") await client.query("UPDATE workflow_steps SET status='pending', error=NULL WHERE id=$1", [final.id]);
  return steps.length;
}

export async function resumeWorkflow(app: FastifyInstance, user: CurrentUser, id: string, opts: { more?: boolean; guidance?: string } = {}) {
  await transaction(app.db, async (client) => {
    const r = await ownRun(client, user, id, true);
    const guidance = opts.guidance ? [...r.guidance, { at: new Date().toISOString(), text: opts.guidance.slice(0, 2000), applied: false }] : r.guidance;
    if (r.status === "paused") {
      await client.query("UPDATE workflow_runs SET status='running', pause_requested=false, guidance=$2, updated_at=now() WHERE id=$1", [id, JSON.stringify(guidance)]);
    } else if (r.status === "needs_pdf") {
      // 「繼續」 after uploading the PDF (or with guidance): plan again (the paper is re-read).
      await client.query("UPDATE workflow_runs SET status='planning', question=NULL, guidance=$2, updated_at=now() WHERE id=$1", [id, JSON.stringify(guidance)]);
    } else if (r.status === "awaiting_input") {
      // Blocked during planning → plan again; blocked during execution (steps exist) → continue the steps.
      const hasSteps = (await getSteps(client, id)).length > 0;
      await client.query("UPDATE workflow_runs SET status=$3, question=NULL, guidance=$2, state = state - 'ask_pending', updated_at=now() WHERE id=$1", [id, JSON.stringify(guidance), hasSteps ? "running" : "planning"]);
    } else if (r.status === "partial" || r.status === "done" || r.status === "failed" || (r.status === "cancelled" && opts.more)) {
      const n = await reopenForMore(client, id);
      const budget = { ...r.budget, max_steps: r.budget.max_steps + 12, max_calls: r.budget.max_calls + 24, max_minutes: r.budget.max_minutes + 15, max_tokens: r.budget.max_tokens + 300_000 };
      await client.query(
        "UPDATE workflow_runs SET status=$2, final_rounds=GREATEST(final_rounds-1,0), guidance=$3, budget=$4, report=NULL, error=NULL, stop_reason=NULL, finished_at=NULL, pause_requested=false, criteria=COALESCE((SELECT jsonb_agg(c || '{\"status\":\"pending\"}'::jsonb) FROM jsonb_array_elements(criteria) c), '[]'::jsonb), updated_at=now() WHERE id=$1",
        [id, n ? "running" : "planning", JSON.stringify(guidance), JSON.stringify(budget)],
      );
    } else if (r.status === "running" || r.status === "verifying" || r.status === "planning") {
      if (opts.guidance) await client.query("UPDATE workflow_runs SET guidance=$2, updated_at=now() WHERE id=$1", [id, JSON.stringify(guidance)]);
    } else throw conflict("這個工作流程目前不能繼續。");
    await enqueueWorkflow(client, id, user.id, r.title);
  });
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: opts.guidance ? `收到補充指示：${opts.guidance.slice(0, 200)}` : opts.more ? "繼續改：針對未通過的部分再修正一輪。" : "繼續執行。" });
  return emitRun(app.db, id);
}

export async function addGuidance(app: FastifyInstance, user: CurrentUser, id: string, text: string) {
  const r = await ownRun(app.db, user, id);
  if (r.status === "awaiting_plan_approval") return revisePlan(app, user, id, text);
  if (FINISHED_STATUSES.includes(r.status) && r.status !== "cancelled") return resumeWorkflow(app, user, id, { more: true, guidance: text });
  if (r.status === "cancelled") throw conflict("工作流程已停止，請重新開始一個。");
  if (r.status === "queued") throw conflict("這個工作流程還在排隊，開始後才能補充指示。");
  return resumeWorkflow(app, user, id, { guidance: text });
}

export async function cancelWorkflow(app: FastifyInstance, user: CurrentUser, id: string) {
  await transaction(app.db, async (client) => {
    const r = await ownRun(client, user, id, true);
    if (FINISHED_STATUSES.includes(r.status)) throw conflict("這個工作流程已經結束了。");
    await client.query("UPDATE workflow_runs SET status='cancelled', stop_reason='cancelled', finished_at=now(), updated_at=now() WHERE id=$1", [id]);
    if (r.job_id) await cancelJob(client, r.job_id);
    // Not running (waiting for approval / paused / input): close the steps now; a running job does it when it stops.
    const running = r.job_id ? (await client.query("SELECT 1 FROM jobs WHERE id=$1 AND status='running'", [r.job_id])).rowCount : 0;
    if (!running) await client.query("UPDATE workflow_steps SET status='cancelled', finished_at=now() WHERE run_id=$1 AND status IN ('pending','running','verifying')", [id]);
  });
  for (const s of await getSteps(app.db, id)) if (s.status === "cancelled") await insertWorkflowEvent(app.db, id, "step", { step: stepView(s) });
  await insertWorkflowEvent(app.db, id, "log", { level: "warn", text: "已停止；已經寫入的草稿會保留。" });
  const out = await emitRun(app.db, id);
  await promoteQueued(app.db, user.id).catch(() => undefined);
  return out;
}

export async function patchWorkflow(app: FastifyInstance, user: CurrentUser, id: string, input: { objective?: string; criteria?: { id?: string; text: string }[] }) {
  await transaction(app.db, async (client) => {
    const r = await ownRun(client, user, id, true);
    if (!["awaiting_plan_approval", "paused", "done", "partial", "failed"].includes(r.status)) throw conflict("執行中無法修改目標，請先暫停。");
    const criteria = input.criteria
      ? input.criteria.slice(0, 12).map((c, i) => {
          const old = c.id ? r.criteria.find((x) => x.id === c.id) : undefined;
          return old ? { ...old, text: c.text.slice(0, 300), status: "pending" as const } : { id: `u${i + 1}`, kind: "judge" as const, text: c.text.slice(0, 300), status: "pending" as const };
        })
      : r.criteria;
    const objective = input.objective?.trim() ? input.objective.slice(0, 1000) : r.objective;
    const changed = objective !== r.objective;
    if (r.status === "awaiting_plan_approval" || !changed) {
      await client.query("UPDATE workflow_runs SET objective=$2, criteria=$3, updated_at=now() WHERE id=$1", [id, objective, JSON.stringify(criteria)]);
      return;
    }
    // A new objective on a paused / finished run is a new plan (drafts already written stay).
    const guidance = [...r.guidance, { at: new Date().toISOString(), text: `目標改為：${objective}`, applied: false }];
    await client.query("UPDATE workflow_runs SET objective=$2, criteria=$3, guidance=$4, status='planning', report=NULL, finished_at=NULL, stop_reason=NULL, request=$5, updated_at=now() WHERE id=$1", [id, objective, JSON.stringify(criteria), JSON.stringify(guidance), `${r.request}\n\n（修改後的目標）${objective}`.slice(0, 4000)]);
    await enqueueWorkflow(client, id, user.id, r.title);
  });
  return emitRun(app.db, id);
}

export async function deleteWorkflow(app: FastifyInstance, user: CurrentUser, id: string) {
  const r = await ownRun(app.db, user, id);
  if (!FINISHED_STATUSES.includes(r.status) && !["awaiting_plan_approval", "awaiting_input", "needs_pdf", "queued"].includes(r.status)) throw conflict("請先停止這個工作流程。");
  if (r.job_id && r.status === "queued") await cancelJob(app.db, r.job_id);
  await app.db.query("DELETE FROM workflow_runs WHERE id=$1", [id]);
}

export async function publishWorkflowDeck(app: FastifyInstance, user: CurrentUser, id: string) {
  const r = await ownRun(app.db, user, id);
  if (r.playbook !== "slides") throw badRequest("只有簡報工作流程可以發布。");
  if (!FINISHED_STATUSES.includes(r.status)) throw conflict("請等工作流程結束後再發布。");
  const deck = (r.state?.deck as { deck_id?: string } | undefined)?.deck_id;
  if (!deck) throw conflict("這個工作流程還沒有寫入簡報。");
  const study = (await app.db.query<{ study_id: string }>("SELECT study_id FROM decks WHERE id=$1", [deck])).rows[0];
  if (!study) throw notFound("簡報不存在。");
  const access = await loadStudyAccess(app.db, study.study_id, user);
  if (!access.canEdit) throw forbidden("只有研究成員可以發布。");
  const { publishTree } = await import("../lib/slides/publish.js");
  const out = await publishTree(app.db, app.storage, deck, user.id, { maxZipBytes: app.config.MAX_SLIDE_ZIP_BYTES });
  if (!out) throw conflict("沒有可以發布的內容。");
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: `已發布為第 ${out.version} 版，正在編譯。` });
  return out;
}

export async function workflowDetail(app: FastifyInstance, user: CurrentUser, id: string) {
  const r = await ownRun(app.db, user, id);
  const steps = await getSteps(app.db, id);
  return { workflow: await runView(app.db, r), steps: steps.map((s: StepRow) => stepView(s, steps)) };
}

/** Self-heal: runs that should be working but have no queued/running job (a job ended in a race) get one. */
export async function sweepWorkflows(app: FastifyInstance) {
  const rows = (await app.db.query<{ id: string; user_id: string; title: string }>(
    `SELECT r.id, r.user_id, r.title FROM workflow_runs r LEFT JOIN jobs j ON j.id=r.job_id
      WHERE r.status IN ('planning','running','verifying') AND r.updated_at < now() - interval '45 seconds'
        AND (j.id IS NULL OR j.status NOT IN ('queued','running')) LIMIT 20`,
  )).rows;
  for (const r of rows) await transaction(app.db, (client) => enqueueWorkflow(client, r.id, r.user_id, r.title)).catch(() => undefined);
  await promoteAllQueued(app.db).catch(() => undefined);
  await app.db.query("DELETE FROM workflow_events e USING workflow_runs r WHERE r.id=e.run_id AND r.finished_at < now() - interval '7 days'").catch(() => undefined);
  return rows.length;
}

// ---------------------------------------------------------------- questions to the user

/**
 * Answers a question card (`state.asks[cardId]`, see `questions.ts`). The pending card → the run resumes (planning
 * or running) from the step that asked. An answered card edited later (「修改答案」) → the asking step and its
 * dependents run again (a finished run is reopened); not while the run is working (409).
 */
export async function answerWorkflow(app: FastifyInstance, user: CurrentUser, id: string, input: { card_id: string; answers: { id: string; value?: unknown; other?: string; skipped?: boolean }[] }) {
  let logText = "";
  await transaction(app.db, async (client) => {
    const r = await ownRun(client, user, id, true);
    const asks = asksOf(r.state);
    const card = asks[input.card_id];
    if (!card) throw notFound("找不到這張問題卡。");
    const pending = r.state?.ask_pending === card.id && r.status === "awaiting_input";
    if (!pending && !card.answers) throw conflict("這張問題卡已經不再需要回答。");
    if (!pending && ["planning", "running", "verifying", "queued"].includes(r.status)) throw conflict("工作流程正在執行，請等它停下來（或先暫停）再修改答案。");
    if (r.status === "cancelled") throw conflict("工作流程已停止，請重新開始一個。");
    const answers = validateCardAnswers(card, input.answers);
    // The user's own answer replaces an autopilot fill (「AI 代填，待你確認」 goes away).
    const next = { ...card, answers, answered_at: new Date().toISOString(), ai_filled: false, ...(card.answers ? { edited: (card.edited ?? 0) + 1 } : {}) };
    const state = { ...(r.state ?? {}), asks: { ...asks, [card.id]: next } } as Record<string, unknown>;
    delete state.ask_pending;
    const answerText = cardAnswersText(next);
    const guidance = card.purpose === "blocked" ? [...r.guidance, { at: new Date().toISOString(), text: `（回答「${card.title.slice(0, 80)}」）\n${answerText}`.slice(0, 2000), applied: false }] : r.guidance;
    logText = `${card.answers ? "已修改答案" : "收到你的回答"}：${card.title.slice(0, 80)}`;
    if (pending) {
      const hasSteps = (await getSteps(client, id)).length > 0;
      await client.query("UPDATE workflow_runs SET status=$2, question=NULL, state=$3, guidance=$4, updated_at=now() WHERE id=$1", [id, hasSteps ? "running" : "planning", JSON.stringify(state), JSON.stringify(guidance)]);
      await enqueueWorkflow(client, id, user.id, r.title);
      return;
    }
    // Edited answers: re-run the asking step and everything after it.
    const steps = await getSteps(client, id);
    const keys = new Set<string>(card.step_key ? [card.step_key] : []);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of steps) if (!keys.has(s.key) && s.depends_on.some((d) => keys.has(d))) (keys.add(s.key), (grew = true));
    }
    for (const s of steps) if (keys.has(s.key) || s.kind === "final") await client.query("UPDATE workflow_steps SET status='pending', error=NULL, inputs = inputs || '{\"fix_issues\":[]}'::jsonb WHERE id=$1", [s.id]);
    const finished = FINISHED_STATUSES.includes(r.status);
    const planningAsk = !card.step_key && !steps.length;
    const status = r.status === "awaiting_plan_approval" || r.status === "paused" ? r.status : planningAsk ? "planning" : "running";
    const budget = finished ? { ...r.budget, max_steps: r.budget.max_steps + 10, max_calls: r.budget.max_calls + 20, max_minutes: r.budget.max_minutes + 15, max_tokens: r.budget.max_tokens + 200_000 } : r.budget;
    await client.query(
      `UPDATE workflow_runs SET status=$2, state=$3, guidance=$4, budget=$5, question=NULL, report=CASE WHEN $6 THEN NULL ELSE report END, finished_at=CASE WHEN $6 THEN NULL ELSE finished_at END,
         stop_reason=CASE WHEN $6 THEN NULL ELSE stop_reason END, error=NULL,
         criteria=CASE WHEN $6 THEN (SELECT coalesce(jsonb_agg(c || '{"status":"pending"}'::jsonb), '[]'::jsonb) FROM jsonb_array_elements(criteria) c) ELSE criteria END, updated_at=now() WHERE id=$1`,
      [id, status, JSON.stringify(state), JSON.stringify(guidance), JSON.stringify(budget), finished],
    );
    if (status === "running" || status === "planning") await enqueueWorkflow(client, id, user.id, r.title);
  });
  for (const s of await getSteps(app.db, id)) await insertWorkflowEvent(app.db, id, "step", { step: stepView(s) });
  await insertWorkflowEvent(app.db, id, "log", { level: "info", text: logText });
  return emitRun(app.db, id);
}
