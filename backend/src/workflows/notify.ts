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
import type { WorkflowEnv } from "./env.js";

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

export type NoticeKind = "awaiting_plan_approval" | "awaiting_input" | "done" | "partial" | "failed" | "cancelled";

const TEXT: Record<NoticeKind, (t: string) => { notice: string; title: string } | null> = {
  awaiting_plan_approval: (t) => ({ notice: `工作計畫「${t}」已擬好，請確認後按「開始」。`, title: "工作計畫待確認" }),
  awaiting_input: (t) => ({ notice: `工作流程「${t}」需要你補充資訊才能繼續。`, title: "工作流程需要你的回覆" }),
  done: (t) => ({ notice: `工作流程「${t}」已完成，所有驗收標準都通過。`, title: "工作流程已完成" }),
  partial: (t) => ({ notice: `工作流程「${t}」已結束，但還有未通過的驗收標準；可以按「繼續改」。`, title: "工作流程部分完成" }),
  failed: (t) => ({ notice: `工作流程「${t}」無法完成。`, title: "工作流程失敗" }),
  cancelled: () => null,
};

export async function finishNotice(env: WorkflowEnv, kind: NoticeKind) {
  const run = env.run;
  const t = TEXT[kind](run.title || "工作流程");
  if (!t) return;
  const url = run.conversation_id ? `/assistant/${run.conversation_id}?workflow=${run.id}` : `/assistant/workflows?id=${run.id}`;
  try {
    if (run.conversation_id) {
      const m = (await env.db.query<MessageRow>(
        "INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'notice',$2,$3) RETURNING *",
        [run.conversation_id, JSON.stringify([{ type: "notice", kind: `workflow_${kind}`, workflowId: run.id }]), t.notice],
      )).rows[0]!;
      await insertEvent(env.db, run.conversation_id, null, "message", { message: messageView(m) });
    }
    await env.db.query("INSERT INTO notifications(user_id,kind,title,body,url) VALUES($1,'workflow',$2,$3,$4)", [run.user_id, t.title, (run.title || t.notice).slice(0, 300), url]);
    const n = pusher(env.db);
    if (n?.canPush) await n.push([run.user_id], { kind: "workflow", title: t.title, body: run.title || t.notice, url }, { pref: null, tag: `workflow-${run.id}` }).catch(() => undefined);
  } catch (e) {
    env.deps.log.warn({ err: e, workflowId: run.id }, "workflow notice failed");
  }
}
