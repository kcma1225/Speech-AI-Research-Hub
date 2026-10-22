/**
 * Goal API (docs/architecture.md "Workflows" → Goals): create (plan a deliverable as a roadmap; one stage starts a
 * plain workflow), list / detail (the GoalCard polls), approve the roadmap, edit its stages, retry / skip a stage,
 * change the deliverable, cancel, delete. Child plugin of routes/workflows.ts.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { parse } from "../lib/http.js";
import { pageContextSchema } from "./agent.js";
import { runView } from "../workflows/store.js";
import { approveGoal, cancelGoal, createGoal, deleteGoal, editStages, goalDetail, goalsOf, resumeGoal, updateGoal } from "../workflows/goals/service.js";
import { goalView } from "../workflows/goals/store.js";
import { DELIVERABLE_KINDS } from "../workflows/goals/capabilities.js";
import "../workflows/goals/agent-tools.js";

const idParams = z.object({ id: z.uuid() });
const uuid = z.uuid();
const createInput = z.object({
  request: z.string().trim().min(2).max(4000),
  deliverable: z.enum(DELIVERABLE_KINDS).optional(),
  playbook: z.string().max(40).optional(),
  conversation_id: uuid.optional(),
  context: pageContextSchema,
  inputs: z.object({ study: z.string().max(80).optional(), paper_id: uuid.optional(), project_id: uuid.optional(), note_ids: z.array(uuid).max(6).optional() }).optional(),
  autopilot: z.boolean().optional(),
});
const stageEdit = z.object({ id: z.string().max(40).optional(), playbook: z.string().max(40).optional(), title: z.string().trim().max(80).optional(), request: z.string().trim().max(2000).optional(), why: z.string().max(300).optional(), skip: z.boolean().optional() });
const stagesInput = z.object({ stages: z.array(stageEdit).max(8) });
const approveInput = z.object({ stages: z.array(stageEdit).max(8).optional() }).optional();
const resumeInput = z.object({ action: z.enum(["retry", "skip"]) });
const updateInput = z.object({ request: z.string().trim().min(2).max(4000), deliverable: z.enum(DELIVERABLE_KINDS).optional() });
const listQuery = z.object({ conversation: uuid.optional(), active: z.enum(["0", "1"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export default async function goals(app: FastifyInstance) {
  const view = async (g: Awaited<ReturnType<typeof approveGoal>>) => ({ goal: g ? await goalView(app.db, g) : null });

  app.post("/goals", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body);
    const out = await createGoal(app, user, { request: input.request, deliverable: input.deliverable, playbook: input.playbook, conversationId: input.conversation_id ?? null, context: (input.context ?? null) as Record<string, unknown> | null, inputs: input.inputs, autopilot: input.autopilot });
    reply.code(201);
    if (out.kind === "goal") return { goal: await goalView(app.db, out.goal), workflow: null };
    return { goal: null, workflow: await runView(app.db, out.runs[0]!) };
  });

  app.get("/goals", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    reply.header("Cache-Control", "no-store");
    return { goals: user.role === "admin" ? [] : await goalsOf(app.db, user, { conversation: q.conversation, active: q.active === "1", limit: q.limit }) };
  });

  app.get("/goals/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    reply.header("Cache-Control", "no-store");
    return { goal: await goalDetail(app.db, user, id) };
  });

  app.post("/goals/:id/approve", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    return view(await approveGoal(app, user, id, parse(approveInput, request.body ?? {})?.stages));
  });
  app.put("/goals/:id/stages", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    return view(await editStages(app, user, id, parse(stagesInput, request.body).stages));
  });
  app.post("/goals/:id/resume", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    return view(await resumeGoal(app, user, id, parse(resumeInput, request.body).action));
  });
  app.patch("/goals/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    const input = parse(updateInput, request.body);
    return view(await updateGoal(app, user, id, input));
  });
  app.post("/goals/:id/cancel", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    return view(await cancelGoal(app, user, id));
  });
  app.delete("/goals/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個目標。");
    await deleteGoal(app, user, id);
    return { ok: true };
  });
}
