/**
 * Workflow API (docs/architecture.md "Workflows"): create (API / composer 「交給 Agent」), list, detail, SSE events,
 * plan approval / revision, pause / resume / 繼續改, cancel, guidance, objective edits, deck publish, delete.
 * The engine runs in the ai-worker (`ai_workflow`); this plugin also sweeps runs whose job ended in a race.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import { attachmentsInput } from "../agent/attachments/index.js";
import { aiFor } from "../ai/platform/index.js";
import { pageContextSchema } from "./agent.js";
import { closeWorkflowEventHub, getRun, lastWorkflowSeq, runView, workflowEventHub, workflowEventsAfter } from "../workflows/store.js";
import {
  addGuidance, answerWorkflow, approveWorkflow, cancelWorkflow, createWorkflows, deleteWorkflow, patchWorkflow, pauseWorkflow, publishWorkflowDeck, resumeWorkflow, revisePlan, startFromChat, sweepWorkflows, workflowDetail,
} from "../workflows/service.js";
import { answerInput } from "../agent/ask.js";
import { listWorkflowPlaybooks } from "../workflows/playbooks/index.js";
import "../workflows/agent-tools.js";
import goals from "./goals.js";
import { activeAgentRuns } from "../workflows/active.js";
import type { RunRow } from "../workflows/types.js";

const idParams = z.object({ id: z.uuid() });
const answerBody = z.object({ card_id: z.string().min(1).max(80), answers: z.array(answerInput).max(6) });
const uuid = z.uuid();
const inputsSchema = z.object({
  study: z.string().max(80).optional(),
  paper_id: uuid.optional(),
  deck_id: uuid.optional(),
  project_id: uuid.optional(),
  note_ids: z.array(uuid).max(6).optional(),
  paper_ids: z.array(uuid).max(10).optional(),
  pages: z.number().int().min(3).max(40).optional(),
  mode: z.enum(["progress", "paper_report"]).optional(),
  attachment_ids: z.array(uuid).max(6).optional(),
}).optional();
const createInput = z.object({
  request: z.string().trim().min(2).max(4000),
  playbook: z.string().max(40).optional(),
  conversation_id: uuid.optional(),
  context: pageContextSchema,
  inputs: inputsSchema,
  autopilot: z.boolean().optional(),
  // Chips of 「交給 Agent」 (with conversation_id): stored on the user message; uploads / notes become the run's material.
  attachments: attachmentsInput.optional(),
});
const listQuery = z.object({ active: z.enum(["0", "1"]).optional(), study: z.string().max(80).optional(), status: z.string().max(40).optional(), conversation: uuid.optional(), batch: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const approveInput = z.object({
  objective: z.string().trim().max(1000).optional(),
  criteria: z.array(z.object({ id: z.string().max(40).optional(), text: z.string().trim().min(1).max(300) })).max(40).optional(),
  // 「你的要求」 (requirements.ts): the full edited list (an empty list removes them all).
  requirements: z.array(z.object({ id: z.string().max(40).optional(), type: z.string().max(40).optional(), text: z.string().trim().max(300), params: z.record(z.string(), z.unknown()).optional() })).max(12).optional(),
  steps: z.array(z.object({ key: z.string().max(40), title: z.string().max(200).optional(), instructions: z.string().max(4000).optional(), skip: z.boolean().optional() })).max(60).optional(),
  outline: z.array(z.object({ title: z.string().trim().min(1).max(120), points: z.array(z.string().max(200)).max(8) })).min(1).max(40).optional(),
});
const textInput = z.object({ text: z.string().trim().min(1).max(2000) });
const feedbackInput = z.object({ feedback: z.string().trim().min(1).max(2000) });
const resumeInput = z.object({ more: z.boolean().optional() }).optional();
const patchInput = z.object({ objective: z.string().trim().max(1000).optional(), criteria: z.array(z.object({ id: z.string().max(40).optional(), text: z.string().trim().min(1).max(300) })).max(40).optional() });

/** Tests: whether role `assistant` can take a workflow (default: AI status ok/degraded). */
let availability: (() => Promise<boolean>) | null = null;
export const setWorkflowAvailability = (fn: typeof availability) => {
  availability = fn;
};

