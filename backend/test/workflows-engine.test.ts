/**
 * Workflow engine with a scripted mock model (real DB + S3): plan → approval → parallel dispatch → verification with
 * a revise verdict → fix round → pass → final verification → done; budget exhaustion → partial; resume after a crash;
 * cancellation; the slides playbook catching a truncated writer output and fixing it (11-page outline); API, SSE and
 * permissions.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { createWorkflow, approveWorkflow, cancelWorkflow, resumeWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import type { ModelPort, StepRow } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Reply = string | ((req: { messages: { role: string; content: unknown }[] }, purpose: string) => string);
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const userText = (req: { messages: { role: string; content: unknown }[] }) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

/** Scripted model: replies by `purpose`; a queue per purpose, then a default. */
function mockModel() {
  const queues = new Map<string, Reply[]>();
  const defaults = new Map<string, Reply>();
  const log: { purpose: string; role: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const port: ModelPort = {
    async chat(role, req, ctx) {
      log.push({ purpose: ctx.purpose, role });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      const q = queues.get(ctx.purpose);
      const reply = q?.length ? q.shift()! : defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as never, ctx.purpose) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return {
    port, log,
    get maxInFlight() { return maxInFlight; },
    queue(purpose: string, ...replies: Reply[]) { queues.set(purpose, [...(queues.get(purpose) ?? []), ...replies]); },
    set(purpose: string, reply: Reply) { defaults.set(purpose, reply); },
    count(purpose: string) { return log.filter((l) => l.purpose === purpose).length; },
  };
}

const PASS = '{"verdict":"pass","issues":[]}';
const allPass = (req: { messages: { role: string; content: unknown }[] }) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], pass: true, evidence: "段落的完整內容", reason: "ok" })) });

// A small playbook that exercises the engine generically: steps a ∥ b → c → final.
let crashOnce = false;
let crashHook: (() => void) | null = null;
registerWorkflowPlaybook({
  id: "test_pb",
  title: "測試流程", titleEn: "Test", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan() {
    const verify = { checks: [{ id: "min_length", params: { chars: 10 } }, { id: "no_placeholder" }], judge: true };
    return {
      kind: "plan", title: "測試", objective: "寫三段", plan: { summary: "三段", writes: [{ kind: "note", label: "沒有" }] },
      criteria: [{ id: "complete", kind: "check", text: "完整", check: { id: "not_truncated" } }, { id: "quality", kind: "judge", text: "內容正確" }],
      steps: [
        { key: "a", role: "writer", title: "A", instructions: "寫 A", verify },
        { key: "b", role: "writer", title: "B", instructions: "寫 B", verify },
        { key: "c", role: "integrator", title: "C", instructions: "合併", depends_on: ["a", "b"], verify: { checks: [{ id: "min_length", params: { chars: 10 } }], judge: false } },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["c"] },
      ],
    };
  },
  async execute(env, step, fix) {
    if (step.key === "c") {
      const steps = await getSteps(env.db, env.run.id);
      return { summary: "合併", text: steps.filter((s) => s.key !== "c" && s.output?.text).map((s) => s.output!.text).join("\n") };
    }
    if (crashOnce && step.key === "b") {
      crashOnce = false;
      crashHook?.();
      throw new Error("simulated worker crash");
    }
    const r = await env.call({ purpose: `w:${step.key}`, role: "writer", messages: [{ role: "user", content: fix ? `修正：${fix.issues.join("；")}` : step.instructions }] }, step.id);
    return { summary: r.text.slice(0, 40), text: r.text };
  },
  async finalText(env) {
    const steps = await getSteps(env.db, env.run.id);
    return { text: steps.find((s) => s.key === "c")?.output?.text ?? "", data: null };
  },
  async repair(_env, failing) {
    return [{ key: "a", issues: failing.map((c) => c.reason ?? c.text) }];
  },
});

