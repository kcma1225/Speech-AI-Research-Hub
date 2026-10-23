/**
 * Chat tools of the goal layer (registered at import by routes/goals.ts): `start_goal` (plan a deliverable as a
 * roadmap; one stage = an ordinary workflow), `update_goal` (the user changed the deliverable mid-way), `get_goal`.
 * `start_workflow` routes through `routeWorkflowRequest` too: a request whose deliverable the chosen playbook does not
 * produce becomes a goal (or updates the conversation's goal) instead of a silently different result.
 */
import { z } from "zod";
import { registerAgentTool, type AgentToolContext } from "../../agent/tools/registry.js";
import { notFound } from "../../lib/http.js";
import { detectPlaybook, getWorkflowPlaybook } from "../playbooks/registry.js";
import { startResult } from "../service.js";
import { capabilityOf, DELIVERABLE_KINDS, DELIVERABLE_LABEL, deliverableOf, type DeliverableKind } from "./capabilities.js";
import { activeConversationGoal, createGoal, goalDetail, goalResult, updateGoal, type GoalStart } from "./service.js";
import { getGoal } from "./store.js";
import type { GoalRow } from "./types.js";
import { collectUserWords, deliverableFromWords } from "../brief.js";

const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);

async function convOf(ctx: AgentToolContext) {
  return ctx.conversationId ? (await ctx.db.query<{ context: Record<string, unknown>; autopilot: boolean }>("SELECT context, autopilot FROM conversations WHERE id=$1", [ctx.conversationId])).rows[0] : undefined;
}
async function callIdOf(ctx: AgentToolContext, tool: string) {
  return ctx.runId ? (await ctx.db.query<{ id: string }>("SELECT id FROM tool_calls WHERE run_id=$1 AND tool=$2 AND status='running' ORDER BY created_at DESC LIMIT 1", [ctx.runId, tool])).rows[0]?.id : undefined;
}

function goalMessage(g: GoalRow, updated = false) {
  const stages = g.stages.map((s, i) => `${i + 1}. ${s.title}`).join("；");
  const direct = g.deliverable.direct ? "" : `注意：${g.deliverable.note ?? "這個成果沒有工作流程能直接產生"}，要照實告訴使用者。`;
  if (updated) return `已更新這個對話的目標：最終成果是「${g.deliverable.label}」，路線圖改為：${stages}。${g.status === "awaiting_approval" ? "卡片會請使用者確認新的路線圖。" : "目前的階段完成後會接著做。"}${direct}用一句話說明，不要描述或預告結果。`;
  return `${g.status === "running" ? "已開始" : "已擬好"}目標路線圖（最終成果：${g.deliverable.label}）：${stages}。${g.status === "awaiting_approval" ? "卡片已顯示給使用者，確認一次後各階段會自動依序執行（需要資料、回答問題或失敗時才會停下來）。" : "各階段會自動依序執行。"}${direct}用一句話請使用者看路線圖卡片，不要描述或預告結果。`;
}

function startedResult(out: GoalStart, autopilot: boolean) {
  if (out.kind === "goal") {
    const data = goalResult(out.goal);
    return { data, text: JSON.stringify({ ...data, message: goalMessage(out.goal) }) };
  }
  const data = startResult({ runs: out.runs, batchId: out.batchId });
  const message = autopilot
    ? "這件事一個工作流程就能完成，已開始規劃；自動駕駛下計畫會自動核准並執行。用一句話說明，不要描述或預告結果。"
    : "這件事一個工作流程就能完成，已開始規劃；計畫卡片會顯示給使用者，確認後才會執行與寫入。用一句話說明，不要描述或預告結果。";
  return { data, text: JSON.stringify({ ...data, message }) };
}

type StartArgs = { request: string; deliverable?: string; playbook?: string; study?: string; paper_id?: string; project_id?: string; note_ids?: string[]; userWords?: string[] };

