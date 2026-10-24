/**
 * The Brief (brief.ts) with a scripted mock model (real DB + S3), reproducing the production cases of the 2026-10-23
 * audit (docs/research/agent-planning-redesign.md):
 * 1. the assistant's paraphrase added 「所有內容使用繁體中文」 and pages: 12 → neither becomes a requirement (「未指定」);
 * 2. an English topic deck whose words mention "paper title" (run 50b49d80) + a guidance 「你自己找」 → stays a deck
 *    (topic mode over the study library), never a paper report, never a note;
 * 3. the repeated-question fallback / a redirect that would turn a deck into a note stops and asks (stop / switch);
 * 4. every sub-agent gets the Brief (deliverable, the user's words, 「未指定」) and its own step scope;
 * 5. immutability (DB trigger) and plan-card edits as new versions; 6. goal stages carry the goal's user words.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { addGuidance, answerWorkflow, approveWorkflow, createWorkflow, revisePlan } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { getAgentTool } from "../src/agent/tools/registry.js";
import { approveGoal, createGoal, setGoalModel } from "../src/workflows/goals/service.js";
import { getGoal } from "../src/workflows/goals/store.js";
import type { ModelPort, RunRow } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";
import { setTopicResearchDeps } from "../src/workflows/playbooks/research.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
type Reply = string | ((req: Req) => string);
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const textOf = (req: Req, role?: string) => req.messages.filter((m) => !role || m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function mockModel() {
  const defaults = new Map<string, Reply>();
  const log: { purpose: string; prompt: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, prompt: textOf(req as Req) });
      const reply = defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as Req) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, log, set(purpose: string, reply: Reply) { defaults.set(purpose, reply); }, prompts(purpose: string) { return log.filter((l) => l.purpose === purpose).map((l) => l.prompt); } };
}

/** Outline of exactly the requested page count (「正好 N 頁」 in the prompt). */
const outline = (req: Req) => {
  const n = Number(/正好 (\d+) 頁/.exec(textOf(req, "user"))?.[1] ?? 8);
  return JSON.stringify({ pages: Array.from({ length: n }, (_, i) => ({ title: `Page ${i + 1}`, points: ["From the library"] })) });
};
const PASS = '{"verdict":"pass","issues":[]}';
const allPass = (req: Req) => JSON.stringify({ results: [...textOf(req, "user").matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "Background", reason: "ok" })) });

// A deck playbook that always lacks its input (the 50b49d80 shape: 「要報告哪一篇論文？」 every time) and one that redirects to generic.
const deckCapability = { produces: "deck" as const, requires: { study: true }, summary: "測試簡報" };
registerWorkflowPlaybook({
  id: "tb_deck", title: "測試簡報", titleEn: "Deck", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0, capability: deckCapability,
  async plan() { return { kind: "question", question: "要報告哪一篇論文？" }; },
  async execute() { return { summary: "", text: "" }; },
  async finalText() { return { text: "", data: null }; },
});
registerWorkflowPlaybook({
  id: "tb_redirect", title: "測試轉交", titleEn: "Redirect", description: "", descriptionEn: "", autoApprovable: true, detect: () => 0, capability: deckCapability,
  async plan() { return { kind: "redirect", playbook: "generic", message: "改用一般流程" }; },
  async execute() { return { summary: "", text: "" }; },
  async finalText() { return { text: "", data: null }; },
});

registerWorkflowPlaybook({
  id: "tb_plan", title: "測試計畫", titleEn: "Plan", description: "", descriptionEn: "", autoApprovable: false, detect: () => 0, capability: deckCapability,
  async plan() {
    return { kind: "plan", title: "測試", objective: "測試", plan: { summary: "測試", writes: [{ kind: "deck", label: "新簡報", effect: "new" }] }, criteria: [],
      steps: [{ key: "w", role: "writer", title: "寫", instructions: "寫" }, { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["w"] }] };
  },
  async execute() { return { summary: "", text: "" }; },
  async finalText() { return { text: "", data: null }; },
});

