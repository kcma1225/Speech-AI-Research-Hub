/**
 * The chat ↔ running workflows of the same conversation (docs/architecture.md → Workflows → Chat integration →
 * Steering): what the assistant is told about them on every model call (`conversationWorkflowsBlock`), the
 * deterministic duplicate guard of `start_workflow` (`duplicateActiveWorkflow`) and the user's-own-words check of the
 * steering tools (`ownWords`). Plain SQL on the stored rows only — no engine imports — so the agent runtime can use it.
 */
import type { Queryable } from "../db.js";
import { overlap } from "../agent/memory.js";
import { BRIEF_KIND_LABEL, deliverableFor, type BriefKind } from "./brief.js";

/** Runs the chat can still steer (not finished, not a goal stage, not part of a batch). */
export const STEERABLE = ["queued", "planning", "awaiting_plan_approval", "running", "verifying", "awaiting_input", "needs_pdf", "paused"];
const STATUS_ZH: Record<string, string> = {
  queued: "排隊中", planning: "規劃中", awaiting_plan_approval: "等使用者確認計畫", running: "執行中", verifying: "驗收中",
  awaiting_input: "等使用者回答", needs_pdf: "需要論文 PDF", paused: "已暫停",
};

type ActiveRow = {
  id: string; title: string; status: string; playbook: string; request: string; study_id: string | null; question: string | null;
  inputs: Record<string, unknown> | null; artifacts: { kind?: string; id?: string; title?: string }[] | null;
  brief: { deliverable?: { kind?: string; label?: string } } | null; state: Record<string, unknown> | null; created_at: string;
};

/** The conversation's steerable runs, newest first. */
export async function activeConversationRuns(db: Queryable, conversationId: string | null | undefined, userId: string): Promise<ActiveRow[]> {
  if (!conversationId) return [];
  return (await db.query<ActiveRow>(
    `SELECT id, title, status, playbook, request, study_id, question, inputs, artifacts, brief, state, created_at FROM workflow_runs
      WHERE conversation_id=$1 AND user_id=$2 AND status = ANY($3::text[]) AND goal_id IS NULL AND batch_id IS NULL ORDER BY created_at DESC LIMIT 6`,
    [conversationId, userId, STEERABLE],
  ).catch(() => ({ rows: [] as ActiveRow[] }))).rows;
}

const kindOf = (r: Pick<ActiveRow, "brief" | "request" | "playbook">): BriefKind => {
  const k = r.brief?.deliverable?.kind;
  return (k as BriefKind | undefined) ?? deliverableFor([], r.request, r.playbook).kind;
};
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
/** Every artifact id a run targets or wrote (input deck / note / LaTeX project + its artifacts). */
const targetsOf = (r: Pick<ActiveRow, "inputs" | "artifacts">) => {
  const i = r.inputs ?? {};
  return new Set([i.deck_id, i.project_id, ...(Array.isArray(i.note_ids) ? i.note_ids : []), ...(r.artifacts ?? []).map((a) => a.id)].filter(uuid));
};

/**
 * `<conversation_workflows>` for the model (appended to the newest user turn on every model call, so it is current):
 * each steerable run with id, title, deliverable, status, current step / question and the artifact it works on, plus
 * the routing rule. Empty when nothing runs.
 */
export async function conversationWorkflowsBlock(db: Queryable, conversationId: string, userId: string): Promise<string> {
  const runs = await activeConversationRuns(db, conversationId, userId);
  if (!runs.length) return "";
  const steps = (await db.query<{ run_id: string; title: string; status: string; done: string; total: string }>(
    `SELECT s.run_id, (array_agg(s.title ORDER BY s.position) FILTER (WHERE s.status IN ('running','verifying')))[1] AS title, '' AS status,
            count(*) FILTER (WHERE s.status IN ('passed','skipped'))::text AS done, count(*)::text AS total
       FROM workflow_steps s WHERE s.run_id = ANY($1::uuid[]) AND s.parent_id IS NULL GROUP BY s.run_id`,
    [runs.map((r) => r.id)],
  ).catch(() => ({ rows: [] as { run_id: string; title: string; status: string; done: string; total: string }[] }))).rows;
  const stepOf = new Map(steps.map((s) => [s.run_id, s]));
  const lines = runs.map((r) => {
    const s = stepOf.get(r.id);
    const kind = kindOf(r);
    const label = r.brief?.deliverable?.label ?? BRIEF_KIND_LABEL[kind] ?? kind;
    const target = (r.artifacts ?? []).filter((a) => uuid(a.id)).map((a) => `${a.kind === "deck" ? "簡報" : a.kind === "note" ? "筆記" : a.kind ?? "成果"}〈${(a.title ?? "").slice(0, 40)}〉（${a.kind}_id ${a.id}）`)[0]
      ?? (uuid(r.inputs?.deck_id) ? `修改簡報（deck_id ${r.inputs!.deck_id}）` : "");
    const bits = [`成果：${label}`, `狀態：${STATUS_ZH[r.status] ?? r.status}`];
    if (s && Number(s.total)) bits.push(`進度 ${s.done}/${s.total}${s.title ? `，目前在做「${s.title.slice(0, 60)}」` : ""}`);
    if (target) bits.push(target);
    if (r.status === "awaiting_input" && r.question) bits.push(`等使用者回答：「${r.question.replace(/\s+/g, " ").slice(0, 160)}」`);
    return `- workflow id ${r.id}〈${r.title.slice(0, 60)}〉：${bits.join("；")}`;
  });
  return [
    '<conversation_workflows trust="system" note="這個對話裡還在進行的工作流程（現在的狀態）">',
    ...lines,
    "規則：使用者這則訊息如果是在調整上面某個工作流程（頁數、語言、內容、加減某頁、換材料，或要它停／暫停／繼續），用 steer_workflow 把他的原話送給它（調整 → action guidance，text 用使用者自己的話；停／暫停 → action pause；繼續 → action resume），不要再用 start_workflow 為同一份成果開第二個工作流程。狀態是「等使用者回答」而這則訊息就是在回答那個問題時，用 answer_workflow（text 用使用者的原話）。不確定他是在調整哪一個、還是要另一份新的成果時，用 ask_user 問一題。和這些工作流程無關的問題照常回答。",
    "</conversation_workflows>",
  ].join("\n");
}