/** The deliverable the user's own words name, else the assistant's request (brief.ts). */
const wantedOf = (a: StartArgs) => (a.userWords?.length ? deliverableFromWords(a.userWords) : null) ?? deliverableOf(a.request);

async function startGoalFrom(ctx: AgentToolContext, a: StartArgs, tool: string) {
  const conv = await convOf(ctx);
  const userWords = a.userWords ?? (await collectUserWords(ctx.db, ctx.conversationId));
  const kind = a.deliverable && (DELIVERABLE_KINDS as readonly string[]).includes(a.deliverable) ? (a.deliverable as DeliverableKind) : null;
  // The conversation already pursues a goal and the user now names a different deliverable: update it.
  const active = await activeConversationGoal(ctx.db, ctx.user.id, ctx.conversationId);
  const want = kind ?? wantedOf({ ...a, userWords });
  if (active && want && want !== active.deliverable.kind) {
    const g = await updateGoal(ctx.app, ctx.user, active.id, { request: a.request, deliverable: want, userWords });
    const data = goalResult(g);
    return { data, text: JSON.stringify({ ...data, message: goalMessage(g, true) }) };
  }
  // Same deliverable as the goal already running here (「可以開論文了」): no second goal — point at the card.
  if (active && want === active.deliverable.kind && ["awaiting_approval", "running", "awaiting_input", "planning"].includes(active.status)) {
    const data = goalResult(active);
    return { data, text: JSON.stringify({ ...data, message: `這個對話已經有同一個目標（${active.deliverable.label}，狀態 ${active.status}）。不要再開新的工作流程；${active.status === "awaiting_approval" ? "請使用者在路線圖卡片上按「開始」" : active.status === "awaiting_input" ? "請使用者在目標卡片上決定怎麼繼續" : "它正在依路線圖執行"}，用一句話說明。` }) };
  }
  const out = await createGoal(ctx.app, ctx.user, {
    request: a.request, playbook: a.playbook && getWorkflowPlaybook(a.playbook) ? a.playbook : undefined, deliverable: kind,
    conversationId: ctx.conversationId, toolCallId: (await callIdOf(ctx, tool)) ?? null, context: conv?.context ?? null, autopilot: conv?.autopilot ?? false, userWords,
    inputs: { study: a.study, paper_id: uuid(a.paper_id), project_id: uuid(a.project_id), note_ids: a.note_ids?.map(uuid).filter((x): x is string => !!x) },
  });
  return startedResult(out, conv?.autopilot ?? false);
}

/**
 * `start_workflow` guard: the request names a deliverable the playbook would not produce (a paper asked for, a
 * literature review picked) → a goal for that deliverable (or the conversation's goal is updated). Null = run the
 * workflow as asked.
 */
export async function routeWorkflowRequest(ctx: AgentToolContext, a: StartArgs & { paper_ids?: string[] }) {
  const want = wantedOf(a);
  if (!want) return null;
  const pb = a.playbook && getWorkflowPlaybook(a.playbook) ? a.playbook : detectPlaybook(a.request, { paper_id: a.paper_id, project_id: a.project_id, paper_ids: a.paper_ids });
  const produces = capabilityOf(pb)?.produces;
  if (produces === want) return null;
  return startGoalFrom(ctx, { ...a, deliverable: want, playbook: produces === want ? pb : undefined }, "start_workflow");
}

