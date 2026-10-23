/**
 * Verification redesign (docs/architecture.md "Workflows" → Verification / Convergence), with a scripted mock model:
 * the judge gets exactly the writer's source blocks (no shorter cut, same order) and only its own scope's checklist;
 * a missing fact the sources do not hold is a 「資料未提供」 note, not a fix; ≤ 2 fix rounds by default; a worse last
 * round gives way to the best version; the final repair runs once and only on evidence-backed failures; autopilot never
 * adds a round for unchanged failures; done needs the criteria (not every step) to pass; ai_call_log records purpose /
 * step / round.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { runWorkflow } from "../src/workflows/engine.js";
import { createWorkflow, approveWorkflow } from "../src/workflows/service.js";
import { getRun, getSteps } from "../src/workflows/store.js";
import { registerWorkflowPlaybook } from "../src/workflows/playbooks/index.js";
import { dataBlock } from "../src/workflows/llm.js";
import type { ModelPort, StepRow } from "../src/workflows/types.js";
import { createTestContext, hasTestDb, hasTestS3, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";
import { setWorkflowAvailability } from "../src/routes/workflows.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");
const run = hasTestDb && hasTestS3 ? describe : describe.skip;

type Req = { messages: { role: string; content: unknown }[] };
type Reply = string | ((req: Req, ctx: { purpose: string; stepKey?: string; round?: number }) => string);
const result = (text: string): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 }, message: { role: "assistant", content: text } });
const userText = (req: Req) => req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const sysText = (req: Req) => req.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

function mockModel() {
  const queues = new Map<string, Reply[]>();
  const defaults = new Map<string, Reply>();
  const log: { purpose: string; stepKey?: string; round?: number; workflowId?: string }[] = [];
  const port: ModelPort = {
    async chat(_role, req, ctx) {
      log.push({ purpose: ctx.purpose, stepKey: ctx.stepKey, round: ctx.round, workflowId: ctx.workflowId });
      const q = queues.get(ctx.purpose);
      const reply = q?.length ? q.shift()! : defaults.get(ctx.purpose) ?? defaults.get("*") ?? "{}";
      return result(typeof reply === "function" ? reply(req as never, ctx) : reply);
    },
    available: async () => true,
    vision: async () => false,
  };
  return {
    port, log,
    queue(purpose: string, ...replies: Reply[]) { queues.set(purpose, [...(queues.get(purpose) ?? []), ...replies]); },
    set(purpose: string, reply: Reply) { defaults.set(purpose, reply); },
    count(purpose: string) { return log.filter((l) => l.purpose === purpose).length; },
  };
}

const PASS = '{"verdict":"pass"}';
const no = (...items: [string, ...object[]][]) => JSON.stringify({ items: items.map(([id, ...problems]) => ({ id, problems, answer: "no" })) });
const allPass = (req: Req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((m) => ({ id: m[1], evidence: "段落內容", pass: true, reason: "ok" })) });

/** 40k characters of research material whose last line is a marker (the part a 16k cut used to drop). */
const RESEARCH = `${"研究資料段落。".repeat(5600)}\nTAIL-MARKER：主要結果 CER 12.3 → 10.1（表 2）`;

