/**
 * Chat tools of the workflow module (registered at import by routes/workflows.ts):
 * `start_workflow` (risk read: it only plans; nothing is written before the user approves the plan card; refuses a
 * second run for a deliverable an active run of the conversation already makes — chat-steer.ts),
 * `get_workflow` (status, criteria, report — so the assistant reports the real state, never unverified outcomes),
 * `steer_workflow` (the user's adjustment → guidance / pause / resume of an active run of this conversation) and
 * `answer_workflow` (the user's reply → the question an `awaiting_input` run waits on). Both pass the user's own words
 * (checked against their recent turns) and act only on runs of this conversation; risk read like start_workflow: they
 * change what an approved run does, never write by themselves.
 */
import { z } from "zod";
import { transaction } from "../db.js";
import { registerAgentTool } from "../agent/tools/registry.js";
import { badRequest, notFound } from "../lib/http.js";
import { artifactGrounded, UNGROUNDED_TARGET } from "./context.js";
import { getRun, getSteps } from "./store.js";
import { addGuidance, announceRuns, answerWorkflowText, insertWorkflows, pauseWorkflow, resumeWorkflow, startMessage, startResult } from "./service.js";
import { activeConversationRuns, duplicateActiveWorkflow, ownWords, recentUserText, STEERABLE } from "./chat-steer.js";
import { listWorkflowPlaybooks } from "./playbooks/index.js";
import { routeWorkflowRequest } from "./goals/agent-tools.js";
import { collectUserWords } from "./brief.js";

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
    "(only use create_deck with generate:true when the user explicitly wants a quick one-shot draft). " +
    "The user's own chat messages are passed to the workflow verbatim and are the ONLY source of its requirements; `request` is your short summary of the task (what to make, about what, which material) — do not add requirements: no language, page count, length, structure or format the user did not say (pass `pages` only when the user gave a number). Things the user did not specify stay 「未指定」 on the plan card. " +
    "Material the user provides (an attached / uploaded file such as a Deep Research result, pasted notes, an attached note) is the task's material: pass the files' attachment_id in `attachment_ids` and say in `request` that it is the main material (the workflow also picks up the turn's own attachments and pasted text; it never searches online or imports papers instead of using it). " +
    "After calling it, end your turn with one short sentence that follows the result's `message` (with autopilot on the plan is approved automatically — never ask the user to confirm it); do not describe results — the card shows progress and the workflow reports back. " +
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
    "playbook is only a proposal: the workflow routes on the user's own words (a deck asked for is a deck whatever playbook you pass) and records a mismatch. When unsure, omit playbook. " +
    "A workflow of this conversation that is still active (see <conversation_workflows>) is adjusted with steer_workflow, never restarted: this tool refuses a second run for the same deck / note / deliverable kind + study; pass separate: true only when the user explicitly asks for an additional, separate one.",
  input: z.object({
    request: z.string().trim().min(4).max(4000).describe("Short summary of the task (what to make, topic, material); never add requirements the user did not state"),
    playbook: z.string().max(40).optional(),
    study: z.string().max(80).optional().describe("Study id or slug (default: the page's study)"),
    paper_id: z.string().max(64).optional(),
    deck_id: z.string().max(64).optional(),
    project_id: z.string().max(64).optional().describe("LaTeX project id"),
    note_ids: z.array(z.string().max(64)).max(6).optional(),
    paper_ids: z.array(z.string().max(64)).max(10).optional().describe("Several papers: lit_review reads them together; slides / reading_note make one run per paper (a batch)"),
    pages: z.number().int().min(3).max(40).optional().describe("Deck page count when the user gave one"),
    attachment_ids: z.array(z.string().max(64)).max(6).optional().describe("Files the user uploaded into this conversation that the task should use (attachment_id from the <attachments> list) — pass them whenever the user refers to an attachment / their file / pasted research result. The workflow reads them as the material"),
    separate: z.boolean().optional().describe("Only when the user explicitly asks for an additional, separate deliverable although a workflow of this conversation is already making one of the same kind"),
  }),
  summarize: (a) => `交給 Agent：${a.request.replace(/\s+/g, " ").slice(0, 50)}`,
  async execute(a, ctx) {
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    // Act only on the conversation's own artifacts or one the user named exactly (never a search pick).
    for (const [kind, id] of [["deck", uuid(a.deck_id)], ["latex_project", uuid(a.project_id)], ...(a.note_ids ?? []).map((n) => ["note", uuid(n)])] as ["deck" | "note" | "latex_project", string | undefined][]) {
      if (id && ctx.source === "agent" && !(await artifactGrounded(ctx.db, ctx.conversationId, ctx.user.id, kind, id))) throw badRequest(UNGROUNDED_TARGET);
    }
    // The user's own words (verbatim chat turns): the Brief's source of requirements; `request` is the assistant's paraphrase.
    const userWords = await collectUserWords(ctx.db, ctx.conversationId);
    // One active run per deliverable and conversation: an adjustment goes to that run (steer_workflow), never a second one.
    const dup = ctx.source === "agent" ? await duplicateActiveWorkflow(ctx.db, ctx.conversationId, ctx.user.id, a, userWords) : null;
    if (dup) {
      const data = { status: "duplicate", existing_workflow_id: dup.id, existing: { id: dup.id, title: dup.title, status: dup.status }, reason: dup.reason };
      const message = `這個對話已經有一個工作流程在做同一份成果（〈${dup.title}〉，workflow id ${dup.id}），沒有再開新的。使用者的調整（頁數、語言、內容…）用 steer_workflow（workflow_id ${dup.id}，action guidance，text 用他的原話）送給它；要停下來用 action pause${dup.status === "awaiting_input" ? "；它正在等使用者回答，這則訊息若是回答就用 answer_workflow" : ""}。只有使用者明確要另外一份新的成果時，才再呼叫 start_workflow 並帶 separate: true；不確定時用 ask_user 問一題。`;
      return { data, text: JSON.stringify({ ...data, message }) };
    }
    // Deliverable first (goals/agent-tools.ts): a playbook that would not produce what the user asked for → a goal.
    const routed = await routeWorkflowRequest(ctx, { ...a, userWords });
    if (routed) return routed;
    const conv = ctx.conversationId ? (await ctx.db.query<{ context: Record<string, unknown>; autopilot: boolean }>("SELECT context, autopilot FROM conversations WHERE id=$1", [ctx.conversationId])).rows[0] : undefined;
    const callId = ctx.runId ? (await ctx.db.query<{ id: string }>("SELECT id FROM tool_calls WHERE run_id=$1 AND tool='start_workflow' AND status='running' ORDER BY created_at DESC LIMIT 1", [ctx.runId])).rows[0]?.id : undefined;
    const out = await transaction(ctx.db, (client) =>
      insertWorkflows(client, ctx.user, {
        request: a.request,
        playbook: a.playbook && playbookIds().includes(a.playbook) ? a.playbook : undefined,
        conversationId: ctx.conversationId,
        toolCallId: callId ?? null,
        context: conv?.context ?? null,
        autopilot: conv?.autopilot ?? false,
        userWords,
        inputs: { study: a.study, paper_id: uuid(a.paper_id), deck_id: uuid(a.deck_id), project_id: uuid(a.project_id), note_ids: a.note_ids?.map(uuid).filter((x): x is string => !!x), paper_ids: a.paper_ids?.map(uuid).filter((x): x is string => !!x), pages: a.pages, attachment_ids: a.attachment_ids?.map(uuid).filter((x): x is string => !!x) },
      }),
    );
    await announceRuns(ctx.db, out.runs);
    const data = startResult(out);
    const message = startMessage(out.runs, out.batchId);
    return { data, text: JSON.stringify({ ...data, message }) };
  },
});

