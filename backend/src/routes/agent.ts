/**
 * Agent API (docs/architecture.md "Agent"): conversations, messages → runs, SSE events with Last-Event-ID replay,
 * approval decisions, cancel / continue, assistant settings. Child plugins: memories (`/memories`), MCP (`/mcp`,
 * `/agent/mcp-tokens`).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import { closeEventHub, eventHub, eventsAfter, insertEvent, lastSeq } from "../agent/events.js";
import { answersInput } from "../agent/ask.js";
import { agentFor } from "../agent/runtime.js";
import { afterUndo, undoToolCall } from "../agent/undo.js";
import { getAgentSettings, saveAgentSettings } from "../agent/settings.js";
import { toolCatalogue } from "../agent/tools/registry.js";
import { conversationView, messageView, runView, toolCallView, type ConversationRow, type MessageRow, type RunRow, type ToolCallRow } from "../agent/views.js";
import memories from "./memories.js";
import mcp from "./mcp.js";
import { agentImagePrefix } from "../agent/images.js";
import { attachmentsInput } from "../agent/attachments/index.js";
import { conversationActivity, deleteConversationWorkflows } from "../workflows/service.js";

const idParams = z.object({ id: z.uuid() });
const uuidLike = z.string().regex(/^[0-9a-f-]{36}$/i);
export const pageContextSchema = z
  .object({
    path: z.string().max(300).optional(),
    studyId: uuidLike.optional(),
    studySlug: z.string().max(80).optional(),
    noteId: uuidLike.optional(),
    deckId: uuidLike.optional(),
    page: z.number().int().min(1).max(9999).optional(),
    meetingId: uuidLike.optional(),
    paperId: uuidLike.optional(),
    taskId: uuidLike.optional(),
  })
  .nullable()
  .optional();
const createInput = z.object({ mode: z.enum(["chat", "interview"]).optional(), context: pageContextSchema, autopilot: z.boolean().optional(), title: z.string().trim().min(1).max(120).optional() });
const patchInput = z.object({ title: z.string().trim().min(1).max(120).optional(), autopilot: z.boolean().optional(), memory_enabled: z.boolean().optional() });
const messageInput = z
  .object({ text: z.string().trim().max(20000).optional(), answers: answersInput.optional(), context: pageContextSchema, intent: z.enum(["make_note"]).optional(), attachments: attachmentsInput.optional() })
  .refine((v) => !!v.answers || !!v.text, { message: "empty" });
const editInput = z.object({ text: z.string().trim().max(20000).optional(), answers: answersInput.optional(), context: pageContextSchema, attachments: attachmentsInput.optional() });
const messageParams = z.object({ id: z.uuid(), messageId: z.uuid() });
const decisionInput = z.object({ decision: z.enum(["approve", "approve_conversation", "deny"]), reason: z.string().max(500).optional(), edited_args: z.record(z.string(), z.unknown()).optional() });
const listQuery = z.object({ mode: z.enum(["chat", "interview"]).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const settingsInput = z.object({ memory_enabled: z.boolean().optional(), autopilot_default: z.boolean().optional(), autopilot_explained: z.boolean().optional() });

async function ownConversation(app: FastifyInstance, userId: string, id: string) {
  const conv = (await app.db.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
  if (!conv) throw notFound("找不到這個對話。");
  return conv;
}

export default async function agent(app: FastifyInstance) {
  const runtime = agentFor(app);
  const background = app.config.NODE_ENV !== "test" && process.env.AGENT_BACKGROUND !== "0";
  app.addHook("onReady", async () => {
    if (background) runtime.start();
  });
  app.addHook("onClose", async () => {
    await runtime.stop();
    await closeEventHub(app.db);
  });

  await app.register(memories);
  await app.register(mcp);

  // ---------------------------------------------------------------- settings + catalogue

  app.get("/agent/settings", async (request, reply) => {
    const user = await requireUser(request);
    reply.header("Cache-Control", "no-store");
    return { settings: await getAgentSettings(app.db, user.id) };
  });

  app.patch("/agent/settings", async (request) => {
    const user = await requireUser(request);
    const input = parse(settingsInput, request.body);
    return { settings: await saveAgentSettings(app.db, user.id, input) };
  });

  app.get("/agent/tools", async (request) => {
    await requireUser(request);
    return { tools: toolCatalogue() };
  });

  /** Pending approvals across my conversations (header/sidebar badge). */
  app.get("/agent/pending", async (request, reply) => {
    const user = await requireUser(request);
    const rows = (await app.db.query<{ id: string; title: string; mode: string; n: number }>(
      `SELECT c.id,c.title,c.mode,count(*)::int AS n FROM tool_calls tc JOIN conversations c ON c.id=tc.conversation_id
        WHERE c.user_id=$1 AND tc.status IN ('pending_approval','deferred') GROUP BY c.id ORDER BY max(tc.created_at) DESC LIMIT 20`,
      [user.id],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return { count: rows.reduce((a, r) => a + r.n, 0), conversations: rows };
  });

  // ---------------------------------------------------------------- conversations

  app.get("/agent/conversations", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    const like = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = (await app.db.query<ConversationRow & { last_text: string | null; run_status: string | null; pending: number }>(
      `SELECT c.*,
              (SELECT m.text FROM agent_messages m WHERE m.conversation_id=c.id AND m.hidden_by IS NULL AND m.role IN ('user','assistant') AND m.text<>'' ORDER BY m.seq DESC LIMIT 1) AS last_text,
              (SELECT r.status FROM agent_runs r WHERE r.conversation_id=c.id ORDER BY r.started_at DESC LIMIT 1) AS run_status,
              (SELECT count(*)::int FROM tool_calls tc WHERE tc.conversation_id=c.id AND tc.status IN ('pending_approval','deferred')) AS pending
         FROM conversations c
        WHERE c.user_id=$1 AND c.mode=$2 AND ($3::text IS NULL OR c.title ILIKE $3 OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversation_id=c.id AND m.text ILIKE $3))
        ORDER BY c.updated_at DESC LIMIT $4`,
      [user.id, q.mode ?? "chat", like, q.limit ?? 100],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return {
      conversations: rows.map((r) => ({ ...conversationView(r), last_text: r.last_text ? r.last_text.slice(0, 140) : null, run_status: r.run_status, pending: r.pending })),
    };
  });

  app.post("/agent/conversations", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(createInput, request.body ?? {});
    reply.code(201);
    return { conversation: await runtime.createConversation(user, { mode: input.mode, context: input.context ?? null, autopilot: input.autopilot, title: input.title }) };
  });

  app.get("/agent/conversations/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    const conv = await ownConversation(app, user.id, id);
    // Only the current branch (hidden_by IS NULL); other versions are listed per user message in `versions`.
    const [messages, calls, run, grants, settings, uses, versions] = await Promise.all([
      app.db.query<MessageRow>("SELECT * FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL AND role IN ('user','assistant','notice','compaction') ORDER BY seq", [id]),
      app.db.query<ToolCallRow>("SELECT tc.* FROM tool_calls tc JOIN agent_messages m ON m.id=tc.message_id WHERE tc.conversation_id=$1 AND m.hidden_by IS NULL ORDER BY m.seq, tc.position", [id]),
      // The latest run of the current branch (an active run, or one with a visible message).
      app.db.query<RunRow>(
        `SELECT r.* FROM agent_runs r WHERE r.conversation_id=$1
            AND (r.status IN ('running','awaiting_approval','awaiting_llm') OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.run_id=r.id AND m.hidden_by IS NULL))
          ORDER BY r.started_at DESC LIMIT 1`,
        [id],
      ),
      app.db.query<{ tool: string; scope: string }>("SELECT tool,scope FROM conversation_grants WHERE conversation_id=$1 ORDER BY created_at", [id]),
      getAgentSettings(app.db, user.id),
      app.db.query<{ message_id: string; id: string; content: string }>(
        "SELECT mu.message_id,m.id,m.content FROM memory_uses mu JOIN memories m ON m.id=mu.memory_id JOIN agent_messages am ON am.id=mu.message_id WHERE am.conversation_id=$1 AND am.hidden_by IS NULL",
        [id],
      ),
      app.db.query<{ g: string; ids: string[] }>(
        "SELECT coalesce(version_of,id) AS g, array_agg(id ORDER BY seq) AS ids FROM agent_messages WHERE conversation_id=$1 AND role='user' GROUP BY 1 HAVING count(*)>1",
        [id],
      ),
    ]);
    const groups = new Map<string, string[]>();
    for (const v of versions.rows) for (const m of v.ids) groups.set(m, v.ids);
    const latest = run.rows[0] ?? null;
    const provenance = latest?.status === "awaiting_approval" ? latest.taint_sources.slice(-3) : [];
    let resumeFrom = await lastSeq(app.db, id);
    if (latest?.status === "running") {
      // Replay the current step's deltas so a reload mid-stream shows the partial answer.
      const s = (await app.db.query<{ seq: string }>("SELECT max(seq) AS seq FROM agent_events WHERE conversation_id=$1 AND run_id=$2 AND type='step_start'", [id, latest.id])).rows[0]?.seq;
      if (s) resumeFrom = Number(s) - 1;
    }
    const byMessage = new Map<string, { id: string; content: string }[]>();
    for (const u of uses.rows) byMessage.set(u.message_id, [...(byMessage.get(u.message_id) ?? []), { id: u.id, content: u.content }]);
    reply.header("Cache-Control", "no-store");
    return {
      conversation: conversationView(conv),
      messages: messages.rows.map((m) => messageView({ ...m, memories: byMessage.get(m.id) ?? [], versions: groups.get(m.id) })),
      toolCalls: calls.rows.map((c) => toolCallView(c, { provenance: c.status === "pending_approval" ? provenance : [] })),
      run: latest ? runView(latest) : null,
      grants: grants.rows,
      settings,
      resumeFrom,
    };
  });

  app.patch("/agent/conversations/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    const input = parse(patchInput, request.body);
    await ownConversation(app, user.id, id);
    const settings = await getAgentSettings(app.db, user.id);
    if (input.memory_enabled && !settings.memory_enabled) throw new HttpError(409, "請先在「設定 → AI 助理」開啟記憶。");
    const row = (await app.db.query<ConversationRow>(
      `UPDATE conversations SET title=COALESCE($2,title), title_source=CASE WHEN $2::text IS NULL THEN title_source ELSE 'user' END,
              autopilot=CASE WHEN mode='interview' THEN false ELSE COALESCE($3,autopilot) END,
              memory_enabled=CASE WHEN mode='interview' THEN false ELSE COALESCE($4,memory_enabled) END, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, input.title ?? null, input.autopilot ?? null, input.memory_enabled ?? null],
    )).rows[0]!;
    const view = conversationView(row);
    await insertEvent(app.db, id, null, "conversation", { conversation: view });
    // Autopilot = 完全自動: cards still open in the current step are settled as autopilot decides them.
    if (input.autopilot && row.autopilot) await runtime.applyAutopilot(user, id);
    return { conversation: view };
  });

  // What still runs for the conversation (the delete dialog warns about it).
  app.get("/agent/conversations/:id/activity", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    await ownConversation(app, user.id, id);
    return conversationActivity(app.db, id);
  });

  app.delete("/agent/conversations/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    const { stop_agents } = parse(z.object({ stop_agents: z.enum(["1", "true"]).optional() }), request.query);
    await ownConversation(app, user.id, id);
    // Agents still running: refuse unless the caller confirmed stopping them (the dialog showed the warning).
    const activity = await conversationActivity(app.db, id);
    if (!stop_agents && (activity.assistant || activity.workflows.length || activity.goals.length)) {
      throw new HttpError(409, `這個對話還有 ${activity.goals.length ? `${activity.goals.length} 個目標` : activity.workflows.length ? `${activity.workflows.length} 個 Agent 工作流程` : "AI 回覆"}正在進行；刪除對話會一併停止並刪除它們。`, { code: "active_agents" });
    }
    await runtime.cancel(user, id).catch(() => undefined);
    await deleteConversationWorkflows(app, user, id);
    await app.db.query("DELETE FROM conversations WHERE id=$1 AND user_id=$2", [id, user.id]);
    // Page images shown to the model (view_paper_pages).
    await app.storage.deletePrefix(agentImagePrefix(id)).catch((e) => request.log.warn({ err: e }, "agent image cleanup failed"));
    return { ok: true };
  });

  // ---------------------------------------------------------------- runs

  app.post("/agent/conversations/:id/messages", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    const input = parse(messageInput, request.body, "訊息不能是空的（最多 20 000 字）。");
    await ownConversation(app, user.id, id);
    await requireAvailable();
    reply.code(202);
    return runtime.postMessage(user, id, { text: input.text, answers: input.answers, context: input.context ?? null, ...(input.intent ? { intent: input.intent } : {}), ...(input.attachments ? { attachments: input.attachments } : {}) });
  });

  const requireAvailable = async () => {
    if (!(await runtime.available())) throw new HttpError(503, "AI 助理維護中，請稍後再試。", { code: "llm_unavailable", hint: "其他功能照常可用；管理員可到「模型設定」檢查 AI 助理的路由。" });
  };

  /** Edit a user message (text, or the answers of a question card) → new version; the later tail is kept as the old version. */
  app.post("/agent/conversations/:id/messages/:messageId/edit", async (request, reply) => {
    const user = await requireUser(request);
    const { id, messageId } = parse(messageParams, request.params, "找不到這則訊息。");
    const input = parse(editInput, request.body ?? {}, "訊息最多 20 000 字。");
    await ownConversation(app, user.id, id);
    await requireAvailable();
    reply.code(202);
    return runtime.editMessage(user, id, messageId, { text: input.text, answers: input.answers, ...(input.context !== undefined ? { context: input.context } : {}), ...(input.attachments ? { attachments: input.attachments } : {}) });
  });

  /** 「重新產生」 the latest reply (resubmits the last user message as a new version). */
  app.post("/agent/conversations/:id/regenerate", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    await ownConversation(app, user.id, id);
    await requireAvailable();
    reply.code(202);
    return runtime.regenerate(user, id);
  });

  /** ‹ 1/2 ›: make another version of a user message (and its replies) the current branch. */
  app.post("/agent/conversations/:id/messages/:messageId/activate", async (request) => {
    const user = await requireUser(request);
    const { id, messageId } = parse(messageParams, request.params, "找不到這則訊息。");
    await ownConversation(app, user.id, id);
    return runtime.activateVersion(user, id, messageId);
  });

  app.post("/agent/conversations/:id/cancel", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    return runtime.cancel(user, id);
  });

  /** Continue after a limit stop, a failure or while waiting for the LLM (retry now). */
  app.post("/agent/conversations/:id/continue", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    await ownConversation(app, user.id, id);
    reply.code(202);
    return runtime.continueRun(user, id);
  });

  app.post("/agent/tool-calls/:id/decision", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個操作。");
    const input = parse(decisionInput, request.body);
    return runtime.decideCall(user, id, { decision: input.decision, reason: input.reason, editedArgs: input.edited_args });
  });

  /** 「復原」 a call that ran without a card (autopilot / grant): see `agent/undo.ts` for the safety rules. */
  app.post("/agent/tool-calls/:id/undo", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個操作。");
    const result = await undoToolCall(app.db, user, id);
    afterUndo(result.disconnect);
    const event = await runtime.toolCallEvent(app.db, id);
    const conversationId = (await app.db.query<{ conversation_id: string; run_id: string }>("SELECT conversation_id,run_id FROM tool_calls WHERE id=$1", [id])).rows[0]!;
    await insertEvent(app.db, conversationId.conversation_id, conversationId.run_id, "tool_call", event.data);
    return { toolCall: event.data.toolCall };
  });

  /**
   * SSE: every event after `Last-Event-ID` (or `?after=`), then live. Event ids are `agent_events.seq`.
   * `?once=1` replays and closes (tests, debugging).
   */
  app.get("/agent/conversations/:id/events", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    await ownConversation(app, user.id, id);
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
          const rows = await eventsAfter(app.db, id, last);
          for (const r of rows) {
            if (closed) return;
            res.write(`id: ${r.seq}\nevent: ${r.type}\ndata: ${JSON.stringify(r.data)}\n\n`);
            last = Number(r.seq);
          }
          if (rows.length === 500) again = true;
        } while (again && !closed);
      } catch (e) {
        request.log.warn({ err: e }, "agent sse pump failed");
      } finally {
        busy = false;
      }
    };
    if (query.once) {
      await pump();
      res.end();
      return;
    }
    const unsubscribe = await eventHub(app.db, app.log).subscribe(id, () => void pump());
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
    res.on("close", close);
  });
}

