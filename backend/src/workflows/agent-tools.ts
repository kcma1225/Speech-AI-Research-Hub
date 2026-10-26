/**
 * Chat tools of the workflow module (registered at import by routes/workflows.ts):
 * `start_workflow` (risk read: it only plans; nothing is written before the user approves the plan card) and
 * `get_workflow` (status, criteria, report — so the assistant reports the real state, never unverified outcomes).
 */
import { z } from "zod";
import { transaction } from "../db.js";
import { registerAgentTool } from "../agent/tools/registry.js";
import { badRequest, notFound } from "../lib/http.js";
import { artifactGrounded, UNGROUNDED_TARGET } from "./context.js";
import { getRun, getSteps } from "./store.js";
import { announceRuns, insertWorkflows, startMessage, startResult } from "./service.js";
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
    "playbook is only a proposal: the workflow routes on the user's own words (a deck asked for is a deck whatever playbook you pass) and records a mismatch. When unsure, omit playbook.",
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
