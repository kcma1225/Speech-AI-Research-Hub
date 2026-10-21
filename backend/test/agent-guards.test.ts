/**
 * Agent runtime guards with a scripted mock model (docs/research/harness-survey.md): update_plan checklist, completion
 * review before a turn ends, failure-streak note + stop, repeat note, wrap-up reply at the step limit, concurrent reads,
 * head+tail truncation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { z } from "zod";
import type { ChatEvent } from "../src/ai/types.js";
import { AiError } from "../src/ai/errors.js";
import { agentFor, type ModelCall } from "../src/agent/runtime.js";
import type { RoleChatRequest } from "../src/ai/platform/index.js";
import { registerAgentTool } from "../src/agent/tools/index.js";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";
import { insertStudy } from "./study-fixtures.js";

let ids = 0;
const call = (name: string, input: unknown, id = `call_${++ids}`) => [
  { type: "tool_call_start", index: 0, id, name } as ChatEvent,
  { type: "tool_call_end", index: 0, id, name, input, argsJson: JSON.stringify(input) } as ChatEvent,
];
const calls = (...list: [string, unknown][]): ChatEvent[] => [...list.flatMap(([n, i]) => call(n, i)), { type: "done", stopReason: "tool_use" }];
const say = (text: string): ChatEvent[] => [{ type: "text_delta", text }, { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }, { type: "done", stopReason: "end_turn" }];
const textOf = (req: RoleChatRequest) => JSON.stringify(req.messages);

let active = 0;
let peak = 0;
registerAgentTool({
  name: "test_slow_read",
  title: "測試讀取",
  titleEn: "Test read",
  risk: "read",
  description: "test",
  input: z.object({ n: z.number() }),
  summarize: (a) => `測試 ${a.n}`,
  async execute(a) {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 400));
    active--;
    return { data: { n: a.n } };
  },
});
registerAgentTool({
  name: "test_big_read",
  title: "大結果",
  titleEn: "Big result",
  risk: "read",
  description: "test",
  input: z.object({}),
  summarize: () => "大結果",
  async execute() {
    return { data: null, text: `${Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")}\nTOTAL=3000` };
  },
});

describe.skipIf(!hasTestDb)("agent guards", () => {
  let t: TestContext;
  let alice: { id: string; cookie: string };
  let study: { id: string; slug: string };
  let script: (ChatEvent[] | ((req: RoleChatRequest) => ChatEvent[]))[] = [];
  const requests: RoleChatRequest[] = [];
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const post = (url: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: alice.cookie }, payload });
  const runtime = () => agentFor(t.app);
  const model: ModelCall = async function* (req) {
    requests.push(structuredClone({ ...req, signal: undefined }) as RoleChatRequest);
    const step = script.shift() ?? say("（沒有更多腳本）");
    for (const e of typeof step === "function" ? step(req) : step) yield e;
  };
  const newConversation = async () => json(await post("/api/agent/conversations", {})).conversation.id as string;
  async function send(conv: string, text: string) {
    const r = await post(`/api/agent/conversations/${conv}/messages`, { text });
    expect(r.statusCode, r.body).toBe(202);
    await runtime().settle();
  }
  const state = async (conv: string) => json(await t.app.inject({ method: "GET", url: `/api/agent/conversations/${conv}`, headers: { cookie: alice.cookie } }));
  const toolResults = (req: RoleChatRequest) => req.messages.filter((m) => m.role === "tool").flatMap((m) => (Array.isArray(m.content) ? (m.content as { content: string }[]) : []));

  beforeAll(async () => {
    t = await createTestContext();
    alice = await t.login("student", "Alice");
    study = await insertStudy(t.db, alice.id, "語音情緒辨識");
    runtime().options.model = model;
    runtime().options.fast = async () => "測試標題";
  });
  afterAll(async () => {
    await runtime().settle();
    await t?.close();
  });
  beforeEach(() => {
    script = [];
    requests.length = 0;
    runtime().options.limits = {};
  });

  it("update_plan runs without a card and is kept on the tool call for the checklist", async () => {
    const conv = await newConversation();
    const plan = [{ step: "讀取研究進度", status: "in_progress" }, { step: "整理摘要", status: "pending" }];
    script = [
      calls(["update_plan", { plan }]),
      calls(["update_plan", { plan: [{ step: "讀取研究進度", status: "completed" }, { step: "整理摘要", status: "completed" }] }]),
      say("整理好了：目前進度如下。"),
    ];
    await send(conv, "幫我整理進度");
    const s = await state(conv);
    expect(s.run.status).toBe("done");
    expect(s.toolCalls.map((c: any) => [c.tool, c.status])).toEqual([["update_plan", "done"], ["update_plan", "done"]]);
    expect(s.toolCalls[0].args.plan).toEqual(plan);
    expect(s.toolCalls[0].summary).toBe("計畫 0/2：讀取研究進度");
    expect(toolResults(requests[1]!)[0]!.content).toContain("計畫已更新（0/2 完成）");
    // all steps done → no review round
    expect(requests).toHaveLength(3);
  });

  it("two in_progress steps fail validation and are reported to the model", async () => {
    const conv = await newConversation();
    script = [calls(["update_plan", { plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }] }]), say("好")];
    await send(conv, "x");
    const s = await state(conv);
    expect(s.toolCalls[0]).toMatchObject({ status: "failed" });
    expect(s.toolCalls[0].error).toContain("in_progress");
  });

  it("completion review: a claimed write that never happened gets one hidden correction round", async () => {
    const conv = await newConversation();
    script = [say("我已經幫你建立筆記「實驗紀錄」。"), say("抱歉，我還沒有建立筆記；要我現在建立嗎？")];
    await send(conv, "記一下實驗");
    const s = await state(conv);
    expect(requests).toHaveLength(2);
    const second = textOf(requests[1]!);
    expect(second).toContain("我已經幫你建立筆記");
    expect(second).toContain("系統檢查");
    expect(s.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.text)).toEqual(["抱歉，我還沒有建立筆記；要我現在建立嗎？"]);
    // the hidden prompt is not stored
    expect(JSON.stringify(s.messages)).not.toContain("系統檢查");
  });

  it("completion review: an unfinished plan is flagged once; the correction may continue with tools", async () => {
    const conv = await newConversation();
    script = [
      calls(["update_plan", { plan: [{ step: "查研究", status: "in_progress" }, { step: "回答", status: "pending" }] }]),
      say("你的研究是語音情緒辨識。"),
      calls(["update_plan", { plan: [{ step: "查研究", status: "completed" }, { step: "回答", status: "completed" }] }]),
      say("你的研究是語音情緒辨識。"),
    ];
    await send(conv, "我的研究是什麼？");
    const s = await state(conv);
    expect(textOf(requests[2]!)).toContain("工作計畫還有 2 個步驟沒有完成");
    expect(s.toolCalls.filter((c: any) => c.tool === "update_plan")).toHaveLength(2);
    expect(s.messages.at(-1).text).toBe("你的研究是語音情緒辨識。");
    expect(requests).toHaveLength(4);
  });

  it("completion review keeps the draft when the corrected reply comes back empty", async () => {
    const conv = await newConversation();
    script = [say("已新增待辦「整理數據」。"), [{ type: "done", stopReason: "end_turn" }]];
    await send(conv, "x");
    const s = await state(conv);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "已新增待辦「整理數據」。" });
    expect(s.run.stop_reason).toBeNull();
  });

  it("no review after a real write; review can be switched off", async () => {
    const conv = await newConversation();
    runtime().options.limits = {};
    await t.db.query("UPDATE conversations SET autopilot=true WHERE id=$1", [conv]);
    script = [calls(["create_task", { study: study.slug, title: "整理數據" }]), say("已新增待辦「整理數據」。")];
    await send(conv, "新增待辦");
    expect(requests).toHaveLength(2);
    runtime().options.review = false;
    const conv2 = await newConversation();
    script = [say("已建立筆記。")];
    await send(conv2, "x");
    expect(requests).toHaveLength(3);
    runtime().options.review = undefined;
  });

  it("an identical read gets a note on its second call", async () => {
    const conv = await newConversation();
    script = [calls(["list_studies", { member: "me" }]), calls(["list_studies", { member: "me" }]), say("好")];
    await send(conv, "x");
    const res = toolResults(requests[2]!);
    expect(res.at(-1)!.content).toContain("完全相同");
    expect(res[0]!.content).not.toContain("完全相同");
  });

  it("three failures in a row get a change-approach note; six stop the run", async () => {
    const conv = await newConversation();
    script = [calls(["no_such_tool", {}]), calls(["no_such_tool", { a: 1 }]), calls(["no_such_tool", { a: 2 }]), calls(["no_such_tool", { a: 3 }]), calls(["no_such_tool", { a: 4 }]), calls(["no_such_tool", { a: 5 }]), say("x")];
    await send(conv, "x");
    const s = await state(conv);
    expect(toolResults(requests[3]!).at(-1)!.content).toContain("連續 3 次工具呼叫失敗");
    expect(toolResults(requests[3]!).filter((r) => r.content.includes("連續 3 次"))).toHaveLength(1);
    expect(s.run).toMatchObject({ status: "done", stop_reason: "stuck" });
    expect(s.messages.at(-1)).toMatchObject({ role: "notice", kind: "stuck" });
    expect(s.toolCalls).toHaveLength(6);
  });

  it("at the step limit the model gives a tool-less wrap-up before the notice", async () => {
    runtime().options.limits = { maxSteps: 2 };
    const conv = await newConversation();
    script = [calls(["list_studies", {}]), calls(["list_tasks", {}]), (req) => (req.toolChoice === "none" ? [...say("已查了研究與待辦；還沒整理。"), ...call("list_notes", {})] : say("wrong"))];
    await send(conv, "一直查");
    const s = await state(conv);
    expect(requests.at(-1)!.toolChoice).toBe("none");
    expect(textOf(requests.at(-1)!)).toContain("步數上限");
    expect(s.run).toMatchObject({ status: "done", stop_reason: "limit_steps" });
    const tail = s.messages.slice(-2);
    expect(tail[0]).toMatchObject({ role: "assistant", text: "已查了研究與待辦；還沒整理。" });
    expect(tail[1]).toMatchObject({ role: "notice", kind: "limit_steps" });
    // a tool call in the wrap-up is dropped (no open step)
    expect(s.toolCalls.map((c: any) => c.tool)).toEqual(["list_studies", "list_tasks"]);
  });

  it("runs the reads of one step concurrently (bounded) and keeps their order in the transcript", async () => {
    peak = 0;
    const conv = await newConversation();
    script = [calls(...Array.from({ length: 6 }, (_, i) => ["test_slow_read", { n: i }] as [string, unknown])), say("好")];
    await send(conv, "x");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    const res = toolResults(requests[1]!);
    expect(res.map((r) => JSON.parse(r.content.split("\n")[1]!).n)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a context-too-long rejection compacts harder and retries once", async () => {
    const conv = await newConversation();
    script = [calls(["test_big_read", {}]), say("第一題的答案。")];
    await send(conv, "第一題");
    script = [
      () => {
        throw new AiError("context_too_long");
      },
      say("第二題的答案。"),
    ];
    await send(conv, "第二題");
    const s = await state(conv);
    expect(s.run.status).toBe("done");
    expect(s.messages.at(-1).text).toBe("第二題的答案。");
    expect(s.messages.some((m: any) => m.role === "compaction")).toBe(true);
    const retry = textOf(requests.at(-1)!);
    expect(retry).toContain("conversation_summary");
    expect(retry).not.toContain("line 1500");
  });

  it("caps big results keeping head and tail", async () => {
    const conv = await newConversation();
    script = [calls(["test_big_read", {}]), say("好")];
    await send(conv, "x");
    const r = toolResults(requests[1]!)[0]!.content;
    expect(r).toContain("line 0\n");
    expect(r).toContain("TOTAL=3000");
    expect(r).toMatch(/中間省略/);
  });
});
