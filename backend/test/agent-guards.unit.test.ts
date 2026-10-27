/** Loop guards (src/agent/guards.ts) and the update_plan tool schema: pure logic, no database. */
import { describe, expect, it } from "vitest";
import { claimsWrite, completionReview, failureNote, failureStreak, planReminder, truncateMiddle, type RunCall } from "../src/agent/guards.js";
import { capResult, RESULT_MAX_CHARS, toModelMessages, type StoredMessage } from "../src/agent/prompt.js";
import { getAgentTool } from "../src/agent/tools/index.js";
import { updatePlanInput } from "../src/agent/tools/plan.js";

const c = (tool: string, risk: RunCall["risk"], status: string, step = 0): RunCall => ({ tool, risk, status, step });

describe("truncateMiddle", () => {
  it("keeps short text and cuts long text in the middle, keeping head and tail", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
    const lines = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
    const out = truncateMiddle(lines, 3000);
    expect(out.length).toBeLessThanOrEqual(3000 + 120);
    expect(out.startsWith("row 0\n")).toBe(true);
    expect(out.endsWith("row 1999")).toBe(true);
    expect(out).toMatch(/中間省略 \d+ 字/);
    // cut on line boundaries
    expect(out.split("\n").filter((l) => l.startsWith("row")).every((l) => /^row \d+$/.test(l))).toBe(true);
  });
  it("capResult keeps the end of a long result (e.g. next_offset)", () => {
    const text = `${"x".repeat(30_000)}"next_offset":12000}`;
    const out = capResult(text);
    expect(out.length).toBeLessThan(RESULT_MAX_CHARS + 200);
    expect(out.endsWith('"next_offset":12000}')).toBe(true);
  });
});

describe("failure streak", () => {
  it("counts trailing failures; denials and pending calls do not break or count", () => {
    expect(failureStreak([])).toBe(0);
    expect(failureStreak([c("a", "read", "failed"), c("b", "read", "done"), c("c", "read", "failed"), c("d", "write", "denied"), c("e", "read", "failed")])).toBe(2);
    expect(failureStreak([c("a", "read", "failed"), c("a", "read", "failed"), c("a", "read", "failed")])).toBe(3);
    expect(failureNote(3)).toContain("連續 3 次");
    expect(failureNote(2)).toBeNull();
    expect(failureNote(4)).toBeNull();
  });
});

describe("completion review", () => {
  it("detects completed-write claims, not offers or explanations", () => {
    expect(claimsWrite("我已經幫你建立筆記「閱讀筆記：wav2vec」。")).toBeTruthy();
    expect(claimsWrite("已新增 3 個待辦到〈語音情緒辨識〉。")).toBeTruthy();
    expect(claimsWrite("閱讀筆記已建立，你可以在筆記頁查看。")).toBeTruthy();
    expect(claimsWrite("I've created the note for you.")).toBeTruthy();
    expect(claimsWrite("要不要我幫你建立一篇筆記？")).toBeNull();
    expect(claimsWrite("作者提出了一個新的自監督方法，在三個資料集上評估。")).toBeNull();
    expect(claimsWrite("The dataset was created by the authors in 2020.")).toBeNull();
  });
  it("asks for a correction when nothing was written in the turn", () => {
    const nudge = completionReview({ text: "已幫你建立筆記「實驗紀錄」。", calls: [c("get_note", "read", "done")], earlierWrite: false, plan: null });
    expect(nudge).toContain("沒有執行任何寫入工具");
    expect(nudge).toContain("系統檢查");
  });
  it("names the failed / denied writes", () => {
    const nudge = completionReview({ text: "已新增待辦「整理數據」。", calls: [c("create_task", "write", "denied")], earlierWrite: true, plan: null });
    expect(nudge).toContain("create_task：使用者拒絕");
  });
  it("accepts a claim backed by a successful write, or one that refers to an earlier turn", () => {
    expect(completionReview({ text: "已新增待辦「整理數據」。", calls: [c("create_task", "write", "done")], earlierWrite: false, plan: null })).toBeNull();
    expect(completionReview({ text: "上一輪已建立的筆記在這裡。", calls: [], earlierWrite: true, plan: null })).toBeNull();
    expect(completionReview({ text: "這篇論文的方法分三步。", calls: [], earlierWrite: false, plan: null })).toBeNull();
  });
  it("flags an unfinished plan of this turn", () => {
    const plan = { plan: [{ step: "讀取方法章節", status: "completed" as const }, { step: "建立閱讀筆記", status: "in_progress" as const }] };
    const nudge = completionReview({ text: "完成了。", calls: [c("update_plan", "read", "done")], earlierWrite: false, plan });
    expect(nudge).toContain("1 個步驟沒有完成");
    expect(nudge).toContain("[~] 建立閱讀筆記");
    expect(completionReview({ text: "完成了。", calls: [], earlierWrite: false, plan: { plan: [{ step: "a", status: "completed" }] } })).toBeNull();
    expect(planReminder(plan)).toContain("<current_plan");
    expect(planReminder({ plan: [{ step: "a", status: "completed" }] })).toBeNull();
  });
});

