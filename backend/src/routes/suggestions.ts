import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { notFound, parse } from "../lib/http.js";
import { canReview, createSuggestion, decideSuggestion, getSuggestion, listSuggestions } from "../lib/suggestions/service.js";

const targetType = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const targetId = z.string().min(1).max(200);
const listQuery = z.object({ target_type: targetType, target_id: targetId, status: z.enum(["pending", "applied", "partial", "rejected", "all"]).default("pending") });
const createInput = z
  .object({
    target_type: targetType,
    target_id: targetId,
    title: z.string().trim().max(200).optional(),
    proposed_text: z.string().max(500_000).optional(),
    hunks: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0), after: z.string().max(200_000), before: z.string().max(200_000).optional() })).min(1).max(200).optional(),
  })
  .refine((v) => (v.proposed_text === undefined) !== (v.hunks === undefined));
const params = z.object({ id: z.uuid() });
const hunkParams = z.object({ id: z.uuid(), hunkId: z.uuid(), decision: z.enum(["accept", "reject"]) });
const allParams = z.object({ id: z.uuid(), decision: z.enum(["accept-all", "reject-all"]) });

/** Suggestions on any registered target (docs/editor-collab.md). Everyone signed in reads; editors of the target decide. */
export default async function suggestions(app: FastifyInstance) {
  const deps = () => ({ db: app.db, collab: app.collab });

  app.get("/suggestions", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    const list = await listSuggestions(deps(), q.target_type, q.target_id, q.status);
    reply.header("Cache-Control", "no-store");
    return { suggestions: list, permissions: { review: await canReview(deps(), user, q.target_type, q.target_id) } };
  });

  app.get("/suggestions/:id", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(params, request.params);
    const suggestion = await getSuggestion(deps(), id);
    if (!suggestion) throw notFound("建議不存在。");
    reply.header("Cache-Control", "no-store");
    return { suggestion };
  });

  app.post("/suggestions", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body);
    const suggestion = await createSuggestion(deps(), {
      targetType: input.target_type, targetId: input.target_id, title: input.title, proposedText: input.proposed_text, hunks: input.hunks, source: "user", actorId: user.id, user,
    });
    reply.code(201);
    return { suggestion };
  });

  app.post("/suggestions/:id/hunks/:hunkId/:decision", async (request) => {
    const user = await requireUser(request);
    const { id, hunkId, decision } = parse(hunkParams, request.params);
    return decideSuggestion(deps(), { suggestionId: id, hunkIds: [hunkId], decision, actorId: user.id, user });
  });

  app.post("/suggestions/:id/:decision", async (request) => {
    const user = await requireUser(request);
    const { id, decision } = parse(allParams, request.params);
    return decideSuggestion(deps(), { suggestionId: id, hunkIds: "all", decision: decision === "accept-all" ? "accept" : "reject", actorId: user.id, user });
  });
}
