/**
 * Workflow → user questions (questions.ts, student-input.ts): a step pauses the run with a card (awaiting_input) and
 * resumes after the answer; answer validation; 「修改答案」 re-runs the asking step and its dependents; a sub-agent's
 * BLOCKED becomes a question with grounded options; option drafting reads the study's knowledge; student-owned slide
 * pages are filled from the answers (skipped → an allowed placeholder).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { approveWorkflow, createWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { askUser, pendingAsk, SKIP_VALUE } from "../src/workflows/questions.js";
import { applyStudentPages, runStudentInput, SKIPPED_PLACEHOLDER, STUDENT_CARD_ID, STUDENT_INPUT_KEY, studentPagesOf } from "../src/workflows/student-input.js";
import { runChecks } from "../src/workflows/checks.js";
import type { ModelPort } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10 }, message: { role: "assistant", content: text } });
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function mockModel() {
  const queues = new Map<string, ((req: Req) => string)[]>();
  const defaults = new Map<string, (req: Req) => string>();
  const prompts: { purpose: string; text: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      prompts.push({ purpose: ctx.purpose, text: userText(req as Req) });
      const q = queues.get(ctx.purpose);
      const f = q?.length ? q.shift()! : defaults.get(ctx.purpose) ?? defaults.get("*") ?? (() => "{}");
      return result(f(req as Req));
    },
    available: async () => true,
    vision: async () => false,
  };
  return {
    port, prompts,
    set: (p: string, r: string | ((req: Req) => string)) => defaults.set(p, typeof r === "string" ? () => r : r),
    queue: (p: string, ...r: string[]) => queues.set(p, [...(queues.get(p) ?? []), ...r.map((x) => () => x)]),
    count: (p: string) => prompts.filter((x) => x.purpose === p).length,
  };
}
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "完整內容", reason: "ok" })) });
const OPTIONS = JSON.stringify({ questions: [
  { id: "p1", options: [{ label: "方法簡潔但實驗只有英文", description: "我認為 CTC 對齊的設計很簡潔，但只在 LibriSpeech 上驗證。" }, { label: "結果可信", description: "消融做得完整。" }] },
  { id: "p2", options: [{ label: "試在中文語料", description: "把這個方法套到我們的台語資料。" }, { label: "改用小模型", description: "先用小模型驗證。" }, { label: "看推論速度", description: "量測 RTF。" }] },
] });

// Ask playbook: a → ask (asks the user) → c (uses the answer) → final.
registerWorkflowPlaybook({
  id: "test_ask",
  title: "提問測試", titleEn: "Ask test", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan() {
    return {
      kind: "plan", title: "提問", objective: "寫一段含學生看法", plan: { summary: "x", writes: [] },
      criteria: [{ id: "complete", kind: "check", text: "完整", check: { id: "not_truncated" } }],
      steps: [
        { key: "a", role: "writer", title: "A", instructions: "寫 A" },
        { key: "ask", role: "planner", title: "問你", instructions: "", depends_on: ["a"] },
        { key: "c", role: "integrator", title: "C", instructions: "", depends_on: ["ask"] },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["c"] },
      ],
    };
  },
  async execute(env, step) {
    if (step.key === "a") {
      const r = await env.call({ purpose: "w:a", role: "writer", messages: [{ role: "user", content: env.guidanceText() || "寫 A" }] }, step.id);
      return { summary: "A", text: r.text };
    }
    if (step.key === "ask") {
      const answers = await askUser(env, {
        id: "view", title: "你的看法", step_key: "ask", purpose: "input", ai_suggested: true,
        questions: [
          { id: "q1", prompt: "主要評價？", type: "single_choice", options: [{ value: "good", label: "好" }, { value: "bad", label: "不好" }, { value: SKIP_VALUE, label: "先跳過" }], allow_other: true, required: true },
          { id: "q2", prompt: "想法", type: "long_text", required: false },
        ],
      });
      return { summary: "answered", text: JSON.stringify(answers) };
    }
    if (step.key === "c") {
      const s = (await getSteps(env.db, env.run.id)).find((x) => x.key === "ask")!;
      return { summary: "C", text: `結果：${s.output!.text}` };
    }
    throw new Error("unknown");
  },
  async finalText(env) {
    return { text: (await getSteps(env.db, env.run.id)).find((s) => s.key === "c")?.output?.text ?? "", data: null };
  },
});

// Slides-hook playbook: drafted pages → student_input → assemble (applyStudentPages) → final.
const DRAFT = "## Main results\n\n- WER 5.1（表 2）\n\n::: {.notes}\n結果頁講稿內容。\n:::\n\n## My assessment\n\n〔　〕\n\n::: {.notes}\n（由報告者補充）\n:::\n\n## Takeaways for my work\n\n〔　〕\n\n::: {.notes}\n（由報告者補充）\n:::\n";
registerWorkflowPlaybook({
  id: "test_student",
  title: "學生頁測試", titleEn: "Student pages", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan() {
    return {
      kind: "plan", title: "學生頁", objective: "簡報", plan: { summary: "x", writes: [], outline: [{ n: 1, title: "Main results", points: [] }, { n: 2, title: "My assessment", points: [], student_owned: true } as never, { n: 3, title: "Takeaways for my work", points: [], student_owned: true } as never] },
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
    if (step.key === STUDENT_INPUT_KEY) return runStudentInput(env, step, { owned: (env.run.plan!.outline as { title: string; student_owned?: boolean }[]).filter((p) => p.student_owned) as never, drafted: DRAFT, brief: "論文研究摘要：CTC 對齊" });
    const body = applyStudentPages(DRAFT, await studentPagesOf(env));
    await env.setState({ body });
    return { summary: "整合", text: body };
  },
  async finalText(env) {
    return { text: env.state<string>("body") ?? "", data: null };
  },
});

run("workflow questions", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const post = (url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: alice.cookie }, payload });
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const newRun = async (playbook: string) => (await createWorkflow(t.app, await asUser(alice.id), { request: "測試任務", playbook, context: { studyId: study.id } })).id;
  const startAndApprove = async (playbook: string) => {
    const id = await newRun(playbook);
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    return id;
  };

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-q");
    study = await insertStudy(t.db, alice.id, "台語語音辨識");
    await t.db.query("UPDATE studies SET summary_md=$2 WHERE id=$1", [study.id, "用 CTC 做台語低資源語音辨識，目前卡在資料量不足。"]);
    await t.db.query("INSERT INTO notes(study_id,title,content_md,created_by,updated_by) VALUES($1,'組會回饋','老師說要比較推論速度 RTF。',$2,$2)", [study.id, alice.id]).catch(() => undefined);
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => t?.close());
  beforeEach(() => {
    m = mockModel();
    m.set("verify", '{"verdict":"pass","issues":[]}');
    m.set("verify_final", allPass);
    m.set("w:a", "A 段落的完整內容。");
    m.set("ask_options", OPTIONS);
  });

  it("pauses on a question, validates the answer, resumes from the asking step", async () => {
    const id = await startAndApprove("test_ask");
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const r = (await getRun(t.db, id))!;
    expect(pendingAsk(r.state)?.id).toBe("view");
    expect(r.question).toBe("你的看法");
    const view = (await t.app.inject({ method: "GET", url: `/api/workflows/${id}`, headers: { cookie: alice.cookie } })).json() as { workflow: { asks: { id: string; pending: boolean }[] } };
    expect(view.workflow.asks).toEqual([expect.objectContaining({ id: "view", pending: true })]);
    // Validation: a wrong option / missing required answer → 400 with a 繁中 message.
    const bad = await post(`/api/workflows/${id}/answer`, { card_id: "view", answers: [{ id: "q1", value: "nope" }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("選項不正確");
    expect((await post(`/api/workflows/${id}/answer`, { card_id: "view", answers: [{ id: "q2", value: "x" }] })).statusCode).toBe(400);
    expect((await post(`/api/workflows/${id}/answer`, { card_id: "nope", answers: [] })).statusCode).toBe(404);
    // Pick an option for one question, own text for another.
    const ok = await post(`/api/workflows/${id}/answer`, { card_id: "view", answers: [{ id: "q1", value: "good" }, { id: "q2", value: "我自己的想法" }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().workflow.status).toBe("running");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const c = (await getSteps(t.db, id)).find((s) => s.key === "c")!;
    expect(c.output!.text).toContain("我自己的想法");
    expect(m.count("w:a")).toBe(1); // step a was not re-run
    const events = (await t.db.query("SELECT data FROM workflow_events WHERE run_id=$1 AND type='log'", [id])).rows.map((e) => e.data.text as string);
    expect(events.some((x) => x.startsWith("收到你的回答"))).toBe(true);

    // 「修改答案」 after the run ended: the asking step and its dependents run again with the new answer.
    const edit = await post(`/api/workflows/${id}/answer`, { card_id: "view", answers: [{ id: "q1", value: null, other: "其實有缺點" }, { id: "q2", skipped: true }] });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().workflow.status).toBe("running");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const c2 = (await getSteps(t.db, id)).find((s) => s.key === "c")!;
    expect(c2.output!.text).toContain("其實有缺點");
    expect(m.count("w:a")).toBe(1);
    expect((await getRun(t.db, id))!.state.asks).toMatchObject({ view: { edited: 1 } });
  });

  it("turns a sub-agent's BLOCKED into a question with grounded options; the answer becomes guidance", async () => {
    m.queue("w:a", "BLOCKED: 找不到實驗數據");
    m.set("ask_options", JSON.stringify({ questions: [{ id: "how", options: [{ label: "用筆記裡的 CER", description: "用研究筆記中記錄的 CER 數字。" }, { label: "只寫方法", description: "先不放數字。" }] }] }));
    const id = await startAndApprove("test_ask");
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const r = (await getRun(t.db, id))!;
    const card = pendingAsk(r.state)!;
    expect(card.purpose).toBe("blocked");
    expect(r.question).toContain("找不到實驗數據");
    const q = card.questions[0]!;
    expect(q.allow_other).toBe(true);
    expect(q.options!.map((o) => o.label)).toEqual(["用筆記裡的 CER", "只寫方法", "先跳過，之後自己填"]);
    // The option drafter saw the study's knowledge.
    const prompt = m.prompts.find((p) => p.purpose === "ask_options")!.text;
    expect(prompt).toContain("台語低資源語音辨識");
    expect(prompt).toContain("測試任務");
    await post(`/api/workflows/${id}/answer`, { card_id: card.id, answers: [{ id: "how", value: "o1" }] });
    // The re-run of step a sees the answer as guidance.
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input"); // then the "ask" step asks its own card
    expect(m.prompts.filter((p) => p.purpose === "w:a").at(-1)!.text).toContain("用筆記裡的 CER");
  });

  it("slides hook: asks once for student pages with grounded options and fills them from the answers", async () => {
    const id = await startAndApprove("test_student");
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const card = pendingAsk((await getRun(t.db, id))!.state)!;
    expect(card.id).toBe(STUDENT_CARD_ID);
    expect(card.ai_suggested).toBe(true);
    expect(card.questions.map((q) => q.prompt)).toEqual([expect.stringContaining("主要評價"), expect.stringContaining("takeaways")]);
    const prompt = m.prompts.find((p) => p.purpose === "ask_options")!.text;
    expect(prompt).toContain("CTC 做台語"); // study summary
    expect(prompt).toContain("WER 5.1"); // the drafted content pages
    expect(prompt).toContain("推論速度"); // recent notes / feedback
    // p1: pick an option; p2: own text.
    await post(`/api/workflows/${id}/answer`, { card_id: card.id, answers: [{ id: "p1", value: ["o1"] }, { id: "p2", value: [], other: "我要把 CTC 對齊用在台語資料" }] });
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const body = (await getRun(t.db, id))!.state.body as string;
    expect(body).toMatch(/## My assessment\n\n- 方法簡潔但實驗只有英文：我認為 CTC 對齊的設計很簡潔/);
    expect(body).toMatch(/## Takeaways for my work\n\n- 我要把 CTC 對齊用在台語資料/);
    expect(body).toContain("WER 5.1");

    // Edit: skip the takeaways → the page keeps an allowed placeholder.
    await post(`/api/workflows/${id}/answer`, { card_id: card.id, answers: [{ id: "p1", value: ["o1", "o2"] }, { id: "p2", value: [SKIP_VALUE] }] });
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    const body2 = (await getRun(t.db, id))!.state.body as string;
    expect(body2).toContain("結果可信：消融做得完整。");
    expect(body2).toContain(SKIPPED_PLACEHOLDER);
    expect(runChecks([{ id: "no_placeholder", params: { allow_titles: ["My assessment", "Takeaways for my work"] } }], body2, null)[0]!.ok).toBe(true);
    expect(m.count("ask_options")).toBe(1); // options drafted once, kept on edit
  });
});

describe("applyStudentPages", () => {
  it("replaces owned pages by title and keeps attributes and order", () => {
    const out = applyStudentPages("## A\n\nx\n\n## My assessment {.smaller}\n\n〔　〕\n\n## B\n\ny\n", [{ title: "My assessment", lines: ["我的評價"], skipped: false, source: "own" }]);
    expect(out).toContain("## My assessment {.smaller}\n\n- 我的評價");
    expect(out.indexOf("## A")).toBeLessThan(out.indexOf("## My assessment"));
    expect(out.indexOf("## My assessment")).toBeLessThan(out.indexOf("## B"));
    expect(out).not.toContain("〔　〕");
  });
});