run("workflow engine", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const user = async (id: string) => (await t.app.db.query("SELECT u.*, u.id FROM users u WHERE id=$1", [id])).rows[0];
  const deps = (signal = new AbortController().signal) => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal, jobId: null, previewWaitMs: 15_000 });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-wf");
    bob = await t.login("student", "bob-wf");
    study = await insertStudy(t.db, alice.id, "語音研究");
    setWorkflowAvailability(async () => true);
    void user;
  });
  afterAll(async () => t?.close());
  beforeEach(() => {
    m = mockModel();
    m.set("verify", PASS);
    m.set("verify_final", allPass);
  });

  async function newRun(playbook = "test_pb", extra: object = {}) {
    const r = await createWorkflow(t.app, await asUser(alice.id), { request: "測試任務", playbook, context: { studyId: study.id }, ...extra });
    return r.id;
  }

  it("plans, waits for approval, dispatches in parallel, fixes a revise verdict and ends done", async () => {
    m.queue("w:a", "TODO 之後再寫", "A 段落的完整內容，依據資料撰寫。");
    m.queue("w:b", "B 段落的完整內容，依據資料撰寫。", "B 段落的完整內容，補上實驗設定。");
    // The verifier asks for a revision of B once (medium issue), then passes.
    let revisedB = false;
    m.set("verify", (req) => {
      if (!revisedB && userText(req).includes("B 段落")) {
        revisedB = true;
        return '{"verdict":"revise","issues":[{"severity":"medium","text":"B 少了實驗設定"}]}';
      }
      return PASS;
    });
    const id = await newRun();
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const planned = await getSteps(t.db, id);
    expect(planned.map((s) => s.status)).toEqual(["pending", "pending", "pending", "pending"]);
    // Nothing runs before approval.
    expect(m.count("w:a")).toBe(0);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const out = await runWorkflow(deps(), id);
    expect(out.status).toBe("done");
    const steps = await getSteps(t.db, id);
    const a = steps.find((s) => s.key === "a")!;
    const b = steps.find((s) => s.key === "b")!;
    expect(b.history.length).toBe(2); // the verifier asked for one revision
    expect(a.status).toBe("passed");
    expect(a.history.length).toBe(2); // TODO placeholder → deterministic check failed → fixed
    expect(a.history[0]!.verdict.checks.find((c) => c.id === "no_placeholder")!.ok).toBe(false);
    expect(m.count("w:a")).toBe(2);
    expect(b.status).toBe("passed");
    expect(m.maxInFlight).toBeGreaterThanOrEqual(2); // a and b ran in parallel
    const r = (await getRun(t.db, id))!;
    expect(r.criteria.every((c) => c.status === "pass")).toBe(true);
    expect(r.report!.summary_md).toContain("已完成");
    expect(r.usage.fix_rounds).toBeGreaterThanOrEqual(2);
  });

  it("ends partial (never done) when a step keeps failing and when the budget runs out", async () => {
    m.set("w:a", "TODO");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const out = await runWorkflow(deps(), id);
    expect(out.status).toBe("partial");
    const r = (await getRun(t.db, id))!;
    expect(r.report!.summary_md).toContain("部分完成");
    expect((await getSteps(t.db, id)).find((s) => s.key === "a")!.status).toBe("failed");

    // Budget: two model calls only.
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    const id2 = await newRun();
    await runWorkflow(deps(), id2);
    await t.db.query("UPDATE workflow_runs SET budget = budget || '{\"max_calls\":2}'::jsonb WHERE id=$1", [id2]);
    await approveWorkflow(t.app, await asUser(alice.id), id2, {});
    expect((await runWorkflow(deps(), id2)).status).toBe("partial");
    const r2 = (await getRun(t.db, id2))!;
    expect(r2.stop_reason).toBe("budget_calls");
    expect((await getSteps(t.db, id2)).some((s) => s.status === "skipped")).toBe(true);
  });

  it("resumes after a crash from the persisted steps and supports 繼續改", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    crashOnce = true;
    await expect(runWorkflow(deps(), id)).rejects.toThrow("simulated worker crash");
    // The crashed attempt left b running; the next attempt resets it and finishes.
    expect((await getSteps(t.db, id)).find((s) => s.key === "b")!.status).toBe("running");
    const callsBefore = m.count("w:a");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    expect(m.count("w:a")).toBe(callsBefore); // a was not redone
    // 繼續改 on a finished run reopens the final verification with a fresh budget.
    await resumeWorkflow(t.app, await asUser(alice.id), id, { more: true, guidance: "語氣再正式一點" });
    expect((await getRun(t.db, id))!.status).toBe("running");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    expect((await getRun(t.db, id))!.guidance[0]!.text).toBe("語氣再正式一點");
  });

  it("a worker shutdown on the job's last attempt hands the run back instead of failing it", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    // The shutdown aborts the job's signal; the interrupted call surfaces as a plain error (aborted fetch).
    const ctrl = new AbortController();
    crashOnce = true;
    crashHook = () => ctrl.abort();
    try {
      await expect(runWorkflow(deps(ctrl.signal), id, { lastAttempt: true })).rejects.toThrow("interrupted");
    } finally {
      crashHook = null;
    }
    expect((await getRun(t.db, id))!.status).toBe("running");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
  });

  it("a model outage does not use up the step's attempts", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const { llmUnavailable } = await import("../src/ai/platform/errors.js");
    let outages = 8; // more outages than the attempt cap (fix rounds + 3)
    m.set("w:b", () => {
      if (outages-- > 0) throw llmUnavailable("assistant", "all_failed");
      return "B 段落的完整內容，依據資料撰寫。";
    });
    for (let i = 0; i < 8; i++) await expect(runWorkflow(deps(), id)).rejects.toThrow();
    const b = (await getSteps(t.db, id)).find((s) => s.key === "b")!;
    expect(b.status).toBe("pending");
    expect(b.attempts).toBe(0);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
  });

  it("final verification failure triggers a targeted repair round", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    m.queue("verify_final", '{"results":[{"id":"quality","pass":false,"reason":"A 段缺少數據"}]}');
    m.queue("w:a", "A 段落的完整內容，依據資料撰寫。", "A 段落的完整內容，補上數據 12.3。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    expect((await runWorkflow(deps(), id)).status).toBe("done");
    expect(m.count("w:a")).toBe(2); // repaired once
    expect(m.count("verify_final")).toBe(2);
    expect((await getRun(t.db, id))!.final_rounds).toBe(1);
  });

  it("a blocked sub-agent puts the run in awaiting_input instead of inventing content; guidance continues it", async () => {
    m.queue("w:a", "BLOCKED: 找不到實驗數據");
    m.set("w:a", "A 段落的完整內容，依據使用者補充的資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    expect((await getRun(t.db, id))!.question).toContain("找不到實驗數據");
    const { addGuidance } = await import("../src/workflows/service.js");
    await addGuidance(t.app, await asUser(alice.id), id, "數據是 CER 12.3 → 10.1");
    expect((await getRun(t.db, id))!.status).toBe("running");
    expect((await runWorkflow(deps(), id)).status).toBe("done");
  });

  it("a final criterion without quoted evidence or that cannot be judged does not pass", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    m.set("verify_final", '{"results":[{"id":"quality","pass":null,"reason":"無法判斷"}]}');
    const id = await newRun();
    await runWorkflow(deps(), id);
    await t.db.query("UPDATE workflow_runs SET final_rounds=2 WHERE id=$1", [id]);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    expect((await runWorkflow(deps(), id)).status).toBe("partial");
    expect((await getRun(t.db, id))!.criteria.find((c) => c.id === "quality")!.status).toBe("skipped");
  });

  it("a worker shutdown (aborted signal) is not a user cancel: the job is handed back and the run resumes", async () => {
    m.set("w:a", "A 段落的完整內容，依據資料撰寫。");
    m.set("w:b", "B 段落的完整內容，依據資料撰寫。");
    const id = await newRun();
    await runWorkflow(deps(), id);
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const ac = new AbortController();
    ac.abort();
    await expect(runWorkflow(deps(ac.signal), id)).rejects.toThrow("interrupted");
    expect((await getRun(t.db, id))!.status).toBe("running");
    expect((await getSteps(t.db, id)).every((s) => s.status === "pending")).toBe(true);
    expect((await runWorkflow(deps(), id)).status).toBe("done");
  });

  it("cancellation stops the run and cancels its steps", async () => {
    const id = await newRun();
    await runWorkflow(deps(), id);
    await cancelWorkflow(t.app, await asUser(alice.id), id);
    const steps = await getSteps(t.db, id);
    expect(steps.every((s: StepRow) => s.status === "cancelled")).toBe(true);
    expect((await runWorkflow(deps(), id)).status).toBe("cancelled");
    expect(m.count("w:a")).toBe(0);
  });

  it("slides playbook: an 11-page outline, a truncated writer output is detected and fixed, deck draft rendered", async () => {
    // Fake worker: completes preview renders.
    let stop = false;
    const worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { previewId: string; deckId: string; shots?: boolean } }>("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND status='queued'")).rows;
        for (const j of jobs) {
          // Outputs first, then the job status (the run reads the shots as soon as the job has succeeded).
          const pv = (await t.db.query<{ output_prefix: string }>("UPDATE deck_previews SET status='ready', entry_html='index.html', finished_at=now() WHERE id=$1 RETURNING output_prefix", [j.payload.previewId])).rows[0];
          if (!j.payload.shots || !pv) {
            await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          // Screenshot capture: one page per slide of the deck's entry, with clean layout metrics.
          const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [j.payload.deckId])).rows[0]?.content ?? "";
          const titles = ["", ...[...qmd.matchAll(/^## (.+)$/gm)].map((x) => x[1]!.trim())];
          const metrics = { words: 20, bullets: 2, minFont: 22, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 1, diagrams: 0, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, emptyBand: 0.1 };
          await t.storage.put(`${pv.output_prefix}_hub/shots.json`, Buffer.from(JSON.stringify({ version: 1, width: 1280, height: 800, total: titles.length, truncated: false, pages: titles.map((title, i) => ({ index: i + 1, h: i, title, metrics })) })), "application/json");
          await t.db.query("UPDATE jobs SET result=$2, status='succeeded', finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ shots: { count: titles.length } })]);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const titles = ["問題定義", "Idea 或架構", "對帳", "Table 1 現況", "本週關鍵結果", "資料集分析", "錯誤分析", "消融實驗", "卡住", "Idea card", "下週與要問"];
    m.set("outline", JSON.stringify({ pages: titles.map((t, i) => ({ title: t, points: ["依資料"], student_owned: i >= 8 })) }));
    const pagesOf = (req: { messages: { role: string; content: unknown }[] }) => {
      const u = userText(req);
      const block = /<data name="your_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(u)?.[1] ?? "";
      return [...block.matchAll(/^\d+\. (.+?)(?:（學生自填）)?$/gm)].map((x) => x[1]!);
    };
    const write = (list: string[]) => list.map((title) => `## ${title}\n\n- 依據研究資料的重點\n\n| 項目 | 狀態 |\n|---|---|\n| 資料 | 完成 |\n\n::: {.notes}\n這一頁說明${title}的內容與資料來源，報告時大約一分鐘，重點放在研究資料裡實際記錄的進展與數字。\n:::`).join("\n\n");
    let truncatedOnce = false;
    m.set("write_slides", (req) => {
      const list = pagesOf(req);
      // The first writer of pages 1–3 stops after one page (the production failure: 1 page instead of many).
      if (!truncatedOnce && list[0] === "問題定義") {
        truncatedOnce = true;
        return write(list.slice(0, 1));
      }
      return write(list);
    });
    const id = await newRun("slides", { request: "幫我做這個研究的進度報告簡報，11 頁", inputs: { pages: 11, mode: "progress" } });
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const planned = (await getRun(t.db, id))!;
    expect(planned.plan!.outline!.length).toBe(11);
    expect(planned.criteria.find((c) => c.id === "pages")!.text).toContain("11 頁");
    await approveWorkflow(t.app, await asUser(alice.id), id, {});
    // Student-owned pages (卡住, Idea card, 下週與要問): the run asks once, after the writers, with grounded options.
    m.set("ask_options", JSON.stringify({ questions: [{ id: "p1", options: [{ label: "資料量不足", description: "我目前卡在標註資料太少。" }, { label: "訓練不穩", description: "loss 會發散。" }] }] }));
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_input");
    const asked = (await getRun(t.db, id))!;
    expect(asked.state.ask_pending).toBe("student_pages");
    const { answerWorkflow } = await import("../src/workflows/service.js");
    await answerWorkflow(t.app, await asUser(alice.id), id, { card_id: "student_pages", answers: [{ id: "p1", value: ["o1"] }, { id: "p2", value: "我想試資料增強" }, { id: "p3", skipped: true }] });
    const out = await runWorkflow(deps(), id);
    stop = true;
    await worker;
    const steps = await getSteps(t.db, id);
    const w1 = steps.find((s) => s.key === "write_1")!;
    expect(w1.history[0]!.verdict.checks.find((c) => c.id === "slide_count")!.ok).toBe(false);
    expect(w1.status, JSON.stringify(w1.history.map((h) => h.verdict))).toBe("passed");
    expect(out.status, JSON.stringify((await getRun(t.db, id))!.report?.issues)).toBe("done");
    const r = (await getRun(t.db, id))!;
    const deck = r.artifacts.find((a) => a.kind === "deck")!;
    expect(deck).toBeTruthy();
    const src = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [deck.id])).rows[0]!.content;
    expect((src.match(/^## /gm) ?? []).length).toBe(11);
    expect(src).toMatch(/## 卡住\n\n- 資料量不足：我目前卡在標註資料太少。/);
    expect(src).toMatch(/## Idea card\n\n- 我想試資料增強/);
    expect(src).toMatch(/## 下週與要問\n\n〔　這頁留給你自己寫/);
    expect(r.criteria.find((c) => c.id === "pages")!.status).toBe("pass");
    // Publishing is a separate, explicit action.
    expect((await t.db.query("SELECT 1 FROM slide_versions WHERE deck_id=$1", [deck.id])).rowCount).toBe(0);
  });

  it("API: create from chat with a synthetic start_workflow call, list, detail, SSE replay, permissions", async () => {
    const conv = json(await post(alice, "/api/agent/conversations", {})).conversation.id;
    const created = await post(alice, "/api/workflows", { request: "測試任務", playbook: "test_pb", conversation_id: conv, context: { studyId: study.id } });
    expect(created.statusCode, created.body).toBe(201);
    const wf = json(created).workflow;
    expect(wf.status).toBe("planning");
    const chat = json(await get(alice, `/api/agent/conversations/${conv}`));
    const call = chat.toolCalls.find((c: any) => c.tool === "start_workflow");
    expect(call.status).toBe("done");
    expect(call.result.data.workflow_id).toBe(wf.id);
    expect(chat.messages.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    // A job was queued for the ai-worker.
    expect((await t.db.query("SELECT 1 FROM jobs WHERE kind='ai_workflow' AND payload->>'workflowId'=$1", [wf.id])).rowCount).toBe(1);
    await runWorkflow(deps(), wf.id);
    const detail = json(await get(alice, `/api/workflows/${wf.id}`));
    expect(detail.workflow.status).toBe("awaiting_plan_approval");
    expect(detail.steps).toHaveLength(4);
    const sse = await get(alice, `/api/workflows/${wf.id}/events?once=1`);
    expect(sse.body).toContain("event: workflow");
    expect(sse.body).toContain("event: step");
    // A notice landed in the conversation.
    expect((await t.db.query("SELECT 1 FROM agent_messages WHERE conversation_id=$1 AND role='notice'", [conv])).rowCount).toBe(1);
    // Other users cannot see or control it.
    expect((await get(bob, `/api/workflows/${wf.id}`)).statusCode).toBe(404);
    expect((await post(bob, `/api/workflows/${wf.id}/approve`)).statusCode).toBe(404);
    expect((await get(bob, `/api/workflows/${wf.id}/events?once=1`)).statusCode).toBe(404);
    expect(json(await get(bob, "/api/workflows")).workflows).toHaveLength(0);
    expect(json(await get(alice, "/api/workflows?active=1")).workflows.some((w: any) => w.id === wf.id)).toBe(true);
    // Admins are refused by the workspace guard.
    const admin = await t.ownerCookie();
    expect((await post(admin, "/api/workflows", { request: "測試" })).statusCode).toBe(403);
    // Approve with edited criteria, then pause/cancel.
    const ok = await post(alice, `/api/workflows/${wf.id}/approve`, { criteria: [{ id: "complete", text: "完整（已修改）" }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok).workflow.criteria[0].text).toBe("完整（已修改）");
    expect((await post(alice, `/api/workflows/${wf.id}/approve`)).statusCode).toBe(409);
    expect((await post(alice, `/api/workflows/${wf.id}/pause`)).statusCode).toBe(200);
    expect((await post(alice, `/api/workflows/${wf.id}/cancel`)).statusCode).toBe(200);
    expect(json(await get(alice, `/api/workflows/${wf.id}`)).workflow.status).toBe("cancelled");
  });

  it("slides plan approved with outline edits over HTTP: steps re-derived, an added template page is student-owned", async () => {
    m.set("outline", JSON.stringify({ pages: ["問題定義", "方法", "結果"].map((title) => ({ title, points: ["依資料"] })) }));
    const id = await newRun("slides", { request: "幫我做這個研究的進度報告簡報，3 頁", inputs: { pages: 3, mode: "progress" } });
    expect((await runWorkflow(deps(), id)).status).toBe("awaiting_plan_approval");
    const outline = [{ title: "問題定義", points: ["依資料"] }, { title: "方法與結果", points: ["依資料", "數字"] }, { title: "My assessment", points: [] }];
    const res = await post(alice, `/api/workflows/${id}/approve`, { outline });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await getRun(t.db, id))!;
    expect(after.status).toBe("running");
    expect(after.plan!.outline!.map((o) => o.title)).toEqual(outline.map((o) => o.title));
    expect((after.plan!.outline as { title: string; student_owned?: boolean }[]).find((o) => o.title === "My assessment")!.student_owned).toBe(true);
    expect((await getSteps(t.db, id)).map((s) => s.key)).toContain("student_input");
    await cancelWorkflow(t.app, await asUser(alice.id), id);
  });

  it("a non-member cannot get writes: slides asks for a study the user belongs to", async () => {
    const other = await insertStudy(t.db, bob.id, "Bob 的研究");
    await addStudyMember(t.db, other.id, alice.id, "member").catch(() => undefined);
    await t.db.query("DELETE FROM study_members WHERE study_id=$1 AND user_id=$2", [other.id, alice.id]);
    const r = await createWorkflow(t.app, await asUser(alice.id), { request: "做進度報告簡報", playbook: "slides", context: { studyId: other.id }, inputs: { mode: "progress" } });
    expect((await runWorkflow(deps(), r.id)).status).toBe("awaiting_input");
    expect((await getRun(t.db, r.id))!.question).toContain("不是");
    expect(m.log.length).toBe(0);
  });
});
