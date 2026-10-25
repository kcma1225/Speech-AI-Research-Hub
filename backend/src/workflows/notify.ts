/**
 * Telling the owner: a `notice` message in the conversation that started the run (never part of the model transcript)
 * and a notification (in-app always; Web Push when the process has VAPID keys).
 */
import type { FastifyBaseLogger } from "fastify";
import { insertEvent } from "../agent/events.js";
import { messageView, type MessageRow } from "../agent/views.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db.js";
import { Notifier } from "../lib/notify.js";
import { focusHref } from "./active.js";
import type { WorkflowEnv } from "./env.js";
import type { RunRow } from "./types.js";

const silent = { warn() {}, info() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silent; }, level: "silent" } as unknown as FastifyBaseLogger;
let notifier: Notifier | null | undefined;
function pusher(db: Db) {
  if (notifier === undefined) {
    try {
      notifier = new Notifier(db, silent, loadConfig());
    } catch {
      notifier = null;
    }
  }
  return notifier;
}

export type NoticeKind = "awaiting_plan_approval" | "awaiting_input" | "needs_pdf" | "ai_filled" | "done" | "partial" | "failed" | "cancelled";

const TEXT: Record<NoticeKind, (t: string) => { notice: string; title: string } | null> = {
  awaiting_plan_approval: (t) => ({ notice: `工作計畫「${t}」已擬好，請確認後按「開始」。`, title: "工作計畫待確認" }),
  awaiting_input: (t) => ({ notice: `工作流程「${t}」需要你補充資訊才能繼續。`, title: "工作流程需要你的回覆" }),
  needs_pdf: (t) => ({ notice: `工作流程「${t}」找不到這篇論文的 PDF，先跳過；貼上 PDF 網址（「從網址下載 PDF」）或上傳後就能繼續。`, title: "需要 PDF" }),
  ai_filled: (t) => ({ notice: `自動駕駛替你代填了「${t}」的學生自填頁（標示「AI 代填，待你確認」），請確認，或按「修改答案」換成你自己的看法。`, title: "AI 代填了你的頁面，待你確認" }),
  done: (t) => ({ notice: `工作流程「${t}」已完成，所有驗收標準都通過。`, title: "工作流程已完成" }),
  partial: (t) => ({ notice: `工作流程「${t}」已結束，但還有未通過的驗收標準；可以按「繼續改」。`, title: "工作流程部分完成" }),
  failed: (t) => ({ notice: `工作流程「${t}」無法完成。`, title: "工作流程失敗" }),
  cancelled: () => null,
};

/**
 * What a partial run left unmet, in plain words (failed / unjudged criteria, else failed steps), ≤ 6 items: the chat
 * notice lists them with 「要我修這幾項嗎？」 (→ 繼續改 with these items as guidance).
 */
/**
 * Internal labels a reader cannot know replaced by plain words (invariant outcome.partial_explained: reports said
 * 「P1…」「approved_outline」): P<n> → the paper's short title, approved_outline / sources → 確認的大綱 / 來源，req ids dropped.
 */
export function plainLabels(run: { state?: RunRow["state"] }, text: string): string {
  const picks = ((run.state?.topic as { picks?: ({ title?: string; hit?: { title?: string } })[] } | undefined)?.picks) ?? [];
  const short = (t: string) => (t.split(/[:：]/)[0] ?? t).trim().slice(0, 40);
  return text
    .replace(/[（(]P\d+…?[）)]/g, "")
    .replace(/\bP(\d+)(?:\s*[-–]\s*P(\d+))?\b/g, (m, a: string, b?: string) => {
      if (b) return "這些論文";
      const p = picks[Number(a) - 1];
      const t = p?.title ?? p?.hit?.title;
      return t ? `〈${short(t)}〉` : "那篇論文";
    })
    .replace(/approved_outline/g, "確認的大綱").replace(/<?sources>?/g, "來源").replace(/\breq_[a-z0-9]+\b/gi, "").replace(/\s{2,}/g, " ");
}

