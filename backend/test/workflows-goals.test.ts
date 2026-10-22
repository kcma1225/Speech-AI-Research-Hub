/**
 * Goals with a scripted mock model (real DB + S3): template planning (paper from scratch, no model call), LLM planning
 * of a composite request, single-stage passthrough, roadmap approval → stages run one after another with the earlier
 * stage's note handed over, re-plan after a stage, a failed stage → 略過 → partial, cancel cascade, conversation delete,
 * the API (permissions, roadmap edits) and the start_workflow guard (no silent substitution, one goal per deliverable).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow, WorkflowInputError } from "../src/workflows/engine.js";
import { approveWorkflow, cancelWorkflow, createWorkflow } from "../src/workflows/service.js";
import { listInputs } from "../src/lib/latex/inputs.js";
import { addArtifact, getRun } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { commitNote } from "../src/workflows/playbooks/documents.js";
import { approveGoal, cancelGoal, createGoal, resumeGoal, setGoalModel } from "../src/workflows/goals/service.js";
import { getGoal } from "../src/workflows/goals/store.js";
import { routeWorkflowRequest } from "../src/workflows/goals/agent-tools.js";
import type { ModelPort, RunRow } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, message: { role: "assistant", content: text } });
type Req = { messages: { role: string; content: unknown }[] };
type Reply = string | ((req: Req) => string);
function mockModel() {
  const queues = new Map<string, Reply[]>();
  const defaults = new Map<string, Reply>();
  const log: string[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push(ctx.purpose);
      const key = ctx.purpose.replace(/:retry$/, "");
      const q = queues.get(key);
      const r = q?.length ? q.shift()! : defaults.get(key) ?? "{}";
      return result(typeof r === "function" ? r(req as Req) : r);
    },
    available: async () => true,
    vision: async () => false,
  };
  return {
    port, log,
    queue: (p: string, ...r: Reply[]) => queues.set(p, [...(queues.get(p) ?? []), ...r]),
    set: (p: string, r: Reply) => defaults.set(p, r),
    count: (p: string) => log.filter((x) => x === p).length,
  };
}
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((x) => ({ id: x[1], pass: true, evidence: "內容", reason: "ok" })) });

// Test playbooks with capabilities: research → a real note; paper → records its inputs and a project artifact; fail → plan error.
const simplePlan = (title: string) => ({
  kind: "plan" as const, title, objective: title, plan: { summary: title, writes: [{ kind: "paper", label: "匯入論文（沒有草稿效果）" }, { kind: "note", label: "新筆記", effect: "new" as const }] },
  criteria: [{ id: "len", kind: "check" as const, text: "有內容", check: { id: "min_length", params: { chars: 4 } } }],
  steps: [
    { key: "w", role: "writer" as const, title: "寫", instructions: "寫", verify: { checks: [{ id: "min_length", params: { chars: 4 } }], judge: false } },
    { key: "final", role: "verifier" as const, kind: "final" as const, title: "最終驗收", instructions: "", depends_on: ["w"] },
  ],
});
registerWorkflowPlaybook({
  id: "tg_research", title: "測試調研", titleEn: "R", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0,
  capability: { produces: "topic_note", requires: { study: true }, summary: "測試調研" },
  async plan(env) { await env.setState({ note_title: "調研筆記" }); return simplePlan("調研"); },
  async execute(env) { const text = "# 調研筆記\n\n台灣語料的整理內容。"; await env.setState({ doc: text }); return { summary: "ok", text }; },
  async finalText(env) { return { text: env.state<string>("doc") ?? "", data: null }; },
  commit: (env, outcome) => commitNote(env, outcome, "research"),
});
registerWorkflowPlaybook({
  id: "tg_paper", title: "測試論文", titleEn: "P", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0,
  capability: { produces: "paper", requires: { study: true }, summary: "測試論文" },
  async plan(env) { await env.setState({ got: env.run.inputs }); return simplePlan("論文"); },
  async execute() { return { summary: "ok", text: "\\section{緒論} 內容" }; },
  async finalText() { return { text: "\\section{緒論} 內容", data: null }; },
  async commit(env) { const id = randomUUID(); await addArtifact(env.db, env.run.id, { kind: "latex_project", id, url: `/x/${id}`, title: "論文專案", role: "draft" }); return null; },
});
registerWorkflowPlaybook({
  id: "tg_fail", title: "測試失敗", titleEn: "F", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0,
  capability: { produces: "outline", requires: { study: true }, summary: "測試失敗" },
  async plan() { throw new WorkflowInputError("缺少資料"); },
  async execute() { return { summary: "", text: "" }; },
  async finalText() { return { text: "", data: null }; },
});

const plan = (stages: { playbook: string; uses?: number[] }[]) => JSON.stringify({ title: "台灣語料論文", objective: "寫一篇論文", deliverable: "paper", stages: stages.map((s, i) => ({ ...s, title: `階段 ${i + 1}`, why: "需要", request: `做階段 ${i + 1}` })) });

run("workflow goals", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const req = (who: { cookie: string }, method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null });
  const newConv = async () => (await req(alice, "POST", "/api/agent/conversations", { title: "論文" })).json().conversation.id as string;
  const stageRun = async (goalId: string, idx: number) => (await t.db.query<RunRow>("SELECT * FROM workflow_runs WHERE id=$1", [(await getGoal(t.db, goalId))!.stages[idx]!.run_id])).rows[0]!;
  const composite = "先調研台灣語料的蒐集現況，再寫成一篇論文";

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-goal");
    bob = await t.login("student", "bob-goal");
    study = await insertStudy(t.db, alice.id, "台灣語料");
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => {
    setGoalModel(undefined);
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    setGoalModel(m.port);
  });

  it("plans a paper from scratch with the template (no model call) and waits for one approval", async () => {
    const conv = await newConv();
    const out = await createGoal(t.app, await asUser(alice.id), { request: "幫我寫一篇 paper 有關於目前台灣語料的搜集狀況", conversationId: conv, context: { studyId: study.id } });
    expect(out.kind).toBe("goal");
    if (out.kind !== "goal") return;
    expect(m.count("goal_plan")).toBe(0);
    expect(out.goal.status).toBe("awaiting_approval");
    expect(out.goal.deliverable).toMatchObject({ kind: "paper", direct: true, language: "zh", template: "article-zh" });
    expect(out.goal.stages.map((s) => s.playbook)).toEqual(["topic_research", "paper_outline", "paper_draft"]);
    expect(out.goal.stages[0]!.why).toContain("0 篇");
    expect(out.goal.readiness).toMatchObject({ papers: 0, papers_with_pdf: 0 });
    expect((await t.db.query("SELECT 1 FROM workflow_runs WHERE conversation_id=$1", [conv])).rowCount).toBe(0);
    const notice = (await t.db.query("SELECT content FROM agent_messages WHERE conversation_id=$1 AND role='notice'", [conv])).rows[0];
    expect(JSON.stringify(notice.content)).toContain("goal_awaiting_approval");
  });

  it("a single-stage plan starts the workflow directly (no goal)", async () => {
    const out = await createGoal(t.app, await asUser(alice.id), { request: "幫我做一份進度報告簡報", context: { studyId: study.id } });
    expect(out.kind).toBe("workflow");
    if (out.kind !== "workflow") return;
    expect(out.runs[0]!.playbook).toBe("slides");
    expect((await t.db.query("SELECT 1 FROM workflow_goals WHERE user_id=$1 AND request LIKE '%進度報告簡報%'", [alice.id])).rowCount).toBe(0);
  });

  it("an LLM-planned goal runs its stages one after another, handing the note over, and ends done", async () => {
    m.queue("goal_plan", plan([{ playbook: "tg_research" }, { playbook: "tg_paper", uses: [0] }]));
    const conv = await newConv();
    const out = await createGoal(t.app, await asUser(alice.id), { request: composite, conversationId: conv, context: { studyId: study.id } });
    if (out.kind !== "goal") throw new Error("expected a goal");
    expect(out.goal.state.planner).toBe("llm");
    const g0 = (await approveGoal(t.app, await asUser(alice.id), out.goal.id))!;
    expect(g0.status).toBe("running");
    const r0 = await stageRun(g0.id, 0);
    expect(r0.goal_id).toBe(g0.id);
    // Goal approval covers the stage plan (incl. a write without draft effect).
    expect((await runWorkflow(deps(), r0.id)).status).toBe("done");
    const g1 = (await getGoal(t.db, g0.id))!;
    expect(g1.stages[0]!.status).toBe("done");
    expect(g1.stages[1]!.status).toBe("running");
    const r1 = await stageRun(g0.id, 1);
    const note = (await getRun(t.db, r0.id))!.artifacts.find((a) => a.kind === "note")!;
    expect(r1.inputs.note_ids).toEqual([note.id]);
    expect((await runWorkflow(deps(), r1.id)).status).toBe("done");
    expect(((await getRun(t.db, r1.id))!.state.got as { note_ids: string[] }).note_ids).toEqual([note.id]);
    const done = (await getGoal(t.db, g0.id))!;
    expect(done.status).toBe("done");
    expect(done.report!.summary_md).toContain("論文專案");
    // Stage runs do not notify per stage; the goal does.
    expect((await t.db.query("SELECT 1 FROM notifications WHERE user_id=$1 AND title='目標已完成'", [alice.id])).rowCount).toBe(1);
  });

  it("re-plans the remaining stages after a stage", async () => {
    m.queue("goal_plan", plan([{ playbook: "tg_research" }, { playbook: "tg_paper", uses: [0] }]));
    m.queue("goal_replan", plan([{ playbook: "tg_research" }, { playbook: "tg_paper", uses: [0] }]));
    const out = await createGoal(t.app, await asUser(alice.id), { request: composite, context: { studyId: study.id } });
    if (out.kind !== "goal") throw new Error("expected a goal");
    await approveGoal(t.app, await asUser(alice.id), out.goal.id);
    await runWorkflow(deps(), (await stageRun(out.goal.id, 0)).id);
    const g = (await getGoal(t.db, out.goal.id))!;
    expect(g.stages.map((s) => [s.playbook, s.status])).toEqual([["tg_research", "done"], ["tg_research", "running"], ["tg_paper", "pending"]]);
    expect(g.stages[2]!.uses).toContain(g.stages[0]!.id);
    expect(g.history.some((h) => h.kind === "replan")).toBe(true);
  });

  it("a failed stage waits for the user; 略過 continues and the goal ends partial", async () => {
    m.queue("goal_plan", plan([{ playbook: "tg_fail" }, { playbook: "tg_paper" }]));
    const out = await createGoal(t.app, await asUser(alice.id), { request: composite, context: { studyId: study.id } });
    if (out.kind !== "goal") throw new Error("expected a goal");
    await approveGoal(t.app, await asUser(alice.id), out.goal.id);
    expect((await runWorkflow(deps(), (await stageRun(out.goal.id, 0)).id)).status).toBe("failed");
    const waiting = (await getGoal(t.db, out.goal.id))!;
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.question).toContain("略過");
    await resumeGoal(t.app, await asUser(alice.id), out.goal.id, "skip");
    const next = (await getGoal(t.db, out.goal.id))!;
    expect(next.stages.map((s) => s.status)).toEqual(["skipped", "running"]);
    await runWorkflow(deps(), (await stageRun(out.goal.id, 1)).id);
    const end = (await getGoal(t.db, out.goal.id))!;
    expect(end.status).toBe("partial");
    expect(end.report!.issues.join()).toContain("已略過");
  });

  it("stopping a stage run asks; stopping the goal cancels its running stage", async () => {
    m.queue("goal_plan", plan([{ playbook: "tg_research" }, { playbook: "tg_paper" }]), plan([{ playbook: "tg_research" }, { playbook: "tg_paper" }]));
    const a = await createGoal(t.app, await asUser(alice.id), { request: composite, context: { studyId: study.id } });
    if (a.kind !== "goal") throw new Error("expected a goal");
    await approveGoal(t.app, await asUser(alice.id), a.goal.id);
    await cancelWorkflow(t.app, await asUser(alice.id), (await stageRun(a.goal.id, 0)).id);
    expect((await getGoal(t.db, a.goal.id))!.status).toBe("awaiting_input");
    const b = await createGoal(t.app, await asUser(alice.id), { request: composite, context: { studyId: study.id } });
    if (b.kind !== "goal") throw new Error("expected a goal");
    await approveGoal(t.app, await asUser(alice.id), b.goal.id);
    const runId = (await stageRun(b.goal.id, 0)).id;
    await cancelGoal(t.app, await asUser(alice.id), b.goal.id);
    expect((await getRun(t.db, runId))!.status).toBe("cancelled");
    const g = (await getGoal(t.db, b.goal.id))!;
    expect(g.status).toBe("cancelled");
    expect(g.stages.map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("deleting the conversation stops and deletes its goal and stage runs", async () => {
    m.queue("goal_plan", plan([{ playbook: "tg_research" }, { playbook: "tg_paper" }]));
    const conv = await newConv();
    const out = await createGoal(t.app, await asUser(alice.id), { request: composite, conversationId: conv, context: { studyId: study.id } });
    if (out.kind !== "goal") throw new Error("expected a goal");
    await approveGoal(t.app, await asUser(alice.id), out.goal.id);
    const runId = (await stageRun(out.goal.id, 0)).id;
    const activity = (await req(alice, "GET", `/api/agent/conversations/${conv}/activity`)).json();
    expect(activity.goals.map((g: { id: string }) => g.id)).toEqual([out.goal.id]);
    expect((await req(alice, "DELETE", `/api/agent/conversations/${conv}`)).statusCode).toBe(409);
    expect((await req(alice, "DELETE", `/api/agent/conversations/${conv}?stop_agents=1`)).statusCode).toBe(200);
    expect(await getGoal(t.db, out.goal.id)).toBeNull();
    expect(await getRun(t.db, runId)).toBeNull();
  });

  it("API: create, owner-only detail, roadmap edits, approve", async () => {
    const created = await req(alice, "POST", "/api/goals", { request: "從零寫一篇關於台灣語音語料蒐集現況的論文", context: { studyId: study.id } });
    expect(created.statusCode).toBe(201);
    const goal = created.json().goal;
    expect(goal.stages.map((s: { playbook: string }) => s.playbook)).toEqual(["topic_research", "paper_outline", "paper_draft"]);
    expect(goal.action).toBe("approve_plan");
    expect(goal.readiness.join()).toContain("文獻庫 0 篇");
    expect((await req(bob, "GET", `/api/goals/${goal.id}`)).statusCode).toBe(404);
    // Remove the research stage, add a lit review before the outline.
    const [, outline, draft] = goal.stages;
    const edited = await req(alice, "PUT", `/api/goals/${goal.id}/stages`, { stages: [{ playbook: "lit_review", request: "先比較文獻庫的論文" }, { id: outline.id }, { id: draft.id }] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().goal.stages.map((s: { playbook: string; added_by: string }) => `${s.playbook}:${s.added_by}`)).toEqual(["lit_review:user", "paper_outline:plan", "paper_draft:plan"]);
    expect((await req(alice, "PUT", `/api/goals/${goal.id}/stages`, { stages: [{ playbook: "nope", request: "x" }] })).statusCode).toBe(400);
    // The same deliverable named again keeps the roadmap (no re-plan, title unchanged).
    const same = (await req(alice, "PATCH", `/api/goals/${goal.id}`, { request: "最後要給我一個 latex 論文" })).json().goal;
    expect(same.title).toBe(goal.title);
    expect(same.stages.map((s: { playbook: string }) => s.playbook)).toEqual(["lit_review", "paper_outline", "paper_draft"]);
    const approved = (await req(alice, "POST", `/api/goals/${goal.id}/approve`)).json().goal;
    expect(approved.status).toBe("running");
    expect(approved.stages[0].run_status).toBe("planning");
    expect((await req(alice, "POST", `/api/goals/${goal.id}/approve`)).statusCode).toBe(409);
    const active = (await req(alice, "GET", "/api/workflows/active")).json();
    expect(active.runs.some((r: { kind: string; focus: string }) => r.kind === "goal" && r.focus === `goal:${goal.id}`)).toBe(true);
    expect((await req(alice, "POST", `/api/goals/${goal.id}/cancel`)).json().goal.status).toBe("cancelled");
  });

  it("start_workflow never substitutes the deliverable and keeps one goal per conversation", async () => {
    const conv = await newConv();
    const ctx = { app: t.app, db: t.db, user: await asUser(alice.id), source: "agent" as const, conversationId: conv, runId: null, autopilot: false };
    await t.db.query("UPDATE conversations SET context=$2 WHERE id=$1", [conv, JSON.stringify({ studyId: study.id })]);
    const first = await routeWorkflowRequest(ctx, { request: "幫我寫一篇 paper 有關於目前台灣語料的搜集狀況", playbook: "lit_review" });
    const goalId = (first!.data as { goal_id: string }).goal_id;
    expect(goalId).toBeTruthy();
    const again = await routeWorkflowRequest(ctx, { request: "可以開論文了", playbook: "generic" });
    expect((again!.data as { goal_id: string }).goal_id).toBe(goalId);
    const third = await routeWorkflowRequest(ctx, { request: "最後要給我一個 latex 論文", playbook: "generic" });
    expect((third!.data as { goal_id: string }).goal_id).toBe(goalId);
    expect((await t.db.query("SELECT 1 FROM workflow_goals WHERE conversation_id=$1", [conv])).rowCount).toBe(1);
    expect((await t.db.query("SELECT 1 FROM workflow_runs WHERE conversation_id=$1", [conv])).rowCount).toBe(0);
    // A playbook that produces what was asked runs as before.
    expect(await routeWorkflowRequest(ctx, { request: "幫我做一份進度報告簡報", playbook: "slides" })).toBeNull();
  });

  it("paper_draft writes every section into a new LaTeX project, compiles and fixes a compile error", async () => {
    const s2 = await insertStudy(t.db, alice.id, "論文研究");
    for (const key of ["chen2021", "lin2022"]) {
      const pid = (await t.db.query<{ id: string }>("INSERT INTO papers(record,type,title,title_norm,abstract,year,added_by) VALUES($1,'article-journal',$2,lower($2),'台灣華語與台語語料的蒐集。',2021,$3) RETURNING id", [JSON.stringify({ title: `Corpus ${key}`, type: "article-journal", authors: [{ family: "Chen", given: "Wei" }] }), `Corpus ${key}`, alice.id])).rows[0]!.id;
      await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,added_by) VALUES($1,$2,$3,$4)", [s2.id, pid, key, alice.id]);
    }
    const outline = "# 論文大綱：台灣語料\n\n## 論文題目\n台灣語音語料蒐集現況\n\n## 主要貢獻\n- 整理\n\n## 章節規劃\n### 1. 緒論\n- 背景\n- 引用：[@chen2021]\n### 2. 現有語料\n- 華語與台語 [@lin2022]\n### 3. 蒐集方法\n- 錄音\n### 4. 結論\n- 總結\n";
    const outlineId = (await t.db.query<{ id: string }>("INSERT INTO notes(study_id,title,kind,content_md,created_by) VALUES($1,'論文大綱：台灣語料','research',$2,$3) RETURNING id", [s2.id, outline, alice.id])).rows[0]!.id;
    const researchId = (await t.db.query<{ id: string }>("INSERT INTO notes(study_id,title,kind,content_md,created_by) VALUES($1,'主題調研：台灣語料','research','華語語料與台語語料的現況。',$2) RETURNING id", [s2.id, alice.id])).rows[0]!.id;
    const body = "台灣的語音語料蒐集近年快速發展，涵蓋華語、台語與客語等語言。".repeat(20);
    m.set("paper_section", `${body}\\cite{chen2021}`);
    m.set("paper_abstract", "本文整理台灣語音語料的蒐集現況、方法與挑戰。".repeat(6) + "\nKEYWORDS: 語料, 台灣");
    m.set("paper_fix", "\\section{緒論}\\label{sec:s1}\n\n修正後的緒論內文。" + body + "\\cite{chen2021}");
    m.set("verify", '{"verdict":"pass","issues":[]}');
    m.set("verify_final", allPass);
    // Fake latex-runner: the first compile fails in the first section, later ones succeed.
    let compiles = 0;
    const runner = setInterval(async () => {
      const rows = (await t.db.query<{ id: string }>("SELECT id FROM latex_compiles WHERE status='queued'")).rows;
      for (const r of rows) {
        compiles++;
        const fail = compiles === 1;
        await t.db.query("UPDATE latex_compiles SET status=$2, result=$3, finished_at=now() WHERE id=$1", [r.id, fail ? "failed" : "success", JSON.stringify({ errors: fail ? [{ file: "sections/s01.tex", line: 3, message: "Undefined control sequence" }] : [] })]);
      }
    }, 200);
    try {
      const u = await asUser(alice.id);
      const r = await createWorkflow(t.app, u, { request: "依論文大綱撰寫完整的 LaTeX 論文「台灣語音語料蒐集現況」", playbook: "paper_draft", context: { studyId: s2.id }, inputs: { note_ids: [outlineId, researchId] } });
      const d = { ...deps(), compileWaitMs: 20_000 };
      expect((await runWorkflow(d, r.id)).status).toBe("awaiting_plan_approval");
      const planned = (await getRun(t.db, r.id))!;
      expect(planned.plan!.outline!.map((o) => o.title)).toEqual(["緒論", "現有語料", "蒐集方法", "結論"]);
      expect(planned.plan!.writes[0]).toMatchObject({ kind: "latex_project", effect: "new" });
      await approveWorkflow(t.app, u, r.id, {});
      expect((await runWorkflow(d, r.id)).status).toBe("done");
      const final = (await getRun(t.db, r.id))!;
      const art = final.artifacts.find((a) => a.kind === "latex_project")!;
      const files = (await t.db.query<{ path: string; content: string }>("SELECT path, content FROM latex_files WHERE project_id=$1", [art.id])).rows;
      const main = files.find((f) => f.path === "main.tex")!.content;
      expect(listInputs(main).map((i) => i.path)).toEqual(["sections/abstract.tex", "sections/s01.tex", "sections/s02.tex", "sections/s03.tex", "sections/s04.tex"]);
      expect(files.find((f) => f.path === "sections/s01.tex")!.content).toContain("修正後的緒論內文");
      expect(files.find((f) => f.path === "sections/s02.tex")!.content).toMatch(/^\\section\{現有語料\}/);
      expect(files.find((f) => f.path === "refs.bib")!.content).toContain("chen2021");
      expect(files.find((f) => f.path === "sections/abstract.tex")!.content).toContain("\\begin{abstract}");
      expect((await t.db.query("SELECT template FROM latex_projects WHERE id=$1", [art.id])).rows[0].template).toBe("article-zh");
      // The preview compile (a real history row) was requested at commit: refs.bib matched the library, nothing to rewrite.
      expect((await t.db.query("SELECT 1 FROM latex_compiles WHERE project_id=$1", [art.id])).rowCount).toBeGreaterThan(0);
    } finally {
      clearInterval(runner);
    }
  });
});