describe("update_plan", () => {
  it("allows at most one in_progress step and 1–12 steps", () => {
    expect(updatePlanInput.safeParse({ plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "pending" }] }).success).toBe(true);
    expect(updatePlanInput.safeParse({ plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }] }).success).toBe(false);
    expect(updatePlanInput.safeParse({ plan: [] }).success).toBe(false);
    expect(updatePlanInput.safeParse({ plan: Array.from({ length: 13 }, (_, i) => ({ step: `s${i}`, status: "pending" })) }).success).toBe(false);
  });
  it("is a chat-only read tool, not on MCP, summarised with progress", () => {
    const def = getAgentTool("update_plan")!;
    expect(def).toMatchObject({ risk: "read", mcp: false, modes: ["chat"] });
    expect(def.summarize({ plan: [{ step: "讀論文", status: "completed" }, { step: "寫筆記", status: "in_progress" }] } as never)).toBe("計畫 1/2：寫筆記");
  });
});

describe("cleared tool results", () => {
  it("name the call and its arguments so the model can repeat it", () => {
    const rows: StoredMessage[] = [
      { id: "1", seq: "1", role: "user", content: [{ type: "text", text: "q" }], text: "q", reasoning: "", provider_state: null, status: "complete" },
      { id: "2", seq: "2", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_paper", input: { paper_id: "p1", section: "3" } }], text: "", reasoning: "", provider_state: null, status: "complete" },
      { id: "3", seq: "3", role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "long text" }], text: "", reasoning: "", provider_state: null, status: "complete" },
    ];
    const msgs = toModelMessages(rows, { clearOldResults: true, keepResults: 0 });
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(JSON.stringify(tool.content)).toContain('read_paper {\\"paper_id\\":\\"p1\\",\\"section\\":\\"3\\"}');
    expect(JSON.stringify(tool.content)).toContain("相同參數重新呼叫");
  });
});

describe("completion review: paper tutoring (staging: 「情境偏置（已講解）」 in the plan, no message explained it)", () => {
  const plan = { plan: [{ step: "補概念 1/6：情境偏置", status: "in_progress" as const }, { step: "講解論文", status: "pending" as const }] };
  const term = "情境偏置（contextual biasing）";
  it("an untaught concept is a correction; the open plan is not (the turn waits for the user)", () => {
    const nudge = completionReview({ text: "", calls: [], earlierWrite: false, plan, teaching: term })!;
    expect(nudge).toContain("沒有講解它");
    expect(nudge).not.toContain("工作計畫還有");
  });
  it("a taught concept ends the turn cleanly, plan open or not", () => {
    const text = "情境偏置（contextual biasing）就是在辨識時給模型一份詞清單，讓清單裡的罕見詞更容易被選中；這篇論文用它來補 Whisper 認不出聯絡人名字的問題。用一句話說：它在做什麼？";
    expect(completionReview({ text, calls: [], earlierWrite: false, plan, teaching: term })).toBeNull();
    expect(completionReview({ text: "Contextual biasing feeds the decoder a list of rare words so they win more often; the paper uses it for names Whisper misses.", calls: [], earlierWrite: false, plan: null, teaching: term })).toBeNull();
  });
  it("without tutoring the plan check is unchanged", () => {
    expect(completionReview({ text: "好了", calls: [], earlierWrite: false, plan })).toContain("工作計畫還有");
  });
});

