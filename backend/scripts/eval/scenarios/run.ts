/**
 * Planning-only scenario runner (docs/research/agent-invariants.md → Scenario matrix). STAGING only (client.ts refuses
 * production). For each case of matrix.ts: set up entry + history (seed.ts), start the run the way the user would
 * (「交給 Agent」 = POST /workflows with the conversation and page context, or a chat message the assistant must
 * delegate), wait for the plan card or the first question (answering ONE clarifying question with the case's answer
 * style), read the stored run back read-only, check every invariant + the scenario oracles, and cancel the run. Nothing
 * is written past planning (autopilot off, the plan is never approved).
 *
 *   cd backend
 *   npx tsx scripts/eval/scenarios/matrix.ts                      # list the cases and dimension coverage
 *   npx tsx scripts/eval/scenarios/run.ts [--only id,id] [--match regex] [--concurrency 2] [--out dir] [--resume dir]
 *   env: HUB_URL, EVAL_USER / EVAL_PASSWORD (acting user, default linyating), EVAL_FIXTURE_USER (fixture owner, default the
 *        acting user; the acting user must be a member of the fixture studies), EVAL_COMPOSE_PROJECT (default hubv3)
 *
 * Every run it starts is recorded in <out>/started.json before anything else and cancelled at the end (also on Ctrl-C,
 * and `--sweep <dir>` cancels a previous run's leftovers). Staging may be redeployed meanwhile: API calls retry across
 * restarts (client.ts) and a case interrupted by an infrastructure error is retried once.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConversation, checkRun, INVARIANTS, SEVERITY_RANK, type Finding } from "../../../src/workflows/invariants.js";
import { loadBundles, loadRuns, openReadOnly, type ReadOnlyDb } from "../../audit/load.js";
import { stagingDbUrl } from "../../audit/run.js";
import { HUB, Hub, deployedBuild, sleep } from "../client.js";
import { ensureFixtures, type Fixtures } from "../fixtures.js";
import { ANSWERS, ENTRIES, HISTORIES, INTENTS, STYLES, buildMatrix, type Scenario } from "./matrix.js";
import { scenarioFindings } from "./oracles.js";
import { setupScenario, waitChat } from "./seed.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

const STOP = new Set(["awaiting_plan_approval", "awaiting_input", "needs_pdf", "done", "partial", "failed", "cancelled", "running", "verifying"]);
const TERMINAL = new Set(["done", "partial", "failed", "cancelled"]);
const PLAN_TIMEOUT = Number(opt("plan-timeout") ?? 16) * 60_000;
/**
 * `--depth plan` waits for the plan card (outline included: ~8–15 min per case on the cheap staging model);
 * `--depth route` (default) stops once the Brief, the requirements and the route are stored and the playbook has
 * planned for `--cut` seconds without asking (questions about the study / paper / deliverable come before the
 * outline) — every invariant except the plan-level ones (plan.writes, edit_kind, topic picks when not yet chosen) can
 * judge it, at a fraction of the cost; those rules return nothing on a run without a plan.
 */
const DEPTH = (opt("depth") ?? "route") as "plan" | "route";
const CUT_MS = Number(opt("cut") ?? 90) * 1000;

export type CaseResult = {
  id: string; dims: Pick<Scenario, "entry" | "history" | "style" | "intent" | "lang" | "anaphora" | "answer" | "start">; request: string;
  status: string; reached: "plan" | "question" | "routed" | "answered_plan" | "answered_question" | "answered_routed" | "other"; run_ids: string[]; conversation_id: string | null; deck_id: string | null;
  questions: string[]; answered: string | null; playbook: string | null; route: unknown; findings: Finding[]; error: string | null; attempts: number; build: string; ms: number;
};

type Wf = { id: string; status: string; playbook: string; question?: string | null; asks?: { id: string; title?: string; pending?: boolean; questions?: { id: string; type: string; options?: { label: string; value: string }[]; allow_other?: boolean }[] }[] };

