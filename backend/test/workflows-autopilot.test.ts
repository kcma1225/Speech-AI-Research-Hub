/**
 * Autopilot rules of workflows (autopilot.ts, student-input.ts, context.ts, queue.ts, paper-pdf.ts):
 * - plan auto-approval matrix (完全自動): autopilot approves every effect, also tainted; only outbound after taint and
 *   no autopilot ask;
 *   「修改計畫」 on an auto-approved plan → the next plan waits for the user;
 * - student-owned pages under autopilot are AI-filled (marked, notified, listed in the report) and stay editable;
 * - context inheritance (conversation / study named in the request);
 * - batches (one run per paper) + queueing over the per-user limit + automatic start when a slot frees;
 * - a paper without a PDF: open access / record URL tried, autopilot → needs_pdf, otherwise a choice card.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { autoApproval, AUTO_APPROVED_NOTE } from "../src/workflows/autopilot.js";
import { addGuidance, createWorkflow, revisePlan } from "../src/workflows/service.js";
import { getRun, getSteps, markTainted } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { pendingAsk } from "../src/workflows/questions.js";
import { AI_FILLED_MARK, applyStudentPages, autopilotAnswers, runStudentInput, STUDENT_CARD_ID, STUDENT_INPUT_KEY, studentPagesOf } from "../src/workflows/student-input.js";
import { batchPapers, EACH_PAPER_RE, textTokens } from "../src/workflows/context.js";
import { MAX_ACTIVE_PER_USER, promoteQueued } from "../src/workflows/queue.js";
import { recordUrls, setPaperPdfDeps } from "../src/workflows/paper-pdf.js";
import type { ModelPort, WriteEffect } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

describe("autopilot plan approval (pure)", () => {
  const w = (...effects: (WriteEffect | undefined)[]) => effects.map((effect, i) => ({ kind: "deck", label: `w${i}`, ...(effect ? { effect } : {}) }));
  it.each([
    // [autopilot, tainted, effects, expected]
    [true, false, ["new"], true],
    [true, true, ["new"], true],
    [true, true, ["draft_own"], true],
    [true, true, ["new", "suggestion"], true],
    [true, false, [], true],
    // 完全自動: overwrites (versions kept), publishing, imports without a declared effect are approved too.
    [true, true, ["overwrite"], true],
    [true, false, ["publish"], true],
    [true, true, ["new", "delete"], true],
    [true, false, ["outbound"], true],
    // Exfiltration protection: sending data out after reading untrusted content still waits.
    [true, true, ["outbound"], false],
    [true, true, [undefined], true],
    [false, false, ["new"], false],
    [false, false, ["overwrite"], false],
  ] as [boolean, boolean, (WriteEffect | undefined)[], boolean][])("autopilot=%s tainted=%s writes=%j → auto=%s", (autopilot, tainted, effects, expected) => {
    expect(autoApproval({ autopilot, tainted, autoApprovable: true, writes: w(...effects) }).auto).toBe(expected);
  });
  it("never auto-approves a non-auto-approvable playbook or after a manual revise", () => {
    expect(autoApproval({ autopilot: true, tainted: false, autoApprovable: false, writes: w("new") })).toMatchObject({ auto: false, reason: "playbook" });
    expect(autoApproval({ autopilot: true, tainted: false, autoApprovable: true, manual: true, writes: w("new") })).toMatchObject({ auto: false, reason: "manual" });
    expect(autoApproval({ autopilot: true, tainted: true, autoApprovable: true, writes: w("new", "publish") })).toMatchObject({ auto: true, reason: "autopilot", effects: [expect.objectContaining({ effect: "publish" })] });
    expect(autoApproval({ autopilot: true, tainted: true, autoApprovable: true, writes: w("new", "outbound") })).toMatchObject({ auto: false, reason: "write_effect", blocking: [expect.objectContaining({ effect: "outbound" })] });
  });
  it("autopilot approves a goal stage whatever its write effects; without autopilot the goal rule applies", () => {
    const writes = [{ kind: "deck", label: "覆蓋簡報", effect: "overwrite" as const }, { kind: "paper", label: "匯入論文" }];
    expect(autoApproval({ autopilot: true, tainted: true, autoApprovable: true, goal: true, writes })).toMatchObject({ auto: true, reason: "autopilot" });
    expect(autoApproval({ autopilot: false, tainted: true, autoApprovable: true, goal: true, writes })).toMatchObject({ auto: false, reason: "write_effect" });
  });
  it("picks the AI's own options for student pages", () => {
    const opts = [{ value: "o1", label: "A" }, { value: "o2", label: "B" }, { value: "o3", label: "C" }, { value: "o4", label: "D" }, { value: "__skip", label: "先跳過" }];
    expect(autopilotAnswers([
      { id: "p1", prompt: "「My assessment」：主要評價？", type: "multi_choice", options: opts },
      { id: "p2", prompt: "「Takeaways」：你想帶走的 takeaways？", type: "multi_choice", options: opts },
      { id: "p3", prompt: "x", type: "single_choice", options: opts },
      { id: "p4", prompt: "y", type: "long_text" },
    ])).toEqual([{ id: "p1", value: ["o1", "o2"] }, { id: "p2", value: ["o1", "o2", "o3"] }, { id: "p3", value: "o1" }, { id: "p4", value: null, skipped: true }]);
  });
  it("detects per-paper requests and record URLs", () => {
    expect(EACH_PAPER_RE.test("把這個研究的每一篇文獻都做成獨立的簡報")).toBe(true);
    expect(EACH_PAPER_RE.test("我想要你幫我把每一個文獻都做成簡報")).toBe(true);
    expect(EACH_PAPER_RE.test("make one deck per paper")).toBe(true);
    expect(EACH_PAPER_RE.test("把這篇論文做成簡報")).toBe(false);
    // Production: one integrated deck where each METHOD lists its paper title is not a per-paper batch.
    expect(EACH_PAPER_RE.test("幫我做一份英文簡報，每個方法要寫出 paper title 和年份")).toBe(false);
    expect(EACH_PAPER_RE.test("For each method, include the paper title and publication year")).toBe(false);
    expect(EACH_PAPER_RE.test("所有文獻各做一份簡報")).toBe(true);
    expect([...textTokens("Lightweight ASR study")]).toEqual(["lightweight", "asr"]);
    expect(recordUrls({ oa_url: null, record: { URL: "https://arxiv.org/abs/2401.00001", link: [{ URL: "https://x.org/a.pdf" }, { URL: "ftp://no" }] } as never })).toEqual(["https://arxiv.org/abs/2401.00001", "https://x.org/a.pdf"]);
  });
});

type Req = { messages: { role: string; content: unknown }[] };
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10 }, message: { role: "assistant", content: text } });
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
function mockModel() {
  const defaults = new Map<string, (req: Req) => string>();
  const prompts: { purpose: string; text: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      prompts.push({ purpose: ctx.purpose, text: userText(req as Req) });
      const f = defaults.get(ctx.purpose) ?? defaults.get("*") ?? (() => "{}");
      return result(f(req as Req));
    },
    available: async () => true,
    vision: async () => false,
  };
  return { port, prompts, set: (p: string, r: string | ((req: Req) => string)) => defaults.set(p, typeof r === "string" ? () => r : r), count: (p: string) => prompts.filter((x) => x.purpose === p).length };
}
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "完整內容", reason: "ok" })) });

// Approval playbook: the plan reads others' content (taints the run) and declares the writes given in the request.
registerWorkflowPlaybook({
  id: "test_autopilot",
  title: "自動駕駛測試", titleEn: "Autopilot test", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan(env) {
    if (/tainted/.test(env.run.request)) await markTainted(env.db, env.run.id, "論文〈測試〉");
    const effect = (/effect=(\w+)/.exec(env.run.request)?.[1] ?? "new") as WriteEffect;
    return {
      kind: "plan", title: "自動駕駛", objective: "寫一段", plan: { summary: "x", outline: [{ n: 1, title: "A", points: [] }], writes: [{ kind: "deck", label: "簡報", effect }] },
      criteria: [{ id: "complete", kind: "check", text: "完整", check: { id: "not_truncated" } }],
      steps: [
        { key: "a", role: "writer", title: "A", instructions: "寫 A" },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["a"] },
      ],
    };
  },
  async execute(env, step) {
    const r = await env.call({ purpose: "w:a", role: "writer", messages: [{ role: "user", content: "寫 A" }] }, step.id);
    return { summary: "A", text: r.text };
  },
  async finalText(env) {
    return { text: (await getSteps(env.db, env.run.id)).find((s) => s.key === "a")?.output?.text ?? "", data: null };
  },
});


// Blocker playbook: step a's writer answers BLOCKED (scripted per test).
registerWorkflowPlaybook({
  id: "test_blocker",
  title: "缺資料測試", titleEn: "Blocker test", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan(env) {
    await env.setState({ brief: "論文來源資料：方法用 CTC，WER 5.1（表 2）。" });
    return {
      kind: "plan", title: "缺資料", objective: "寫一段", plan: { summary: "x", writes: [{ kind: "note", label: "新筆記", effect: "new" }] },
      criteria: [{ id: "complete", kind: "check", text: "完整", check: { id: "not_truncated" } }],
      steps: [
        { key: "a", role: "writer", title: "A", instructions: "寫 A", verify: { checks: [], judge: true } },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["a"] },
      ],
    };
  },
  async execute(env, step, fix) {
    const r = await env.call({ purpose: "w:blk", role: "writer", messages: [{ role: "user", content: [env.guidanceText(), fix ? fix.issues.join("\n") : "寫 A"].join("\n") }] }, step.id);
    return { summary: "A", text: r.text };
  },
  async finalText(env) {
    return { text: (await getSteps(env.db, env.run.id)).find((s) => s.key === "a")?.output?.text ?? "", data: null };
  },
});

const DRAFT = "## Main results\n\n- WER 5.1（表 2）\n\n::: {.notes}\n結果頁講稿內容。\n:::\n\n## My assessment\n\n〔　〕\n\n::: {.notes}\n（由報告者補充）\n:::\n\n## Takeaways for my work\n\n〔　〕\n\n::: {.notes}\n（由報告者補充）\n:::\n";
registerWorkflowPlaybook({
  id: "test_ap_student",
  title: "學生頁自動駕駛", titleEn: "Student pages autopilot", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan() {
    return {
      kind: "plan", title: "學生頁", objective: "簡報", plan: { summary: "x", writes: [{ kind: "deck", label: "新簡報", effect: "new" }], outline: [{ n: 1, title: "Main results", points: [] }, { n: 2, title: "My assessment", points: [], student_owned: true } as never, { n: 3, title: "Takeaways for my work", points: [], student_owned: true } as never] },
      criteria: [{ id: "clean", kind: "check", text: "沒有佔位文字", check: { id: "no_placeholder", params: { allow_titles: ["My assessment", "Takeaways for my work"] } } }],
      steps: [
        { key: "write_1", role: "writer", title: "寫", instructions: "" },
        { key: STUDENT_INPUT_KEY, role: "planner", title: "問你", instructions: "", depends_on: ["write_1"] },
        { key: "assemble", role: "integrator", kind: "integrate", title: "整合", instructions: "", depends_on: ["write_1", STUDENT_INPUT_KEY] },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["assemble"] },
      ],
    };
  },
  async execute(env, step) {
    if (step.key === "write_1") return { summary: "寫", text: DRAFT };
    if (step.key === STUDENT_INPUT_KEY) return runStudentInput(env, step, { owned: (env.run.plan!.outline as { title: string; student_owned?: boolean }[]).filter((p) => p.student_owned) as never, drafted: DRAFT, brief: "CTC 對齊" });
    const body = applyStudentPages(DRAFT, await studentPagesOf(env));
    await env.setState({ body });
    return { summary: "整合", text: body };
  },
  async finalText(env) {
    return { text: env.state<string>("body") ?? "", data: null };
  },
});

const OPTIONS = JSON.stringify({ questions: [
  { id: "p1", options: [{ label: "方法簡潔", description: "我認為 CTC 對齊很簡潔。" }, { label: "實驗只有英文", description: "只在 LibriSpeech 上驗證。" }, { label: "消融完整", description: "消融做得完整。" }] },
  { id: "p2", options: [{ label: "試在台語", description: "套到台語資料。" }, { label: "改用小模型", description: "先用小模型驗證。" }] },
] });

run("workflow autopilot", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null, previewWaitMs: 5_000 });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const logs = async (id: string) => (await t.db.query("SELECT data FROM workflow_events WHERE run_id=$1 AND type='log' ORDER BY seq", [id])).rows.map((e) => e.data.text as string);
  const addPaper = async (studyId: string, title: string, opts: { pdf?: boolean; url?: string } = {}) => {
    const id = (await t.db.query<{ id: string }>(
      "INSERT INTO papers(record,type,title,title_norm,abstract,pdf_key,oa_url,added_by) VALUES($1,'article-journal',$2,lower($2),'我們提出一個輕量化的串流語音辨識方法。',$3,$4,$5) RETURNING id",
      [JSON.stringify({ title }), title, opts.pdf ? `papers/${randomBytes(4).toString("hex")}.pdf` : null, opts.url ?? null, alice.id],
    )).rows[0]!.id;
    await t.db.query("INSERT INTO study_papers(study_id,paper_id,cite_key,added_by) VALUES($1,$2,$3,$4)", [studyId, id, `k${randomBytes(3).toString("hex")}`, alice.id]);
    return id;
  };

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-ap");
    study = await insertStudy(t.db, alice.id, "低算力條件下的輕量化串流語音辨識（Lightweight Streaming ASR）");
    await t.db.query("UPDATE studies SET summary_md=$2 WHERE id=$1", [study.id, "用 CTC 做輕量化串流語音辨識。"]);
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => {
    setPaperPdfDeps(null);
    await t?.close();
  });
  beforeEach(async () => {
    if (t) await t.db.query("UPDATE workflow_runs SET status='done' WHERE user_id=$1 AND status NOT IN ('done','partial','failed','cancelled')", [alice.id]);
    m = mockModel();
    m.set("verify", '{"verdict":"pass","issues":[]}');
    m.set("verify_final", allPass);
    m.set("w:a", "A 段落的完整內容。");
    m.set("ask_options", OPTIONS);
  });
  const newRun = async (request: string, playbook: string, autopilot: boolean) => (await createWorkflow(t.app, await asUser(alice.id), { request, playbook, autopilot, context: { studyId: study.id } })).id;
  const clearRuns = () => t.db.query("UPDATE workflow_runs SET status='done' WHERE user_id=$1 AND status NOT IN ('done','partial','failed','cancelled')", [alice.id]);

  it("auto-approves tainted plans under autopilot, also with overwrite / publish; outbound after taint / no autopilot ask", async () => {
    const id = await newRun("tainted effect=new", "test_autopilot", true);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const r = (await getRun(t.db, id))!;
    expect(r.tainted).toBe(true);
    expect(r.state.auto_approved).toMatchObject({ tainted: true });
    expect((await logs(id)).some((x) => x.startsWith(AUTO_APPROVED_NOTE))).toBe(true);
    const view = (await get(alice, `/api/workflows/${id}`)).json();
    expect(view.workflow.auto_approved).toMatchObject({ tainted: true });
    expect(view.workflow.plan.outline).toHaveLength(1); // the plan stays visible

    for (const req of ["tainted effect=overwrite", "effect=publish"]) {
      const id2 = await newRun(req, "test_autopilot", true);
      expect((await runWorkflow(deps(), id2)).status).toBe("done");
      expect((await logs(id2)).some((x) => x.startsWith(`${AUTO_APPROVED_NOTE}（完全自動）`) && x.includes("版本"))).toBe(true);
    }
    const out = await newRun("tainted effect=outbound", "test_autopilot", true);
    expect((await runWorkflow(deps(), out)).status).toBe("awaiting_plan_approval");
    expect((await logs(out)).some((x) => x.includes("需要你確認"))).toBe(true);
    const id3 = await newRun("tainted effect=new", "test_autopilot", false);
    expect((await runWorkflow(deps(), id3)).status).toBe("awaiting_plan_approval");
    await clearRuns();
  });

  it("「修改計畫」 on an auto-approved run re-plans and then waits for the user", async () => {
    const id = await newRun("tainted effect=new", "test_autopilot", true);
    const me = await asUser(alice.id);
    // Stop it right after planning (auto-approved → running), then pause and revise.
    await t.db.query("UPDATE workflow_runs SET pause_requested=true WHERE id=$1", [id]);
    expect((await runWorkflow(deps(), id)).status).toBe("paused");
    expect((await getRun(t.db, id))!.state.auto_approved).toBeTruthy();
    await revisePlan(t.app, me, id, "改成兩段");
    const r = (await getRun(t.db, id))!;
    expect(r.status).toBe("planning");
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    expect((await getRun(t.db, id))!.guidance.at(-1)!.text).toBe("改成兩段");
    await clearRuns();
  });

  it("a BLOCKED writer asks at most once, then best-effort fix rounds; repeated BLOCKED fails instead of looping", async () => {
    m.set("w:blk", "BLOCKED: 論文沒有具體的例子");
    m.set("ask_options", JSON.stringify({ questions: [{ id: "how", options: [{ label: "用現有資料", description: "用表 2 的數字。" }, { label: "省略例子", description: "不放例子。" }] }] }));
    const id = await newRun("缺資料", "test_blocker", false);
    await runWorkflow(deps(), id);
    await post(alice, `/api/workflows/${id}/approve`);
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const card = pendingAsk((await getRun(t.db, id))!.state)!;
    expect(card.id).toMatch(/^blocked_a_/);
    await post(alice, `/api/workflows/${id}/answer`, { card_id: card.id, answers: [{ id: "how", value: "o1" }] });
    const before = m.count("w:blk");
    expect((await runWorkflow(deps(), id)).status).toBe("partial");
    const r = (await getRun(t.db, id))!;
    expect(Object.keys(r.state.asks as object).filter((k) => k.startsWith("blocked_"))).toHaveLength(1); // asked once
    expect(m.count("w:blk") - before).toBeLessThanOrEqual(3); // no loop
    const a = (await getSteps(t.db, id)).find((s) => s.key === "a")!;
    expect(a.status).toBe("failed");
    expect(a.error).toContain("缺少資料");
    expect(m.prompts.filter((p) => p.purpose === "w:blk").at(-1)!.text).toContain("資料未提供");
    expect(r.usage.calls).toBeLessThan(10);
  });

  it("under autopilot a BLOCKED writer never asks: it is told to finish best-effort", async () => {
    let n = 0;
    m.set("w:blk", () => (n++ === 0 ? "BLOCKED: 論文沒有具體的例子" : "A 段落：方法用 CTC，WER 5.1（表 2）；具體例子：資料未提供。"));
    const id = await newRun("缺資料", "test_blocker", true);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const r = (await getRun(t.db, id))!;
    expect(Object.keys((r.state.asks as object) ?? {})).toHaveLength(0);
    expect(m.count("w:blk")).toBe(2);
    expect((await logs(id)).some((x) => x.includes("改用現有資料盡力完成"))).toBe(true);
    // The step verifier sees the sources and the rule not to demand details they lack.
    const v = m.prompts.find((p) => p.purpose === "verify")!.text;
    expect(v).toContain("WER 5.1");
  });

  it("caps the attempts of a step", async () => {
    const id = await newRun("缺資料", "test_blocker", true);
    m.set("w:blk", "A 段落的完整內容。");
    await t.db.query("UPDATE workflow_runs SET pause_requested=true WHERE id=$1", [id]);
    expect((await runWorkflow(deps(), id)).status).toBe("paused");
    await t.db.query("UPDATE workflow_steps SET attempts=6 WHERE run_id=$1 AND key='a'", [id]);
    // The autopilot's one automatic 繼續改 round already used: the cap alone decides.
    await t.db.query("UPDATE workflow_runs SET status='running', pause_requested=false, state = state || '{\"auto_continued\":true}'::jsonb WHERE id=$1", [id]);
    expect((await runWorkflow(deps(), id)).status).toBe("partial");
    expect((await getSteps(t.db, id)).find((s) => s.key === "a")!.error).toContain("停止重試");
    expect(m.count("w:blk")).toBe(0);
  });

  it("fills student-owned pages under autopilot (marked, notified, in the report) and keeps them editable", async () => {
    const id = await newRun("學生頁", "test_ap_student", true);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const r = (await getRun(t.db, id))!;
    const body = r.state.body as string;
    expect(body).toContain(AI_FILLED_MARK);
    expect(body).toMatch(/## My assessment\n\n\[AI 代填，待你確認\]\{\.hub-ai-filled[^}]*\}\n\n- 方法簡潔：我認為 CTC 對齊很簡潔。\n- 實驗只有英文/);
    expect(body).toMatch(/::: \{\.notes\}\n（AI 代填，待你確認：/);
    expect(pendingAsk(r.state)).toBeNull();
    expect((r.state.asks as Record<string, { ai_filled?: boolean }>)[STUDENT_CARD_ID]!.ai_filled).toBe(true);
    expect(r.report!.confirm).toEqual([expect.stringContaining("My assessment"), expect.stringContaining("Takeaways for my work")]);
    expect(r.report!.summary_md).toContain("待你確認");
    const n = (await t.db.query("SELECT title FROM notifications WHERE user_id=$1 AND kind='workflow' AND title LIKE 'AI 代填%'", [alice.id])).rowCount;
    expect(n).toBe(1);
    // The student edits the answers afterwards: the step re-runs, the marker disappears.
    const edit = await post(alice, `/api/workflows/${id}/answer`, { card_id: STUDENT_CARD_ID, answers: [{ id: "p1", value: [], other: "我覺得實驗不夠" }, { id: "p2", value: ["o2"] }] });
    expect(edit.statusCode).toBe(200);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const r2 = (await getRun(t.db, id))!;
    expect(r2.state.body as string).not.toContain(AI_FILLED_MARK);
    expect(r2.state.body as string).toContain("- 我覺得實驗不夠");
    expect(r2.report!.confirm).toBeUndefined();
    // Outside autopilot it still asks.
    const id2 = await newRun("學生頁", "test_ap_student", false);
    await runWorkflow(deps(), id2);
    await post(alice, `/api/workflows/${id2}/approve`);
    expect((await runWorkflow(deps(), id2)).status).toBe("awaiting_input");
    await clearRuns();
  });

  it("inherits the study from the conversation or from the study named in the request", async () => {
    const me = await asUser(alice.id);
    const conv = (await t.db.query<{ id: string }>("INSERT INTO conversations(user_id,mode,context) VALUES($1,'chat','{}') RETURNING id", [alice.id])).rows[0]!.id;
    await t.db.query("INSERT INTO agent_messages(conversation_id,role,content,text,page_context) VALUES($1,'user','[]','看這個研究',$2)", [conv, JSON.stringify({ studyId: study.id, path: `/studies/${study.slug}` })]);
    const a = await createWorkflow(t.app, me, { request: "幫我整理一份會議準備", playbook: "test_autopilot", conversationId: conv });
    expect(a.study_id).toBe(study.id);
    // Another study exists, so the single-study fallback does not apply: the name in the request decides.
    await insertStudy(t.db, alice.id, "台語語音合成");
    const b = await createWorkflow(t.app, me, { request: "我們的Lightweight ASR study裡面的文獻做成簡報", playbook: "test_autopilot" });
    expect(b.study_id).toBe(study.id);
    const c = await createWorkflow(t.app, me, { request: "隨便做一份", playbook: "test_autopilot" });
    expect(c.study_id).toBeNull();
    await clearRuns();
  });

  it("splits 「每一篇文獻」 into a batch, queues over the limit and starts queued runs when a slot frees", async () => {
    const s2 = await insertStudy(t.db, alice.id, `批次 ${randomBytes(2).toString("hex")}`);
    const papers = [];
    for (let i = 0; i < 5; i++) papers.push(await addPaper(s2.id, `Paper ${i + 1}`, { pdf: true }));
    expect(await batchPapers(t.db, { playbook: "slides", request: "把這個研究的每一篇文獻都做成獨立的簡報", studyId: s2.id })).toHaveLength(5);
    expect(await batchPapers(t.db, { playbook: "lit_review", request: "每一篇文獻", studyId: s2.id })).toBeNull();
    // Several paper ids from the assistant without the user asking for one per paper → sources of ONE deck.
    expect(await batchPapers(t.db, { playbook: "slides", request: "Create one English deck from the library", studyId: s2.id, paperIds: papers.slice(0, 3), userText: "幫我做一份英文簡報，根據研究文獻庫整理" })).toBeNull();
    expect(await batchPapers(t.db, { playbook: "slides", request: "x", studyId: s2.id, paperIds: papers.slice(0, 3), userText: "這三篇各做一份簡報" })).toHaveLength(3);
    expect(await batchPapers(t.db, { playbook: "slides", request: "x", studyId: s2.id, paperIds: papers.slice(0, 3), userText: "每一篇文獻都做成簡報" })).toHaveLength(3);
    const res = await post(alice, "/api/workflows", { request: "把這個研究的每一篇文獻都做成獨立的簡報", context: { studyId: s2.id }, autopilot: true });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.workflows).toHaveLength(5);
    expect(body.workflows.map((w: { playbook: string }) => w.playbook)).toEqual(Array(5).fill("slides"));
    expect(body.workflows.map((w: { paper_id: string }) => w.paper_id)).toEqual(papers);
    expect(body.workflows.map((w: { status: string }) => w.status)).toEqual([...Array(MAX_ACTIVE_PER_USER).fill("planning"), "queued", "queued"]);
    const runs = (await t.db.query("SELECT r.id, r.status, r.request, j.run_after = 'infinity' AS parked, j.stage FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE batch_id=$1 ORDER BY batch_index", [body.batch_id])).rows;
    expect(runs.map((r) => r.parked)).toEqual([false, false, false, true, true]);
    expect(runs[0].request).toContain("批次 1/5");
    // Listing by batch, and the shell indicator / jobs tray show the queued runs.
    const list = (await get(alice, `/api/workflows?batch=${body.batch_id}`)).json();
    expect(list.workflows.map((w: { id: string }) => w.id)).toEqual(runs.map((r) => r.id));
    const active = (await get(alice, "/api/workflows/active")).json();
    expect(active.runs.filter((r: { status: string }) => r.status === "queued")).toHaveLength(2);
    const tray = (await get(alice, "/api/jobs/active")).json();
    expect(tray.jobs.filter((j: { status: string; stage: string }) => j.status === "queued" && j.stage === "排隊中").length).toBeGreaterThanOrEqual(2);
    // A slot frees (one run waits for the user): the oldest queued run starts.
    await t.db.query("UPDATE workflow_runs SET status='awaiting_plan_approval' WHERE id=$1", [runs[0].id]);
    expect(await promoteQueued(t.db, alice.id)).toEqual([runs[3].id]);
    const promoted = (await t.db.query("SELECT r.status, j.run_after <= now() AS ready FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=$1", [runs[3].id])).rows[0];
    expect(promoted).toEqual({ status: "planning", ready: true });
    expect(await promoteQueued(t.db, alice.id)).toEqual([]);
    // Cancelling a working run frees a slot too.
    await post(alice, `/api/workflows/${runs[1].id}/cancel`);
    expect((await getRun(t.db, runs[4].id))!.status).toBe("planning");
    await clearRuns();
  });

  it("「放在哪個研究」 lists the studies; 「你決定」 picks the latest one and splits 「每一個文獻」 into a batch", async () => {
    const title = `委派 ${randomBytes(2).toString("hex")}`;
    const s4 = await insertStudy(t.db, alice.id, title);
    await t.db.query("UPDATE studies SET activity_at=now() + interval '1 hour' WHERE id=$1", [s4.id]);
    await addPaper(s4.id, "Delegated A", { pdf: true });
    await addPaper(s4.id, "Delegated B", { pdf: true });
    const request = "幫我把每一個文獻都做成簡報，要在週會報告";
    const id = (await createWorkflow(t.app, await asUser(alice.id), { request, playbook: "slides" })).id;
    expect((await getRun(t.db, id))!.study_id).toBeNull();
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const q = (await getRun(t.db, id))!.question!;
    expect(q).toContain(`〈${title}〉`);
    expect(q).toContain("你決定");
    await addGuidance(t.app, await asUser(alice.id), id, "你決定");
    expect((await runWorkflow(deps(), id)).status).toBe("cancelled");
    const r = (await getRun(t.db, id))!;
    expect(r.study_id).toBe(s4.id);
    expect(r.report!.summary_md).toContain("已拆成 2 個工作流程");
    const batch = (await t.db.query("SELECT study_id, inputs->>'mode' AS mode FROM workflow_runs WHERE user_id=$1 AND batch_id IS NOT NULL AND created_at > $2 ORDER BY batch_index", [alice.id, r.created_at])).rows;
    expect(batch).toEqual([{ study_id: s4.id, mode: "paper_report" }, { study_id: s4.id, mode: "paper_report" }]);
    await t.db.query("UPDATE studies SET activity_at=now() - interval '1 day' WHERE id=$1", [s4.id]);
    await clearRuns();
  });

  it("missing PDF: tries open access and the record URL; autopilot → needs_pdf; otherwise asks with options", async () => {
    const s3 = await insertStudy(t.db, alice.id, `PDF ${randomBytes(2).toString("hex")}`);
    const tried: string[] = [];
    setPaperPdfDeps({
      autoFetch: async (_env, p) => (tried.push(`oa:${p.id}`), { status: "not_found" }),
      fromUrl: async (_env, p, url) => {
        tried.push(url);
        if (url.includes("good")) await t.db.query("UPDATE papers SET pdf_key='papers/fake.pdf' WHERE id=$1", [p.id]);
        else throw new Error("不是 PDF");
      },
    });
    const p1 = await addPaper(s3.id, "No PDF paper", { url: "https://example.org/bad-landing" });
    const ap = await createWorkflow(t.app, await asUser(alice.id), { request: "把這篇論文做成簡報", playbook: "slides", autopilot: true, context: { studyId: s3.id, paperId: p1 } });
    expect((await runWorkflow(deps(), ap.id)).status).toBe("needs_pdf");
    expect(tried).toEqual([`oa:${p1}`, "https://example.org/bad-landing"]);
    const r = (await getRun(t.db, ap.id))!;
    expect(r.question).toContain("從網址下載 PDF");
    expect((await get(alice, "/api/workflows/active")).json().runs.find((x: { id: string }) => x.id === ap.id)).toMatchObject({ status: "needs_pdf", needs_you: true });
    expect((await t.db.query("SELECT 1 FROM notifications WHERE user_id=$1 AND title='需要 PDF'", [alice.id])).rowCount).toBeGreaterThan(0);

    // Outside autopilot: a card with 提供網址 / 上傳 PDF / 只用摘要 / 跳過; a URL answer downloads and continues.
    const p2 = await addPaper(s3.id, "Ask PDF paper");
    const id = (await createWorkflow(t.app, await asUser(alice.id), { request: "把這篇論文做成簡報", playbook: "slides", context: { studyId: s3.id, paperId: p2 } })).id;
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const card = pendingAsk((await getRun(t.db, id))!.state)!;
    expect(card.questions[0]!.options!.map((o) => o.label)).toEqual(["提供網址", "上傳 PDF", "只用摘要", "跳過這篇"]);
    // Skip → the run ends skipped.
    const id2 = (await createWorkflow(t.app, await asUser(alice.id), { request: "把這篇論文做成簡報", playbook: "slides", context: { studyId: s3.id, paperId: p2 } })).id;
    await runWorkflow(deps(), id2);
    const card2 = pendingAsk((await getRun(t.db, id2))!.state)!;
    await post(alice, `/api/workflows/${id2}/answer`, { card_id: card2.id, answers: [{ id: "how", value: "skip" }] });
    expect((await runWorkflow(deps(), id2)).status).toBe("cancelled");
    expect((await getRun(t.db, id2))!.stop_reason).toBe("skipped");
    // URL → downloaded → planning continues (research + outline with the mock model) → plan approval.
    m.set("research_paper", `## 問題與動機\n${"內容".repeat(300)}（§1，p. 1）（§2，p. 2）（表 1）（表 2）（§3）`);
    m.set("outline", JSON.stringify({ pages: Array.from({ length: 11 }, (_, i) => ({ title: `第 ${i + 1} 頁`, points: ["重點"] })) }));
    await post(alice, `/api/workflows/${id}/answer`, { card_id: card.id, answers: [{ id: "how", value: "url" }, { id: "url", value: "https://example.org/good.pdf" }] });
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    expect(tried.at(-1)).toBe("https://example.org/good.pdf");
    // Abstract-only: clearly marked plan.
    const p3 = await addPaper(s3.id, "Abstract paper");
    const id3 = (await createWorkflow(t.app, await asUser(alice.id), { request: "把這篇論文做成簡報", playbook: "slides", context: { studyId: s3.id, paperId: p3 } })).id;
    await runWorkflow(deps(), id3);
    await post(alice, `/api/workflows/${id3}/answer`, { card_id: pendingAsk((await getRun(t.db, id3))!.state)!.id, answers: [{ id: "how", value: "abstract" }] });
    expect((await runWorkflow(deps(), id3)).status).toBe("awaiting_plan_approval");
    const r3 = (await getRun(t.db, id3))!;
    expect(r3.title).toContain("僅依摘要");
    expect(r3.plan!.notes).toContain("只用摘要");
    expect(r3.plan!.writes[0]!.effect).toBe("new");
    await clearRuns();
  });
});