/** 「另外再做一份」「再開一個新的」「another deck」: the user explicitly wants a separate, additional deliverable. */
export const SEPARATE_RE = /另外(?:再)?(?:做|開|建|寫|弄)|另(?:一|開)(?:份|個)|再(?:做|開|建|寫|弄)(?:一|另一)(?:份|個)|(?:再|多)(?:一|兩)份|新的一份|分開(?:做|的)|\b(?:another|a second|a separate|an additional|one more)\b/i;

export type Duplicate = { id: string; title: string; status: string; reason: "same_target" | "same_kind" };

/**
 * start_workflow's guard: an active run of this conversation already makes the same deliverable — it targets the same
 * deck / note / LaTeX project (input or written artifact), or (no target named) the same deliverable kind in the same
 * study and about the same paper — and the user did not ask for a separate one (`separate`, or SEPARATE_RE on their
 * newest turn). Batches and goal stages are left to their own logic.
 */
export async function duplicateActiveWorkflow(
  db: Queryable,
  conversationId: string | null | undefined,
  userId: string,
  a: { request: string; playbook?: string; study?: string; paper_id?: string; deck_id?: string; project_id?: string; note_ids?: string[]; paper_ids?: string[]; separate?: boolean },
  userWords: string[],
): Promise<Duplicate | null> {
  if (!conversationId || a.separate || (a.paper_ids?.length ?? 0) > 1) return null;
  if (SEPARATE_RE.test(userWords.at(-1) ?? "")) return null;
  const runs = await activeConversationRuns(db, conversationId, userId);
  if (!runs.length) return null;
  const wanted = [a.deck_id, a.project_id, ...(a.note_ids ?? [])].filter(uuid);
  for (const r of runs) {
    const t = targetsOf(r);
    if (wanted.some((id) => t.has(id))) return { id: r.id, title: r.title, status: r.status, reason: "same_target" };
  }
  if (wanted.length) return null;
  const kind = deliverableFor(userWords, a.request, a.playbook ?? "generic").kind;
  if (kind === "other") return null;
  let study: string | null = null;
  if (a.study) study = (await db.query<{ id: string }>("SELECT id FROM studies WHERE id::text=$1 OR slug=$1 LIMIT 1", [a.study])).rows[0]?.id ?? null;
  for (const r of runs) {
    if (kindOf(r) !== kind) continue;
    if (study && r.study_id && study !== r.study_id) continue;
    const paper = uuid(a.paper_id) ? a.paper_id : null;
    const runPaper = uuid(r.inputs?.paper_id) ? (r.inputs!.paper_id as string) : null;
    if (paper && runPaper && paper !== runPaper) continue;
    return { id: r.id, title: r.title, status: r.status, reason: "same_kind" };
  }
  return null;
}

/** The newest user turns of the conversation (current branch), oldest first. */
export async function recentUserText(db: Queryable, conversationId: string | null | undefined, n = 3): Promise<string> {
  if (!conversationId) return "";
  const rows = (await db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL AND role='user' ORDER BY seq DESC LIMIT $2", [conversationId, n])).rows;
  return rows.reverse().map((r) => r.text).join("\n");
}

/** Whether `text` is substantially the user's own words (≥ 60 % of its n-grams are in their recent turns). */
export const ownWords = (text: string, userText: string) => overlap(text, userText) >= 0.6;

