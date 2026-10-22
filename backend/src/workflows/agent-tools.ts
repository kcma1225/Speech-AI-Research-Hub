/**
 * Chat tools of the workflow module (registered at import by routes/workflows.ts):
 * `start_workflow` (risk read: it only plans; nothing is written before the user approves the plan card) and
 * `get_workflow` (status, criteria, report — so the assistant reports the real state, never unverified outcomes).
 */
import { z } from "zod";
import { transaction } from "../db.js";
import { registerAgentTool } from "../agent/tools/registry.js";
import { notFound } from "../lib/http.js";
import { getRun, getSteps } from "./store.js";
import { announceRuns, insertWorkflows, startResult } from "./service.js";
import { listWorkflowPlaybooks } from "./playbooks/index.js";
import { routeWorkflowRequest } from "./goals/agent-tools.js";

const playbookIds = () => listWorkflowPlaybooks().map((p) => p.id);

registerAgentTool({
  name: "start_workflow",
  title: "交給 Agent 工作流程",
  titleEn: "Start agent workflow",
  risk: "read",
  mcp: false,
  description:
    "Hand a multi-step creation task to the workflow engine instead of producing it in one reply: building a slide deck from zero (paper report or progress report), " +
    "writing a thesis/LaTeX section, a literature review, a topic survey (which approaches exist for X), a deep reading note, an experiment report note, meeting preparation, or another task-oriented request. " +
    "An orchestrator gathers context, writes objective + acceptance criteria + a plan (for decks: the page-by-page outline) that the user approves on a card, " +
    "then sub-agents do the parts, every part is verified and fixed, and the result is checked against the objective. Use it when the user asks you to create such a thing " +
    "(only use create_deck with generate:true when the user explicitly wants a quick one-shot draft). Put the user's request with all agreed details (page count, structure, emphasis, language) in `request`. " +
    "After calling it, end your turn with one short sentence; do not describe results — the card shows progress and the workflow reports back. " +
    "One deck / reading note per paper (「把每一篇文獻都做成簡報」): call it ONCE — pass the study (or all paper_ids) and the request; it creates one run per paper as a batch " +
    "(runs over the limit of 3 working runs queue and start automatically). Papers without a PDF are handled by the workflow (open-access lookup, the record's URL, then it asks or skips) — do not drop them yourself. " +
    "The study and paper default to the conversation's page context. " +
    "playbook ids: slides, latex_section, lit_review, reading_note, topic_research, experiment_report, meeting_prep, paper_outline, paper_draft, generic (auto-detected when omitted). " +
    "reading_note = notes on ONE specific paper already in the library (pass paper_id); lit_review = compare papers already in the study's library (≥ 2); " +
    "topic_research = a topic / survey request without a specific paper (「研究有哪些做法／方法」, 調研, survey, state of the art, related approaches, 研究現況, find papers on a subject): " +
    "it splits the topic into sub-questions, searches papers online with keywords only, lists candidates for the user to approve, imports and reads them, and writes a note with an approach taxonomy, per-approach sections, a result comparison and open problems. " +
    "Never use reading_note or lit_review for such requests. " +
    "A request whose final deliverable needs several workflows (a whole paper from scratch, 「先…再…」) is better started with start_goal; if the playbook you pass would not produce the deliverable the request names (e.g. lit_review for 「寫一篇論文」), this tool starts a goal for that deliverable instead (the result then has goal_id). " +
    "Editing an existing deck (translate, rewrite, shorten, restyle) = slides with deck_id (the page's deck); it revises that deck as a new draft revision. " +
    "When unsure, omit playbook.",
  input: z.object({
    request: z.string().trim().min(4).max(4000).describe("The task in the user's words plus the details agreed in the chat"),
    playbook: z.string().max(40).optional(),
    study: z.string().max(80).optional().describe("Study id or slug (default: the page's study)"),
    paper_id: z.string().max(64).optional(),
    deck_id: z.string().max(64).optional(),
    project_id: z.string().max(64).optional().describe("LaTeX project id"),
    note_ids: z.array(z.string().max(64)).max(6).optional(),
    paper_ids: z.array(z.string().max(64)).max(10).optional().describe("Several papers: lit_review reads them together; slides / reading_note make one run per paper (a batch)"),
    pages: z.number().int().min(3).max(40).optional().describe("Deck page count when the user gave one"),
  }),
  summarize: (a) => `交給 Agent：${a.request.replace(/\s+/g, " ").slice(0, 50)}`,
  async execute(a, ctx) {
    // Deliverable first (goals/agent-tools.ts): a playbook that would not produce what the user asked for → a goal.
    const routed = await routeWorkflowRequest(ctx, a);
    if (routed) return routed;
    const conv = ctx.conversationId ? (await ctx.db.query<{ context: Record<string, unknown>; autopilot: boolean }>("SELECT context, autopilot FROM conversations WHERE id=$1", [ctx.conversationId])).rows[0] : undefined;
    const callId = ctx.runId ? (await ctx.db.query<{ id: string }>("SELECT id FROM tool_calls WHERE run_id=$1 AND tool='start_workflow' AND status='running' ORDER BY created_at DESC LIMIT 1", [ctx.runId])).rows[0]?.id : undefined;
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    const out = await transaction(ctx.db, (client) =>
      insertWorkflows(client, ctx.user, {
        request: a.request,
        playbook: a.playbook && playbookIds().includes(a.playbook) ? a.playbook : undefined,
        conversationId: ctx.conversationId,
        toolCallId: callId ?? null,
        context: conv?.context ?? null,
        autopilot: conv?.autopilot ?? false,
        inputs: { study: a.study, paper_id: uuid(a.paper_id), deck_id: uuid(a.deck_id), project_id: uuid(a.project_id), note_ids: a.note_ids?.map(uuid).filter((x): x is string => !!x), paper_ids: a.paper_ids?.map(uuid).filter((x): x is string => !!x), pages: a.pages },
      }),
    );
    await announceRuns(ctx.db, out.runs);
    const data = startResult(out);
    const autopilot = conv?.autopilot ?? false;
    const message = out.batchId
      ? `已拆成 ${out.runs.length} 個工作流程（每篇一個，${out.runs.filter((r) => r.status === "queued").length} 個排隊中，會自動接著開始）。${autopilot ? "自動駕駛開啟：只寫草稿的計畫會自動核准並執行，不用等使用者確認。" : "每份的計畫準備好後請使用者確認。"}用一句話告訴使用者批次卡片會顯示每一篇的進度，不要描述或預告結果。`
      : autopilot
        ? "工作流程已開始規劃；自動駕駛下只寫草稿的計畫會自動核准並執行（卡片可暫停或修改計畫）。用一句話說明，不要描述或預告結果。"
        : "工作流程已開始規劃；計畫卡片會顯示給使用者，確認後才會執行與寫入。現在用一句話告訴使用者計畫準備好時請他確認，不要描述或預告結果。";
    return { data, text: JSON.stringify({ ...data, message }) };
  },
});