const outDir = resolve(opt("resume") ?? opt("out") ?? join(HERE, "..", "runs", `scenarios-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
const startedFile = join(outDir, "started.json");
let started: string[] = [];
const recordStart = async (ids: string[]) => {
  started = [...new Set([...started, ...ids])];
  await writeFile(startedFile, JSON.stringify(started, null, 2));
};

async function cancelAll(hub: Hub, ids: string[]) {
  for (const id of ids) {
    try {
      if (id.startsWith("goal:")) {
        await hub.api("POST", `/goals/${id.slice(5)}/cancel`, {}).catch(() => undefined);
        continue;
      }
      const w = (await hub.api<{ workflow: Wf }>("GET", `/workflows/${id}`)).workflow;
      if (!TERMINAL.has(w.status)) await hub.api("POST", `/workflows/${id}/cancel`, {});
    } catch {
      // gone / no access: nothing to cancel
    }
  }
}

async function poll(hub: Hub, id: string, until: (w: Wf) => boolean, timeoutMs: number, db?: ReadOnlyDb): Promise<Wf & { cut?: boolean }> {
  // The clock runs only while the run's job is executing: time spent waiting for a free ai-worker slot (shared with
  // the eval runner and other users of staging) or in the LLM-outage backoff is not the case's (cap: 2 h in total).
  let end = Date.now() + timeoutMs;
  const hardEnd = Date.now() + 120 * 60_000;
  let since: number | null = null;
  for (;;) {
    const w = (await hub.api<{ workflow: Wf }>("GET", `/workflows/${id}`)).workflow;
    if (until(w) || Date.now() > end || Date.now() > hardEnd) return w;
    if (db) {
      const [job] = await db.query<{ status: string; stage: string | null }>("SELECT status, stage FROM jobs WHERE kind = 'ai_workflow' AND payload->>'workflowId' = $1 ORDER BY created_at DESC LIMIT 1", [id]);
      if (job && (job.status === "queued" || job.stage === "waiting_llm")) end = Math.max(end, Date.now() + timeoutMs);
    }
    if (DEPTH === "route" && db && w.status === "planning") {
      const [st] = await db.query<{ ready: boolean }>("SELECT (state ? 'requirements_key') AND coalesce((state->'route'->>'brief_version')::int, 0) >= 1 AND coalesce((brief->>'version')::int, 0) >= 1 AS ready FROM workflow_runs WHERE id = $1", [id]);
      if (st?.ready) since ??= Date.now();
      else since = null;
      if (since != null && Date.now() - since >= CUT_MS) return { ...w, cut: true };
    }
    await sleep(6_000);
  }
}

const STUDY_ANSWER: Record<(typeof ANSWERS)[number], (fx: Fixtures) => string> = {
  study_name: () => "Agent 評估集：串流 ASR 熱詞偏置",
  delegate: () => "你決定",
  free_text: () => "就是我們做串流 ASR 熱詞偏置的那個研究",
};

/** Answers the pending question once: a card (matching option, else 「其他」 text) or a plan-phase question (guidance). */
async function answer(hub: Hub, w: Wf, s: Scenario, fx: Fixtures): Promise<string> {
  const text = STUDY_ANSWER[s.answer](fx);
  const card = (w.asks ?? []).find((a) => a.pending);
  if (card?.questions?.length) {
    const answers = card.questions.map((q) => {
      if (!q.options?.length) return { id: q.id, value: text };
      const hit = q.options.find((o) => o.label.includes("串流 ASR 熱詞偏置") || (s.answer === "delegate" && /你決定|自動/.test(o.label)));
      if (hit) return { id: q.id, value: hit.value };
      return q.allow_other !== false ? { id: q.id, value: null, other: text } : { id: q.id, value: q.options[0]!.value };
    });
    await hub.api("POST", `/workflows/${w.id}/answer`, { card_id: card.id, answers });
    return `card ${card.id}: ${JSON.stringify(answers)}`;
  }
  await hub.api("POST", `/workflows/${w.id}/guidance`, { text });
  return `guidance: ${text}`;
}

async function startRun(hub: Hub, s: Scenario, setup: Awaited<ReturnType<typeof setupScenario>>): Promise<{ ids: string[]; note?: string }> {
  if (s.start === "delegate") {
    const r = await hub.api<{ workflows: { id: string }[] }>("POST", "/workflows", { request: s.request, conversation_id: setup.conversationId, context: s.entry === "home" ? null : setup.context, autopilot: false });
    return { ids: r.workflows.map((w) => w.id) };
  }
  await hub.api("POST", `/agent/conversations/${setup.conversationId}/messages`, { text: s.request, context: setup.context });
  const d = await waitChat(hub, setup.conversationId, 5 * 60_000);
  const raw = JSON.stringify(d.toolCalls.filter((t) => t.tool === "start_workflow" || t.tool === "start_goal").map((t) => t.result));
  const ids = [...new Set([...raw.matchAll(/workflow_id\\?":\\?"([0-9a-f-]{36})/g)].map((m) => m[1]!))];
  // A goal the assistant started instead (start_goal) is recorded and cancelled like a run.
  for (const m of raw.matchAll(/goal_id\\?":\\?"([0-9a-f-]{36})/g)) {
    await recordStart([`goal:${m[1]}`]);
    if (!ids.length) return { ids, note: `助理開了目標 ${m[1]!.slice(0, 8)}（不是工作流程）` };
  }
  if (!ids.length) {
    const reply = d.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    return { ids, note: `助理沒有交給工作流程（工具：${d.toolCalls.map((t) => t.tool).join("、") || "無"}）：${reply.slice(0, 160)}` };
  }
  return { ids };
}

async function runCase(hub: Hub, db: ReadOnlyDb, fx: Fixtures, s: Scenario, userId: string, tag: string): Promise<CaseResult> {
  const t0 = Date.now();
  const base: CaseResult = { id: s.id, dims: { entry: s.entry, history: s.history, style: s.style, intent: s.intent, lang: s.lang, anaphora: s.anaphora, answer: s.answer, start: s.start }, request: s.request, status: "error", reached: "other", run_ids: [], conversation_id: null, deck_id: null, questions: [], answered: null, playbook: null, route: null, findings: [], error: null, attempts: 1, build: (await deployedBuild()).image, ms: 0 };
  const setup = await setupScenario(hub, fx, s, tag, userId);
  base.conversation_id = setup.conversationId;
  base.deck_id = setup.deckId;
  const { ids, note } = await startRun(hub, s, setup);
  await recordStart(ids);
  base.run_ids = ids;
  if (!ids.length) return { ...base, status: "no_workflow", error: note ?? null, findings: [{ invariant: "scenario.started", severity: "low", run_id: null, conversation_id: setup.conversationId, message: note ?? "沒有開始工作流程", evidence: { start: s.start } }], ms: Date.now() - t0 };
  const id = ids[0]!;
  let w = await poll(hub, id, (x) => STOP.has(x.status), PLAN_TIMEOUT, db);
  base.reached = w.status === "awaiting_input" ? "question" : w.status === "awaiting_plan_approval" ? "plan" : w.cut ? "routed" : "other";
  if (w.question) base.questions.push(w.question);
  if (w.status === "awaiting_input") {
    base.answered = await answer(hub, w, s, fx);
    await sleep(3_000);
    w = await poll(hub, id, (x) => x.status !== "planning" && x.status !== "queued" && STOP.has(x.status) && !(x.status === "awaiting_input" && !x.question), PLAN_TIMEOUT, db);
    // A second question right after the answer is recorded (q.not_repeated judges whether it is the same one).
    if (w.question) base.questions.push(w.question);
    base.reached = w.status === "awaiting_plan_approval" ? "answered_plan" : w.status === "awaiting_input" ? "answered_question" : w.cut ? "answered_routed" : "other";
  }
  base.status = w.status;
  base.playbook = w.playbook;
  // Read the stored run back (read-only) and check it.
  const runs = await loadRuns(db, { runIds: ids });
  const { bundles, conversations } = await loadBundles(db, runs);
  for (const b of bundles) {
    base.route = b.run.state?.route ?? null;
    base.findings.push(...checkRun(b), ...scenarioFindings(s, b, { studyId: fx.main.id, deckId: setup.deckId, status: b.run.status, routed: !!w.cut }));
  }
  // The conversation-scope invariants (assistant claims) — only the turns of this case's conversation.
  for (const c of conversations) base.findings.push(...checkConversation(c));
  await cancelAll(hub, ids);
  return { ...base, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- report

function report(results: CaseResult[], meta: Record<string, unknown>): string {
  const out: string[] = [];
  const failed = (r: CaseResult) => r.findings.filter((f) => SEVERITY_RANK[f.severity] <= 2);
  const ids = [...new Set(results.flatMap((r) => r.findings.map((f) => f.invariant)))].sort();
  out.push(`# Scenario matrix ${String(meta.started).slice(0, 16)}Z`, "", `- Hub ${HUB}, user ${meta.user}, builds ${(meta.builds as string[]).join(", ")}; ${results.length} cases; planning only (every run cancelled).`);
  out.push(`- Depth ${meta.depth}. Reached: plan card ${results.filter((r) => r.reached === "plan").length}, routed + planning (cut) ${results.filter((r) => r.reached === "routed").length}, question ${results.filter((r) => r.reached === "question").length}, answered → plan ${results.filter((r) => r.reached === "answered_plan").length}, answered → routed (cut) ${results.filter((r) => r.reached === "answered_routed").length}, answered → question again ${results.filter((r) => r.reached === "answered_question").length}, other ${results.filter((r) => r.reached === "other").length} (${results.filter((r) => r.reached === "other").map((r) => `${r.id}:${r.status}`).join(", ")})`);
  out.push(`- Cases with ≥ 1 finding (critical/high/medium): ${results.filter((r) => failed(r).length).length}/${results.length}`, "");
  out.push("## Failures by invariant", "", "| Invariant | Severity | Cases | Share | Scenarios |", "|---|---|---|---|---|");
  const sev = (id: string) => INVARIANTS.find((i) => i.id === id)?.severity ?? results.flatMap((r) => r.findings).find((f) => f.invariant === id)?.severity ?? "high";
  const rows = ids.map((id) => ({ id, cases: results.filter((r) => r.findings.some((f) => f.invariant === id)) })).sort((a, b) => b.cases.length - a.cases.length);
  for (const r of rows) out.push(`| \`${r.id}\` | ${sev(r.id)} | ${r.cases.length} | ${Math.round((100 * r.cases.length) / results.length)}% | ${r.cases.map((c) => c.id.split("_")[0]).join(" ")} |`);
  // Invariant × dimension value: where each class concentrates.
  const dims: [keyof CaseResult["dims"], readonly string[]][] = [["entry", ENTRIES], ["history", HISTORIES], ["style", STYLES], ["intent", INTENTS]];
  for (const [d, vals] of dims) {
    out.push("", `## Invariant × ${d}`, "", `| Invariant | ${vals.map((v) => `${v} (${results.filter((r) => r.dims[d] === v).length})`).join(" | ")} |`, `|---|${vals.map(() => "---").join("|")}|`);
    for (const r of rows) out.push(`| \`${r.id}\` | ${vals.map((v) => r.cases.filter((c) => c.dims[d] === v).length || "").join(" | ")} |`);
  }
  out.push("", "## Cases", "", "| Case | entry | history | style | start | reached | run | findings |", "|---|---|---|---|---|---|---|---|");
  for (const r of results) out.push(`| ${r.id} | ${r.dims.entry} | ${r.dims.history} | ${r.dims.style} | ${r.dims.start} | ${r.reached}/${r.status} | ${r.run_ids.map((x) => x.slice(0, 8)).join(",")} | ${[...new Set(r.findings.map((f) => f.invariant))].join(", ") || "—"} |`);
  out.push("", "## Evidence (first finding per case and invariant)", "");
  for (const r of results) {
    const seen = new Set<string>();
    const fs = r.findings.filter((f) => !seen.has(f.invariant) && seen.add(f.invariant));
    if (!fs.length) continue;
    out.push(`### ${r.id} — ${r.request.slice(0, 120)}`, "");
    for (const f of fs) out.push(`- \`${f.invariant}\` [${f.severity}] ${f.message} — \`${JSON.stringify(f.evidence).slice(0, 400)}\``);
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- main

const hub = new Hub(process.env.EVAL_USER ?? "linyating", process.env.EVAL_PASSWORD ?? "password123");
await hub.login();
await mkdir(outDir, { recursive: true });
if (existsSync(startedFile)) started = JSON.parse(await readFile(startedFile, "utf8")) as string[];
/**
 * `--recheck <dir>`: re-reads every case's stored run(s) (read-only) and recomputes the invariant + oracle findings with
 * the CURRENT detectors (after a detector fix, without re-running planning). The setup facts come from results.json.
 */
if (opt("recheck")) {
  const dir = resolve(opt("recheck")!);
  const all = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as CaseResult[];
  const owner = process.env.EVAL_FIXTURE_USER && process.env.EVAL_FIXTURE_USER !== hub.username ? new Hub(process.env.EVAL_FIXTURE_USER, process.env.EVAL_FIXTURE_PASSWORD ?? "password123") : hub;
  if (owner !== hub) await owner.login();
  const fxr = await ensureFixtures(owner);
  const rdb = await openReadOnly(await stagingDbUrl(process.env.EVAL_COMPOSE_PROJECT ?? "hubv3"));
  const byId = new Map(buildMatrix().map((s) => [s.id, s]));
  for (const r of all) {
    const s = byId.get(r.id);
    if (!s || !r.run_ids.length) continue;
    const { bundles, conversations } = await loadBundles(rdb, await loadRuns(rdb, { runIds: r.run_ids }));
    const keep = r.findings.filter((f) => f.invariant === "scenario.started").map((f) => ({ ...f, severity: "low" as const }));
    r.findings = [...keep];
    for (const b of bundles) {
      // The stored status is `cancelled` now: judge the state the case reached.
      const status = /plan/.test(r.reached) ? "awaiting_plan_approval" : r.status;
      r.findings.push(...checkRun({ ...b, run: { ...b.run, status: r.status }, now: b.run.updated_at ?? b.now }), ...scenarioFindings(s, b, { studyId: fxr.main.id, deckId: r.deck_id, status, routed: /routed/.test(r.reached) }));
    }
    for (const c of conversations) r.findings.push(...checkConversation(c));
  }
  for (const r of all) for (const f of r.findings) if (f.invariant === "scenario.started") f.severity = "low";
  await writeFile(join(dir, "results.json"), JSON.stringify(all, null, 2));
  const builds = [...new Set(all.map((r) => r.build))];
  await writeFile(join(dir, "report.md"), report(all, { started: new Date().toISOString(), user: `${hub.username} (rechecked)`, builds, depth: DEPTH }));
  await rdb.close();
  console.log(`rechecked ${all.length} cases → ${join(dir, "report.md")}`);
  process.exit(0);
}
if (argv.includes("--sweep")) {
  await cancelAll(hub, started);
  console.log(`swept ${started.length} runs`);
  process.exit(0);
}
// The fixtures belong to their owner (EVAL_FIXTURE_USER, default linyating); the cases may act as another member
// (EVAL_USER) so they do not compete with the eval runner for the owner's 3 working-run slots.
const owner = process.env.EVAL_FIXTURE_USER && process.env.EVAL_FIXTURE_USER !== hub.username ? new Hub(process.env.EVAL_FIXTURE_USER, process.env.EVAL_FIXTURE_PASSWORD ?? "password123") : hub;
if (owner !== hub) await owner.login();
const fx = await ensureFixtures(owner);
const db = await openReadOnly(await stagingDbUrl(process.env.EVAL_COMPOSE_PROJECT ?? "hubv3"));
const userId = (await db.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [hub.username]))[0]!.id;
const only = list(opt("only"));
const match = opt("match") ? new RegExp(opt("match")!) : null;
let cases = buildMatrix().filter((s) => (!only.length || only.includes(s.id)) && (!match || match.test(s.id)));
const resultsFile = join(outDir, "results.json");
const results = new Map<string, CaseResult>();
if (existsSync(resultsFile)) for (const r of JSON.parse(await readFile(resultsFile, "utf8")) as CaseResult[]) if (r.status !== "error") results.set(r.id, r);
cases = cases.filter((s) => !results.has(s.id));
const tag = new Date().toISOString().slice(5, 16);
const meta = { started: new Date().toISOString(), user: hub.username, builds: [] as string[], depth: DEPTH };
const flush = async () => {
  const all = buildMatrix().map((s) => results.get(s.id)).filter((r): r is CaseResult => !!r);
  for (const r of all) if (!meta.builds.includes(r.build)) meta.builds.push(r.build);
  await writeFile(resultsFile, JSON.stringify(all, null, 2));
  await writeFile(join(outDir, "report.md"), report(all, meta));
};
let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\ncancelling started runs…");
  await cancelAll(hub, started);
  await flush();
  process.exit(130);
});

