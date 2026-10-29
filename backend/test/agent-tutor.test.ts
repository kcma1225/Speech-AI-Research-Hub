/**
 * 「先確認先備知識」 end to end through the agent runtime with a scripted mock model: the per-conversation switch, tool
 * gating, extract → concept_check card (rows filled by code, memory pre-fill) → answer → next_concept /
 * mark_concepts → user_concepts, the /concepts routes, the end-of-paper quiz (build_quiz → quiz card without keys →
 * graded answer → re-teach), tutoring state following message edits / versions, and the concept-memory switch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { ChatEvent } from "../src/ai/types.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import { writeMemory, type Session } from "../src/agent/tutor.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

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
const toolNames = (req: RoleChatRequest) => (req.tools ?? []).map((t) => t.name);

describe.skipIf(!hasTestDb)("paper tutoring (prereq_check)", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let paperId: string;
  // A step is the model's events, or a function computing them when the model is called (e.g. a quiz id).
  let script: (ChatEvent[] | (() => Promise<ChatEvent[]>))[] = [];
  const requests: RoleChatRequest[] = [];
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const req = (who: { cookie: string }, method: "POST" | "PATCH" | "DELETE" | "GET", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const runtime = () => agentFor(t.app);
  const model: ModelCall = async function* (r) {
    requests.push(r);
    const next = script.shift();
    for (const e of (typeof next === "function" ? await next() : next) ?? say("（沒有更多腳本）")) yield e;
  };
  const newConversation = async (body: object = {}) => json(await req(alice, "POST", "/api/agent/conversations", body)).conversation;
  async function send(conv: string, body: object) {
    const r = await req(alice, "POST", `/api/agent/conversations/${conv}/messages`, body);
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
  }
  const state = async (conv: string) => json(await req(alice, "GET", `/api/agent/conversations/${conv}`));

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    bob = await t.login("student", "Bob");
    paperId = (await t.db.query<{ id: string }>(
      "INSERT INTO papers(record,type,title,title_norm,abstract,year,added_by) VALUES($1,'article-journal','CTC for Speech','ctc for speech','We use CTC on MFCC features.',2020,$2) RETURNING id",
      [JSON.stringify({ title: "CTC for Speech", type: "article-journal", authors: [] }), alice.id],
    )).rows[0]!.id;
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

  it("the switch: off by default, set on create / patch; tools and rules only when on", async () => {
    const off = await newConversation();
    expect(off.prereq_check).toBe(false);
    script = [say("好")];
    await send(off.id, { text: "嗨" });
    expect(toolNames(requests[0]!)).not.toContain("extract_prerequisites");
    expect(JSON.stringify(requests[0]!.messages[0])).not.toContain("先確認先備知識");
    // concept_check cards are refused without the switch
    script = [calls(["ask_user", { questions: [{ id: "concepts", type: "concept_check", prompt: "?", paper_id: paperId }] }]), say("好")];
    await send(off.id, { text: "問我" });
    expect((await state(off.id)).toolCalls.at(-1)).toMatchObject({ tool: "ask_user", status: "failed" });

    const patched = json(await req(alice, "PATCH", `/api/agent/conversations/${off.id}`, { prereq_check: true })).conversation;
    expect(patched.prereq_check).toBe(true);
    script = [say("好")];
    requests.length = 0;
    await send(off.id, { text: "再一次" });
    expect(toolNames(requests[0]!)).toEqual(expect.arrayContaining(["extract_prerequisites", "next_concept", "add_subconcepts", "mark_concepts"]));
    expect(JSON.stringify(requests[0]!.messages[0])).toContain("先確認先備知識");
    expect((await newConversation({ prereq_check: true })).prereq_check).toBe(true);
    expect((await newConversation({ mode: "interview", prereq_check: true })).prereq_check).toBe(false);
  });

  it("extract → card (code rows, memory) → answer remembered → next_concept / mark_concepts", async () => {
    await t.db.query("INSERT INTO user_concepts(user_id,concept_key,term_en,level,source) VALUES($1,'mel-frequency cepstral coefficients','MFCC','known','checked'),($1,'hidden markov model','HMM','known','self_report')", [alice.id]);
    const conv = (await newConversation({ prereq_check: true })).id;
    const concepts = [
      { key: "connectionist temporal classification", term_en: "Connectionist Temporal Classification (CTC)", term_zh: "連結時序分類", gloss: "對齊未知時的序列損失", kind: "prerequisite", depends_on: ["hidden markov model"], centrality: "core", section: "3" },
      { key: "hidden markov model", term_en: "Hidden Markov Model (HMM)", gloss: "隱藏狀態的序列模型", kind: "prerequisite", section: "2" },
      { key: "mel-frequency cepstral coefficients", term_en: "MFCC", gloss: "語音特徵", kind: "prerequisite" },
      { term_en: "Blank label", gloss: "CTC 的空白符號", kind: "paper_defined" },
    ];
    script = [
      calls(["extract_prerequisites", { paper_id: paperId, concepts }]), // before reading: refused
      calls(["read_paper", { paper_id: paperId }]),
      calls(["extract_prerequisites", { paper_id: paperId, concepts }]),
      calls(["ask_user", { questions: [{ id: "concepts", type: "concept_check", prompt: "熟悉哪些？", paper_id: paperId, concepts: [{ key: "fake", term_en: "Fake", gloss: "x" }] }] }]),
    ];
    await send(conv, { text: "幫我講解這篇論文" });
    let s = await state(conv);
    expect(s.toolCalls.map((c: any) => [c.tool, c.status])).toEqual([["extract_prerequisites", "failed"], ["read_paper", "done"], ["extract_prerequisites", "done"], ["ask_user", "done"]]);
    expect(s.run).toMatchObject({ stop_reason: "awaiting_input" });
    const card = s.toolCalls.at(-1);
    // rows from code: leaves first, the verified MFCC is not asked, the HMM self-report pre-fills, the model's list is ignored
    expect(card.args.questions[0].concepts.map((c: any) => c.key)).toEqual(["hidden markov model", "connectionist temporal classification"]);
    expect(card.args.questions[0].concepts[0]).toMatchObject({ prefill: "known", remembered: true });
    expect(s.toolCalls[2].result.data.already_verified).toEqual(["mel-frequency cepstral coefficients"]);

    // invalid answer → 400
    expect((await req(alice, "POST", `/api/agent/conversations/${conv}/messages`, { answers: { tool_call_id: card.id, answers: [{ id: "concepts", value: ["fake=known"] }] } })).statusCode).toBe(400);

    script = [
      calls(["next_concept", { paper_id: paperId }]),
      calls(["mark_concepts", { paper_id: paperId, updates: [{ key: "hidden markov model", outcome: "understood" }] }]),
      calls(["next_concept", { paper_id: paperId, section: "3" }]),
      say("用一句話說：CTC 在解決什麼問題？（想跳過也可以）"),
    ];
    requests.length = 0;
    await send(conv, { answers: { tool_call_id: card.id, answers: [{ id: "concepts", value: ["hidden markov model=unknown", "connectionist temporal classification=heard"] }] } });
    expect(lastUserText(requests[0]!)).toContain("[hidden markov model]");
    expect(lastUserText(requests[0]!)).toContain("已記下");
    s = await state(conv);
    const tail = s.toolCalls.slice(-3);
    expect(tail.map((c: any) => [c.tool, c.status])).toEqual([["next_concept", "done"], ["mark_concepts", "done"], ["next_concept", "done"]]);
    expect(tail[0].result.data.next.key).toBe("hidden markov model");
    expect(tail[0].result.data.verify).toBe(false);
    expect(tail[2].result.data).toMatchObject({ next: { key: "connectionist temporal classification" }, mode: "recap", verify: true });
    let mem = (await t.db.query("SELECT concept_key,level,source FROM user_concepts WHERE user_id=$1 ORDER BY concept_key", [alice.id])).rows;
    expect(mem).toEqual([
      { concept_key: "connectionist temporal classification", level: "heard", source: "self_report" },
      { concept_key: "hidden markov model", level: "known", source: "self_report" },
      { concept_key: "mel-frequency cepstral coefficients", level: "known", source: "checked" },
    ]);

    script = [calls(["mark_concepts", { paper_id: paperId, updates: [{ key: "connectionist temporal classification", outcome: "explain_back_passed" }] }]), calls(["next_concept", { paper_id: paperId }]), say("好，接著講 §3")];
    await send(conv, { text: "它讓模型不用事先對齊就能訓練" });
    s = await state(conv);
    expect(s.toolCalls.at(-2).result.data.saved).toEqual([expect.objectContaining({ key: "connectionist temporal classification", level: "known", source: "checked" })]);
    expect(s.toolCalls.at(-1).result.data.next).toBeNull();
    mem = (await t.db.query("SELECT level,source,paper_id FROM user_concepts WHERE user_id=$1 AND concept_key='connectionist temporal classification'", [alice.id])).rows;
    expect(mem[0]).toEqual({ level: "known", source: "checked", paper_id: paperId });

    // A second extraction in another conversation: CTC is verified now and is not asked again.
    const conv2 = (await newConversation({ prereq_check: true })).id;
    script = [calls(["read_paper", { paper_id: paperId }]), calls(["extract_prerequisites", { paper_id: paperId, concepts }]), say("都懂了")];
    await send(conv2, { text: "再講一次" });
    s = await state(conv2);
    expect(s.toolCalls.at(-1).result.data.already_verified).toEqual(expect.arrayContaining(["connectionist temporal classification", "mel-frequency cepstral coefficients"]));
    expect(s.toolCalls.at(-1).result.data.card_rows).toBe(1);
  });

  it("/concepts: own list, change level, delete; private", async () => {
    const list = json(await req(alice, "GET", "/api/concepts")).concepts;
    expect(list.length).toBeGreaterThanOrEqual(3);
    const ctc = list.find((c: any) => c.key === "connectionist temporal classification");
    expect(ctc).toMatchObject({ level: "known", source: "checked", source_label: "已確認", paper: { id: paperId, title: "CTC for Speech" } });
    expect(json(await req(bob, "GET", "/api/concepts")).concepts).toEqual([]);
    const key = encodeURIComponent("connectionist temporal classification");
    expect((await req(alice, "PATCH", `/api/concepts/${key}`, { level: "maybe" })).statusCode).toBe(400);
    const patched = json(await req(alice, "PATCH", `/api/concepts/${key}`, { level: "heard" })).concept;
    expect(patched).toMatchObject({ level: "heard", source: "self_report", level_label: "有聽過" });
    expect((await req(bob, "PATCH", `/api/concepts/${key}`, { level: "known" })).statusCode).toBe(404);
    expect((await req(bob, "DELETE", `/api/concepts/${key}`)).statusCode).toBe(404);
    expect((await req(alice, "DELETE", `/api/concepts/${key}`)).statusCode).toBe(200);
    expect((await req(alice, "DELETE", `/api/concepts/${key}`)).statusCode).toBe(404);
    expect(json(await req(alice, "DELETE", "/api/concepts")).deleted).toBeGreaterThanOrEqual(2);
    expect(json(await req(alice, "GET", "/api/concepts")).concepts).toEqual([]);
    expect((await t.app.inject({ method: "GET", url: "/api/concepts" })).statusCode).toBe(401);
  });

  it("quiz: targets → checked questions → card without keys → graded → re-teach; edits rewind; memory switch", async () => {
    const conv = (await newConversation({ prereq_check: true })).id;
    const concepts = [
      { key: "connectionist temporal classification", term_en: "CTC", gloss: "對齊未知時的序列損失", kind: "prerequisite", centrality: "core", section: "3" },
      { key: "hidden markov model", term_en: "HMM", gloss: "隱藏狀態的序列模型", kind: "prerequisite", section: "2" },
    ];
    script = [calls(["read_paper", { paper_id: paperId }]), calls(["extract_prerequisites", { paper_id: paperId, concepts }]), calls(["ask_user", { questions: [{ id: "concepts", type: "concept_check", prompt: "?", paper_id: paperId }] }])];
    await send(conv, { text: "幫我講解這篇論文" });
    const card = (await state(conv)).toolCalls.at(-1);
    script = [
      calls(["next_concept", { paper_id: paperId }]),
      calls(["mark_concepts", { paper_id: paperId, updates: [{ key: "connectionist temporal classification", outcome: "understood" }] }]),
      calls(["next_concept", { paper_id: paperId }]),
      say("論文講完了"),
    ];
    await send(conv, { answers: { tool_call_id: card.id, answers: [{ id: "concepts", value: ["connectionist temporal classification=unknown", "hidden markov model=known"] }] } });
    let s = await state(conv);
    expect(s.toolCalls.at(-1).result.data.next).toBeNull();
    expect(s.toolCalls.at(-1).result.data.quiz).toBe(true);

    const session = async () => (await t.db.query<Session>("SELECT paper_id,concepts,answered,checks_off,quizzes FROM paper_concept_sessions WHERE conversation_id=$1", [conv])).rows[0]!;
    const opt = (text: string, correct = false) => ({ text, correct, why: correct ? "論文第三節的定義" : "常見誤解：以為需要事先對齊" });
    const q = (concept: string, level: "concept" | "apply") => ({
      concept, level, format: "choice", prompt: `${concept} 在這篇論文中的作用是什麼？`,
      options: [opt("讓模型不必事先對齊", true), opt("需要逐幀的人工標記"), opt("只用在語言模型解碼")],
      section: "3", evidence: "We use CTC on MFCC features.",
    });
    script = [
      calls(["build_quiz", { paper_id: paperId }]),
      calls(["build_quiz", { paper_id: paperId, questions: [q("connectionist temporal classification", "apply")] }]), // misses HMM
      calls(["build_quiz", { paper_id: paperId, questions: [q("connectionist temporal classification", "apply"), q("hidden markov model", "concept")] }]),
      async () => calls(["ask_user", { questions: [{ id: "quiz", type: "quiz", prompt: "小測驗", paper_id: paperId, quiz_id: (await session()).quizzes!.at(-1)!.id }] }]),
    ];
    await send(conv, { text: "考我" });
    s = await state(conv);
    const quizCalls = s.toolCalls.slice(-4);
    expect(quizCalls.map((c: any) => [c.tool, c.status])).toEqual([["build_quiz", "done"], ["build_quiz", "failed"], ["build_quiz", "done"], ["ask_user", "done"]]);
    expect(quizCalls[0].result.data.targets.map((x: any) => x.key)).toEqual(["connectionist temporal classification", "hidden markov model"]);
    expect(quizCalls[1].error).toContain("還缺：hidden markov model");
    const quizCard = quizCalls[3];
    expect(quizCard.args.questions[0].items).toHaveLength(2);
    expect(JSON.stringify(quizCard.args)).not.toMatch(/correct|why|evidence/);

    const items = (await session()).quizzes!.at(-1)!.items;
    const right = (i: number) => items[i]!.options.find((o) => o.correct)!.value;
    const wrong = (i: number) => items[i]!.options.find((o) => !o.correct)!.value;
    script = [say("第一題答錯了，我們換個角度")];
    requests.length = 0;
    await send(conv, { answers: { tool_call_id: quizCard.id, answers: [{ id: "quiz", value: JSON.stringify({ q1: { choice: wrong(0) }, q2: { choice: right(1) } }) }] } });
    expect(lastUserText(requests[0]!)).toContain("答錯");
    expect(lastUserText(requests[0]!)).toContain("next_concept");
    s = await state(conv);
    const answerMsg = s.messages.filter((m: any) => m.answers).at(-1);
    expect(answerMsg.answers.answers[0].graded.map((g: any) => g.outcome)).toEqual(["wrong", "correct"]);
    let mem = Object.fromEntries((await t.db.query("SELECT concept_key,level,source FROM user_concepts WHERE user_id=$1", [alice.id])).rows.map((r) => [r.concept_key, `${r.level}/${r.source}`]));
    expect(mem).toMatchObject({ "connectionist temporal classification": "heard/self_report", "hidden markov model": "known/checked" });
    let ctc = (await session()).concepts.find((c) => c.key === "connectionist temporal classification")!;
    expect(ctc).toMatchObject({ status: "pending", quiz: "failed" });
    // build_quiz now asks for the re-teach first
    script = [calls(["build_quiz", { paper_id: paperId }]), say("先重講")];
    await send(conv, { text: "再考一次" });
    expect((await state(conv)).toolCalls.at(-1).error).toContain("還沒重講");

    // 「修改答案」: the tutoring state goes back to before the answer, the new answer is graded on it
    script = [say("全部答對")];
    const edit = await req(alice, "POST", `/api/agent/conversations/${conv}/messages/${answerMsg.id}/edit`, { answers: { tool_call_id: quizCard.id, answers: [{ id: "quiz", value: JSON.stringify({ q1: { choice: right(0) }, q2: { choice: right(1) } }) }] } });
    expect(edit.statusCode, edit.body).toBeLessThan(300);
    await runtime().settle();
    let ss = await session();
    ctc = ss.concepts.find((c) => c.key === "connectionist temporal classification")!;
    expect(ctc).toMatchObject({ status: "done", quiz: "passed" });
    expect(ss.quizzes!.at(-1)!.status).toBe("answered");
    // ‹ 1/2 ›: back to the first version → the failed state again
    await req(alice, "POST", `/api/agent/conversations/${conv}/messages/${answerMsg.id}/activate`, {});
    ss = await session();
    expect(ss.concepts.find((c) => c.key === "connectionist temporal classification")).toMatchObject({ status: "pending", quiz: "failed" });
    // editing the first message drops the session started after it
    const first = (await state(conv)).messages.find((m: any) => m.role === "user");
    script = [say("好")];
    await req(alice, "POST", `/api/agent/conversations/${conv}/messages/${first.id}/edit`, { text: "只是打招呼" });
    await runtime().settle();
    expect((await t.db.query("SELECT 1 FROM paper_concept_sessions WHERE conversation_id=$1", [conv])).rowCount).toBe(0);

    // concept memory switch (設定 → 懂的概念): off = nothing read or written
    expect(json(await req(alice, "PATCH", "/api/agent/settings", { concept_memory: false })).settings.concept_memory).toBe(false);
    expect(await writeMemory(t.db, alice.id, paperId, [{ key: "x", term_zh: "", term_en: "X", level: "known", source: "self_report" }])).toEqual([]);
    mem = Object.fromEntries((await t.db.query("SELECT concept_key FROM user_concepts WHERE user_id=$1 AND concept_key='x'", [alice.id])).rows.map((r) => [r.concept_key, 1]));
    expect(mem).toEqual({});
    await req(alice, "PATCH", "/api/agent/settings", { concept_memory: true });
  });
});