registerAgentTool({
  name: "get_workflow",
  title: "查看工作流程",
  titleEn: "Read workflow",
  risk: "read",
  mcp: false,
  description: "Status of a workflow started in this conversation (or by id): objective, acceptance criteria with pass/fail, step statuses, artifacts with links, and the final report. Report exactly this state to the user (planning / waiting for approval / running / partial / done) — never claim results the workflow has not verified.",
  input: z.object({ workflow_id: z.string().max(64).optional() }),
  summarize: () => "查看工作流程的進度",
  async execute(a, ctx) {
    const id = a.workflow_id && /^[0-9a-f-]{36}$/i.test(a.workflow_id)
      ? a.workflow_id
      : ctx.conversationId ? (await ctx.db.query<{ id: string }>("SELECT id FROM workflow_runs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1", [ctx.conversationId, ctx.user.id])).rows[0]?.id : undefined;
    const r = id ? await getRun(ctx.db, id) : null;
    if (!r || r.user_id !== ctx.user.id) throw notFound("找不到工作流程。");
    const steps = await getSteps(ctx.db, r.id);
    return {
      data: {
        id: r.id, title: r.title, status: r.status, objective: r.objective, question: r.question,
        criteria: r.criteria.map((c) => ({ text: c.text, status: c.status, reason: c.reason })),
        steps: steps.map((s) => ({ title: s.title, role: s.role, status: s.status, round: s.round, summary: s.output?.summary })),
        artifacts: r.artifacts.map((x) => ({ kind: x.kind, title: x.title, url: x.url, role: x.role })),
        report: r.report?.summary_md ?? null,
        usage: r.usage,
      },
      links: r.artifacts.map((x) => ({ label: x.title, url: x.url, kind: x.kind === "deck" ? ("deck" as const) : x.kind === "note" ? ("note" as const) : undefined })),
    };
  },
});