export default async function workflows(app: FastifyInstance) {
  // Goals (multi-stage roadmaps of workflows): /goals…
  await app.register(goals);
  async function assistantUp() {
    if (availability) return availability();
    try {
      const st = (await aiFor(app).status()).roles.assistant?.state;
      return st === "ok" || st === "degraded";
    } catch {
      return false;
    }
  }

  app.get("/workflows/playbooks", async (request) => {
    await requireUser(request);
    return { playbooks: listWorkflowPlaybooks().map((p) => ({ id: p.id, title: p.title, title_en: p.titleEn, description: p.description, description_en: p.descriptionEn, auto_approvable: p.autoApprovable })) };
  });

  app.post("/workflows", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body);
    if (!(await assistantUp())) throw new HttpError(503, "AI 助理維護中，暫時無法啟動工作流程。", { code: "llm_unavailable", hint: "請稍後再試，或請管理員檢查模型設定。" });
    if (input.attachments?.length && !input.conversation_id) throw badRequest("附件需要搭配對話（conversation_id）。");
    const base = { request: input.request, playbook: input.playbook, context: (input.context ?? null) as Record<string, unknown> | null, inputs: input.inputs, autopilot: input.autopilot, ...(input.attachments?.length ? { attachments: input.attachments } : {}) };
    const run = input.conversation_id ? await startFromChat(app, user, { ...base, conversationId: input.conversation_id }) : (await createWorkflows(app, user, base)).runs[0]!;
    const batch = run.batch_id ? (await app.db.query<RunRow>("SELECT * FROM workflow_runs WHERE batch_id=$1 ORDER BY batch_index", [run.batch_id])).rows : [run];
    reply.code(201);
    return { workflow: await runView(app.db, run), workflows: await Promise.all(batch.map((r) => runView(app.db, r))), batch_id: run.batch_id, conversation_id: run.conversation_id };
  });

  app.get("/workflows", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    let studyId: string | null = null;
    if (q.study) studyId = (await app.db.query<{ id: string }>("SELECT id FROM studies WHERE id::text=$1 OR slug=$1", [q.study])).rows[0]?.id ?? "00000000-0000-0000-0000-000000000000";
    const rows = (await app.db.query<RunRow>(
      `SELECT * FROM workflow_runs WHERE user_id=$1
          AND ($2::boolean IS NOT TRUE OR status IN ('queued','planning','awaiting_plan_approval','running','verifying','awaiting_input','needs_pdf','paused'))
          AND ($3::uuid IS NULL OR study_id=$3) AND ($4::text IS NULL OR status=$4) AND ($5::uuid IS NULL OR conversation_id=$5) AND ($7::uuid IS NULL OR batch_id=$7)
        ORDER BY CASE WHEN $7::uuid IS NOT NULL THEN batch_index END, (status IN ('queued','planning','awaiting_plan_approval','running','verifying','awaiting_input','needs_pdf','paused')) DESC, created_at DESC LIMIT $6`,
      [user.id, q.active === "1", studyId, q.status ?? null, q.conversation ?? null, q.limit ?? 30, q.batch ?? null],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return { workflows: await Promise.all(rows.map((r) => runView(app.db, r))) };
  });

  // Shell indicator 「N 個 Agent 執行中」 + its live overview (polled ~5 s while open): my active workflow runs and
  // assistant runs that work or wait for me. Admin accounts have no workspace → always empty.
  app.get("/workflows/active", async (request, reply) => {
    const user = await requireUser(request);
    reply.header("Cache-Control", "no-store");
    const runs = user.role === "admin" ? [] : await activeAgentRuns(app.db, user.id);
    return { runs, count: runs.length, needs_you: runs.filter((r) => r.needs_you).length };
  });

  app.get("/workflows/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    const detail = await workflowDetail(app, user, id);
    reply.header("Cache-Control", "no-store");
    return { ...detail, resumeFrom: await lastWorkflowSeq(app.db, id) };
  });

  app.get("/workflows/:id/events", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    const run = await getRun(app.db, id);
    if (!run || run.user_id !== user.id) throw notFound("找不到這個工作流程。");
    const query = request.query as { after?: string; once?: string };
    const header = request.headers["last-event-id"];
    let last = Number((Array.isArray(header) ? header[0] : header) ?? query.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    let closed = false;
    let busy = false;
    let again = false;
    const pump = async () => {
      if (closed) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const rows = await workflowEventsAfter(app.db, id, last);
          for (const r of rows) {
            if (closed) return;
            res.write(`id: ${r.seq}\nevent: ${r.type}\ndata: ${JSON.stringify(r.data)}\n\n`);
            last = Number(r.seq);
          }
          if (rows.length === 500) again = true;
        } while (again && !closed);
      } catch (e) {
        request.log.warn({ err: e }, "workflow sse pump failed");
      } finally {
        busy = false;
      }
    };
    if (query.once) {
      await pump();
      res.end();
      return;
    }
    const unsubscribe = await workflowEventHub(app.db, app.log).subscribe(id, () => void pump());
    await pump();
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    const poll = setInterval(() => void pump(), 5_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(poll);
      unsubscribe();
    };
    request.raw.on("close", close);
    res.on("error", close);
  });

  const view = async (r: RunRow | null) => ({ workflow: r ? await runView(app.db, r) : null });

  app.post("/workflows/:id/approve", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await approveWorkflow(app, user, id, parse(approveInput, request.body ?? {})));
  });
  app.post("/workflows/:id/revise", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await revisePlan(app, user, id, parse(feedbackInput, request.body).feedback));
  });
  app.post("/workflows/:id/pause", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await pauseWorkflow(app, user, id));
  });
  app.post("/workflows/:id/resume", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await resumeWorkflow(app, user, id, { more: parse(resumeInput, request.body ?? {})?.more }));
  });
  app.post("/workflows/:id/cancel", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await cancelWorkflow(app, user, id));
  });
  app.post("/workflows/:id/guidance", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await addGuidance(app, user, id, parse(textInput, request.body).text));
  });
  app.post("/workflows/:id/answer", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await answerWorkflow(app, user, id, parse(answerBody, request.body)));
  });
  app.patch("/workflows/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    return view(await patchWorkflow(app, user, id, parse(patchInput, request.body)));
  });
  app.post("/workflows/:id/publish", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    const out = await publishWorkflowDeck(app, user, id);
    reply.code(202);
    return out;
  });
  app.delete("/workflows/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個工作流程。");
    await deleteWorkflow(app, user, id);
    return { ok: true };
  });

  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    if (process.env.NODE_ENV === "test") return;
    timer = setInterval(() => void sweepWorkflows(app).catch((e) => app.log.warn({ err: e }, "workflow sweep failed")), 60_000);
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await closeWorkflowEventHub(app.db);
  });
}
