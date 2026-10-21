/**
 * Message editing / regenerate / version switching (branches), `ask_user` question cards and the adaptive study
 * interview, with a scripted mock model (no LLM).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { ChatEvent } from "../src/ai/types.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import { askUserInput, answersText, validateAnswers } from "../src/agent/ask.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

type Step = ChatEvent[] | ((req: RoleChatRequest, signal: AbortSignal) => AsyncGenerator<ChatEvent>);
let ids = 0;
const calls = (...list: [string, unknown][]): ChatEvent[] => [
  ...list.flatMap(([name, input]) => {
    const id = `call_${++ids}`;
    return [{ type: "tool_call_start", index: 0, id, name } as ChatEvent, { type: "tool_call_end", index: 0, id, name, input, argsJson: JSON.stringify(input) } as ChatEvent];
  }),
  { type: "done", stopReason: "tool_use" },
];
const say = (text: string): ChatEvent[] => [{ type: "text_delta", text }, { type: "done", stopReason: "end_turn" }];
const lastUserText = (req: RoleChatRequest) => JSON.stringify(req.messages.filter((m) => m.role === "user").at(-1));

const QUESTIONS = {
  intro: "幾個問題",
  questions: [
    { id: "data", prompt: "會用哪些資料？", type: "multi_choice", options: [{ value: "speech", label: "語音" }, { value: "text", label: "文字" }, { value: "unsure", label: "還不確定" }], allow_other: true },
    { id: "goal", prompt: "研究目標？", type: "short_text", required: true },
    { id: "confidence", prompt: "有多確定？", type: "scale" },
  ],
};

describe("ask_user schema and answers (unit)", () => {
  it("validates questions", () => {
    expect(askUserInput.safeParse(QUESTIONS).success).toBe(true);
    expect(askUserInput.safeParse({ questions: [] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: [{ id: "a", prompt: "?", type: "single_choice" }] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: [{ id: "a", prompt: "?", type: "short_text" }, { id: "a", prompt: "?", type: "date" }] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, prompt: "?", type: "yes_no" })) }).success).toBe(false);
  });
  it("validates and formats answers with labels", () => {
    const args = askUserInput.parse(QUESTIONS);
    expect(() => validateAnswers(args, { tool_call_id: crypto.randomUUID(), answers: [{ id: "data", value: ["speech"] }] })).toThrow(/必答/);
    expect(() => validateAnswers(args, { tool_call_id: crypto.randomUUID(), answers: [{ id: "data", value: ["video"] }, { id: "goal", value: "x" }] })).toThrow(/選項/);
    expect(() => validateAnswers(args, { tool_call_id: crypto.randomUUID(), answers: [{ id: "goal", value: "x" }, { id: "confidence", value: 9 }] })).toThrow(/1–5/);
    const stored = validateAnswers(args, { tool_call_id: crypto.randomUUID(), answers: [{ id: "data", value: ["speech", "text"], other: "腦波" }, { id: "goal", value: "辨識情緒" }, { id: "confidence", skipped: true }] });
    const text = answersText(args, stored);
    expect(text.model).toContain("語音、文字、其他：腦波");
    expect(text.model).toContain("辨識情緒");
    expect(text.model).toContain("（略過）");
    expect(text.model).toMatch(/^<user_answers/);
  });
  it("interview prompt: adaptive, no schedules", () => {
    const p = systemPrompt({ mode: "interview", user: { name: "A", role: "student" }, memories: null });
    expect(p).toContain("這個研究目前進行到哪個程度");
    expect(p).toContain("絕對不要問實驗或研究何時完成");
    expect(p).toContain("## 待釐清的問題");
    expect(p).toContain("ask_user");
    expect(systemPrompt({ mode: "chat", user: { name: "A", role: "student" }, memories: null })).toContain("ask_user");
  });
});

describe.skipIf(!hasTestDb)("agent branches + ask_user", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let script: Step[] = [];
  const requests: RoleChatRequest[] = [];
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const post = (who: { cookie: string }, url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const get = (who: { cookie: string }, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
  const runtime = () => agentFor(t.app);
  const model: ModelCall = async function* (req, ctx) {
    requests.push(req);
    const step = script.shift() ?? say("（沒有更多腳本）");
    if (typeof step === "function") yield* step(req, ctx.signal);
    else for (const e of step) yield e;
  };
  const newConversation = async (who = alice, body: object = {}) => json(await post(who, "/api/agent/conversations", body)).conversation.id as string;
  async function send(conv: string, body: object, who = alice) {
    const r = await post(who, `/api/agent/conversations/${conv}/messages`, body);
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
    return json(r);
  }
  async function edit(conv: string, messageId: string, body: object, who = alice) {
    const r = await post(who, `/api/agent/conversations/${conv}/messages/${messageId}/edit`, body);
    await runtime().settle();
    return r;
  }
  const state = async (conv: string) => json(await get(alice, `/api/agent/conversations/${conv}`));
  const texts = (s: any) => s.messages.filter((m: any) => m.role === "user" || m.role === "assistant").map((m: any) => m.text);

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    await t.login("professor", "王教授");
    study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    await t.db.query("INSERT INTO study_stages(study_id,position,name) VALUES($1,0,'題目發想')", [study.id]);
    const rt = runtime();
    rt.options.model = model;
    rt.options.fast = async () => "標題";
  });
  afterAll(async () => {
    await runtime().settle();
    await t?.close();
  });
  beforeEach(() => {
    script = [];
    requests.length = 0;
  });

  it("edit resubmits from that message, keeps the old tail as a version, and switches back", async () => {
    const conv = await newConversation();
    script = [say("a1")];
    const a = (await send(conv, { text: "A" })).message;
    script = [say("b1")];
    await send(conv, { text: "B" });
    expect(texts(await state(conv))).toEqual(["A", "a1", "B", "b1"]);

    requests.length = 0;
    script = [say("a2")];
    const r = await edit(conv, a.id, { text: "A2" });
    expect(r.statusCode, r.body).toBe(202);
    let s = await state(conv);
    expect(texts(s)).toEqual(["A2", "a2"]);
    // the model saw only the new branch
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('"B"');
    expect(lastUserText(requests[0]!)).toContain("A2");
    const a2 = s.messages[0];
    expect(a2.versions).toEqual([a.id, a2.id]);
    expect(s.run.status).toBe("done");

    // ‹ 1/2 ›: back to the first version and its whole tail
    let sw = await post(alice, `/api/agent/conversations/${conv}/messages/${a.id}/activate`);
    expect(sw.statusCode, sw.body).toBe(200);
    s = await state(conv);
    expect(texts(s)).toEqual(["A", "a1", "B", "b1"]);
    expect(s.messages[0].versions).toEqual([a.id, a2.id]);
    // the run shown belongs to this branch
    expect(s.messages.some((m: any) => m.run_id === s.run.id)).toBe(true);
    sw = await post(alice, `/api/agent/conversations/${conv}/messages/${a2.id}/activate`);
    expect(texts(await state(conv))).toEqual(["A2", "a2"]);

    // 重新產生: the last user message again as a third version
    script = [say("a3")];
    const rg = await post(alice, `/api/agent/conversations/${conv}/regenerate`);
    expect(rg.statusCode, rg.body).toBe(202);
    await runtime().settle();
    s = await state(conv);
    expect(texts(s)).toEqual(["A2", "a3"]);
    expect(s.messages[0].versions).toHaveLength(3);
    // events: a branch marker; replay after resumeFrom has no messages from hidden branches
    const ev = await get(alice, `/api/agent/conversations/${conv}/events?after=0&once=1`);
    expect(ev.body).toContain("event: branch");
    const after = await get(alice, `/api/agent/conversations/${conv}/events?after=${s.resumeFrom}&once=1`);
    expect(after.body).not.toContain("event: message");
  });

  it("nested edits keep inner versions restorable", async () => {
    const conv = await newConversation();
    script = [say("r1")];
    const u1 = (await send(conv, { text: "U1" })).message;
    script = [say("r2")];
    const u2 = (await send(conv, { text: "U2" })).message;
    script = [say("r2b")];
    await edit(conv, u2.id, { text: "U2b" });
    script = [say("r1b")];
    await edit(conv, u1.id, { text: "U1b" });
    expect(texts(await state(conv))).toEqual(["U1b", "r1b"]);
    await post(alice, `/api/agent/conversations/${conv}/messages/${u1.id}/activate`);
    const s = await state(conv);
    expect(texts(s)).toEqual(["U1", "r1", "U2b", "r2b"]);
    await post(alice, `/api/agent/conversations/${conv}/messages/${u2.id}/activate`);
    expect(texts(await state(conv))).toEqual(["U1", "r1", "U2", "r2"]);
  });

  it("cannot edit, regenerate or switch someone else's conversation", async () => {
    const conv = await newConversation();
    script = [say("ok")];
    const m = (await send(conv, { text: "hi" })).message;
    expect((await edit(conv, m.id, { text: "x" }, bob)).statusCode).toBe(404);
    expect((await post(bob, `/api/agent/conversations/${conv}/regenerate`)).statusCode).toBe(404);
    expect((await post(bob, `/api/agent/conversations/${conv}/messages/${m.id}/activate`)).statusCode).toBe(404);
    // a message id from another conversation
    const other = await newConversation();
    expect((await edit(other, m.id, { text: "x" })).statusCode).toBe(404);
    expect(texts(await state(conv))).toEqual(["hi", "ok"]);
  });

  it("editing cancels a running run first (no ghost partial on the new branch)", async () => {
    const conv = await newConversation();
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    script = [
      async function* (_req, signal) {
        yield { type: "text_delta", text: "partial…" } as ChatEvent;
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      },
      say("fresh"),
    ];
    const r = await post(alice, `/api/agent/conversations/${conv}/messages`, { text: "long question" });
    const first = json(r);
    await begun;
    const e = await edit(conv, first.message.id, { text: "short question" });
    expect(e.statusCode, e.body).toBe(202);
    const old = (await t.db.query("SELECT status, stop_reason FROM agent_runs WHERE id=$1", [first.run.id])).rows[0];
    expect(old).toMatchObject({ status: "cancelled", stop_reason: "superseded" });
    const s = await state(conv);
    expect(texts(s)).toEqual(["short question", "fresh"]);
    expect((await t.db.query("SELECT 1 FROM agent_messages WHERE conversation_id=$1 AND text LIKE 'partial%'", [conv])).rowCount).toBe(0);
  });

  it("a pending approval in the discarded tail is dropped", async () => {
    const conv = await newConversation();
    script = [calls(["create_task", { study: study.slug, title: "整理數據" }])];
    const m = (await send(conv, { text: "新增待辦" })).message;
    let s = await state(conv);
    expect(s.run.status).toBe("awaiting_approval");
    const callId = s.toolCalls[0].id;
    script = [say("好的，不新增。")];
    await edit(conv, m.id, { text: "算了，不用新增" });
    s = await state(conv);
    expect(s.toolCalls).toHaveLength(0);
    expect((await t.db.query("SELECT status FROM tool_calls WHERE id=$1", [callId])).rows[0].status).toBe("cancelled");
    expect(json(await get(alice, "/api/agent/pending")).count).toBe(0);
    expect((await post(alice, `/api/agent/tool-calls/${callId}/decision`, { decision: "approve" })).statusCode).toBe(409);
    expect((await t.db.query("SELECT 1 FROM tasks WHERE title='整理數據'")).rowCount).toBe(0);
  });

  it("ask_user: invalid questions fail, valid ones end the turn; answers are a user turn and editable", async () => {
    const conv = await newConversation();
    script = [calls(["ask_user", { questions: [{ id: "a", prompt: "?", type: "single_choice" }] }]), calls(["ask_user", QUESTIONS])];
    await send(conv, { text: "幫我規劃" });
    let s = await state(conv);
    expect(s.toolCalls.map((c: any) => [c.tool, c.status])).toEqual([["ask_user", "failed"], ["ask_user", "done"]]);
    expect(s.run).toMatchObject({ status: "done", stop_reason: "awaiting_input" });
    expect(requests).toHaveLength(2); // no model call after the card
    const card = s.toolCalls[1];

    const url = `/api/agent/conversations/${conv}/messages`;
    expect((await post(alice, url, { answers: { tool_call_id: card.id, answers: [{ id: "data", value: ["speech"] }] } })).statusCode).toBe(400);
    expect((await post(alice, url, { answers: { tool_call_id: card.id, answers: [{ id: "goal", value: "x" }, { id: "data", value: ["nope"] }] } })).statusCode).toBe(400);
    // a normal message instead of answering keeps the card answerable
    script = [say("請先填卡片")];
    await send(conv, { text: "等一下" });
    script = [say("收到")];
    const ans = (await send(conv, { answers: { tool_call_id: card.id, answers: [{ id: "data", value: ["speech", "unsure"] }, { id: "goal", value: "情緒辨識" }, { id: "confidence", value: 2 }] } })).message;
    expect(ans.answers.toolCallId).toBe(card.id);
    expect(lastUserText(requests.at(-1)!)).toContain("語音、還不確定");
    expect(lastUserText(requests.at(-1)!)).toContain("2/5");
    // answering the same card twice → 409 (use 修改答案)
    expect((await post(alice, url, { answers: { tool_call_id: card.id, answers: [{ id: "goal", value: "y" }] } })).statusCode).toBe(409);
    // 修改答案 = edit → new branch with the new answers
    script = [say("改好了")];
    const e = await edit(conv, ans.id, { answers: { tool_call_id: card.id, answers: [{ id: "goal", value: "說話者辨識" }] } });
    expect(e.statusCode, e.body).toBe(202);
    s = await state(conv);
    const last = s.messages.filter((m: any) => m.role === "user").at(-1);
    expect(last.answers.answers.find((a: any) => a.id === "goal").value).toBe("說話者辨識");
    expect(last.versions).toHaveLength(2);
    expect(lastUserText(requests.at(-1)!)).toContain("說話者辨識");
    // an answer message cannot be edited into plain text
    expect((await edit(conv, last.id, { text: "純文字" })).statusCode).toBe(400);
  });

  it("interview: seeded maturity card, mode-specific rounds, plan from the latest branch only", async () => {
    const conv = await newConversation(alice, { mode: "interview" });
    let s = await state(conv);
    expect(requests).toHaveLength(0);
    const seed = s.toolCalls[0];
    expect(seed).toMatchObject({ tool: "ask_user", status: "done" });
    expect(seed.args.questions[0].id).toBe("maturity");
    expect(seed.args.questions[0].options.map((o: any) => o.value)).toEqual(["exploring", "problem_defined", "method_first", "continuation", "assigned", "well_defined"]);

    // exploring → one round of questions (advisor list from the directory) → plan
    const round2 = { questions: [{ id: "area", prompt: "感興趣的領域？", type: "short_text" }, { id: "advisor", prompt: "指導教授？", type: "single_choice", options: [{ value: "wang", label: "王教授" }, { value: "undecided", label: "還沒決定" }] }] };
    script = [calls(["list_lab_members", { role: "professor" }]), calls(["ask_user", round2])];
    const first = (await send(conv, { answers: { tool_call_id: seed.id, answers: [{ id: "maturity", value: "exploring" }] } })).message;
    expect(lastUserText(requests[0]!)).toContain("探索中");
    expect(JSON.stringify(requests[0]!.messages[0])).toContain("絕對不要問");
    const tools = requests[0]!.tools!.map((x) => x.name).sort();
    expect(tools).toEqual(["ask_user", "list_lab_members", "propose_study_plan"]);
    expect(JSON.stringify(requests[1]!.messages)).toContain("王教授");
    s = await state(conv);
    const card2 = s.toolCalls.find((c: any) => c.tool === "ask_user" && c.id !== seed.id);
    const exploring = { maturity: "exploring", title: "語音情緒（暫定）", summary_md: "## 研究方向\n語音情緒\n## 待釐清的問題\n- 資料：待探討", stages: [{ name: "題目發想" }, { name: "文獻探討" }], open_questions: ["要用哪個資料集？"], first_steps: [{ title: "整理 10 篇相關論文" }] };
    script = [calls(["propose_study_plan", exploring]), say("草案好了")];
    await send(conv, { answers: { tool_call_id: card2.id, answers: [{ id: "area", value: "語音情緒" }, { id: "advisor", value: "undecided" }] } });
    s = await state(conv);
    expect(s.toolCalls.filter((c: any) => c.tool === "propose_study_plan").map((c: any) => c.args.maturity)).toEqual(["exploring"]);

    // the student changes the first answer → the interview re-runs from there; only the new plan is visible
    const wellDefined = { maturity: "well_defined", title: "以 wav2vec2 做中文語音情緒辨識", summary_md: "## 研究方向\n…\n## 方法\nwav2vec2\n## 資料\nNNIME\n## 評估\nUAR", stages: [{ name: "實驗" }, { name: "撰寫" }] };
    script = [calls(["propose_study_plan", wellDefined]), say("新草案")];
    const e = await edit(conv, first.id, { answers: { tool_call_id: seed.id, answers: [{ id: "maturity", value: "well_defined" }] } });
    expect(e.statusCode, e.body).toBe(202);
    s = await state(conv);
    const plans = s.toolCalls.filter((c: any) => c.tool === "propose_study_plan");
    expect(plans.map((c: any) => c.args.maturity)).toEqual(["well_defined"]);
    expect(plans[0].args.milestones).toBeUndefined();
    expect(lastUserText(requests.at(-1)!)).toContain("方向明確");
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("語音情緒（暫定）");
  });

  it("studies store and edit the maturity", async () => {
    const r = await post(alice, "/api/studies", { title: "成熟度測試", maturity: "exploring" });
    expect(r.statusCode, r.body).toBe(201);
    const slug = json(r).study.slug;
    expect(json(r).study.maturity).toBe("exploring");
    const p = await t.app.inject({ method: "PATCH", url: `/api/studies/${slug}`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { maturity: "well_defined" } });
    expect(json(p).study.maturity).toBe("well_defined");
    const bad = await t.app.inject({ method: "PATCH", url: `/api/studies/${slug}`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { maturity: "nope" } });
    expect(bad.statusCode).toBe(400);
    const clear = await t.app.inject({ method: "PATCH", url: `/api/studies/${slug}`, headers: { origin: ORIGIN, cookie: alice.cookie }, payload: { maturity: null } });
    expect(json(clear).study.maturity).toBeNull();
    const pb = await t.app.inject({ method: "PATCH", url: `/api/studies/${slug}`, headers: { origin: ORIGIN, cookie: bob.cookie }, payload: { maturity: "assigned" } });
    expect(pb.statusCode).toBe(403);
  });
});