export function unmetItems(run: Pick<RunRow, "criteria"> & { state?: RunRow["state"] }, failedSteps: { title: string; error: string | null }[] = []): string[] {
  const plain = (s: string) => plainLabels(run, s.replace(/^你的要求：/, "")).replace(/\s+/g, " ").trim();
  const replan = new Set(replanItems(run).map((r) => r.id));
  const items = run.criteria.filter((c) => c.status !== "pass" && !replan.has(c.id)).map((c) => `${plain(c.text)}${c.reason && c.status === "fail" ? `：${plain(c.reason).slice(0, 160)}` : c.status !== "fail" ? "（還沒驗收）" : ""}`);
  if (!items.length) for (const s of failedSteps) items.push(`「${s.title}」沒有完成${s.error ? `：${s.error.slice(0, 120)}` : ""}`);
  return items.slice(0, 6);
}

/** Unmet criteria only a new plan can meet (engine finalStep → playbook `structural`): listed apart, with 「重新規劃」. */
export function replanItems(run: { criteria: RunRow["criteria"]; state?: RunRow["state"] }): { id: string; text: string }[] {
  const list = (run.state?.replan_needed as { id: string; why: string }[] | null | undefined) ?? [];
  return list.map((r) => {
    const c = run.criteria.find((x) => x.id === r.id);
    return c && c.status !== "pass" ? { id: r.id, text: plainLabels(run, `${c.text.replace(/^你的要求：/, "")}：${r.why}`).replace(/\s+/g, " ").slice(0, 300) } : null;
  }).filter((x): x is { id: string; text: string } => !!x).slice(0, 4);
}

export async function finishNotice(env: WorkflowEnv, kind: NoticeKind) {
  const run = env.run;
  let t = TEXT[kind](run.title || "工作流程");
  if (!t) return;
  // Partial: say what is still wrong and offer to fix exactly those items (the user should not have to hunt for them).
  let items: string[] = [];
  let replan: string[] = [];
  if (kind === "partial") {
    const failed = (await env.db.query<{ title: string; error: string | null }>("SELECT title, error FROM workflow_steps WHERE run_id=$1 AND status='failed' ORDER BY position", [run.id]).catch(() => ({ rows: [] as { title: string; error: string | null }[] }))).rows;
    items = unmetItems(run, failed);
    replan = replanItems(run).map((r) => r.text);
    const parts = [
      items.length ? `還有 ${items.length} 項沒有達成：\n${items.map((i) => `・${i}`).join("\n")}\n要我修這幾項嗎？` : "",
      replan.length ? `這些要重新規劃才做得到（改寫頁面補不出來）：\n${replan.map((i) => `・${i}`).join("\n")}` : "",
    ].filter(Boolean);
    if (parts.length) t = { ...t, notice: `工作流程「${run.title || "工作流程"}」已結束，${parts.join("\n")}` };
  }
  // Deep link to the run's card in its conversation (scrolled to + highlighted), or the expanded run on /assistant/workflows.
  const url = run.goal_id ? focusHref(run.conversation_id, `goal:${run.goal_id}`, run.id) : focusHref(run.conversation_id, `workflow:${run.id}`, run.id);
  try {
    if (run.conversation_id) {
      const m = (await env.db.query<MessageRow>(
        "INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'notice',$2,$3) RETURNING *",
        [run.conversation_id, JSON.stringify([{ type: "notice", kind: `workflow_${kind}`, workflowId: run.id, ...(items.length ? { items, model: true } : {}), ...(replan.length ? { replan, model: true } : {}) }]), t.notice],
      )).rows[0]!;
      await insertEvent(env.db, run.conversation_id, null, "message", { message: messageView(m) });
    }
    // A goal stage that finished: the goal reports (goals/advance.ts), no notification per stage.
    if (run.goal_id && (kind === "done" || kind === "partial")) return;
    await env.db.query("INSERT INTO notifications(user_id,kind,title,body,url) VALUES($1,'workflow',$2,$3,$4)", [run.user_id, t.title, (run.title || t.notice).slice(0, 300), url]);
    const n = pusher(env.db);
    if (n?.canPush) await n.push([run.user_id], { kind: "workflow", title: t.title, body: run.title || t.notice, url }, { pref: null, tag: `workflow-${run.id}` }).catch(() => undefined);
  } catch (e) {
    env.deps.log.warn({ err: e, workflowId: run.id }, "workflow notice failed");
  }
}
