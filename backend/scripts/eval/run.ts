/**
 * Agent eval runner (docs/research/agent-eval.md). Runs the fixed task set (tasks.ts) against a STAGING hub as the eval
 * user, under autopilot, and records per task: outcome, deliverable kind correct?, deterministic graders, the run's own
 * criteria, wall / queued / active time, model calls by `ai_call_log.purpose`, fix rounds, step stop reasons, flips
 * (criteria pass → fail between snapshots; checks that passed in one round and failed in the next), a rubric judge and
 * a pairwise judge against the previous run (both orders). Writes <out>/report.json + report.md + artifacts/.
 *
 *   cd backend
 *   npx tsx scripts/eval/run.ts --list
 *   npx tsx scripts/eval/run.ts --tags quick                 # subset by tag (any of)
 *   npx tsx scripts/eval/run.ts --only deck_add_page,kind_conflict
 *   npx tsx scripts/eval/run.ts                              # everything (hours on the cheap staging model)
 *   options: --concurrency 2  --out <dir>  --compare <report.json>  --no-judge  --fixtures (set up fixtures and exit)
 *   env: HUB_URL (default http://127.0.0.1:18090), EVAL_USER / EVAL_PASSWORD (default linyating / password123),
 *        EVAL_COMPOSE_PROJECT (default hubv3; DB, ai-worker and backend containers are reached with `docker`)
 *
 * Production is refused (client.ts). The runner never answers question cards: a run that stops to ask is recorded as
 * such (that is the expected outcome of the `stop` tasks) and cancelled afterwards; a run past its time limit is cancelled.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB, Hub, deployedBuild, isUuid, sleep, sql, type Build } from "./client.js";
import { deckSource, ensureFixtures, type Fixtures } from "./fixtures.js";
import * as G from "./graders.js";
import { pairwise, rubric } from "./judge.js";
import { markdown, summarize, type Report, type TaskResult } from "./report.js";
import { FIXTURE_DECKS, TASKS, fixtureDeck, type Ctx, type Kind, type Outcome, type Prep, type Task } from "./tasks.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUNS = join(HERE, "runs");

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

if (flag("list")) {
  for (const t of TASKS) console.log(`${t.id.padEnd(28)} ${t.mode.padEnd(5)} [${t.tags.join(",")}] ${t.title}`);
  process.exit(0);
}

const tags = list(opt("tags"));
const only = list(opt("only"));
const skip = list(opt("skip"));
let selected = TASKS.filter((t) => (!only.length || only.includes(t.id)) && (!tags.length || t.tags.some((x) => tags.includes(x))) && !skip.includes(t.id));
// A chained task needs the task it continues.
for (const t of [...selected]) if (t.after && !selected.some((x) => x.id === t.after)) selected = [TASKS.find((x) => x.id === t.after)!, ...selected];
const concurrency = Math.max(1, Number(opt("concurrency") ?? 2) || 2);
const judgeOn = !flag("no-judge");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
/** `--into <dir>`: re-run some tasks and replace their results in an earlier run's report (e.g. after an infra fault). */
const into = opt("into");
const outDir = resolve(into ?? opt("out") ?? join(RUNS, stamp));