// One writer step `a` (judged) + final. Unit-scope criteria u1–u3, an artifact-scope criterion, requirements of both scopes.
registerWorkflowPlaybook({
  id: "test_conv",
  title: "收斂", titleEn: "Convergence", description: "", descriptionEn: "",
  autoApprovable: true,
  detect: () => 0,
  async plan(env) {
    await env.setState({ requirements: [
      { id: "r1", type: "length", text: "全文 12 段", source: "request" },
      { id: "r2", type: "tone", text: "語氣正式", source: "request" },
    ] });
    return {
      kind: "plan", title: "收斂", objective: "寫一段", plan: { summary: "一段", writes: [{ kind: "note", label: "新筆記", effect: "new" }] },
      criteria: [
        { id: "u1", kind: "judge", text: "單位一", scope: "unit" },
        { id: "u2", kind: "judge", text: "單位二", scope: "unit" },
        { id: "u3", kind: "judge", text: "單位三", scope: "unit" },
        { id: "whole", kind: "judge", text: "整份涵蓋十二個主題" },
      ],
      steps: [
        { key: "a", role: "writer", title: "撰寫 A", instructions: "依研究資料寫 A 段，包含主要結果", verify: { checks: [{ id: "min_length", params: { chars: 5 } }], judge: true } },
        { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "", depends_on: ["a"] },
      ],
    };
  },
  async execute(env, step, fix) {
    const user = [`你的任務：${step.instructions}`, dataBlock("outline", "1. A 段"), dataBlock("research", RESEARCH), fix ? `修正：${fix.issues.join("；")}` : "", fix ? dataBlock("previous_version", fix.previous.text ?? "") : ""].filter(Boolean).join("\n\n");
    const r = await env.call({ purpose: "w:a", role: "writer", messages: [{ role: "user", content: user }] }, step.id);
    return { summary: r.text.slice(0, 40), text: r.text };
  },
  async finalText(env) {
    const steps = await getSteps(env.db, env.run.id);
    return { text: steps.find((s) => s.key === "a")?.output?.text ?? "", data: null };
  },
  async repair(_env, failing) {
    return failing.map((c) => ({ key: "a", issues: [c.reason ?? c.text] }));
  },
});

