import { describe, expect, it } from "vitest";
import { buildTranscript, dropSupersededNotices, workflowIdOf, categoryOf, countActivity, hasActivity, latestPlan, turnSeconds, type AssistantTurn } from "./transcript.ts";
import type { Message, ToolCall } from "./types.ts";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 8, 0, s)).toISOString();
function msg(role: Message["role"], text = "", extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, seq, run_id: "r1", role, text, reasoning: "", status: "complete", page_context: null, kind: null, memories: [], created_at: at(seq), ...extra };
}
let pos = 0;
function call(m: Message, tool: string, extra: Partial<ToolCall> = {}): ToolCall {
  pos++;
  return {
    id: `c${pos}`, run_id: "r1", message_id: m.id, step: 1, position: pos, tool, title: tool, title_en: tool, risk: "read", always_ask: false, grantable: false,
    open_world: false, status: "done", approved_via: null, approval_reason: null, decided_at: null, deny_reason: null, summary: tool, target: null, args: {}, edited: false,
    result: null, error: null, provenance: [], created_at: m.created_at, finished_at: m.created_at, ...extra,
  };
}
const plan = (m: Message, steps: [string, "pending" | "in_progress" | "completed"][]) => call(m, "update_plan", { args: { plan: steps.map(([step, status]) => ({ step, status })) } });
const turns = (items: ReturnType<typeof buildTranscript>) => items.filter((i): i is AssistantTurn => i.kind === "assistant");

describe("transcript grouping", () => {
  it("folds every step of a turn into one group with one plan (the newest state)", () => {
    const u = msg("user", "幫我讀這篇論文並建立筆記");
    const a1 = msg("assistant", "我先列出計畫。");
    const a2 = msg("assistant", "", { reasoning: "想一下章節" });
    const a3 = msg("assistant", "接著建立筆記。");
    const a4 = msg("assistant", "完成了：筆記已建立。");
    const calls = [
      plan(a1, [["讀目錄", "in_progress"], ["讀方法", "pending"], ["建立筆記", "pending"]]),
      call(a1, "read_paper"),
      plan(a2, [["讀目錄", "completed"], ["讀方法", "in_progress"], ["建立筆記", "pending"]]),
      call(a2, "read_paper"),
      call(a2, "view_paper_pages", { args: { pages: [3, 4, 5] } }),
      call(a3, "create_note", { risk: "write", result: { data: {}, links: [{ label: "開啟筆記", url: "/notes/n1" }], source: null } }),
      plan(a3, [["讀目錄", "completed"], ["讀方法", "completed"], ["建立筆記", "completed"]]),
    ];
    const items = buildTranscript([u, a1, a2, a3, a4], calls);
    expect(items.map((i) => i.kind)).toEqual(["message", "assistant"]);
    const [t] = turns(items);
    expect(t!.final?.id).toBe(a4.id);
    expect(t!.steps.map((m) => m.id)).toEqual([a1.id, a2.id, a3.id]);
    expect(t!.plan).toMatchObject({ done: 3, total: 3, updates: 3, current: null });
    expect(t!.activity.map((c) => c.tool)).toEqual(["read_paper", "read_paper", "view_paper_pages", "create_note"]);
    expect(t!.counts).toEqual({ section: 2, page: 3, create: 1 });
    expect(t!.results.map((c) => c.tool)).toEqual(["create_note"]);
    expect(t!.key).toBe(`turn:${u.id}`);
    expect(hasActivity(t!)).toBe(true);
    expect(turnSeconds(t!)).toBe(4);
  });

  it("splits turns at user messages and keeps cards that need action visible", () => {
    const u1 = msg("user", "Q1");
    const a1 = msg("assistant", "請回答幾個問題");
    const ask = call(a1, "ask_user", { args: { questions: [{ id: "q", prompt: "?", type: "short_text" }] } });
    const u2 = msg("user", "", { answers: { toolCallId: ask.id, answers: [{ id: "q", value: "x" }] } });
    const a2 = msg("assistant", "要建立待辦嗎？");
    const pending = call(a2, "create_task", { risk: "write", status: "pending_approval" });
    const wf = call(a2, "start_workflow", { result: { data: { workflow_id: "w1" }, links: [], source: null } });
    const t = turns(buildTranscript([u1, a1, u2, a2], [ask, pending, wf], { answered: new Set([ask.id]) }));
    expect(t).toHaveLength(2);
    expect(t[0]!.asks).toHaveLength(0); // answered → shown by the answer message
    expect(t[1]!.pending.map((c) => c.id)).toEqual([pending.id]);
    expect(t[1]!.workflows.map((c) => c.id)).toEqual([wf.id]);
    expect(t[1]!.activity).toHaveLength(0);
    expect(t[1]!.final?.id).toBe(a2.id);
    const open = turns(buildTranscript([u1, a1], [ask]));
    expect(open[0]!.asks.map((c) => c.id)).toEqual([ask.id]);
  });

  it("a deletion autopilot deferred stays an open card of a finished turn until decided", () => {
    const u = msg("user", "刪掉舊待辦並新增一個");
    const a1 = msg("assistant", "");
    const a2 = msg("assistant", "完成；刪除等待你確認。");
    const created = call(a1, "create_task", { risk: "write", approved_via: "autopilot" });
    const del = call(a1, "delete_task", { risk: "destructive", status: "deferred", deferred: true, approval_reason: "destructive" });
    const [t] = turns(buildTranscript([u, a1, a2], [created, del]));
    expect(t!.final?.id).toBe(a2.id);
    expect(t!.pending.map((c) => c.id)).toEqual([del.id]);
    expect(t!.activity.map((c) => c.id)).toEqual([created.id]);
    const [after] = turns(buildTranscript([u, a1, a2], [created, { ...del, status: "done" }]));
    expect(after!.pending).toHaveLength(0);
  });

  it("start_goal / a start_workflow routed to a goal carry the goal card", () => {
    const u = msg("user", "幫我寫一篇論文");
    const a = msg("assistant", "我先排路線圖。");
    const goal = call(a, "start_goal", { result: { data: { goal_id: "g1" }, links: [], source: null } });
    const routed = call(a, "start_workflow", { result: { data: { goal_id: "g2" }, links: [], source: null } });
    const t = turns(buildTranscript([u, a], [goal, routed]));
    expect(t[0]!.workflows.map((c) => workflowIdOf(c))).toEqual(["goal:g1", "goal:g2"]);
    expect(t[0]!.activity).toHaveLength(0);
  });

  it("a live turn has no final answer yet, and an empty live turn exists before the first step", () => {
    const u = msg("user", "Q");
    const a = msg("assistant", "我先查一下。");
    const running = call(a, "search", { status: "running", finished_at: null });
    const [live] = turns(buildTranscript([u, a], [running], { live: true }));
    expect(live!.live).toBe(true);
    expect(live!.final).toBeNull();
    expect(live!.steps.map((m) => m.id)).toEqual([a.id]);
    const answer = msg("assistant", "答案");
    expect(turns(buildTranscript([u, a, answer], [{ ...running, status: "done" }], { live: true }))[0]!.final?.id).toBe(answer.id);
    const empty = buildTranscript([u], [], { live: true });
    expect(empty.at(-1)).toMatchObject({ kind: "assistant", live: true, key: `turn:${u.id}` });
    expect(buildTranscript([u], [])).toHaveLength(1);
  });

  it("counts failures and denials apart and skips uncounted tools", () => {
    const m = msg("assistant", "x");
    const r = countActivity([
      call(m, "get_note"),
      call(m, "get_note", { status: "failed" }),
      call(m, "delete_task", { risk: "destructive", status: "denied" }),
      call(m, "update_plan"),
      call(m, "suggest_note_edit", { risk: "write" }),
      call(m, "search_papers_online"),
    ]);
    expect(r).toEqual({ counts: { read: 1, suggest: 1, search: 1 }, failed: 1, denied: 1 });
    expect(categoryOf({ tool: "latex_suggest_edit", risk: "write" })).toBe("suggest");
    expect(categoryOf({ tool: "update_task", risk: "write" })).toBe("edit");
    expect(categoryOf({ tool: "remove_paper_from_study", risk: "destructive" })).toBe("delete");
    expect(categoryOf({ tool: "ask_user", risk: "read" })).toBeNull();
  });

  it("parses the newest plan defensively", () => {
    const m = msg("assistant");
    expect(latestPlan([call(m, "update_plan", { args: { plan: "x" } })])).toBeNull();
    const p = latestPlan([plan(m, [["a", "completed"], ["b", "in_progress"]]), call(m, "update_plan", { args: { plan: [{ step: "a", status: "completed" }, { step: "b", status: "weird" }, { nope: 1 }] }, status: "failed" })]);
    expect(p).toMatchObject({ done: 1, total: 2, current: "b", updates: 1 });
  });

  it("notices stay with their turn; compaction rows split turns", () => {
    const u = msg("user", "Q");
    const a = msg("assistant", "部分完成");
    const n = msg("notice", "", { kind: "limit_steps" });
    const c = msg("compaction");
    const items = buildTranscript([u, a, n, c], []);
    expect(items.map((i) => i.kind)).toEqual(["message", "assistant", "message"]);
    expect(turns(items)[0]!.notices.map((m) => m.id)).toEqual([n.id]);
  });
});