const hub = new Hub(process.env.EVAL_USER ?? "linyating", process.env.EVAL_PASSWORD ?? "password123");
await hub.login();
const fx: Fixtures = await ensureFixtures(hub);
if (flag("fixtures")) {
  console.log(JSON.stringify({ main: { id: fx.main.id, papers: fx.main.papers.length, noPdf: fx.main.noPdfId }, single: { id: fx.single.id, paper: fx.single.paper.key } }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- previous run

async function previousReport(): Promise<{ report: Report; dir: string } | null> {
  const explicit = opt("compare");
  if (explicit) return { report: JSON.parse(await readFile(explicit, "utf8")) as Report, dir: join(explicit, "..") };
  const dirs = existsSync(RUNS) ? (await readdir(RUNS)).filter((d) => join(RUNS, d) !== outDir).sort().reverse() : [];
  for (const d of dirs) {
    const f = join(RUNS, d, "report.json");
    if (existsSync(f)) return { report: JSON.parse(await readFile(f, "utf8")) as Report, dir: join(RUNS, d) };
  }
  // The committed baseline (docs/research/agent-eval.md): report + artifacts, for pairwise judging on a fresh checkout.
  const base = join(HERE, "baseline", "report.json");
  return existsSync(base) ? { report: JSON.parse(await readFile(base, "utf8")) as Report, dir: join(HERE, "baseline") } : null;
}
const prev = await previousReport();

// ---------------------------------------------------------------- running one task

type Wf = {
  id: string; status: string; playbook: string; created_at: string; started_at: string | null; finished_at: string | null;
  criteria: { id: string; status: string; reason?: string; text: string }[]; brief: G.BriefLike;
  artifacts: { kind: string; id: string; title: string; role: string }[];
  usage: { calls?: number; fix_rounds?: number; active_ms?: number } | null;
  question?: string | null; asks: { id: string; title?: string; pending?: boolean }[];
};
type Goal = { id: string; status: string; question: string | null; stages: { run_id: string | null }[]; brief: G.BriefLike };

const TERMINAL = new Set(["done", "partial", "failed", "cancelled"]);
const STOPPED = new Set(["needs_pdf", "awaiting_input"]);
const POLL_MS = 15_000;
const results = new Map<string, TaskResult>();
const log = (id: string, text: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${id}: ${text}`);

const ctx: Ctx = {
  hub, fx, tag: stamp.slice(5, 16),
  prev: (id) => {
    const r = results.get(id);
    return r ? { conversationId: r.conversation_id, deckId: r.deck_id } : null;
  },
};

async function newConversation(studyId: string): Promise<string> {
  return (await hub.api<{ conversation: { id: string } }>("POST", "/agent/conversations", { autopilot: true, context: { studyId } })).conversation.id;
}

/** Chat: the assistant must start a workflow or goal; returns its ids (none → the assistant answered itself). */
async function viaChat(task: Task, studyId: string, deadline: number): Promise<{ conv: string; runIds: string[]; goalId: string | null }> {
  const conv = await newConversation(studyId);
  await hub.api("POST", `/agent/conversations/${conv}/messages`, { text: task.request, context: { studyId } });
  for (;;) {
    await sleep(8_000);
    const d = await hub.api<{ toolCalls: { tool: string; status: string; result?: unknown }[]; run: { status: string } | null }>("GET", `/agent/conversations/${conv}`);
    const start = d.toolCalls.find((t) => (t.tool === "start_workflow" || t.tool === "start_goal") && t.result);
    if (start) {
      const raw = JSON.stringify(start.result);
      const goalId = /"goal_id":"([0-9a-f-]{36})"/.exec(raw)?.[1] ?? null;
      const ids = [...raw.matchAll(/"workflow_id":"([0-9a-f-]{36})"/g)].map((m) => m[1]!);
      const many = /"workflow_ids":\[([^\]]*)\]/.exec(raw)?.[1];
      if (many) ids.push(...[...many.matchAll(/"([0-9a-f-]{36})"/g)].map((m) => m[1]!));
      return { conv, runIds: [...new Set(ids)], goalId };
    }
    if ((d.run && !["running", "awaiting_approval", "awaiting_llm"].includes(d.run.status)) || Date.now() > deadline) return { conv, runIds: [], goalId: null };
  }
}

/** Polls until every run ended or stopped (plan cards approved, never question cards); cancels at the deadline. */
async function waitRuns(task: Task, runIds: string[], goalId: string | null, limitMs: number): Promise<{ status: string; runs: Wf[]; goal: Goal | null; timedOut: boolean }> {
  let startedAt: number | null = null;
  let goal: Goal | null = null;
  for (;;) {
    let ids = runIds;
    if (goalId) {
      goal = (await hub.api<{ goal: Goal }>("GET", `/goals/${goalId}`)).goal;
      ids = [...new Set([...runIds, ...goal.stages.map((s) => s.run_id).filter(isUuid)])];
      if (goal.status === "awaiting_approval") {
        log(task.id, "goal waits for approval → approve");
        await hub.api("POST", `/goals/${goalId}/approve`, {});
      }
    }
    const runs = await Promise.all(ids.map(async (id) => (await hub.api<{ workflow: Wf }>("GET", `/workflows/${id}`)).workflow));
    for (const r of runs) {
      if (r.status === "awaiting_plan_approval") {
        log(task.id, `${r.id.slice(0, 8)} waits for plan approval → approve`);
        await hub.api("POST", `/workflows/${r.id}/approve`, {}).catch(() => undefined);
      }
    }
    const working = runs.some((r) => !TERMINAL.has(r.status) && !STOPPED.has(r.status) && r.status !== "queued") || (goal && ["planning", "running"].includes(goal.status));
    // The time limit counts from the moment a run really started executing (started_at): time spent queued behind other
    // runs (per-user limit, busy ai-worker slots shared with other users of staging) is not the agent's.
    if (startedAt == null && (runs.some((r) => r.started_at) || (goal && !runs.length && working))) startedAt = Date.now();
    const runsEnded = runs.length > 0 && runs.every((r) => TERMINAL.has(r.status) || STOPPED.has(r.status));
    const goalEnded = !goal || TERMINAL.has(goal.status) || goal.status === "awaiting_input";
    if ((runsEnded && goalEnded) || (goal && goalEnded && runsEnded)) {
      const status = goal ? goal.status : runs.length === 1 ? runs[0]!.status : runs.map((r) => r.status).join("+");
      return { status, runs, goal, timedOut: false };
    }
    if (!runs.length && !goal) return { status: "no_workflow", runs, goal, timedOut: false };
    if (startedAt != null && Date.now() - startedAt > limitMs) {
      log(task.id, "time limit → cancel");
      if (goalId) await hub.api("POST", `/goals/${goalId}/cancel`, {}).catch(() => undefined);
      for (const r of runs) if (!TERMINAL.has(r.status)) await hub.api("POST", `/workflows/${r.id}/cancel`, {}).catch(() => undefined);
      const after = await Promise.all(ids.map(async (id) => (await hub.api<{ workflow: Wf }>("GET", `/workflows/${id}`)).workflow));
      return { status: "timeout", runs: after, goal, timedOut: true };
    }
    await sleep(POLL_MS);
  }
}

const kindOf = (k: string): Kind | null => (k === "deck" ? "deck" : k === "note" ? "note" : k === "latex_project" || k === "latex_file" ? "latex" : null);

async function latexOf(projectId: string): Promise<{ text: string; compile: string | null }> {
  const d = await hub.api<{ files: { id: string; path: string }[]; latest_compile?: { status: string } | null; pdf_compile?: { status: string } | null }>("GET", `/latex/${projectId}`);
  const parts: string[] = [];
  for (const f of d.files.filter((x) => /\.tex$/.test(x.path))) {
    parts.push(`%% ---- ${f.path}\n${await hub.text(`/latex/${projectId}/files/${f.id}/raw`)}`);
  }
  let compile = d.latest_compile?.status ?? null;
  if (!compile || compile === "queued" || compile === "running") {
    const c = await hub.api<{ compile: { id: string; status: string } }>("POST", `/latex/${projectId}/compile`, {}).catch(() => null);
    for (let i = 0; c && i < 40; i++) {
      await sleep(10_000);
      const v = await hub.api<{ compile?: { status: string }; status?: string }>("GET", `/latex/${projectId}/compiles/${c.compile.id}`);
      compile = v.compile?.status ?? v.status ?? null;
      if (compile && !["queued", "running"].includes(compile)) break;
    }
  }
  return { text: parts.join("\n\n"), compile };
}

async function collect(runs: Wf[], goal: Goal | null, status: string): Promise<Outcome> {
  const arts = runs.flatMap((r) => r.artifacts ?? []);
  const kinds = [...new Set(arts.map((a) => kindOf(a.kind)).filter((k): k is Kind => !!k))];
  const o: Outcome = { status, kinds, brief: goal?.brief ?? runs[0]?.brief ?? null, asks: runs.flatMap((r) => r.asks ?? []), playbook: runs[0]?.playbook ?? null };
  const deckId = arts.filter((a) => a.kind === "deck").at(-1)?.id;
  if (deckId) {
    const qmd = await deckSource(hub, deckId);
    const d = await hub.api<{ project: { kind: string | null; paper_id: string | null; metadata?: { paper?: { title?: string } } } }>("GET", `/slides/${deckId}`);
    o.deck = { id: deckId, qmd, parsed: G.parseDeck(qmd), kind: d.project.kind, paperId: d.project.paper_id, paperTitle: d.project.metadata?.paper?.title ?? null };
  }
  const noteId = arts.filter((a) => a.kind === "note").at(-1)?.id;
  if (noteId) o.note = { id: noteId, md: (await hub.api<{ note: { content_md: string } }>("GET", `/notes/${noteId}`)).note.content_md };
  const latexId = arts.filter((a) => a.kind === "latex_project").at(-1)?.id;
  if (latexId) o.latex = { id: latexId, ...(await latexOf(latexId)) };
  return o;
}

function deliverableCheck(task: Task, o: Outcome): TaskResult["deliverable"] {
  const got = o.kinds;
  const brief = o.brief?.deliverable?.kind ?? null;
  const e = task.expect;
  if ("stop" in e) {
    const ok = o.status === e.stop && !got.length;
    return { expected: `停在 ${e.stop}`, got, brief, ok, detail: `狀態 ${o.status}，成果 ${got.join("、") || "無"}` };
  }
  if ("kindOrAsk" in e) {
    const asked = o.asks.some((a) => /^deliverable_|^clarify_deliverable/.test(a.id));
    const wrong = got.filter((k) => e.never.includes(k));
    const ok = !wrong.length && (got.includes(e.kindOrAsk) || asked);
    return { expected: `${e.kindOrAsk} 或詢問`, got, brief, ok, detail: `成果 ${got.join("、") || "無"}${asked ? "；有問交付物" : ""}${wrong.length ? `；不該出現 ${wrong.join("、")}` : ""}` };
  }
  // A goal's intermediate stages legitimately write other kinds (an outline note before the paper).
  const extra = task.mode === "goal" ? [] : got.filter((k) => k !== e.kind);
  const ok = got.includes(e.kind) && !extra.length;
  return { expected: e.kind, got, brief, ok, detail: `要 ${e.kind}，得到 ${got.join("、") || "無"}（Brief：${brief ?? "無"}）` };
}

async function metrics(runIds: string[]) {
  const ids = runIds.filter(isUuid);
  const empty = { fixCalls: 0, calls: 0, by: {} as TaskResult["calls_by_purpose"], tokens: { in: 0, out: 0 }, stops: {} as Record<string, number>, flips: { criteria: [] as string[], checks: [] as string[] }, finalRounds: 0, fixRounds: 0 };
  if (!ids.length) return empty;
  const inList = ids.map((x) => `'${x}'`).join(",");
  const calls = await sql<{ purpose: string; n: number; s: number; tin: number; tout: number }>(
    `SELECT coalesce(purpose,'?') AS purpose, count(*)::int AS n, (sum(latency_ms)/1000)::int AS s, sum(coalesce(tokens_in,0))::bigint AS tin, sum(coalesce(tokens_out,0))::bigint AS tout
       FROM ai_call_log WHERE final AND workflow_id IN (${inList}) GROUP BY 1`,
  );
  const steps = await sql<{ run_id: string; key: string; verify: { checks?: { id: string }[] } | null; conv: { rounds?: { round: number; failures: string[] }[]; stop?: string } | null }>(
    `SELECT run_id, key, verify, inputs->'conv' AS conv FROM workflow_steps WHERE run_id IN (${inList})`,
  );
  const snaps = await sql<{ run_id: string; c: { id: string; status: string }[] | null }>(
    `SELECT run_id, data->'workflow'->'criteria' AS c FROM workflow_events WHERE run_id IN (${inList}) AND type='workflow' ORDER BY seq`,
  );
  const fixCalls = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ai_call_log WHERE final AND workflow_id IN (${inList}) AND (coalesce(round,0) > 0 OR purpose ~* '(fix|repair|revise)')`);
  const runs = await sql<{ final_rounds: number | null; fix: number | null }>(`SELECT final_rounds, (usage->>'fix_rounds')::int AS fix FROM workflow_runs WHERE id IN (${inList})`);
  const out = { ...empty, by: {} as TaskResult["calls_by_purpose"], stops: {} as Record<string, number>, flips: { criteria: [] as string[], checks: [] as string[] } };
  for (const c of calls) {
    out.calls += c.n;
    out.by[c.purpose] = { n: c.n, s: c.s };
    out.tokens.in += Number(c.tin);
    out.tokens.out += Number(c.tout);
  }
  for (const s of steps) {
    if (s.conv?.stop) out.stops[s.conv.stop] = (out.stops[s.conv.stop] ?? 0) + 1;
    out.flips.checks.push(...G.checkFlips(s.conv?.rounds ?? [], (s.verify?.checks ?? []).map((c) => c.id)).map((f) => `${s.key}:${f}`));
  }
  for (const id of ids) out.flips.criteria.push(...G.criteriaFlips(snaps.filter((x) => x.run_id === id && Array.isArray(x.c)).map((x) => x.c!)));
  out.fixCalls = fixCalls[0]?.n ?? 0;
  out.finalRounds = runs.reduce((a, r) => a + (r.final_rounds ?? 0), 0);
  out.fixRounds = runs.reduce((a, r) => a + (r.fix ?? 0), 0);
  return out;
}

const seconds = (a: string | null | undefined, b: string | null | undefined) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);

async function runTask(task: Task): Promise<TaskResult> {
  const startedAt = new Date().toISOString();
  const buildStart = await deployedBuild();
  const base: TaskResult = {
    id: task.id, title: task.title, tags: task.tags, mode: task.mode, started_at: startedAt, ended_at: startedAt, build_start: buildStart, build_end: buildStart, redeployed: false,
    status: "error", run_ids: [], goal_id: null, conversation_id: null, playbook: null, deck_id: null, deck_pages: null,
    deliverable: { expected: "", got: [], brief: null, ok: false, detail: "" }, grades: [], pass: false,
    criteria: { pass: 0, fail: 0, other: 0, req_pass: 0, req_total: 0, failed: [] }, wall_s: null, queued_s: null, active_s: null,
    calls: 0, fix_calls: 0, calls_by_purpose: {}, tokens: { in: 0, out: 0 }, fix_rounds: 0, final_rounds: 0, stops: {}, flips: { criteria: [], checks: [] }, judge: null, pair: null, question: null, error: null,
  };
  const studyId = task.study === "single" ? fx.single.id : fx.main.id;
  const limitMs = (task.timeoutMin ?? 60) * 60_000;
  try {
    let prep: Prep = {};
    let conv: string | null = null;
    let runIds: string[] = [];
    let goalId: string | null = null;
    if (task.after) {
      const p = ctx.prev(task.after);
      if (!p?.deckId || !p.conversationId) return { ...base, status: "skipped", error: `前一個任務 ${task.after} 沒有產生簡報` };
      conv = p.conversationId;
      prep = { inputs: { deck_id: p.deckId }, before: { titles: [], pages: results.get(task.after)?.deck_pages ?? 0 } };
    } else if (task.deck) prep = await fixtureDeck(ctx, task);
    else if (task.prepare) prep = await task.prepare(ctx);
    if (task.mode === "chat") {
      const r = await viaChat(task, studyId, Date.now() + 15 * 60_000);
      conv = r.conv;
      runIds = r.runIds;
      goalId = r.goalId;
    } else if (task.mode === "goal") {
      conv = await newConversation(studyId);
      const r = await hub.api<{ goal: { id: string } | null; workflow: { id: string } | null }>("POST", "/goals", { request: task.request, conversation_id: conv, context: { studyId }, inputs: { study: studyId, ...(prep.inputs ?? {}) }, autopilot: true });
      goalId = r.goal?.id ?? null;
      if (r.workflow) runIds = [r.workflow.id];
    } else {
      conv ??= await newConversation(studyId);
      const r = await hub.api<{ workflows: { id: string }[] }>("POST", "/workflows", { request: task.request, ...(task.playbook ? { playbook: task.playbook } : {}), conversation_id: conv, context: { studyId }, inputs: { study: studyId, ...(prep.inputs ?? {}) }, autopilot: true });
      runIds = r.workflows.map((w) => w.id);
    }
    log(task.id, `started ${goalId ? `goal ${goalId.slice(0, 8)} ` : ""}${runIds.map((x) => x.slice(0, 8)).join(",") || "(no run)"}`);
    const w = await waitRuns(task, runIds, goalId, limitMs);
    const allIds = w.runs.map((r) => r.id);
    const o = await collect(w.runs, w.goal, w.status);
    const m = await metrics(allIds);
    const crit = w.runs.flatMap((r) => r.criteria ?? []);
    const first = w.runs.map((r) => r.created_at).sort()[0];
    const started = w.runs.map((r) => r.started_at).filter(Boolean).sort()[0] ?? null;
    const finished = w.runs.map((r) => r.finished_at).filter(Boolean).sort().at(-1) ?? null;
    const result: TaskResult = {
      ...base,
      status: w.status, run_ids: allIds, goal_id: goalId, conversation_id: conv, playbook: o.playbook, deck_id: o.deck?.id ?? null, deck_pages: o.deck?.parsed.slides.length ?? null,
      deliverable: deliverableCheck(task, o),
      grades: [],
      criteria: {
        pass: crit.filter((c) => c.status === "pass").length, fail: crit.filter((c) => c.status === "fail").length, other: crit.filter((c) => c.status !== "pass" && c.status !== "fail").length,
        req_pass: crit.filter((c) => c.id.startsWith("req_") && c.status === "pass").length, req_total: crit.filter((c) => c.id.startsWith("req_")).length,
        failed: crit.filter((c) => c.status === "fail").map((c) => `${c.id}：${(c.reason ?? c.text).slice(0, 140)}`),
      },
      wall_s: seconds(started ?? first, w.timedOut ? new Date().toISOString() : finished ?? new Date().toISOString()), queued_s: seconds(first, started),
      active_s: Math.round(w.runs.reduce((a, r) => a + (r.usage?.active_ms ?? 0), 0) / 1000),
      calls: m.calls, fix_calls: m.fixCalls, calls_by_purpose: m.by, tokens: m.tokens, fix_rounds: m.fixRounds, final_rounds: m.finalRounds, stops: m.stops, flips: m.flips,
      question: w.goal?.question ?? w.runs.map((r) => r.question).find(Boolean) ?? null,
    };
    result.grades = task.grade(o, ctx, prep);
    result.pass = result.deliverable.ok && result.grades.every((g) => g.ok) && w.status !== "timeout";
    // Artifact text for the judges and the next run's pairwise comparison.
    const byKind: Record<Kind, string | undefined> = { deck: o.deck?.qmd, note: o.note?.md, latex: o.latex?.text };
    const want = "kind" in task.expect ? task.expect.kind : "kindOrAsk" in task.expect ? task.expect.kindOrAsk : null;
    const text = (want && byKind[want]) || o.deck?.qmd || o.note?.md || o.latex?.text || "";
    if (text) await writeFile(join(outDir, "artifacts", `${task.id}.txt`), text);
    if (judgeOn && task.judge && text) {
      result.judge = await rubric(task.request, task.judge, text).catch((e) => (log(task.id, `judge failed: ${e}`), null));
      const prevText = prev?.dir && existsSync(join(prev.dir, "artifacts", `${task.id}.txt`)) ? await readFile(join(prev.dir, "artifacts", `${task.id}.txt`), "utf8") : null;
      if (prevText) result.pair = await pairwise(task.request, task.judge, text, prevText).catch(() => null);
    }
    // A run that stopped to ask (or wait for a PDF) is recorded, then cancelled so it does not linger on staging.
    for (const r of w.runs) if (STOPPED.has(r.status)) await hub.api("POST", `/workflows/${r.id}/cancel`, {}).catch(() => undefined);
    if (w.goal && w.goal.status === "awaiting_input") await hub.api("POST", `/goals/${w.goal.id}/cancel`, {}).catch(() => undefined);
    return result;
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- regrade

/**
 * `--regrade <dir>`: re-collect every task's artifacts from its recorded runs and apply the CURRENT graders (after a
 * grader fix, so runs stay comparable); timings, calls and judges are kept. The artifact text saved when the task ended
 * (artifacts/<id>.txt) is used when present; metadata (deck kind, compile status, Brief) is re-read from the hub.
 */
const regrade = opt("regrade");
if (regrade) {
  const dir = resolve(regrade);
  const rep = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as Report;
  for (const r of rep.results) {
    const task = TASKS.find((t) => t.id === r.id);
    if (!task || (!r.run_ids.length && !r.goal_id)) continue;
    const runs = await Promise.all(r.run_ids.map(async (id) => (await hub.api<{ workflow: Wf }>("GET", `/workflows/${id}`)).workflow));
    const goal = r.goal_id ? (await hub.api<{ goal: Goal }>("GET", `/goals/${r.goal_id}`)).goal : null;
    const o = await collect(runs, goal, r.status);
    // The text as it was when the task ended (a later task may have edited the same deck: the chained follow-up).
    const saved = join(dir, "artifacts", `${r.id}.txt`);
    if (existsSync(saved)) {
      const text = await readFile(saved, "utf8");
      const want = "kind" in task.expect ? task.expect.kind : "kindOrAsk" in task.expect ? task.expect.kindOrAsk : null;
      if (want === "deck" && o.deck) o.deck = { ...o.deck, qmd: text, parsed: G.parseDeck(text) };
      if (want === "note" && o.note) o.note = { ...o.note, md: text };
      if (want === "latex" && o.latex) o.latex = { ...o.latex, text };
    } else {
      // No saved text (or it was removed because it held the wrong artifact): save the current one and judge it again.
      const want = "kind" in task.expect ? task.expect.kind : null;
      const text = (want === "deck" ? o.deck?.qmd : want === "note" ? o.note?.md : want === "latex" ? o.latex?.text : undefined) ?? "";
      if (text) {
        await writeFile(saved, text);
        if (judgeOn && task.judge) r.judge = await rubric(task.request, task.judge, text).catch(() => r.judge);
      }
    }
    const before = task.deck ? FIXTURE_DECKS[task.deck].before : task.after ? { titles: [], pages: rep.results.find((x) => x.id === task.after)?.deck_pages ?? 0 } : undefined;
    r.deliverable = deliverableCheck(task, o);
    r.grades = task.grade(o, ctx, { before: before ? { titles: [...before.titles], pages: before.pages } : undefined });
    r.pass = r.deliverable.ok && r.grades.every((g) => g.ok) && r.status !== "timeout";
    const m = await metrics(r.run_ids);
    Object.assign(r, { calls: m.calls, fix_calls: m.fixCalls, calls_by_purpose: m.by, tokens: m.tokens, fix_rounds: m.fixRounds, final_rounds: m.finalRounds, stops: m.stops, flips: m.flips });
    log(r.id, `regraded: ${r.pass ? "PASS" : "FAIL"} ${r.grades.filter((g) => g.ok).length}/${r.grades.length}`);
  }
  rep.summary = summarize(rep.results);
  rep.selection = `${rep.selection.replace(/; regraded [^;]*/g, "")}; regraded ${new Date().toISOString().slice(0, 16)}`;
  await writeFile(join(dir, "report.json"), JSON.stringify(rep, null, 2));
  await writeFile(join(dir, "report.md"), markdown(rep, rep.compared_with && prev?.report.id === rep.compared_with ? prev.report : null));
  process.exit(0);
}

// ---------------------------------------------------------------- schedule

await mkdir(join(outDir, "artifacts"), { recursive: true });
const startedAll = new Date().toISOString();
const builds: Build[] = [];
const noteBuild = (b: Build) => {
  if (!builds.some((x) => x.image === b.image && x.git === b.git)) builds.push(b);
};
console.log(`Eval ${stamp}: ${selected.length} tasks, concurrency ${concurrency}, hub ${HUB}, out ${outDir}${prev ? `, compare ${prev.report.id}` : ""}`);

// Longest tasks first (shorter makespan); a chained task still waits for the one it continues.
const pending = [...selected].sort((a, b) => (b.timeoutMin ?? 60) - (a.timeoutMin ?? 60));
const running = new Map<string, Promise<void>>();
const earlier: Report | null = into && existsSync(join(into, "report.json")) ? (JSON.parse(await readFile(join(into, "report.json"), "utf8")) as Report) : null;
if (earlier) for (const b of earlier.builds) builds.push(b);
const writeReport = async () => {
  const fresh = selected.map((t) => results.get(t.id)).filter((r): r is TaskResult => !!r);
  const ordered = earlier ? [...earlier.results.map((r) => fresh.find((x) => x.id === r.id) ?? r), ...fresh.filter((x) => !earlier.results.some((r) => r.id === x.id))] : fresh;
  const report: Report = { id: earlier?.id ?? stamp, hub: HUB, user: hub.username, started_at: earlier?.started_at ?? startedAll, ended_at: new Date().toISOString(), builds, selection: `${earlier ? `${earlier.selection}; re-run ${stamp}: ` : ""}${only.length ? `only ${only.join(",")}` : tags.length ? `tags ${tags.join(",")}` : "all"}`, results: ordered, summary: summarize(ordered), compared_with: prev?.report.id ?? null };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.md"), markdown(report, prev?.report ?? null));
  return report;
};

while (pending.length || running.size) {
  const ready = pending.filter((t) => !t.after || results.has(t.after));
  while (running.size < concurrency && ready.length) {
    const t = ready.shift()!;
    pending.splice(pending.indexOf(t), 1);
    running.set(t.id, (async () => {
      const r = await runTask(t);
      r.ended_at = new Date().toISOString();
      r.build_end = await deployedBuild();
      r.redeployed = r.build_end.image !== r.build_start.image;
      noteBuild(r.build_start);
      noteBuild(r.build_end);
      results.set(t.id, r);
      log(t.id, `${r.pass ? "PASS" : "FAIL"} ${r.status} · deliverable ${r.deliverable.ok ? "ok" : "WRONG"} · ${r.grades.filter((g) => g.ok).length}/${r.grades.length} · ${r.wall_s == null ? "?" : Math.round(r.wall_s / 60)} min · ${r.calls} calls${r.error ? ` · ${r.error}` : ""}`);
      await writeReport();
    })().finally(() => running.delete(t.id)));
  }
  if (!running.size && pending.length && !ready.length) {
    // Only chained tasks whose predecessor is not selected / never finished.
    for (const t of pending.splice(0)) results.set(t.id, { ...(await runTask({ ...t, after: t.after })) });
    break;
  }
  await Promise.race(running.values());
}

const report = await writeReport();
console.log(`\n${report.summary.passed}/${report.summary.tasks} passed · deliverable ${report.summary.deliverable_ok}/${report.summary.tasks} · median ${report.summary.median_wall_min} min · ${report.summary.calls} calls\n→ ${join(outDir, "report.md")}`);