run("workflow verification and convergence", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let m: ReturnType<typeof mockModel>;
  const deps = () => ({ db: t.db, storage: t.storage, app: t.app, model: m.port, log: t.app.log, signal: new AbortController().signal, jobId: null });
  const asUser = async (id: string) => {
    const { toCurrentUser, CURRENT_USER_COLUMNS } = await import("../src/lib/auth.js");
    return toCurrentUser((await t.db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1`, [id])).rows[0]);
  };
  const go = async (extra: object = {}) => {
    const id = (await createWorkflow(t.app, await asUser(alice.id), { request: "寫一段", playbook: "test_conv", context: { studyId: study.id }, ...extra })).id;
    await runWorkflow(deps(), id);
    if ((await getRun(t.db, id))!.status === "awaiting_plan_approval") await approveWorkflow(t.app, await asUser(alice.id), id, {});
    const out = await runWorkflow(deps(), id);
    return { id, status: out.status, a: (await getSteps(t.db, id)).find((s) => s.key === "a")! };
  };
  const conv = (s: StepRow) => (s.inputs as { conv?: { stop?: string; best?: { round: number }; rounds: { round: number; score: number; total: number }[] } }).conv!;
  const ledger = (s: StepRow) => ((s.inputs as { ledger?: { items: { status: string; text: string; note?: string }[] } }).ledger?.items ?? []);

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "alice-conv");
    study = await insertStudy(t.db, alice.id, "收斂研究");
    setWorkflowAvailability(async () => true);
  });
  afterAll(async () => t?.close());
  beforeEach(() => {
    m = mockModel();
    m.set("verify", PASS);
    m.set("verify_final", allPass);
    m.set("w:a", "A 段：主要結果 CER 12.3 → 10.1。");
  });

  it("source parity + scope: the judge gets the writer's blocks whole and in order, and only unit-scope items and requirements", async () => {
    const prompts: { user: string; sys: string }[] = [];
    m.set("verify", (req) => (prompts.push({ user: userText(req), sys: sysText(req) }), PASS));
    const { status } = await go();
    expect(status).toBe("done");
    const p = prompts[0]!.user;
    // The same blocks the writer got (the previous_version block is not a source), the tail of 40k research included.
    expect(p).toContain("TAIL-MARKER");
    expect(p.indexOf('<data name="outline"')).toBeGreaterThan(-1);
    expect(p.indexOf('<data name="outline"')).toBeLessThan(p.indexOf('<data name="research"'));
    expect(p).toContain(RESEARCH);
    // Scope: the unit items and the unit requirement (tone); never the artifact-scope criterion or the length requirement.
    for (const id of ["task", "u1", "u2", "u3"]) expect(p).toContain(`- [${id}]`);
    expect(p).not.toContain("整份涵蓋十二個主題");
    expect(`${p}\n${prompts[0]!.sys}`).not.toContain("全文 12 段");
    expect(p).toContain("語氣正式");
  });

  it("a missing fact the sources do not hold is a 「資料未提供」 note, not a fix; one the sources hold is fixed", async () => {
    m.queue("verify", no(["task", { kind: "missing", required_quote: "包含主要結果", source_quote: "論文第 9 頁的 WER 數字", fix: "補上 WER" }]));
    const first = await go();
    expect(first.status).toBe("done");
    expect(m.count("w:a")).toBe(1); // no fix round
    expect(ledger(first.a).map((i) => i.status)).toEqual(["note"]);
    const r = (await getRun(t.db, first.id))!;
    expect(r.report!.ledger!.notes!.length).toBe(1);
    expect(r.report!.summary_md).toContain("資料未提供");

    m.queue("verify", no(["task", { kind: "missing", required_quote: "包含主要結果", source_quote: "主要結果 CER 12.3 → 10.1", fix: "補上主要結果" }]));
    m.queue("w:a", "A 段：方法。", "A 段：方法；主要結果 CER 12.3 → 10.1（表 2）。");
    const second = await go();
    expect(second.status).toBe("done");
    expect(m.count("w:a")).toBe(3); // the sources hold it: one fix round (1 call in the first run + 2 here)
    expect(ledger(second.a).map((i) => i.status)).toEqual(["fixed"]);
  });

  it("a critique of a sentence the sources contain verbatim is dropped; an output quote that does not exist is dropped", async () => {
    m.set("w:a", "研究資料段落。研究資料段落。主要結果。");
    m.queue("verify", no(["grounded", { kind: "wrong", output_quote: "研究資料段落。研究資料段落。", fix: "沒有依據" }, { kind: "wrong", output_quote: "WavLM 在所有資料集最好", fix: "捏造" }]));
    const { a, status } = await go();
    expect(status).toBe("done");
    expect(m.count("w:a")).toBe(1);
    expect(ledger(a).map((i) => [i.status, i.note])).toEqual([["invalid", "被指為沒有依據的這段在來源中找得到"], ["invalid", "引用的原文不在產出中"]]);
  });

  it("≤ 2 fix rounds by default: improving but still failing rounds stop at the cap", async () => {
    let n = 0;
    m.set("w:a", () => `A 段第 ${++n} 版：問題${n}。`);
    // Round 0: three items fail; round 1: two; round 2: one (each round a different, real problem).
    m.set("verify", (_req, ctx) => {
      const r = ctx.round ?? 0;
      const ids = ["u1", "u2", "u3"].slice(0, 3 - r);
      return no(...ids.map((id): [string, object] => [id, { kind: "wrong", output_quote: `問題${r + 1}`, fix: `${id} 第 ${r} 輪的問題` }]));
    });
    const { a } = await go();
    expect(m.count("w:a")).toBe(3); // draft + 2 fix rounds
    expect(a.status).toBe("failed");
    expect(conv(a).stop).toBe("cap");
    expect(conv(a).best!.round).toBe(2);
    expect(a.output!.text).toBe("A 段第 3 版：問題3。");
  });

  it("keeps the best-scoring version when the last round is worse", async () => {
    let n = 0;
    m.set("w:a", () => `A 段第 ${++n} 版：缺點${n}。`);
    m.queue("verify",
      no(["u1", { kind: "wrong", output_quote: "缺點1", fix: "u1 有誤" }]),
      no(["u1", { kind: "wrong", output_quote: "缺點2", fix: "u1 有誤" }], ["u2", { kind: "wrong", output_quote: "缺點2", fix: "u2 有誤" }]),
    );
    const { a, id } = await go();
    expect(m.count("w:a")).toBe(2);
    expect(conv(a).stop).toBe("no_improvement");
    expect(conv(a).best!.round).toBe(0);
    expect(a.output!.text).toBe("A 段第 1 版：缺點1。"); // round 0, not the worse last round
    const r = (await getRun(t.db, id))!;
    expect(r.report!.summary_md).toContain("保留第 0 輪");
    expect(r.report!.steps!.find((s) => s.key === "a")).toMatchObject({ kept_best: true, best_round: 0, stop: "no_improvement" });
  });

  it("final repair runs once, only for evidence-backed failures; autopilot adds no round for the unchanged failure", async () => {
    m.set("verify_final", (req) => JSON.stringify({ results: [...userText(req).matchAll(/- \[([a-z0-9_]+)\]/g)].map((x) => (x[1] === "whole" ? { id: "whole", evidence: "A 段", kind: "wrong", pass: false, reason: "只寫了一個主題" } : { id: x[1], evidence: "A 段", pass: true })) }));
    const { id, status } = await go({ autopilot: true });
    expect(status).toBe("partial");
    const r = (await getRun(t.db, id))!;
    expect(r.final_rounds).toBe(1);
    expect(m.count("w:a")).toBe(2); // the draft + one repair round
    expect(m.count("verify_final")).toBe(2);
    expect(r.state.auto_continued).toBeUndefined(); // the same failure was already repaired once: no autopilot round
    expect(r.report!.summary_md).toContain("部分完成");
  });

  it("done semantics: a step stopped on a judged item does not make the run partial; a broken check does", async () => {
    m.set("verify", no(["u1", { kind: "wrong", output_quote: "主要結果", fix: "u1 有誤" }]));
    const judged = await go();
    expect(judged.a.status).toBe("failed");
    expect(judged.status).toBe("done");

    m.set("verify", PASS);
    m.set("w:a", "TODO");
    const broken = await go();
    expect(broken.a.status).toBe("failed");
    expect(broken.status).toBe("partial");
  });

  it("every workflow call carries its purpose, run, step key and fix round (ai_call_log columns)", async () => {
    m.queue("verify", no(["u1", { kind: "wrong", output_quote: "主要結果", fix: "u1 有誤" }]));
    const { id } = await go();
    const writes = m.log.filter((l) => l.purpose === "w:a");
    expect(writes.map((w) => [w.stepKey, w.round])).toEqual([["a", 0], ["a", 1]]);
    expect(m.log.filter((l) => l.purpose === "verify").every((l) => l.stepKey === "a" && l.workflowId === id)).toBe(true);
    expect(m.log.find((l) => l.purpose === "verify_final")).toMatchObject({ stepKey: "final", workflowId: id });
  });

  it("slides visual QA (vision): only the rewritten page is scored again; a borderline empty band on a 4.9 page is a note", async () => {
    // Fake worker: completes renders and writes screenshots (PNG bytes) + clean metrics, page 4 with a 54 % empty band.
    let stop = false;
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const worker = (async () => {
      while (!stop) {
        const jobs = (await t.db.query<{ id: string; payload: { previewId: string; deckId: string; shots?: boolean } }>("SELECT id, payload FROM jobs WHERE kind='slide_preview' AND status='queued'")).rows;
        for (const j of jobs) {
          const pv = (await t.db.query<{ output_prefix: string }>("UPDATE deck_previews SET status='ready', entry_html='index.html', finished_at=now() WHERE id=$1 RETURNING output_prefix", [j.payload.previewId])).rows[0];
          if (!j.payload.shots || !pv) {
            await t.db.query("UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1", [j.id]);
            continue;
          }
          const qmd = (await t.db.query<{ content: string }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [j.payload.deckId])).rows[0]?.content ?? "";
          const titles = ["", ...[...qmd.matchAll(/^## (.+)$/gm)].map((x) => x[1]!.trim())];
          const metrics = (band: number) => ({ words: 20, bullets: 2, minFont: 22, maxFont: 40, overflowY: 0, overflowX: 0, visuals: 1, tables: 1, diagrams: 0, diagramErrors: 0, rawDiagramCode: 0, codeBlocks: 0, emptyBand: band });
          for (let i = 1; i <= titles.length; i++) await t.storage.put(`${pv.output_prefix}_hub/shots/${i}.webp`, png, "image/webp");
          await t.storage.put(`${pv.output_prefix}_hub/shots.json`, Buffer.from(JSON.stringify({ version: 1, width: 1280, height: 800, total: titles.length, truncated: false, pages: titles.map((title, i) => ({ index: i + 1, h: i, title, metrics: metrics(i === 3 ? 0.54 : 0.1) })) })), "application/json");
          await t.db.query("UPDATE jobs SET result=$2, status='succeeded', finished_at=now() WHERE id=$1", [j.id, JSON.stringify({ shots: { count: titles.length } })]);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    m.port.vision = async () => true;
    const titles = ["問題定義", "方法", "結果"];
    m.set("outline", JSON.stringify({ pages: titles.map((title) => ({ title, points: ["依資料"] })) }));
    const page = (title: string, extra = "") => `## ${title}\n\n- 依據研究資料的重點${extra}\n\n| 項目 | 狀態 |\n|---|---|\n| 資料 | 完成 |\n\n::: {.notes}\n這一頁說明${title}的內容與資料來源，報告時大約一分鐘，重點放在研究資料裡實際記錄的進展與數字。\n:::`;
    m.set("write_slides", (req) => [...(/<data name="your_pages"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(userText(req))?.[1] ?? "").matchAll(/^\d+\. (.+)$/gm)].map((x) => page(x[1]!)).join("\n\n"));
    m.set("visual_fix", page("結果", "（精簡後）"));
    const seen: number[][] = [];
    m.set("visual_qa", (req) => {
      const pages = [...userText(req).matchAll(/第 (\d+) 頁「([^」]*)」/g)].map((x) => ({ page: Number(x[1]), title: x[2]! }));
      seen.push(pages.map((p) => p.page));
      const firstRound = seen.length === 1;
      const ok = { readability: 5, crowding: 5, layout: 5, visual: 5, diagrams: 5, overflow: 5, consistency: 5, professional: 4 };
      return JSON.stringify({ pages: pages.map((p) => (p.title === "結果" && firstRound ? { page: p.page, scores: { ...ok, crowding: 2 }, pass: false, issues: [{ text: "太擠", severity: "medium" }], fix: "刪成 3 條" } : { page: p.page, scores: ok, pass: true, issues: [] })) });
    });
    try {
      const id = (await createWorkflow(t.app, await asUser(alice.id), { request: "幫我做這個研究的進度報告簡報，3 頁", playbook: "slides", context: { studyId: study.id }, inputs: { pages: 3, mode: "progress" } })).id;
      expect((await runWorkflow({ ...deps(), previewWaitMs: 15_000 }, id)).status).toBe("awaiting_plan_approval");
      await approveWorkflow(t.app, await asUser(alice.id), id, {});
      const out = await runWorkflow({ ...deps(), previewWaitMs: 15_000 }, id);
      const r = (await getRun(t.db, id))!;
      expect(out.status, JSON.stringify(r.report?.issues)).toBe("done");
      // Round 1: the three content pages; round 2: only the rewritten 「結果」 page (the others keep their verdict).
      expect(seen).toEqual([[2, 3, 4], [4]]);
      const qa = (await getSteps(t.db, id)).find((s) => s.key === "visual_qa")!;
      expect(qa.status).toBe("passed");
      expect(r.criteria.find((c) => c.id === "visual_qa")!.status).toBe("pass");
      // Page 4 kept its 54 % empty band: a 5/5 page, so a note in the score table, not a failure.
      expect(String(r.state.qa_table)).toMatch(/\| 4 \| 結果 \| [\d.]+ \| 通過 \|.*大片空白/);
    } finally {
      stop = true;
      await worker;
      m.port.vision = async () => false;
    }
  });

  it("call log rows store purpose, workflow, step key and round", async () => {
    const { CallLogger, CallRecorder } = await import("../src/ai/platform/call-log.js");
    const logger = new CallLogger(t.db, undefined, 0);
    const wf = (await t.db.query<{ id: string }>("SELECT id FROM workflow_runs LIMIT 1")).rows[0]!.id;
    const rec = new CallRecorder(logger, { role: "writing", capability: "chat", stream: false, ctx: { userId: alice.id, purpose: "write_slides", workflowId: wf, stepKey: "write_1", round: 2 } });
    rec.exhausted("llm_unavailable");
    await logger.flush();
    const row = (await t.db.query("SELECT purpose, workflow_id, step_key, round FROM ai_call_log WHERE workflow_id=$1", [wf])).rows[0];
    expect(row).toEqual({ purpose: "write_slides", workflow_id: wf, step_key: "write_1", round: 2 });
  });
});