registerAgentTool({
  name: "get_workflow",
  title: "查看工作流程",
  titleEn: "Read workflow",
  risk: "read",
  mcp: false,
  description: "Status of a workflow started in this conversation (or by id): objective, acceptance criteria with pass/fail, step statuses, artifacts with ids and links, and the final report. Report exactly this state to the user (planning / waiting for approval / running / partial / done) — never claim results the workflow has not verified. It does not contain the artifact's content: to answer what a deck / note says, read it with get_deck / get_note.",
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
        artifacts: r.artifacts.map((x) => ({ kind: x.kind, id: x.id, title: x.title, url: x.url, role: x.role })),
        // The run's status is not the artifact's content (production 79ab0678: the assistant listed a method the deck does
        // not have, from a criterion's reason).
        content_note: r.artifacts.length ? "這裡只有進度與驗收結果，不是成果的內容。被問到成果講了什麼、涵蓋哪些內容時，先用 get_deck（deck_id）／get_note（note_id）／latex_read_file 讀成果本身，再依讀到的內容回答；不要從驗收理由推測內容。" : undefined,
        report: r.report?.summary_md ?? null,
        usage: r.usage,
      },
      links: r.artifacts.map((x) => ({ label: x.title, url: x.url, kind: x.kind === "deck" ? ("deck" as const) : x.kind === "note" ? ("note" as const) : undefined })),
    };
  },
});