describe("dropSupersededNotices", () => {
  const partial = (wf: string, text = "p") => msg("notice", text, { kind: "workflow_partial", items: ["a"], workflow_id: wf });
  it("keeps only the newest partial summary per run", () => {
    const a1 = partial("w1"), b1 = partial("w2"), a2 = partial("w1");
    const out = dropSupersededNotices([msg("user", "q"), a1, b1, a2, msg("assistant", "ok")]);
    expect(out).not.toContain(a1);
    expect(out).toContain(b1);
    expect(out).toContain(a2);
  });
  it("keeps a quiet status notice only when it is the last message", () => {
    const n1 = msg("notice", "需要你補充資訊", { kind: "workflow_awaiting_input" });
    const n2 = msg("notice", "已完成", { kind: "workflow_done" });
    const other = msg("notice", "其他", { kind: "compaction_note" });
    expect(dropSupersededNotices([n1, other, n2])).toEqual([other, n2]);
  });
  it("never shows 'please act' notices: the card carries the prompt", () => {
    const plan = msg("notice", "工作計畫已擬好，請確認後按「開始」", { kind: "workflow_awaiting_plan_approval" });
    const goal = msg("notice", "路線圖待確認", { kind: "goal_awaiting_approval" });
    const pdf = msg("notice", "需要 PDF", { kind: "workflow_needs_pdf" });
    expect(dropSupersededNotices([pdf, goal, plan])).toEqual([]);
  });
});

describe("turn duration", () => {
  it("does not count the time a deferred delete waited for the user", () => {
    const u = msg("user", "刪掉它");
    const a = msg("assistant", "已排入待確認");
    const del = call(a, "delete_task", { status: "done", created_at: a.created_at, decided_at: "2099-01-01T00:00:00.000Z", finished_at: "2099-01-01T00:00:01.000Z" });
    const turn = buildTranscript([u, a], [del]).find((x) => x.kind === "assistant") as AssistantTurn;
    expect(turn.endedAt).toBe(a.created_at);
  });
});