const concurrency = Math.max(1, Number(opt("concurrency") ?? 2));
console.log(`Scenario matrix: ${cases.length} cases (concurrency ${concurrency}) → ${outDir}`);
const queue = [...cases];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let s = queue.shift(); s && !stopping; s = queue.shift()) {
      let r: CaseResult | null = null;
      for (let attempt = 1; attempt <= 2 && !r; attempt++) {
        try {
          r = { ...(await runCase(hub, db, fx, s, userId, tag)), attempts: attempt };
          // An infrastructure failure (worker restart / redeploy mid-planning) is retried once with a fresh setup.
          if (attempt === 1 && r.status === "failed" && /lost|abort|shutdown|ECONN|terminat|interrupted/i.test(JSON.stringify(r.findings))) r = null;
        } catch (e) {
          console.log(`[${s.id}] attempt ${attempt} error: ${e instanceof Error ? e.message : e}`);
          if (attempt === 2) r = { id: s.id, dims: { entry: s.entry, history: s.history, style: s.style, intent: s.intent, lang: s.lang, anaphora: s.anaphora, answer: s.answer, start: s.start }, request: s.request, status: "error", reached: "other", run_ids: [], conversation_id: null, deck_id: null, questions: [], answered: null, playbook: null, route: null, findings: [], error: e instanceof Error ? e.message : String(e), attempts: 2, build: "?", ms: 0 };
          else await sleep(20_000);
        }
      }
      results.set(s.id, r!);
      const fs = [...new Set(r!.findings.filter((f) => SEVERITY_RANK[f.severity] <= 2).map((f) => f.invariant))];
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${s.id}: ${r!.reached}/${r!.status} ${Math.round(r!.ms / 1000)}s · ${fs.length ? fs.join(", ") : "clean"}${r!.error ? ` · ${r!.error}` : ""}`);
      await flush();
    }
  }),
);
await cancelAll(hub, started);
await flush();
await db.close();
console.log(`done → ${join(outDir, "report.md")}`);