/** The run a steering call means: the given id (must belong to this conversation), else the newest steerable run here. */
async function steerTarget(ctx: Parameters<NonNullable<Parameters<typeof registerAgentTool>[0]["execute"]>>[1], id?: string, statuses?: string[]) {
  const runs = await activeConversationRuns(ctx.db, ctx.conversationId, ctx.user.id);
  const pick = id && /^[0-9a-f-]{36}$/i.test(id) ? runs.find((r) => r.id === id) : runs.find((r) => !statuses || statuses.includes(r.status));
  if (!pick) {
    if (id) throw notFound("這個對話沒有這個進行中的工作流程（可能已經結束；結束的工作流程用 start_workflow 或「繼續改」）。");
    throw notFound("這個對話目前沒有進行中的工作流程。");
  }
  return pick;
}

registerAgentTool({
  name: "steer_workflow",
  title: "調整進行中的工作流程",
  titleEn: "Steer workflow",
  risk: "read",
  mcp: false,
  modes: ["chat"],
  description:
    "Adjust a workflow of THIS conversation that is still active (listed in <conversation_workflows>: planning, waiting for plan approval, running, paused…) with the user's message, instead of starting another workflow for the same deliverable. " +
    "action guidance = send the user's own words as 補充指示 (page count, language, content, add/remove a page, other material…): before plan approval the plan is redone with it, while running the next steps follow it; " +
    "action pause = the user says 停／暫停 (it stops after the current sub-task); action resume = 繼續 a paused run. " +
    "`text` must be the user's own words (verbatim, or the clause of their message that adjusts the workflow) — never your paraphrase or additions. " +
    "To answer a question the workflow waits on (status 等使用者回答) use answer_workflow instead. After calling it, say in one sentence what was sent; do not predict results.",
  input: z.object({
    workflow_id: z.string().max(64).optional().describe("The workflow id from <conversation_workflows> (default: the newest active one)"),
    action: z.enum(["guidance", "pause", "resume"]).default("guidance"),
    text: z.string().trim().max(2000).optional().describe("guidance: the user's own words"),
  }),
  summarize: (a) => (a.action === "pause" ? "暫停工作流程" : a.action === "resume" ? "繼續工作流程" : `補充指示：${(a.text ?? "").replace(/\s+/g, " ").slice(0, 50)}`),
  async execute(a, ctx) {
    const r = await steerTarget(ctx, a.workflow_id, a.action === "resume" ? ["paused"] : a.action === "pause" ? ["running", "verifying", "planning"] : STEERABLE);
    if (a.action === "pause") {
      const w = await pauseWorkflow(ctx.app, ctx.user, r.id);
      return { data: { workflow_id: r.id, action: "pause", status: w?.status ?? r.status }, text: JSON.stringify({ workflow_id: r.id, status: w?.status, message: "已請工作流程在目前的子任務完成後暫停。用一句話告訴使用者；要繼續時可以說「繼續」。" }) };
    }
    if (a.action === "resume") {
      const w = await resumeWorkflow(ctx.app, ctx.user, r.id);
      return { data: { workflow_id: r.id, action: "resume", status: w?.status ?? r.status }, text: JSON.stringify({ workflow_id: r.id, status: w?.status, message: "工作流程已繼續執行。用一句話告訴使用者。" }) };
    }
    const text = a.text?.trim() ?? "";
    if (!text) throw badRequest("補充指示不能是空的：text 放使用者自己的話。");
    if (!ownWords(text, await recentUserText(ctx.db, ctx.conversationId))) throw badRequest("補充指示要用使用者自己的話（逐字，或他訊息裡調整工作流程的那一句），不要改寫或加上他沒說的要求。");
    if (r.status === "awaiting_input") throw badRequest("這個工作流程正在等使用者回答問題：如果這則訊息是在回答，用 answer_workflow；否則先用 ask_user 確認。");
    const w = await addGuidance(ctx.app, ctx.user, r.id, text);
    const before = r.status === "awaiting_plan_approval";
    return {
      data: { workflow_id: r.id, action: "guidance", status: w?.status ?? r.status },
      text: JSON.stringify({ workflow_id: r.id, status: w?.status, message: before ? "已把使用者的話交給工作流程，計畫會依它重新規劃，新的計畫卡片會再給使用者確認（自動駕駛時自動核准）。用一句話說明，不要預告結果。" : "已把使用者的話當成補充指示交給執行中的工作流程，接下來的步驟會照著做。用一句話說明，不要預告結果。" }),
    };
  },
});