const TOPIC_DECK = "Make an English research presentation on the state of the art in dynamic hotwording for streaming ASR. Each method slide should show the paper title and year.";

run("workflow brief", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const newConv = async () => (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context) VALUES($1,'chat',$2) RETURNING id", [alice.id, JSON.stringify({ studyId: study.id })])).rows[0]!.id;
  const say = (conv: string, text: string) => t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'user',$2,$3)", [conv, JSON.stringify([{ type: "text", text }]), text]);
  const toolCtx = async (conv: string) => ({ app: t.app, db: t.db, user: await asUser(alice.id), source: "agent" as const, conversationId: conv, runId: null, autopilot: false });
  const row = async (id: string) => (await getRun(t.db, id))!;

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-brief");
    study = await insertStudy(t.db, alice.id, "Dynamic hotwording");
    setWorkflowAvailability(async () => true);
    // The study's only paper has a PDF: the old fallback made every deck request a report on it.
    const pid = (await t.db.query<{ id: string }>("INSERT INTO papers(record,type,title,title_norm,abstract,year,pdf_key,added_by) VALUES($1,'article-journal',$2,lower($2),'Contextual biasing with a prefix tree for RNN-T.',2021,'papers/x.pdf',$3) RETURNING id", [JSON.stringify({ title: "Tree-constrained pointer generator" }), "Tree-constrained pointer generator for end-to-end contextual speech recognition", alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,added_by) VALUES($1,$2,'sun2021',$3)", [study.id, pid, alice.id]);
  });
  afterAll(async () => {
    setGoalModel(undefined);
    await t?.close();
  });
  beforeEach(() => {
    m = mockModel();
    setGoalModel(m.port);
    m.set("requirements", '{"requirements":[]}');
    m.set("outline", outline);
    m.set("verify", PASS);
    m.set("verify_final", allPass);
    m.set("title_translate", "Dynamic Hotwording");
  });

  it("1. the assistant's paraphrase adds 繁體中文 and 12 pages: neither becomes a requirement, both stay 「未指定」", async () => {
    const conv = await newConv();
    await say(conv, "幫我做一份 dynamic hotwording 的進度簡報");
    const tool = getAgentTool("start_workflow")!;
    const out = await tool.execute({ request: "幫我做一份 12 頁的進度報告簡報，所有內容使用繁體中文，結構：背景、方法、實驗、結果、下一步", playbook: "slides", pages: 12 } as never, await toolCtx(conv));
    const id = (out.data as { workflow_id: string }).workflow_id;
    const created = await row(id);
    expect(created.brief).toMatchObject({ version: 0, user_words: ["幫我做一份 dynamic hotwording 的進度簡報"], deliverable: { kind: "deck", hard: true } });
    expect(created.brief!.paraphrase).toContain("12 頁");
    expect(created.inputs.pages).toBeUndefined();
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const r = await row(id);
    expect(r.brief).toMatchObject({ version: 1, source: "plan", unspecified: ["語言", "頁數"] });
    expect(r.brief!.requirements.filter((x) => x.type === "language" || x.type === "page_count")).toEqual([]);
    expect(r.plan!.outline!.length).toBe(8);
    expect(r.plan!.notes).toContain("頁數：未指定");
    expect(r.criteria.some((c) => c.check?.id === "req_pages" || c.check?.id === "req_language")).toBe(false);
    // The checklist of the Brief is the plan's criteria (same ids).
    expect(r.brief!.checklist.map((c) => c.id)).toEqual(r.criteria.map((c) => c.id));
    // The outline planner sees the user's words; the paraphrase is marked as a reference, never as the user's request.
    const p = m.prompts("outline")[0]!;
    expect(p).toContain("「幫我做一份 dynamic hotwording 的進度簡報」");
    expect(p).toContain("使用者沒有指定：語言、頁數");
    expect(p).not.toContain("使用者的要求：幫我做一份 12 頁");
    expect(p).toContain("任務說明（助理整理的，只是參考");
  });

  it("2. an English topic deck that says 'paper title' + 「你自己找」 stays a deck (topic mode), never a paper report or a note", async () => {
    // The library is empty, so the topic deck searches online: stubbed (never the real APIs), finding nothing importable.
    const searched: string[] = [];
    setTopicResearchDeps({ search: async (_env, q) => (searched.push(q), []), snowball: async () => [] });
    // No playbook given: detection alone would pick topic research (state of the art) — the user's words name a deck.
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: TOPIC_DECK, context: { studyId: study.id } });
    expect(created.playbook).toBe("slides");
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    let r = await row(created.id);
    expect(r.state.deck_style).toBe("topic");
    expect(r.state.mode).toBe("progress");
    expect(r.inputs.paper_id).toBeUndefined();
    expect(r.title).toContain("主題簡報");
    expect(r.plan!.notes).toContain("主題簡報");
    expect(r.brief!.requirements.find((x) => x.type === "language")).toMatchObject({ params: { language: "en" }, quote: expect.stringContaining("English research presentation") });
    expect(r.plan!.outline!.length).toBe(10);
    const research = (await getSteps(t.db, created.id)).find((s) => s.key === "research")!;
    expect(research.output!.text).toContain("研究文獻庫");
    expect(m.prompts("outline")[0]).toContain("主題簡報規則");
    // The user's guidance (「find them yourself」) re-plans: still the deck, a new brief version with their words.
    await revisePlan(t.app, await asUser(alice.id), created.id, "Find the papers yourself, I don't have a specific one.");
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    r = await row(created.id);
    expect(r.playbook).toBe("slides");
    expect(r.brief).toMatchObject({ version: 2, source: "guidance", deliverable: { kind: "deck" } });
    expect(r.brief!.user_words.at(-1)).toContain("Find the papers yourself");
    expect(r.state.deck_style).toBe("topic");
    expect(searched.length).toBeGreaterThan(0);
    setTopicResearchDeps(null);
  });

  it("3a. the repeated-question fallback would turn the deck into a note: it asks; 「先停下來」 ends the run without a note", async () => {
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "做一份簡報", playbook: "tb_deck", context: { studyId: study.id } });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_input");
    await addGuidance(t.app, await asUser(alice.id), created.id, "你自己去找");
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_input");
    let r = await row(created.id);
    expect(r.playbook).toBe("tb_deck");
    const card = (r.state.asks as Record<string, { id: string; questions: { options: { value: string }[] }[] }>).deliverable_1!;
    expect(card.questions[0]!.options.map((o) => o.value)).toEqual(["switch", "stop"]);
    await answerWorkflow(t.app, await asUser(alice.id), created.id, { card_id: "deliverable_1", answers: [{ id: "q", value: "stop" }] });
    expect((await runWorkflow(deps(), created.id)).status).toBe("cancelled");
    r = await row(created.id);
    expect(r.stop_reason).toBe("skipped");
    expect(r.artifacts).toEqual([]);
    expect(m.prompts("plan_generic")).toEqual([]);
  });

  it("3b. a redirect to another kind asks too; the user's 「改做筆記」 is a new brief version, then generic plans", async () => {
    m.set("plan_generic", JSON.stringify({ title: "熱詞筆記", objective: "整理熱詞", criteria: ["涵蓋 TCPGen"], steps: [{ key: "s1", title: "背景", role: "writer", instructions: "寫背景" }] }));
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "做一份熱詞簡報", playbook: "tb_redirect", context: { studyId: study.id } });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_input");
    expect((await row(created.id)).playbook).toBe("tb_redirect");
    await answerWorkflow(t.app, await asUser(alice.id), created.id, { card_id: "deliverable_1", answers: [{ id: "q", value: "switch" }] });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    const r = await row(created.id);
    expect(r.playbook).toBe("generic");
    expect(r.brief!.deliverable.kind).toBe("note");
    expect(r.brief_versions!.some((v) => v.source === "deliverable")).toBe(true);
  });

  it("4. sub-agents get the Brief and their own scope; verifiers are told not to ask for what the user did not say", async () => {
    m.set("plan_generic", JSON.stringify({ title: "熱詞比較", objective: "比較熱詞方法", criteria: ["涵蓋 TCPGen"], steps: [{ key: "s1", title: "背景", role: "writer", instructions: "寫背景" }, { key: "s2", title: "方法比較", role: "writer", instructions: "寫方法", depends_on: ["s1"] }] }));
    m.set("write:generic", (req) => (textOf(req, "user").includes("寫方法") ? "## 方法比較\n\nTCPGen 用字首樹指標產生器把熱詞偏置進解碼，淺層融合則在解碼時加上外部語言模型分數，兩者在延遲與資料需求上各有取捨：TCPGen 需要訓練偏置模組但對長清單較穩定，淺層融合不需重新訓練但容易過度偏置常見詞。" : "## 背景\n\n串流語音辨識常常漏掉罕見的專有名詞，動態熱詞在不重新訓練模型的情況下，讓解碼偏向使用者提供的清單，例如人名、地名與產品名稱，這在會議記錄與客服情境特別重要，也是這份比較的出發點。"));
    const conv = await newConv();
    await say(conv, "幫我整理 TCPGen 和 shallow fusion 的比較筆記");
    const out = await getAgentTool("start_workflow")!.execute({ request: "整理一份熱詞方法比較筆記，3000 字，含表格", playbook: "generic" } as never, await toolCtx(conv));
    const id = (out.data as { workflow_id: string }).workflow_id;
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const done = await runWorkflow(deps(), id);
    expect(done.status, JSON.stringify((await row(id)).report?.issues)).toBe("done");
    const writers = m.prompts("write:generic");
    expect(writers.length).toBeGreaterThanOrEqual(2);
    for (const p of writers) {
      expect(p).toContain("要交付的成果：筆記");
      expect(p).toContain("「幫我整理 TCPGen 和 shallow fusion 的比較筆記」");
      expect(p).toContain("使用者沒有指定：語言、篇幅");
      expect(p).not.toContain("3000 字");
    }
    expect(writers.find((p) => p.includes("寫方法"))).toContain("這一步的範圍：只完成「方法比較」");
    // The final judge gets the Brief (the step judge gets only its own scope's requirements: verify.ts).
    const judged = m.prompts("verify_final");
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((p) => p.includes("不要要求使用者沒說的東西") && p.includes("「幫我整理 TCPGen 和 shallow fusion 的比較筆記」"))).toBe(true);
  });

  it("5. a written version is immutable (DB trigger); plan-card edits are a new version", async () => {
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我做這個研究的進度報告簡報", playbook: "slides", context: { studyId: study.id }, inputs: { mode: "progress" } });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    const r: RunRow = await row(created.id);
    const tampered = { ...r.brief!, user_words: ["做 20 頁英文簡報"] };
    await expect(t.db.query("UPDATE workflow_runs SET brief=$2 WHERE id=$1", [r.id, JSON.stringify(tampered)])).rejects.toThrow(/immutable/);
    await expect(t.db.query("UPDATE workflow_runs SET brief=$2 WHERE id=$1", [r.id, JSON.stringify({ ...r.brief!, version: 0 })])).rejects.toThrow(/cannot go back/);
    await approveWorkflow(t.app, await asUser(alice.id), r.id, { requirements: [{ text: "正好 5 頁" }] });
    const after = await row(r.id);
    expect(after.brief).toMatchObject({ version: r.brief!.version + 1, source: "edit" });
    expect(after.brief!.requirements.map((x) => x.type)).toEqual(["page_count"]);
    expect(after.brief!.unspecified).toEqual(["語言"]);
    expect(after.brief!.checklist.some((c) => c.id.startsWith("req_") && c.source === "user")).toBe(true);
    expect(after.brief_versions!.at(-1)!.version).toBe(r.brief!.version);
  });

  it("7. clarify once: two deliverables named at once → one card; the choice picks the playbook; autopilot records 「未指定」", async () => {
    m.set("plan_generic", JSON.stringify({ title: "熱詞筆記", objective: "整理熱詞", criteria: ["涵蓋 TCPGen"], steps: [{ key: "s1", title: "背景", role: "writer", instructions: "寫背景" }] }));
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我把熱詞的資料整理成簡報或筆記", context: { studyId: study.id } });
    expect(created.playbook).toBe("slides");
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_input");
    expect(Object.keys((await row(created.id)).state.asks as object)).toEqual(["clarify_deliverable"]);
    await answerWorkflow(t.app, await asUser(alice.id), created.id, { card_id: "clarify_deliverable", answers: [{ id: "q", value: "note" }] });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    let r = await row(created.id);
    expect(r.playbook).toBe("generic");
    expect(r.brief).toMatchObject({ deliverable: { kind: "note" }, clarified: true });
    expect(r.brief!.user_words.some((w) => w.includes("回答「要交付哪一種成果？」") && w.includes("筆記"))).toBe(true);
    // Autopilot: no card; the item stays 「未指定」 and the run keeps its playbook.
    const auto = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我把熱詞的資料整理成簡報或筆記", playbook: "tb_plan", context: { studyId: study.id }, autopilot: true });
    expect((await runWorkflow(deps(), auto.id)).status).toBe("awaiting_plan_approval");
    r = await row(auto.id);
    expect(r.state.asks ?? {}).toEqual({});
    expect(r.brief!.unspecified).toContain("成果種類");
    expect(r.playbook).toBe("tb_plan");
  });

  it("8. a paper report without a paper: one card with the study's papers; 「不指定論文」 → a topic deck", async () => {
    const s2 = await insertStudy(t.db, alice.id, "Two papers");
    for (const [i, title] of ["Contextual RNN-T", "Deep context"].entries()) {
      const pid = (await t.db.query<{ id: string }>("INSERT INTO papers(record,type,title,title_norm,abstract,year,added_by) VALUES($1,'article-journal',$2,lower($2),'Biasing.',2020,$3) RETURNING id", [JSON.stringify({ title }), title, alice.id])).rows[0]!.id;
      await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,added_by) VALUES($1,$2,$3,$4)", [s2.id, pid, `p${i}2020`, alice.id]);
    }
    const created = await createWorkflow(t.app, await asUser(alice.id), { request: "幫我做一份論文報告簡報", context: { studyId: s2.id } });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_input");
    const card = (await row(created.id)).state.asks as Record<string, { questions: { options: { value: string; label: string }[] }[] }>;
    expect(card.clarify_paper!.questions[0]!.options.map((o) => o.label)).toEqual(expect.arrayContaining(["Contextual RNN-T", "Deep context", "不指定論文：用研究的文獻庫與筆記做主題簡報"]));
    await answerWorkflow(t.app, await asUser(alice.id), created.id, { card_id: "clarify_paper", answers: [{ id: "q", value: "topic" }] });
    expect((await runWorkflow(deps(), created.id)).status).toBe("awaiting_plan_approval");
    const r = await row(created.id);
    expect(r.state.deck_style).toBe("topic");
    expect(r.brief!.deliverable.kind).toBe("deck");
  });

  it("6. a goal keeps the user's words: language from them (not the paraphrase), stage runs carry them with their own deliverable", async () => {
    const out = await createGoal(t.app, await asUser(alice.id), { request: "幫我寫一篇關於台灣語料蒐集現況的論文，使用繁體中文", userWords: ["write an English paper about Taiwanese speech corpora"], context: { studyId: study.id } });
    expect(out.kind).toBe("goal");
    if (out.kind !== "goal") return;
    expect(out.goal.deliverable).toMatchObject({ kind: "paper", language: "en", template: "ieee-conference" });
    expect(out.goal.brief).toMatchObject({ version: 1, deliverable: { kind: "latex" }, user_words: ["write an English paper about Taiwanese speech corpora"] });
    await approveGoal(t.app, await asUser(alice.id), out.goal.id);
    const g = (await getGoal(t.db, out.goal.id))!;
    const stage = await row(g.stages[0]!.run_id!);
    expect(stage.brief).toMatchObject({ user_words: ["write an English paper about Taiwanese speech corpora"], deliverable: { kind: "note" } });
    expect(stage.brief!.paraphrase).toContain("階段");
  });
});
