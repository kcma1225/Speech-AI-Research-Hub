/**
 * The user's own memories (`/memories`): list, add (a user action is consent, no card), edit, delete, delete all,
 * export. Memories are private: no route shows them to anyone else, admins included.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, notFound, parse } from "../lib/http.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { getMemory, insertMemory, listMemories, looksSecret, MEMORY_MAX } from "../agent/memory.js";
import { getAgentSettings } from "../agent/settings.js";

const idParams = z.object({ id: z.uuid() });
const content = z.string().trim().min(1).max(MEMORY_MAX);
const scopeInput = z.enum(["global", "study"]);
const createInput = z.object({ content, scope: scopeInput.optional(), study: z.string().max(80).optional(), conversation_id: z.uuid().optional() });
const patchInput = z.object({ content: content.optional(), scope: scopeInput.optional(), study: z.string().max(80).nullable().optional() });
const listQuery = z.object({ scope: scopeInput.optional(), study: z.string().max(80).optional(), q: z.string().max(100).optional() });

export default async function memories(app: FastifyInstance) {
  async function studyId(user: Awaited<ReturnType<typeof requireUser>>, scope: "global" | "study" | undefined, ref: string | null | undefined) {
    if (scope !== "study") return null;
    if (!ref) throw badRequest("研究範圍的記憶需要選擇研究。");
    return (await loadStudyAccess(app.db, ref, user)).study.id;
  }

  app.get("/memories", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    const sid = q.study ? (await loadStudyAccess(app.db, q.study, user)).study.id : undefined;
    const settings = await getAgentSettings(app.db, user.id);
    reply.header("Cache-Control", "no-store");
    return { memories: await listMemories(app.db, user.id, { scope: q.scope, studyId: sid, q: q.q }), enabled: settings.memory_enabled };
  });

  app.get("/memories/export", async (request, reply) => {
    const user = await requireUser(request);
    const rows = await listMemories(app.db, user.id);
    reply.header("Cache-Control", "no-store").header("Content-Disposition", 'attachment; filename="memories.json"').type("application/json; charset=utf-8");
    return JSON.stringify({ format: "speech-ai-hub.memories", version: 1, exported_at: new Date().toISOString(), memories: rows.map((m) => ({ content: m.content, scope: m.scope, study: m.study?.title ?? null, source: m.source, created_at: m.created_at, updated_at: m.updated_at })) }, null, 2);
  });

  app.post("/memories", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body, "記憶內容需為 1–300 字。");
    if (looksSecret(input.content)) throw badRequest("這段內容看起來像密碼或金鑰，不能記住。");
    let conversationId: string | null = null;
    if (input.conversation_id) {
      const own = await app.db.query("SELECT 1 FROM conversations WHERE id=$1 AND user_id=$2", [input.conversation_id, user.id]);
      conversationId = own.rowCount ? input.conversation_id : null;
    }
    const sid = await studyId(user, input.scope, input.study);
    const id = await insertMemory(app.db, user.id, { content: input.content, scope: sid ? "study" : "global", studyId: sid, source: "user", conversationId });
    if (!id) throw conflict("記憶已達上限（500 則），請先刪除一些。");
    reply.code(201);
    return { memory: await getMemory(app.db, user.id, id) };
  });

  app.patch("/memories/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這則記憶。");
    const input = parse(patchInput, request.body, "記憶內容需為 1–300 字。");
    const cur = await getMemory(app.db, user.id, id);
    if (!cur) throw notFound("找不到這則記憶。");
    if (input.content && looksSecret(input.content)) throw badRequest("這段內容看起來像密碼或金鑰，不能記住。");
    const scope = input.scope ?? cur.scope;
    const sid = scope === "study" ? (input.study !== undefined ? await studyId(user, "study", input.study) : cur.study_id) : null;
    if (scope === "study" && !sid) throw badRequest("研究範圍的記憶需要選擇研究。");
    await app.db.query("UPDATE memories SET content=COALESCE($3,content), scope=$4, study_id=$5, updated_at=now() WHERE id=$1 AND user_id=$2", [id, user.id, input.content ?? null, scope, sid]);
    return { memory: await getMemory(app.db, user.id, id) };
  });

  app.delete("/memories/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這則記憶。");
    const r = await app.db.query("DELETE FROM memories WHERE id=$1 AND user_id=$2", [id, user.id]);
    if (!r.rowCount) throw notFound("找不到這則記憶。");
    return { ok: true };
  });

  app.delete("/memories", async (request) => {
    const user = await requireUser(request);
    const r = await app.db.query("DELETE FROM memories WHERE user_id=$1", [user.id]);
    return { ok: true, deleted: r.rowCount ?? 0 };
  });
}
