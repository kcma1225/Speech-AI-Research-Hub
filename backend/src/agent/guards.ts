/**
 * Loop guards of the agent runtime (pure functions; docs/research/harness-survey.md):
 *  - `truncateMiddle`: tool output capped keeping its head AND tail (openai/codex truncates the middle of exec output,
 *    so the end of a long result — totals, the last rows, a `next_offset` — is not lost).
 *  - `failureNote` / `FAILURE_STOP`: consecutive failed tool calls get a "change approach" note on the third failure and
 *    stop the run on the sixth (cline's consecutive-mistake counter, OpenHands' stuck detector "repeated errors").
 *  - `repeatNote`: an identical read repeated once gets a note instead of a silent identical result (the hard stop on
 *    the third identical call stays in the runtime).
 *  - `completionReview`: before a turn ends, a deterministic reviewer checks the final answer against what actually
 *    happened in the run (claimed writes that never succeeded; a plan left unfinished) and returns one hidden
 *    correction prompt (codex's "finish the plan before the final message", cline's completion double-check). The
 *    runtime uses it at most once per run.
 * Idea sources only; no code was copied.
 */
import { planText, unfinishedSteps, type Plan } from "./tools/plan.js";

/** Caps text for the model keeping head (≈ 70 %) and tail (≈ 30 %), cut on line breaks when possible. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (n: number) => `\n…（中間省略 ${n} 字；結果共 ${text.length} 字，請縮小範圍或分段讀取）…\n`;
  const budget = Math.max(0, max - 60);
  let headEnd = Math.floor(budget * 0.7);
  let tailStart = text.length - (budget - headEnd);
  const nlHead = text.lastIndexOf("\n", headEnd);
  if (nlHead > headEnd * 0.8) headEnd = nlHead;
  const nlTail = text.indexOf("\n", tailStart);
  if (nlTail !== -1 && nlTail - tailStart < (text.length - tailStart) * 0.2) tailStart = nlTail + 1;
  return `${text.slice(0, headEnd)}${marker(tailStart - headEnd)}${text.slice(tailStart)}`;
}

export type RunCall = { tool: string; risk: "read" | "write" | "destructive"; status: string; step: number };

/** Failed calls at the end of the run's call list (denials and cancellations do not count: the user chose them). */
export function failureStreak(calls: RunCall[]): number {
  let n = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const s = calls[i]!.status;
    if (s === "failed") n++;
    else if (s === "done") break;
  }
  return n;
}

export const FAILURE_NOTE_AT = 3;
export const FAILURE_STOP = 6;

/** Appended to the result of the third failure in a row. */
export function failureNote(streak: number): string | null {
  if (streak !== FAILURE_NOTE_AT) return null;
  return "（系統提示：已經連續 3 次工具呼叫失敗。不要用相同的方法再試；先檢查錯誤訊息（id 是否來自工具結果、參數是否正確），換一個方法，或直接向使用者說明遇到的問題。）";
}

/** Appended to an identical repeat of an earlier read in the same run. */
export const REPEAT_NOTE = "（系統提示：這個呼叫和這一輪先前的呼叫完全相同，結果也相同。不要再重複；改用其他參數（例如 offset、section）或根據已有資料回答。）";

// ---------------------------------------------------------------- completion review

/** "I created / added / updated … <object>" in zh-TW or English (completed claims only: 已… / …了 / passive …已…). */
const VERB = "(?:建立|新增|建好|加入|加上|更新|修改|刪除|移除|匯入|設定|標記|排定|產生)";
const OBJ = "(?:筆記|待辦|任務|里程碑|簡報|文獻|研究簡述|建議|記憶|章節|草稿)";
const CLAIMS = [
  new RegExp(`已經?\\s*(?:幫你|為你|替你)?\\s*(?:成功)?${VERB}[^。！？\\n]{0,20}?${OBJ}`),
  new RegExp(`${VERB}了[^。！？\\n]{0,20}?${OBJ}`),
  new RegExp(`${OBJ}[^。！？\\n]{0,30}?已經?(?:成功)?${VERB}`),
  /\bI(?:'ve| have)?\s+(?:just\s+|now\s+|successfully\s+)?(?:created|added|updated|deleted|removed|imported|saved)\b/i,
];

export function claimsWrite(text: string): string | null {
  for (const re of CLAIMS) {
    const m = text.match(re);
    if (m) return m[0].trim().slice(0, 60);
  }
  return null;
}

export type CompletionFacts = {
  /** The final answer the model just produced (no tool calls). */
  text: string;
  /** Tool calls since the last user message (this turn, across runs: approvals and 「繼續」 resume it), in order. */
  calls: RunCall[];
  /** Whether any write succeeded earlier on the current branch (the answer may refer to it). */
  earlierWrite: boolean;
  /** The latest plan when it was set or changed in this turn, else null. */
  plan: Plan | null;
};

/** One hidden correction prompt when the final answer does not match the run, else null. */
export function completionReview(f: CompletionFacts): string | null {
  const issues: string[] = [];
  const writes = f.calls.filter((c) => c.risk !== "read");
  const claim = claimsWrite(f.text);
  const failed = writes.filter((c) => c.status === "failed" || c.status === "denied" || c.status === "cancelled");
  // Fires when nothing was written in this turn and either a write of this turn failed or nothing was ever written
  // here (an answer that refers to an earlier turn's write is fine).
  if (claim && !writes.some((c) => c.status === "done") && (failed.length || !f.earlierWrite)) {
    issues.push(
      failed.length
        ? `你的回答提到「${claim}」，但這一輪的寫入操作沒有成功（${failed.map((c) => `${c.tool}：${c.status === "denied" ? "使用者拒絕" : c.status === "cancelled" ? "已取消" : "失敗"}`).join("、")}）。`
        : `你的回答提到「${claim}」，但這一輪沒有執行任何寫入工具，所以什麼都還沒有被建立或修改。`,
    );
  }
  const open = f.plan ? unfinishedSteps(f.plan) : [];
  if (open.length) issues.push(`工作計畫還有 ${open.length} 個步驟沒有完成：\n${planText(f.plan!)}`);
  if (!issues.length) return null;
  return [
    "（系統檢查，不是使用者的訊息）在結束這一輪之前，請修正下面的問題：",
    ...issues.map((s, i) => `${i + 1}. ${s}`),
    "做法：若還有該做的步驟，現在就呼叫對應的工具繼續；若步驟其實已完成或不再需要，呼叫 update_plan 更新計畫；若做不到，在回答中誠實說明哪些沒有完成、為什麼。不要聲稱沒有發生的操作。修正後給出最後的回答（不要提到這則系統檢查）。",
  ].join("\n");
}

/** Reminder of an unfinished plan for the model context (after compaction the original call may be gone). */
export function planReminder(plan: Plan | null): string | null {
  if (!plan || !unfinishedSteps(plan).length) return null;
  return `<current_plan trust="derived" note="你先前用 update_plan 設定的工作計畫；完成步驟後記得更新">\n${planText(plan)}\n</current_plan>`;
}