registerAgentTool({
  name: "start_goal",
  title: "規劃目標路線圖",
  titleEn: "Plan a goal",
  risk: "read",
  mcp: false,
  description:
    "Plan a request whose final deliverable needs several workflows, e.g. a whole paper from scratch (「幫我寫一篇論文」「最後要給我一個 latex 論文」: topic research when the library is thin → paper outline note → a new built-in LaTeX project with every section written and compiled), " +
    "a literature review when the study has too few papers, or 「先…再…」 requests. It fixes the deliverable (never substitutes another one), checks the study's readiness (papers, PDFs, notes, LaTeX projects), and shows ONE roadmap card the user approves once; " +
    "then the stages run automatically one after another and the roadmap is re-planned after each stage. When a single workflow is enough it simply starts that workflow (same as start_workflow). " +
    "deliverable: paper (whole LaTeX paper), paper_section, deck, topic_note, lit_review, reading_note, outline, experiment_report, meeting_agenda, note (auto-detected when omitted). " +
    "After calling it, end your turn with one short sentence; do not describe results.",
  input: z.object({
    request: z.string().trim().min(4).max(4000).describe("Short summary of the goal (deliverable, topic); the user's own messages are passed verbatim — never add language, length or other requirements they did not state"),
    deliverable: z.enum(DELIVERABLE_KINDS).optional(),
    study: z.string().max(80).optional(),
    paper_id: z.string().max(64).optional(),
    project_id: z.string().max(64).optional(),
    note_ids: z.array(z.string().max(64)).max(6).optional(),
  }),
  summarize: (a) => `規劃目標：${a.request.replace(/\s+/g, " ").slice(0, 50)}`,
  execute: (a, ctx) => startGoalFrom(ctx, a, "start_goal"),
});

registerAgentTool({
  name: "update_goal",
  title: "更新目標",
  titleEn: "Update goal",
  risk: "read",
  mcp: false,
  description: "The user changed the final deliverable or the objective of the goal this conversation pursues (「最後要給我一個 latex 論文」): keeps the stages that already ran (their outputs feed the new roadmap) and re-plans the rest for the new deliverable. Use this instead of starting unrelated workflows.",
  input: z.object({ request: z.string().trim().min(2).max(4000).describe("What the user now wants, in their words"), deliverable: z.enum(DELIVERABLE_KINDS).optional(), goal_id: z.string().max(64).optional() }),
  summarize: (a) => `更新目標：${a.request.replace(/\s+/g, " ").slice(0, 50)}`,
  async execute(a, ctx) {
    const id = uuid(a.goal_id) ?? (await activeConversationGoal(ctx.db, ctx.user.id, ctx.conversationId))?.id;
    if (!id) return startGoalFrom(ctx, a, "update_goal");
    const userWords = await collectUserWords(ctx.db, ctx.conversationId);
    const g = await updateGoal(ctx.app, ctx.user, id, { request: a.request, deliverable: a.deliverable ?? wantedOf({ ...a, userWords }), userWords });
    const data = goalResult(g);
    return { data, text: JSON.stringify({ ...data, message: goalMessage(g, true) }) };
  },
});

registerAgentTool({
  name: "get_goal",
  title: "查看目標",
  titleEn: "Read goal",
  risk: "read",
  mcp: false,
  description: "Status of the goal of this conversation (or by id): deliverable, roadmap stages with status and artifacts, what it waits for, the report. Report exactly this state.",
  input: z.object({ goal_id: z.string().max(64).optional() }),
  summarize: () => "查看目標的進度",
  async execute(a, ctx) {
    const id = uuid(a.goal_id) ?? (await activeConversationGoal(ctx.db, ctx.user.id, ctx.conversationId))?.id;
    const g = id ? await getGoal(ctx.db, id) : null;
    if (!g || g.user_id !== ctx.user.id) throw notFound("找不到目標。");
    const v = await goalDetail(ctx.db, ctx.user, g.id);
    return {
      data: { id: v.id, title: v.title, status: v.status, deliverable: `${DELIVERABLE_LABEL[v.deliverable.kind]}${v.deliverable.direct ? "" : `（${v.deliverable.note ?? "無法直接產生"}）`}`, question: v.question, stages: v.stages.map((s) => ({ title: s.title, playbook: s.playbook, status: s.status, summary: s.summary, artifacts: s.artifacts.map((x) => ({ kind: x.kind, title: x.title, url: x.url })) })), report: v.report?.summary_md ?? null },
      links: v.stages.flatMap((s) => s.artifacts).map((x) => ({ label: x.title, url: x.url, kind: x.kind === "deck" ? ("deck" as const) : x.kind === "note" ? ("note" as const) : undefined })),
    };
  },
});