registerAgentTool({
  name: "answer_workflow",
  title: "回答工作流程的問題",
  titleEn: "Answer workflow question",
  risk: "read",
  mcp: false,
  modes: ["chat"],
  description:
    "A workflow of THIS conversation waits for the user's answer (status 等使用者回答 in <conversation_workflows>, with its question) and the user's message answers it: pass their own words as `text` and the workflow continues with that answer " +
    "(its question card's free-text question gets the text; a question without a card gets it as the answer/guidance). Never invent or paraphrase an answer the user did not give; if the message is about something else, answer normally and remind them the workflow still waits. " +
    "Choice-only cards cannot be answered by text: the tool says so — then tell the user to pick on the card.",
  input: z.object({
    workflow_id: z.string().max(64).optional().describe("Default: the conversation's workflow that waits for an answer"),
    text: z.string().trim().min(1).max(2000).describe("The user's own answer, verbatim"),
  }),
  summarize: (a) => `回答工作流程：${a.text.replace(/\s+/g, " ").slice(0, 50)}`,
  async execute(a, ctx) {
    const r = await steerTarget(ctx, a.workflow_id, ["awaiting_input"]);
    if (r.status !== "awaiting_input") throw badRequest("這個工作流程目前沒有在等使用者回答。");
    if (!ownWords(a.text, await recentUserText(ctx.db, ctx.conversationId))) throw badRequest("回答要用使用者自己的話（逐字），不要替他回答或改寫。");
    const w = await answerWorkflowText(ctx.app, ctx.user, r.id, a.text);
    return { data: { workflow_id: r.id, status: w?.status ?? "running", answered: true }, text: JSON.stringify({ workflow_id: r.id, status: w?.status, message: "已把使用者的回答交給工作流程，它會接著做。用一句話說明，不要預告結果。" }) };
  },
});
