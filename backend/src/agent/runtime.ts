/**
 * Agent runtime (spec §5/§9, docs/research/agent-harness.md §2). The loop runs in the backend process and persists
 * everything, so nothing is lost on reload or restart:
 *
 *   POST message → user message + agent_runs(running) → executor:
 *     loop: resolve the open step (run approved calls; wait while any call is pending_approval → status
 *           awaiting_approval, executor ends) → append the tool message → limits → model call (role `assistant`,
 *           streamed into agent_events) → assistant message → tool calls: validate, precheck, target, policy
 *           (reads run at once; writes ask unless granted / autopilot) → next step.
 *   Decisions (approve / approve_conversation / deny) resume the run once every call of the step is decided.
 *   LLM outage → awaiting_llm with backoff, auto-resumed by the ticker or when the role comes back.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { aiFor, isLlmUnavailable, isPlatformError } from "../ai/platform/index.js";
import type { RoleChatRequest } from "../ai/platform/index.js";
import { AiError } from "../ai/errors.js";
import type { ChatEvent, ContentBlock, ProviderState, TextBlock, ToolResultBlock, ToolUseBlock } from "../ai/types.js";
import { transaction, type Queryable } from "../db.js";
import { CURRENT_USER_COLUMNS, toCurrentUser, type CurrentUser } from "../lib/auth.js";
import { conflict, HttpError, notFound } from "../lib/http.js";
import { answersText, askUserInput, validateAnswers, type AnswersInput, type StoredAnswers } from "./ask.js";
import { EventWriter, insertEvent } from "./events.js";
import { memoriesForContext, stripMemoryMarkers, usedMemories } from "./memory.js";
import { decide, grantScope } from "./policy.js";
import {
  capResult, compactionCut, envelope, estimateTokens, intentText, pageContextText, SUMMARY_SYSTEM, systemPrompt, toModelMessages, transcriptText,
  type PageContext, type StoredMessage,
} from "./prompt.js";
import { getAgentSettings } from "./settings.js";
import { completionReview, failureNote, failureStreak, FAILURE_NOTE_AT, FAILURE_STOP, planReminder, REPEAT_NOTE, type RunCall } from "./guards.js";
import type { Plan } from "./tools/plan.js";
import { inlineToolImages, storeToolImages, toolResultContent, type StoredToolImage } from "./images.js";
import "./tools/index.js";
import { inlineAttachmentImages, prepareAttachments, refOf, type AttachmentRef, type PreparedAttachments, type StoredAttachment } from "./attachments/index.js";
import { INTERVIEW_INTRO, MATURITY_QUESTION } from "./tools/interview.js";
import { getAgentTool, listAgentTools, toolJsonSchema, type AgentToolContext, type AgentToolDef } from "./tools/registry.js";
import { conversationView, messageView, runView, toolCallView, type ConversationRow, type MessageRow, type RunRow, type ToolCallRow } from "./views.js";

/** A user turn: free text and/or the answers to an `ask_user` card; page context from the page (or the edited message). */
export type TurnInput = { text?: string; answers?: AnswersInput; context?: PageContext | null; intent?: TurnIntent; attachments?: AttachmentRef[]; prepared?: PreparedAttachments };
/** Attachment fields of a built turn (stored list + taint labels of content the caller did not author). */
const turnAttachments = (p?: PreparedAttachments) => ({ attachments: p?.stored.length ? p.stored : (null as StoredAttachment[] | null), taint: p?.taint ?? [] });
/** Quick actions of the chat toolbar: the shown text stays the user's, the model also gets the task instructions. */
export type TurnIntent = "make_note";

export type ModelCall = (req: RoleChatRequest, ctx: { userId: string; signal: AbortSignal; onRoute?: (info: { model: string }) => void }) => AsyncIterable<ChatEvent>;
export type FastCall = (req: RoleChatRequest, ctx: { userId: string }) => Promise<string>;

export type AgentLimits = {
  maxSteps: number;
  /** Executing time per run (waiting for approval or the LLM does not count). */
  maxActiveMs: number;
  maxTokens: number;
  autopilotWrites: number;
  /** Same tool + same arguments this many times in one run → stop. */
  repeat: number;
  approvalTtlMs: number;
  llmRetries: number;
};
export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 25, maxActiveMs: 10 * 60_000, maxTokens: 400_000, autopilotWrites: 20, repeat: 3, approvalTtlMs: 24 * 3600_000, llmRetries: 5 };

export type AgentOptions = {
  model?: ModelCall;
  fast?: FastCall;
  /** Whether the `assistant` role can take a new message (503 otherwise). */
  available?: () => Promise<boolean>;
  /** Whether the `assistant` role takes images right now (default: ai.capabilities("assistant").vision). */
  vision?: () => Promise<boolean>;
  limits?: Partial<AgentLimits>;
  /** Estimated-token thresholds: clear old tool results above `clearAbove`, summarise above `compactAbove`. */
  compaction?: { clearAbove: number; compactAbove: number };
  maxOutputTokens?: number;
  leaseMs?: number;
  /** Delays between LLM retries (ms), by attempt. */
  backoffMs?: number[];
  /** Completion review before a chat turn ends (default on; src/agent/guards.ts). */
  review?: boolean;
  /** Concurrent read-only tool calls per step (default 4; open-world reads always run after them, one by one). */
  readConcurrency?: number;
};

/** Second attempt after an empty / cut-off reply (the user never sees it; it is not stored). */
const RETRY_NUDGE = "（系統提示：上一次的回覆在給出答案前就中斷或用完了輸出額度。請不要長篇思考，直接用繁體中文給出完整的回答；內容很多時先給最重要的部分，最後問使用者要不要繼續。）";

/** Hidden last turn when a run hits its step / time limit: answer in text only. */
const wrapUpNudge = (kind: "steps" | "time") =>
  `（系統提示：這一輪已達${kind === "steps" ? "步數" : "時間"}上限，現在不能再呼叫工具。請直接用文字簡短回覆：1) 目前已經完成了什麼（只說真的完成的），2) 還有哪些沒做完，3) 告訴使用者可以按「繼續」讓你接著做。不要道歉，也不要重複先前已經寫過的內容。）`;

const ACTIVE = ["running", "awaiting_approval", "awaiting_llm"] as const;
const UNRESOLVED = ["pending_approval", "approved", "running"];

const stable = (v: unknown): string =>
  v && typeof v === "object" ? (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`) : JSON.stringify(v);

const errorText = (e: unknown) => (e instanceof HttpError ? e.message : isPlatformError(e) ? e.message_zh : e instanceof AiError ? e.message_zh : "工具執行時發生錯誤。");

export class AgentRuntime {
  readonly options: AgentOptions;
  readonly owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  private readonly controllers = new Map<string, AbortController>();
  private readonly executing = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private offStatus: (() => void) | null = null;
  private stopped = false;

  constructor(readonly app: FastifyInstance, options: AgentOptions = {}) {
    this.options = options;
  }

  get limits(): AgentLimits {
    return { ...DEFAULT_LIMITS, ...this.options.limits };
  }

  private get db() {
    return this.app.db;
  }

  // ---------------------------------------------------------------- background

  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.app.log.warn({ err: e }, "agent tick failed")), intervalMs);
    try {
      this.offStatus = aiFor(this.app).onStatus((s) => {
        const st = s.roles.assistant?.state;
        if (st === "ok" || st === "degraded") void this.db.query("UPDATE agent_runs SET next_retry_at=now() WHERE status='awaiting_llm'").then(() => this.tick()).catch(() => undefined);
      });
    } catch {
      // platform not initialised (tests)
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offStatus?.();
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.executing.values()]);
  }

  /** Resumes due LLM retries and orphaned runs, expires stale approvals, prunes old events. */
  async tick() {
    const due = (await this.db.query<{ id: string }>("UPDATE agent_runs SET status='running', next_retry_at=NULL, updated_at=now() WHERE status='awaiting_llm' AND next_retry_at<=now() RETURNING id")).rows;
    for (const r of due) {
      await this.emitRun(r.id);
      this.kick(r.id);
    }
    // Self-heal: a run left waiting although nothing in its open step is pending any more (approved calls only).
    const unstuck = (await this.db.query<{ id: string }>(
      `UPDATE agent_runs r SET status='running', updated_at=now() WHERE r.status='awaiting_approval' AND r.updated_at < now() - interval '5 seconds'
          AND EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.run_id=r.id AND tc.status='approved')
          AND NOT EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.run_id=r.id AND tc.status='pending_approval') RETURNING r.id`,
    )).rows;
    for (const r of unstuck) await this.emitRun(r.id);
    const orphans = (await this.db.query<{ id: string }>("SELECT id FROM agent_runs WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<now())")).rows;
    for (const r of orphans) if (!this.executing.has(r.id)) this.kick(r.id);
    const expired = (await this.db.query<{ conversation_id: string; run_id: string }>(
      `SELECT DISTINCT tc.conversation_id, tc.run_id FROM tool_calls tc JOIN agent_runs r ON r.id=tc.run_id
        WHERE tc.status='pending_approval' AND r.status='awaiting_approval' AND tc.created_at < now() - ($1 || ' milliseconds')::interval`,
      [String(this.limits.approvalTtlMs)],
    )).rows;
    for (const e of expired) {
      const events = await transaction(this.db, async (client) => {
        await this.lockConversation(client, e.conversation_id);
        const ev = await this.closeStep(client, e.conversation_id, "expire");
        await client.query("UPDATE agent_runs SET status='done', stop_reason='expired', finished_at=now(), updated_at=now() WHERE id=$1 AND status='awaiting_approval'", [e.run_id]);
        await this.insertNotice(client, e.conversation_id, e.run_id, "expired", "等待同意的操作已逾時（24 小時），已自動取消。需要的話請重新提出。");
        return ev;
      });
      await this.emitAll(e.conversation_id, e.run_id, events);
      await this.emitRun(e.run_id);
    }
    await this.db.query(
      `DELETE FROM agent_events e WHERE e.created_at < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.conversation_id=e.conversation_id AND r.status IN ('running','awaiting_approval','awaiting_llm'))`,
    );
  }

  private kick(runId: string) {
    if (this.stopped || this.executing.has(runId)) return;
    const p = this.execute(runId)
      .catch((e) => this.app.log.error({ err: e, runId }, "agent run crashed"))
      .finally(() => this.executing.delete(runId));
    this.executing.set(runId, p);
  }

  /** Waits for the executor of a run in this process (tests). */
  async settle(runId?: string) {
    for (let i = 0; i < 200; i++) {
      const list = runId ? [this.executing.get(runId)].filter(Boolean) : [...this.executing.values()];
      if (!list.length) return;
      await Promise.allSettled(list);
    }
  }

  // ---------------------------------------------------------------- helpers

  private async loadUser(db: Queryable, id: string): Promise<CurrentUser | null> {
    const row = (await db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL`, [id])).rows[0];
    return row ? toCurrentUser(row) : null;
  }

  private lockConversation(client: Queryable, id: string) {
    return client.query("SELECT id FROM conversations WHERE id=$1 FOR UPDATE", [id]);
  }

  private async getRun(db: Queryable, id: string) {
    return (await db.query<RunRow>("SELECT * FROM agent_runs WHERE id=$1", [id])).rows[0] ?? null;
  }

  async activeRun(db: Queryable, conversationId: string, forUpdate = false) {
    return (await db.query<RunRow>(`SELECT * FROM agent_runs WHERE conversation_id=$1 AND status = ANY($2) ORDER BY started_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [conversationId, ACTIVE])).rows[0] ?? null;
  }

  private async emitRun(runId: string) {
    const run = await this.getRun(this.db, runId);
    if (run) await insertEvent(this.db, run.conversation_id, run.id, "run", { run: runView(run) });
  }

  private async emitAll(conversationId: string, runId: string | null, events: { type: "tool_call" | "message"; data: Record<string, unknown> }[]) {
    for (const e of events) await insertEvent(this.db, conversationId, runId, e.type, e.data);
  }

  private async provenance(db: Queryable, runId: string) {
    return ((await db.query<{ taint_sources: string[] }>("SELECT taint_sources FROM agent_runs WHERE id=$1", [runId])).rows[0]?.taint_sources ?? []).slice(-3);
  }

  async toolCallEvent(db: Queryable, id: string) {
    const row = (await db.query<ToolCallRow>("SELECT * FROM tool_calls WHERE id=$1", [id])).rows[0]!;
    return { type: "tool_call" as const, data: { toolCall: toolCallView(row, { provenance: row.status === "pending_approval" ? await this.provenance(db, row.run_id) : [] }) } };
  }

  private async insertNotice(client: Queryable, conversationId: string, runId: string | null, kind: string, text: string) {
    const m = (await client.query<MessageRow>("INSERT INTO agent_messages(conversation_id,run_id,role,content,text) VALUES($1,$2,'notice',$3,$4) RETURNING *", [conversationId, runId, JSON.stringify([{ type: "notice", kind }]), text])).rows[0]!;
    return { type: "message" as const, data: { message: messageView(m) } };
  }

  /** The last assistant message with tool_use blocks that has no tool message yet (the open step). */
  private async openStep(db: Queryable, conversationId: string) {
    const last = (await db.query<MessageRow & { content: ContentBlock[] }>("SELECT * FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL AND role IN ('user','assistant','tool') ORDER BY seq DESC LIMIT 1", [conversationId])).rows[0];
    if (!last || last.role !== "assistant" || !last.content.some((b) => b.type === "tool_use")) return null;
    return last;
  }

  /**
   * Closes the open step: unresolved calls get a final status and synthetic result (`cancel` 已被使用者中止,
   * `supersede` 使用者改提其他要求, `expire` 操作逾時未確認), then the tool message pairs every tool_use. Inside the
   * conversation lock. Returns the events to emit after commit.
   */
  private async closeStep(client: Queryable, conversationId: string, mode: "cancel" | "supersede" | "expire" | "execute") {
    const events: { type: "tool_call" | "message"; data: Record<string, unknown> }[] = [];
    const step = await this.openStep(client, conversationId);
    if (!step) return events;
    const calls = (await client.query<ToolCallRow>("SELECT * FROM tool_calls WHERE message_id=$1 ORDER BY position FOR UPDATE", [step.id])).rows;
    for (const c of calls) {
      if (!UNRESOLVED.includes(c.status)) continue;
      if (mode === "execute") return events; // still waiting
      const [status, text] =
        mode === "expire" && c.status === "pending_approval"
          ? ["expired", "操作逾時未確認，已取消。"]
          : mode === "supersede" && c.status === "pending_approval"
            ? ["denied", "使用者沒有同意，改提了其他要求。"]
            : c.status === "running"
              ? ["failed", "執行被中斷，結果不明；請先確認後再決定是否重試。"]
              : ["cancelled", mode === "supersede" ? "使用者改提了其他要求，這個操作沒有執行。" : "已被使用者中止，沒有執行。"];
      await client.query("UPDATE tool_calls SET status=$2, result_text=$3, error=CASE WHEN $2='failed' THEN $3 ELSE error END, finished_at=now() WHERE id=$1", [c.id, status, text]);
      events.push(await this.toolCallEvent(client, c.id));
    }
    const fresh = (await client.query<ToolCallRow>("SELECT * FROM tool_calls WHERE message_id=$1 ORDER BY position", [step.id])).rows;
    const byProvider = new Map(fresh.map((c) => [c.provider_call_id, c]));
    const uses = step.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const results: ToolResultBlock[] = uses.map((u) => {
      const c = byProvider.get(u.id);
      if (!c) return { type: "tool_result", tool_use_id: u.id, content: "這個工具呼叫沒有被執行。", is_error: true };
      const images = c.status === "done" ? (c.result as { images?: StoredToolImage[] } | null)?.images : undefined;
      return { type: "tool_result", tool_use_id: u.id, content: toolResultContent(c.result_text ?? "（沒有結果）", images), ...(c.status === "done" ? {} : { is_error: true }) };
    });
    await client.query("INSERT INTO agent_messages(conversation_id,run_id,role,content) VALUES($1,$2,'tool',$3)", [conversationId, step.run_id, JSON.stringify(results)]);
    return events;
  }

  // ---------------------------------------------------------------- public API (routes)

  async createConversation(user: CurrentUser, input: { mode?: "chat" | "interview"; context?: PageContext | null; autopilot?: boolean; title?: string }) {
    const settings = await getAgentSettings(this.db, user.id);
    const ctx = await this.resolveContext(input.context ?? null);
    const row = (await this.db.query<ConversationRow>(
      `INSERT INTO conversations(user_id,mode,context,study_id,autopilot,memory_enabled,title,title_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.id, input.mode ?? "chat", JSON.stringify(ctx ?? {}), ctx?.studyId ?? null, input.mode === "interview" ? false : (input.autopilot ?? settings.autopilot_default), input.mode === "interview" ? false : settings.memory_enabled, input.title?.slice(0, 120) ?? "", input.title ? "user" : "auto"],
    )).rows[0]!;
    if (row.mode === "interview") await this.seedInterview(row.id, user.id);
    return conversationView(row);
  }

  /**
   * The interview opens with a fixed question card (「這個研究目前進行到哪個程度？」) without a model call: a finished run
   * whose assistant message holds one `ask_user` call, its result and the tool message (a valid transcript).
   */
  private async seedInterview(conversationId: string, userId: string) {
    await transaction(this.db, async (client) => {
      const run = (await client.query<{ id: string }>(
        "INSERT INTO agent_runs(conversation_id,user_id,status,max_steps,stop_reason,finished_at) VALUES($1,$2,'done',$3,'awaiting_input',now()) RETURNING id",
        [conversationId, userId, this.limits.maxSteps],
      )).rows[0]!;
      const use: ToolUseBlock = { type: "tool_use", id: "seed_maturity", name: "ask_user", input: MATURITY_QUESTION };
      const msg = (await client.query<{ id: string }>(
        "INSERT INTO agent_messages(conversation_id,run_id,role,content,text) VALUES($1,$2,'assistant',$3,$4) RETURNING id",
        [conversationId, run.id, JSON.stringify([{ type: "text", text: INTERVIEW_INTRO }, use]), INTERVIEW_INTRO],
      )).rows[0]!;
      const resultText = envelope("ask_user", "問題卡片已顯示給使用者；使用者的回答會是下一則使用者訊息。", { untrusted: false });
      await client.query(
        `INSERT INTO tool_calls(run_id,conversation_id,message_id,step,position,provider_call_id,tool,args,risk,status,summary,result,result_text,finished_at)
         VALUES($1,$2,$3,0,0,$4,'ask_user',$5,'read','done',$6,$7,$8,now())`,
        [run.id, conversationId, msg.id, use.id, JSON.stringify(MATURITY_QUESTION), "詢問 1 個問題", JSON.stringify({ data: { questions: 1, status: "shown_to_user" }, links: [], source: null, untrusted: false }), resultText],
      );
      await client.query("INSERT INTO agent_messages(conversation_id,run_id,role,content) VALUES($1,$2,'tool',$3)", [conversationId, run.id, JSON.stringify([{ type: "tool_result", tool_use_id: use.id, content: resultText }])]);
    });
  }

  /** Validates and enriches the page context (study title; ids that do not resolve are dropped). */
  async resolveContext(ctx: PageContext | null): Promise<PageContext | null> {
    if (!ctx) return null;
    const out: PageContext = { path: ctx.path?.slice(0, 300) };
    const ref = ctx.studyId ?? ctx.studySlug;
    if (ref) {
      const s = (await this.db.query<{ id: string; slug: string; title: string }>("SELECT id,slug,title FROM studies WHERE id::text=$1 OR slug=$1 LIMIT 1", [ref])).rows[0];
      if (s) Object.assign(out, { studyId: s.id, studySlug: s.slug, studyTitle: s.title });
    }
    for (const k of ["noteId", "deckId", "meetingId", "paperId"] as const) if (ctx[k] && /^[0-9a-f-]{36}$/i.test(ctx[k]!)) out[k] = ctx[k];
    if (ctx.page && Number.isInteger(ctx.page) && ctx.page > 0 && ctx.page < 10000) out.page = ctx.page;
    return out;
  }

  async available() {
    if (this.options.available) return this.options.available();
    if (this.options.model) return true;
    const s = await aiFor(this.app).status();
    const st = s.roles.assistant?.state;
    return st === "ok" || st === "degraded";
  }

  /**
   * The content of a user turn: free text, or the answers to an `ask_user` card on the current branch (validated
   * against its questions; `beforeSeq` = the edited message, so the card must come before it). Inside the lock.
   */
  private async buildTurn(client: Queryable, conversationId: string, input: TurnInput, ctx: PageContext | null, beforeSeq: number | null) {
    const hint = pageContextText(ctx);
    const head: TextBlock[] = hint ? [{ type: "text", text: hint }] : [];
    const extra = input.text?.trim() ?? "";
    if (!input.answers) {
      if (!extra) throw new HttpError(400, "訊息不能是空的（最多 20 000 字）。");
      const task: TextBlock[] = input.intent ? [{ type: "text", text: intentText(input.intent) }] : [];
      return { blocks: [...head, ...(input.prepared?.blocks ?? []), { type: "text" as const, text: extra }, ...task], text: extra, answers: null as StoredAnswers | null, ...turnAttachments(input.prepared) };
    }
    const call = (await client.query<ToolCallRow & { mseq: string; hidden_by: string | null }>(
      "SELECT tc.*, m.seq AS mseq, m.hidden_by FROM tool_calls tc JOIN agent_messages m ON m.id=tc.message_id WHERE tc.id=$1 AND tc.conversation_id=$2",
      [input.answers.tool_call_id, conversationId],
    )).rows[0];
    if (!call || call.tool !== "ask_user" || call.hidden_by || (beforeSeq !== null && Number(call.mseq) >= beforeSeq)) throw notFound("找不到這張問題卡片。");
    if (call.status !== "done") throw conflict("這張問題卡片已經無法回答。");
    const args = askUserInput.safeParse(call.edited_args ?? call.args);
    if (!args.success) throw conflict("這張問題卡片的格式不正確。");
    const answered = (await client.query(
      "SELECT 1 FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL AND role='user' AND answers->>'toolCallId'=$2 AND ($3::bigint IS NULL OR seq<$3) LIMIT 1",
      [conversationId, call.id, beforeSeq],
    )).rowCount;
    if (answered) throw conflict("這些問題已經回答過了；要改的話請按「修改答案」。");
    const stored = validateAnswers(args.data, input.answers);
    const out = answersText(args.data, stored);
    const model = extra ? `${out.model}\n\n補充：${extra}` : out.model;
    const display = extra ? `${out.display}\n\n${extra}` : out.display;
    return { blocks: [...head, { type: "text" as const, text: model }], text: display, answers: stored, ...turnAttachments() };
  }

  /** Inserts the user turn, updates the conversation's context and opens a run (inside the lock). */
  private async insertTurn(client: Queryable, conv: ConversationRow, user: CurrentUser, turn: Awaited<ReturnType<AgentRuntime["buildTurn"]>>, ctx: PageContext | null, versionOf: string | null) {
    const msg = (await client.query<MessageRow>(
      "INSERT INTO agent_messages(conversation_id,role,content,text,page_context,answers,version_of,attachments) VALUES($1,'user',$2,$3,$4,$5,$6,$7) RETURNING *",
      [conv.id, JSON.stringify(turn.blocks), turn.text, ctx ? JSON.stringify(ctx) : null, turn.answers ? JSON.stringify(turn.answers) : null, versionOf, turn.attachments ? JSON.stringify(turn.attachments) : null],
    )).rows[0]!;
    const conversation = (await client.query<ConversationRow>(
      "UPDATE conversations SET updated_at=now(), context=CASE WHEN $2::jsonb IS NULL THEN context ELSE $2::jsonb END, study_id=CASE WHEN $2::jsonb IS NULL THEN study_id ELSE $3::uuid END WHERE id=$1 RETURNING *",
      [conv.id, ctx ? JSON.stringify(ctx) : null, ctx?.studyId ?? null],
    )).rows[0]!;
    const run = (await client.query<RunRow>(
      // Attached content the caller did not author taints the run from the start (like an untrusted tool result).
      "INSERT INTO agent_runs(conversation_id,user_id,status,max_steps,autopilot,tainted,taint_sources) VALUES($1,$2,'running',$3,$4,$5,$6::jsonb) RETURNING *",
      [conv.id, user.id, this.limits.maxSteps, conv.autopilot, turn.taint.length > 0, JSON.stringify(turn.taint)],
    )).rows[0]!;
    await client.query("UPDATE agent_messages SET run_id=$2 WHERE id=$1", [msg.id, run.id]);
    return { msg: { ...msg, run_id: run.id }, run, conversation };
  }

  /** Adds a user message (text or `ask_user` answers) and starts a run. A pending step is superseded (its open approvals are denied). */
  async postMessage(user: CurrentUser, conversationId: string, input: TurnInput | string, pageContext: PageContext | null = null) {
    let turnInput: TurnInput = typeof input === "string" ? { text: input, context: pageContext } : input;
    const ctx = await this.resolveContext(turnInput.context ?? null);
    // Attachments: access checked and content loaded before the lock (403/404 names the item).
    if (turnInput.attachments?.length && !turnInput.answers) turnInput = { ...turnInput, prepared: await prepareAttachments(this.app, user, conversationId, turnInput.attachments) };
    const result = await transaction(this.db, async (client) => {
      const conv = (await client.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [conversationId, user.id])).rows[0];
      if (!conv) throw notFound("找不到這個對話。");
      const events: { type: "tool_call" | "message"; data: Record<string, unknown> }[] = [];
      const active = await this.activeRun(client, conv.id, true);
      if (active?.status === "running") throw conflict("AI 正在回覆中，請先按「停止」或等它完成。");
      const turn = await this.buildTurn(client, conv.id, turnInput, ctx, null);
      if (active) {
        events.push(...(await this.closeStep(client, conv.id, active.status === "awaiting_approval" ? "supersede" : "cancel")));
        await client.query("UPDATE agent_runs SET status=$2, stop_reason=$3, finished_at=now(), updated_at=now() WHERE id=$1", [active.id, active.status === "awaiting_approval" ? "done" : "cancelled", "superseded"]);
      } else {
        // A run that stopped mid-step (crash, limit) leaves an open step: close it so the transcript stays valid.
        events.push(...(await this.closeStep(client, conv.id, "cancel")));
      }
      const out = await this.insertTurn(client, conv, user, turn, ctx, null);
      return { events, ...out, superseded: active?.id ?? null };
    });
    if (result.superseded) await this.emitRun(result.superseded);
    await this.emitAll(conversationId, result.superseded, result.events);
    await insertEvent(this.db, conversationId, result.run.id, "message", { message: messageView(result.msg) });
    await insertEvent(this.db, conversationId, result.run.id, "conversation", { conversation: conversationView(result.conversation) });
    await insertEvent(this.db, conversationId, result.run.id, "run", { run: runView(result.run) });
    this.kick(result.run.id);
    return { message: messageView(result.msg), run: runView(result.run) };
  }

  /**
   * Edit (or resubmit = regenerate) one user message of the current branch: the active run is cancelled first, every
   * current-branch message from it on is hidden (`hidden_by` = that message; kept as the previous version), the new
   * version is appended in the same version group and a run starts. `input` without text/answers resubmits the same
   * content. Pending approvals in the discarded tail were cancelled by the cancel; executed writes are not undone.
   */
  async editMessage(user: CurrentUser, conversationId: string, messageId: string, input: TurnInput) {
    await this.ownConversationOrThrow(user, conversationId);
    await this.cancel(user, conversationId, "superseded");
    const result = await transaction(this.db, async (client) => {
      const conv = (await client.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [conversationId, user.id])).rows[0];
      if (!conv) throw notFound("找不到這個對話。");
      const target = (await client.query<MessageRow & { version_of: string | null; answers: StoredAnswers | null; content: TextBlock[]; attachments: StoredAttachment[] | null }>(
        "SELECT * FROM agent_messages WHERE id=$1 AND conversation_id=$2 AND role='user' AND hidden_by IS NULL",
        [messageId, conv.id],
      )).rows[0];
      if (!target) throw notFound("找不到這則訊息。");
      if (await this.activeRun(client, conv.id, true)) throw conflict("AI 正在回覆中，請稍後再試。");
      const events = await this.closeStep(client, conv.id, "cancel");
      const seq = Number(target.seq);
      const ctx = input.context !== undefined ? await this.resolveContext(input.context) : ((target.page_context as PageContext | null) ?? null);
      let turn: Awaited<ReturnType<AgentRuntime["buildTurn"]>>;
      // A quick action (「整理成筆記」) keeps its task instructions when edited or regenerated.
      const intent = input.intent ?? (target.content.some((b) => b.type === "text" && b.text.startsWith('<task kind="make_note"')) ? ("make_note" as const) : undefined);
      // Attachments are kept unless the edit sends a new list; re-resolved (fresh content, access re-checked).
      const refs = input.attachments ?? (target.attachments ?? []).map(refOf);
      const prepared = refs.length && !target.answers ? await prepareAttachments(this.app, user, conv.id, refs) : undefined;
      if (input.answers || input.text?.trim()) {
        if (target.answers && !input.answers) throw new HttpError(400, "這則是問題卡片的回答，請用「修改答案」。");
        turn = await this.buildTurn(client, conv.id, { ...input, intent, prepared }, ctx, seq);
      } else if (target.answers) {
        // Regenerate after an answered card: the same answers again.
        turn = { blocks: target.content, text: target.text, answers: target.answers, ...turnAttachments() };
      } else {
        turn = await this.buildTurn(client, conv.id, { text: target.text, intent, prepared }, ctx, seq);
      }
      const firstUser = (await client.query<{ id: string }>("SELECT id FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq LIMIT 1", [conv.id])).rows[0];
      await this.hideFrom(client, conv.id, seq, target.id);
      if (firstUser?.id === target.id) await client.query("UPDATE conversations SET title='' WHERE id=$1 AND title_source='auto'", [conv.id]);
      const out = await this.insertTurn(client, conv, user, turn, ctx, target.version_of ?? target.id);
      return { events, ...out };
    });
    await this.emitAll(conversationId, null, result.events);
    await insertEvent(this.db, conversationId, null, "branch", { messageId: result.msg.id });
    await insertEvent(this.db, conversationId, result.run.id, "message", { message: messageView(result.msg) });
    await insertEvent(this.db, conversationId, result.run.id, "conversation", { conversation: conversationView(result.conversation) });
    await insertEvent(this.db, conversationId, result.run.id, "run", { run: runView(result.run) });
    this.kick(result.run.id);
    return { message: messageView(result.msg), run: runView(result.run) };
  }

  /** 「重新產生」: resubmits the last user message of the current branch as a new version. */
  async regenerate(user: CurrentUser, conversationId: string) {
    await this.ownConversationOrThrow(user, conversationId);
    const last = (await this.db.query<{ id: string }>("SELECT id FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq DESC LIMIT 1", [conversationId])).rows[0];
    if (!last) throw conflict("這個對話還沒有可以重新產生的訊息。");
    return this.editMessage(user, conversationId, last.id, {});
  }

  /**
   * ‹ 1/2 ›: makes another version of a user message current. The current tail (from the current version on) is
   * hidden under that version, and the chosen version's own tail comes back. No run starts.
   */
  async activateVersion(user: CurrentUser, conversationId: string, messageId: string) {
    await this.ownConversationOrThrow(user, conversationId);
    await this.cancel(user, conversationId, "superseded");
    const changed = await transaction(this.db, async (client) => {
      await this.lockConversation(client, conversationId);
      const target = (await client.query<{ id: string; seq: string; version_of: string | null; hidden_by: string | null }>(
        "SELECT id,seq,version_of,hidden_by FROM agent_messages WHERE id=$1 AND conversation_id=$2 AND role='user'", [messageId, conversationId],
      )).rows[0];
      if (!target) throw notFound("找不到這則訊息。");
      if (!target.hidden_by) return false;
      const group = target.version_of ?? target.id;
      const current = (await client.query<{ id: string; seq: string }>(
        "SELECT id,seq FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL AND coalesce(version_of,id)=$2 LIMIT 1", [conversationId, group],
      )).rows[0];
      if (target.hidden_by !== target.id || !current) throw conflict("這個版本目前無法切換。");
      if (await this.activeRun(client, conversationId, true)) throw conflict("AI 正在回覆中，請稍後再試。");
      await this.closeStep(client, conversationId, "cancel");
      await this.hideFrom(client, conversationId, Number(current.seq), current.id);
      await client.query("UPDATE agent_messages SET hidden_by=NULL WHERE conversation_id=$1 AND hidden_by=$2", [conversationId, target.id]);
      await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
      return true;
    });
    if (changed) await insertEvent(this.db, conversationId, null, "branch", { messageId });
    return { ok: true, changed };
  }

  /** Hides the current branch from `seq` on under `by`; a compaction summary covering it is dropped (rebuilt on demand). */
  private async hideFrom(client: Queryable, conversationId: string, seq: number, by: string) {
    await client.query("UPDATE agent_messages SET hidden_by=$3 WHERE conversation_id=$1 AND hidden_by IS NULL AND seq>=$2", [conversationId, seq, by]);
    await client.query("UPDATE conversations SET summary=NULL, summary_until=NULL WHERE id=$1 AND summary_until>=$2", [conversationId, seq]);
  }

  private async ownConversationOrThrow(user: CurrentUser, conversationId: string) {
    const ok = (await this.db.query("SELECT 1 FROM conversations WHERE id=$1 AND user_id=$2", [conversationId, user.id])).rowCount;
    if (!ok) throw notFound("找不到這個對話。");
  }

  /** Continue after a limit, a failure or an LLM outage (no new user message). */
  async continueRun(user: CurrentUser, conversationId: string) {
    const out = await transaction(this.db, async (client) => {
      const conv = (await client.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [conversationId, user.id])).rows[0];
      if (!conv) throw notFound("找不到這個對話。");
      const active = await this.activeRun(client, conv.id, true);
      if (active?.status === "running" || active?.status === "awaiting_approval") throw conflict(active.status === "running" ? "AI 正在回覆中。" : "請先回覆等待同意的操作。");
      if (active?.status === "awaiting_llm") {
        const run = (await client.query<RunRow>("UPDATE agent_runs SET status='running', next_retry_at=NULL, updated_at=now() WHERE id=$1 RETURNING *", [active.id])).rows[0]!;
        return { run, events: [] as Awaited<ReturnType<AgentRuntime["closeStep"]>> };
      }
      const last = (await client.query<{ role: string }>("SELECT role FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL AND role IN ('user','assistant','tool') ORDER BY seq DESC LIMIT 1", [conv.id])).rows[0];
      if (!last) throw conflict("這個對話還沒有訊息。");
      const events = await this.closeStep(client, conv.id, "cancel");
      const run = (await client.query<RunRow>("INSERT INTO agent_runs(conversation_id,user_id,status,max_steps,autopilot) VALUES($1,$2,'running',$3,$4) RETURNING *", [conv.id, user.id, this.limits.maxSteps, conv.autopilot])).rows[0]!;
      return { run, events };
    });
    await this.emitAll(conversationId, out.run.id, out.events);
    await insertEvent(this.db, conversationId, out.run.id, "run", { run: runView(out.run) });
    this.kick(out.run.id);
    return { run: runView(out.run) };
  }

  /** Stops the active run: the executor (if here) is aborted; pending calls are cancelled with synthetic results. */
  async cancel(user: CurrentUser, conversationId: string, reason: "cancelled" | "superseded" = "cancelled") {
    const out = await transaction(this.db, async (client) => {
      const conv = (await client.query("SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [conversationId, user.id])).rows[0];
      if (!conv) throw notFound("找不到這個對話。");
      const active = await this.activeRun(client, conversationId, true);
      if (!active) return null;
      await client.query("UPDATE agent_runs SET status='cancelled', stop_reason=$2, finished_at=now(), updated_at=now(), next_retry_at=NULL WHERE id=$1", [active.id, reason]);
      const local = this.controllers.get(active.id);
      // A local executor finalizes itself after it stops; otherwise close the step now.
      const events = local ? [] : await this.closeStep(client, conversationId, "cancel");
      return { run: active, local, events };
    });
    if (!out) return { run: null };
    out.local?.abort();
    await this.emitAll(conversationId, out.run.id, out.events);
    await this.emitRun(out.run.id);
    if (out.local) await this.executing.get(out.run.id)?.catch(() => undefined);
    return { run: runView((await this.getRun(this.db, out.run.id))!) };
  }

  /** Approve / approve for this conversation / deny one pending call. Resumes the run when the step is fully decided. */
  async decideCall(user: CurrentUser, toolCallId: string, input: { decision: "approve" | "approve_conversation" | "deny"; reason?: string; editedArgs?: Record<string, unknown> }) {
    const out = await transaction(this.db, async (client) => {
      const call = (await client.query<ToolCallRow & { user_id: string }>(
        "SELECT tc.*, c.user_id FROM tool_calls tc JOIN conversations c ON c.id=tc.conversation_id WHERE tc.id=$1 FOR UPDATE OF tc",
        [toolCallId],
      )).rows[0];
      if (!call || call.user_id !== user.id) throw notFound("找不到這個操作。");
      await this.lockConversation(client, call.conversation_id);
      if (call.status !== "pending_approval") throw conflict("這個操作已經處理過了。");
      const def = getAgentTool(call.tool);
      const touched = [call.id];
      if (input.decision === "deny") {
        const reason = input.reason?.trim().slice(0, 500);
        await client.query("UPDATE tool_calls SET status='denied', deny_reason=$2, decided_by=$3, decided_at=now(), finished_at=now(), result_text=$4 WHERE id=$1", [
          call.id, reason ?? null, user.id, `使用者拒絕了這個操作。${reason ? `理由：${reason}` : ""}請不要重試相同的呼叫；說明或詢問下一步。`,
        ]);
      } else {
        if (!def) throw conflict("這個工具已不存在。");
        let edited: Record<string, unknown> | null = null;
        if (input.editedArgs) {
          const parsed = def.input.safeParse(input.editedArgs);
          if (!parsed.success) throw new HttpError(400, "修改後的內容不正確。");
          edited = parsed.data as Record<string, unknown>;
        }
        const grant = input.decision === "approve_conversation" && !def.alwaysAsk && def.risk === "write" && (def.grantable ?? true);
        await client.query("UPDATE tool_calls SET status='approved', approved_via='user', decided_by=$2, decided_at=now(), edited_args=$3 WHERE id=$1", [call.id, user.id, edited ? JSON.stringify(edited) : null]);
        if (grant) {
          const scope = grantScope(call.target);
          await client.query("INSERT INTO conversation_grants(conversation_id,tool,scope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [call.conversation_id, call.tool, scope]);
          // Other pending calls of the same step covered by the new grant are approved too.
          const others = await client.query<{ id: string }>(
            `UPDATE tool_calls SET status='approved', approved_via='conversation_grant', decided_by=$3, decided_at=now()
              WHERE message_id=$1 AND status='pending_approval' AND tool=$2 AND coalesce(target->>'studyId','*')=$4 AND approval_reason='write' RETURNING id`,
            [call.message_id, call.tool, user.id, scope],
          );
          touched.push(...others.rows.map((r) => r.id));
        }
      }
      const events = [];
      for (const id of touched) events.push(await this.toolCallEvent(client, id));
      const pending = (await client.query("SELECT 1 FROM tool_calls WHERE message_id=$1 AND status='pending_approval' LIMIT 1", [call.message_id])).rowCount;
      let resumed = false;
      if (!pending) {
        resumed = ((await client.query("UPDATE agent_runs SET status='running', updated_at=now() WHERE id=$1 AND status='awaiting_approval'", [call.run_id])).rowCount ?? 0) > 0;
      }
      return { call, events, resumed };
    });
    await this.emitAll(out.call.conversation_id, out.call.run_id, out.events);
    if (out.resumed) {
      await this.emitRun(out.call.run_id);
      this.kick(out.call.run_id);
    }
    return { toolCall: (out.events[0]!.data as { toolCall: unknown }).toolCall, resumed: out.resumed };
  }

  // ---------------------------------------------------------------- executor

  private async execute(runId: string) {
    const leaseMs = this.options.leaseMs ?? 30_000;
    const claimed = (await this.db.query<RunRow>(
      `UPDATE agent_runs SET lease_owner=$2, lease_expires_at=now() + ($3 || ' milliseconds')::interval, updated_at=now()
        WHERE id=$1 AND status='running' AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at<now()) RETURNING *`,
      [runId, this.owner, String(leaseMs)],
    )).rows[0];
    if (!claimed) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const writer = new EventWriter(this.db, claimed.conversation_id, runId);
    const t0 = Date.now();
    const beat = setInterval(() => {
      void this.db
        .query<{ status: string }>("UPDATE agent_runs SET lease_expires_at=now() + ($3 || ' milliseconds')::interval WHERE id=$1 AND lease_owner=$2 RETURNING status", [runId, this.owner, String(leaseMs)])
        .then((r) => {
          if (r.rows[0]?.status === "cancelled" && !controller.signal.aborted) controller.abort();
        })
        .catch(() => undefined);
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    try {
      await this.loop(claimed, writer, controller.signal, t0);
    } catch (e) {
      this.app.log.error({ err: e, runId }, "agent run failed");
      await this.db.query("UPDATE agent_runs SET status='failed', error=$2, finished_at=now(), updated_at=now() WHERE id=$1 AND status='running'", [runId, JSON.stringify({ error: "AI 助理發生錯誤，請重試。", code: "internal" })]);
      await writer.drain();
      await this.emitRun(runId);
    } finally {
      clearInterval(beat);
      await writer.drain();
      await this.db.query("UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL, active_ms=active_ms+$2 WHERE id=$1", [runId, Date.now() - t0]).catch(() => undefined);
      this.controllers.delete(runId);
      const run = await this.getRun(this.db, runId).catch(() => null);
      if (run?.status === "cancelled") await this.finalizeCancelled(run);
    }
  }

  private async finalizeCancelled(run: RunRow) {
    const events = await transaction(this.db, async (client) => {
      await this.lockConversation(client, run.conversation_id);
      return this.closeStep(client, run.conversation_id, "cancel");
    });
    await this.emitAll(run.conversation_id, run.id, events);
    await this.emitRun(run.id);
  }

  private async finish(run: RunRow, status: "done" | "failed", extra: { stopReason?: string; error?: unknown; notice?: [string, string] } = {}) {
    const events = await transaction(this.db, async (client) => {
      await this.lockConversation(client, run.conversation_id);
      const updated = await client.query("UPDATE agent_runs SET status=$2, stop_reason=$3, error=$4, finished_at=now(), updated_at=now() WHERE id=$1 AND status='running'", [run.id, status, extra.stopReason ?? null, extra.error ? JSON.stringify(extra.error) : null]);
      if (!updated.rowCount) return [];
      return extra.notice ? [await this.insertNotice(client, run.conversation_id, run.id, extra.notice[0], extra.notice[1])] : [];
    });
    await this.emitAll(run.conversation_id, run.id, events);
    await this.emitRun(run.id);
  }

  private async loop(initial: RunRow, writer: EventWriter, signal: AbortSignal, t0: number) {
    const runId = initial.id;
    let stopAfterStep: [string, string] | null = null;
    for (;;) {
      const run = await this.getRun(this.db, runId);
      if (!run || run.status !== "running" || signal.aborted) return;
      const user = await this.loadUser(this.db, run.user_id);
      if (!user) return this.finish(run, "failed", { error: { error: "帳號已停用。", code: "forbidden" } });
      const conv = (await this.db.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1", [run.conversation_id])).rows[0];
      if (!conv) return;

      // 1. The open step: run approved calls, wait for pending ones, then append the tool message.
      const step = await this.openStep(this.db, conv.id);
      if (step) {
        const waiting = await this.runApproved(run, conv, user, step.id, writer, signal);
        if (signal.aborted) return;
        if (waiting) {
          // Under the conversation lock (decisions hold it too) and only while a call is still pending: an approval that
          // lands between the check above and this update would otherwise leave the run waiting forever.
          const moved = await transaction(this.db, async (client) => {
            await this.lockConversation(client, conv.id);
            return client.query(
              "UPDATE agent_runs SET status='awaiting_approval', updated_at=now() WHERE id=$1 AND status='running' AND EXISTS (SELECT 1 FROM tool_calls WHERE message_id=$2 AND status='pending_approval')",
              [run.id, step.id],
            );
          });
          if (!moved.rowCount) continue;
          await writer.drain();
          await this.emitRun(run.id);
          void this.maybeTitle(conv, user).catch(() => undefined);
          return;
        }
        const events = await transaction(this.db, async (client) => {
          await this.lockConversation(client, conv.id);
          return this.closeStep(client, conv.id, "execute");
        });
        await writer.drain();
        await this.emitAll(conv.id, run.id, events);
        if (stopAfterStep) return this.finish(run, "done", { stopReason: stopAfterStep[0], notice: stopAfterStep });
        // A question card was shown: the turn ends here; the answers come back as the next user message.
        const asked = await this.db.query("SELECT 1 FROM tool_calls WHERE message_id=$1 AND tool='ask_user' AND status='done' LIMIT 1", [step.id]);
        if (asked.rowCount) {
          await this.finish(run, "done", { stopReason: "awaiting_input" });
          void this.maybeTitle(conv, user).catch(() => undefined);
          return;
        }
        continue;
      }

      // 2. Limits.
      const active = run.active_ms + (Date.now() - t0);
      // Step / time limit: one last model call without tools so the user gets a summary of what was done and what is
      // left instead of a bare stop (opencode's max-steps prompt; tool definitions stay for the prompt cache).
      if (run.step >= run.max_steps || active > this.limits.maxActiveMs) {
        const steps = run.step >= run.max_steps;
        const res = await this.modelStep(run, conv, user, writer, signal, { wrapUp: steps ? "steps" : "time" });
        if (res.kind === "stopped") return;
        await writer.drain();
        return steps
          ? this.finish(run, "done", { stopReason: "limit_steps", notice: ["limit_steps", `已達這一輪的步數上限（${run.max_steps} 步）。要繼續的話請按「繼續」。`] })
          : this.finish(run, "done", { stopReason: "limit_time", notice: ["limit_time", "這一輪執行太久，已先停止。要繼續的話請按「繼續」。"] });
      }
      if (run.tokens_in + run.tokens_out > this.limits.maxTokens) return this.finish(run, "done", { stopReason: "limit_tokens", notice: ["limit_tokens", "這一輪用量已達上限，已先停止。要繼續的話請按「繼續」。"] });

      // 3. Model call.
      const res = await this.modelStep(run, conv, user, writer, signal);
      if (res.kind === "stopped") return;
      if (res.kind !== "ok") {
        if (res.kind === "llm_down") return this.awaitLlm(run, writer, res.error);
        await writer.drain();
        return this.finish(run, "failed", { error: res.error });
      }
      if (!res.calls.length) {
        await writer.drain();
        if (res.truncated) await this.finish(run, "done", { stopReason: "limit_output", notice: ["limit_output", "AI 的回覆不完整（輸出被截斷或是空的）。可以按「繼續」讓它接著回答，或換個方式再問一次。"] });
        else await this.finish(run, "done");
        void this.maybeTitle(conv, user).catch(() => undefined);
        return;
      }
      stopAfterStep = await this.proposeCalls(run, conv, user, res.messageId, res.calls, writer, signal);
      await this.db.query("UPDATE agent_runs SET step=step+1, updated_at=now() WHERE id=$1", [run.id]);
    }
  }

  private async awaitLlm(run: RunRow, writer: EventWriter, error: { error: string; code?: string; hint?: string }) {
    const waits = run.llm_waits + 1;
    const backoff = this.options.backoffMs ?? [20_000, 40_000, 80_000, 160_000, 300_000];
    await writer.emit("step_discarded", { runId: run.id });
    await writer.drain();
    if (waits > this.limits.llmRetries) return this.finish(run, "failed", { error: { ...error, code: "llm_unavailable" } });
    const delay = backoff[Math.min(waits - 1, backoff.length - 1)] ?? 60_000;
    await this.db.query(
      "UPDATE agent_runs SET status='awaiting_llm', llm_waits=$2, next_retry_at=now() + ($3 || ' milliseconds')::interval, error=$4, updated_at=now() WHERE id=$1 AND status='running'",
      [run.id, waits, String(delay), JSON.stringify({ ...error, code: "llm_unavailable" })],
    );
    await this.emitRun(run.id);
  }

  private toolsFor(conv: ConversationRow, memoryOn: boolean) {
    return listAgentTools({ mode: conv.mode }).filter((t) => t.name !== "remember" || memoryOn);
  }

  private async modelStep(run: RunRow, conv: ConversationRow, user: CurrentUser, writer: EventWriter, signal: AbortSignal, opts: { wrapUp?: "steps" | "time" } = {}):
    Promise<{ kind: "ok"; messageId: string; calls: ToolUseBlock[]; truncated?: boolean } | { kind: "stopped" } | { kind: "llm_down" | "failed"; error: { error: string; code?: string; hint?: string } }> {
    const settings = await getAgentSettings(this.db, user.id);
    const memoryOn = conv.mode === "chat" && settings.memory_enabled && conv.memory_enabled;
    const memories = memoryOn ? await memoriesForContext(this.db, user.id, conv.study_id) : null;
    const tools = this.toolsFor(conv, memoryOn);
    const system = systemPrompt({ mode: conv.mode, user, memories });
    const vision = await this.visionNow();
    const messages = await inlineAttachmentImages(this.app.storage, await inlineToolImages(this.app.storage, await this.contextMessages(conv, user, system), { vision }), { vision });
    const req: RoleChatRequest = {
      messages: [{ role: "system", content: system }, ...messages],
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) })),
      // Room for a full paper explanation or a structured reading note in one reply (clamped to the model's limit).
      maxTokens: this.options.maxOutputTokens ?? 8000,
      signal,
    };
    if (opts.wrapUp) {
      req.toolChoice = "none";
      req.messages = [...req.messages, { role: "user", content: [{ type: "text", text: wrapUpNudge(opts.wrapUp) }] }];
    }
    // Completion review (src/agent/guards.ts): at most one hidden correction round per model step.
    let reviewed = !!opts.wrapUp || conv.mode !== "chat" || this.options.review === false;
    let draft: { text: string; reasoning: string; stop: string | null } | null = null;
    let overflowRetried = false;
    await writer.emit("step_start", { runId: run.id, step: run.step });
    let text = "";
    let reasoning = "";
    let calls: ToolUseBlock[] = [];
    let providerState: ProviderState | undefined;
    let model: string | null = null;
    let usage = { in: 0, out: 0 };
    let stop: string | null = null;
    let truncated = false;
    const call = this.options.model ?? ((r, c) => aiFor(this.app).chatStream("assistant", r, { userId: c.userId, signal: c.signal, onRoute: (i) => c.onRoute?.(i) }));
    for (let attempt = 0; ; attempt++) {
    try {
      for await (const ev of call(req, { userId: user.id, signal, onRoute: (i) => (model = i.model) })) {
        if (signal.aborted) break;
        if (ev.type === "text_delta") {
          text += ev.text;
          writer.delta("text", ev.text);
        } else if (ev.type === "reasoning_delta") {
          reasoning += ev.text;
          writer.delta("reasoning", ev.text);
        } else if (ev.type === "tool_call_start") {
          void writer.emit("tool_input", { runId: run.id, index: ev.index, name: ev.name, title: getAgentTool(ev.name)?.title ?? ev.name });
        } else if (ev.type === "tool_call_end") {
          calls.push({ type: "tool_use", id: ev.id || `call_${randomBytes(6).toString("hex")}`, name: ev.name, input: ev.invalidJson ? { __invalid_json: ev.argsJson.slice(0, 2000) } : (ev.input ?? {}) });
        } else if (ev.type === "usage") {
          usage = { in: ev.usage.inputTokens ?? usage.in, out: ev.usage.outputTokens ?? usage.out };
        } else if (ev.type === "done") {
          providerState = ev.providerState;
          model = ev.model ?? model;
          stop = ev.stopReason;
        } else if (ev.type === "error") {
          throw ev.error;
        }
      }
    } catch (e) {
      if (signal.aborted) {
        await this.savePartial(run, conv, text, reasoning, writer);
        return { kind: "stopped" };
      }
      // Context rejected as too long (our estimate is rough): compact harder and retry once (OpenHands'
      // CondensationRequest, opencode's overflow recovery).
      if ((e as { code?: string })?.code === "context_too_long" && !overflowRetried && !text && !calls.length) {
        overflowRetried = true;
        this.app.log.warn({ runId: run.id, model }, "agent context too long; compacting and retrying");
        const fresh = (await this.db.query<ConversationRow>("SELECT * FROM conversations WHERE id=$1", [conv.id])).rows[0] ?? conv;
        const again = await inlineAttachmentImages(this.app.storage, await inlineToolImages(this.app.storage, await this.contextMessages(fresh, user, system, true), { vision }), { vision });
        const extra = req.messages.slice(1 + messages.length);
        req.messages = [{ role: "system", content: system }, ...again, ...extra];
        await writer.emit("step_discarded", { runId: run.id });
        await writer.drain();
        await writer.emit("step_start", { runId: run.id, step: run.step });
        reasoning = "";
        stop = null;
        continue;
      }
      if (isLlmUnavailable(e)) return { kind: "llm_down", error: (e as { toResponse(): { error: string; code: string; hint: string } }).toResponse() };
      if (e instanceof AiError) {
        if (e.retryable) return { kind: "llm_down", error: e.toResponse() };
        return { kind: "failed", error: e.toResponse() };
      }
      if (isPlatformError(e)) return { kind: "failed", error: e.toResponse() };
      throw e;
    }
    if (signal.aborted) {
      await this.savePartial(run, conv, text, reasoning, writer);
      return { kind: "stopped" };
    }
    // An empty or cut-off final answer (reasoning models can spend the whole budget thinking, or the stream just ends):
    // retry once with a nudge to answer directly, a bigger budget and low reasoning; still cut off → notice + 「繼續」.
    if (opts.wrapUp) calls = []; // no tools after a limit, even if the provider ignored tool_choice
    const incomplete = !calls.length && (!text.replace(/\n?data: \[DONE\]\s*$/, "").trim() || stop === "max_tokens" || stop === "other");
    if (incomplete && draft) {
      // The corrected reply failed: keep the reviewed draft rather than nothing.
      ({ text, reasoning, stop } = draft);
      break;
    }
    if (!incomplete) {
      if (reviewed || calls.length) break;
      reviewed = true;
      const nudge = await this.reviewFinal(conv, text).catch((e) => {
        this.app.log.warn({ err: e, runId: run.id }, "agent completion review failed");
        return null;
      });
      if (!nudge) break;
      this.app.log.info({ runId: run.id, model }, "agent completion review: asking for a correction");
      draft = { text, reasoning, stop };
      await writer.emit("step_discarded", { runId: run.id });
      await writer.drain();
      await writer.emit("step_start", { runId: run.id, step: run.step });
      req.messages = [...req.messages, { role: "assistant", content: [{ type: "text", text: text.replace(/\n?data: \[DONE\]\s*$/, "") }] }, { role: "user", content: [{ type: "text", text: nudge }] }];
      text = "";
      reasoning = "";
      calls = [];
      stop = null;
      continue;
    }
    this.app.log.warn({ runId: run.id, attempt, stopReason: stop, textChars: text.length, reasoningChars: reasoning.length, model }, "agent reply empty or cut off");
    if (attempt >= 1) {
      truncated = true;
      break;
    }
    await writer.emit("step_discarded", { runId: run.id });
    await writer.drain();
    await writer.emit("step_start", { runId: run.id, step: run.step });
    req.messages = [...req.messages, { role: "user", content: [{ type: "text", text: RETRY_NUDGE }] }];
    req.maxTokens = Math.max(req.maxTokens ?? 0, 12_000);
    req.reasoning = { effort: "low" };
    text = "";
    reasoning = "";
    calls = [];
    stop = null;
    }
    // Some gateways append a stray `data: [DONE]` line.
    text = text.replace(/\n?data: \[DONE\]\s*$/, "");
    const display = stripMemoryMarkers(text).trim();
    const content: ContentBlock[] = [...(text.trim() ? [{ type: "text" as const, text }] : []), ...calls];
    if (!content.length) content.push({ type: "text", text: "" });
    const used = memories?.length ? usedMemories(text, memories) : [];
    const saved = await transaction(this.db, async (client) => {
      await this.lockConversation(client, conv.id);
      const st = (await client.query<{ status: string }>("SELECT status FROM agent_runs WHERE id=$1", [run.id])).rows[0]?.status;
      if (st !== "running") return null;
      const m = (await client.query<MessageRow>(
        "INSERT INTO agent_messages(conversation_id,run_id,role,content,text,reasoning,provider_state,model) VALUES($1,$2,'assistant',$3,$4,$5,$6,$7) RETURNING *",
        [conv.id, run.id, JSON.stringify(content), display, reasoning, providerState ? JSON.stringify(providerState) : null, model],
      )).rows[0]!;
      for (const id of used) await client.query("INSERT INTO memory_uses(message_id,memory_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [m.id, id]);
      await client.query("UPDATE agent_runs SET tokens_in=tokens_in+$2, tokens_out=tokens_out+$3, updated_at=now() WHERE id=$1", [run.id, usage.in, usage.out]);
      await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conv.id]);
      return { ...m, memories: memories?.filter((x) => used.includes(x.id)).map((x) => ({ id: x.id, content: x.content })) ?? [] };
    });
    if (!saved) return { kind: "stopped" };
    await writer.emit("message", { message: messageView(saved) });
    return { kind: "ok", messageId: saved.id, calls, truncated };
  }

  /**
   * Facts of the current turn (every call since the last user message on the current branch, across runs) for the
   * completion review, and the latest plan when it was set in this turn.
   */
  private async turnFacts(conversationId: string) {
    const lastUser = (await this.db.query<{ seq: string | null }>("SELECT max(seq) AS seq FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL", [conversationId])).rows[0]?.seq ?? "0";
    const rows = (await this.db.query<{ tool: string; risk: RunCall["risk"]; status: string; step: number; args: unknown; edited_args: unknown }>(
      `SELECT tc.tool, tc.risk, tc.status, tc.step, tc.args, tc.edited_args FROM tool_calls tc JOIN agent_messages m ON m.id=tc.message_id
        WHERE tc.conversation_id=$1 AND m.hidden_by IS NULL AND m.seq > $2 ORDER BY m.seq, tc.position`,
      [conversationId, lastUser],
    )).rows;
    const earlierWrite = ((await this.db.query(
      `SELECT 1 FROM tool_calls tc JOIN agent_messages m ON m.id=tc.message_id
        WHERE tc.conversation_id=$1 AND m.hidden_by IS NULL AND m.seq < $2 AND tc.risk <> 'read' AND tc.status='done' LIMIT 1`,
      [conversationId, lastUser],
    )).rowCount ?? 0) > 0;
    const planRow = [...rows].reverse().find((r) => r.tool === "update_plan" && r.status === "done");
    return { calls: rows as RunCall[], earlierWrite, plan: planRow ? ((planRow.edited_args ?? planRow.args) as Plan) : null };
  }

  /** Deterministic review of a final answer against the turn; returns the hidden correction prompt or null. */
  private async reviewFinal(conv: ConversationRow, text: string) {
    const facts = await this.turnFacts(conv.id);
    return completionReview({ text: stripMemoryMarkers(text), ...facts });
  }

  /** Keeps text streamed before a stop (marked 已中止); never tool calls of an unfinished step. */
  private async savePartial(run: RunRow, conv: ConversationRow, text: string, reasoning: string, writer: EventWriter) {
    const display = stripMemoryMarkers(text).trim();
    // An edit superseded the run: its tail is discarded, so a late partial must not land on the new branch.
    const reason = (await this.db.query<{ stop_reason: string | null }>("SELECT stop_reason FROM agent_runs WHERE id=$1", [run.id])).rows[0]?.stop_reason;
    if (!display || reason === "superseded") return writer.emit("step_discarded", { runId: run.id });
    const m = (await this.db.query<MessageRow>(
      "INSERT INTO agent_messages(conversation_id,run_id,role,content,text,reasoning,status) VALUES($1,$2,'assistant',$3,$4,$5,'cancelled') RETURNING *",
      [conv.id, run.id, JSON.stringify([{ type: "text", text }]), display, reasoning],
    )).rows[0]!;
    await writer.emit("message", { message: messageView(m) });
  }

  /** Model context with compaction: clear old tool results, then summarise older turns (role `fast`). */
  private async contextMessages(conv: ConversationRow, user: CurrentUser, system: string, force = false) {
    const load = async () => (await this.db.query<StoredMessage>("SELECT id,seq,role,content,text,reasoning,provider_state,status FROM agent_messages WHERE conversation_id=$1 AND hidden_by IS NULL ORDER BY seq", [conv.id])).rows;
    let rows = await load();
    // `force`: the provider rejected the context as too long — clear and summarise regardless of the estimate.
    const th = force ? { clearAbove: 0, compactAbove: 0 } : (this.options.compaction ?? { clearAbove: 24_000, compactAbove: 40_000 });
    const keep = force ? { keepResults: 1 } : {};
    const base = { summary: conv.summary, summaryUntil: conv.summary_until ? Number(conv.summary_until) : null };
    let msgs = toModelMessages(rows, base);
    const sys = system.length / 2;
    if (estimateTokens(msgs) + sys <= th.clearAbove) return msgs;
    msgs = toModelMessages(rows, { ...base, clearOldResults: true, ...keep });
    if (estimateTokens(msgs) + sys <= th.compactAbove) return msgs;
    const live = rows.filter((r) => !(base.summaryUntil && Number(r.seq) <= base.summaryUntil));
    const cut = compactionCut(live, force ? 1 : 2);
    if (cut === null || cut === 0) return msgs;
    const older = live.slice(0, cut);
    const until = Number(older.at(-1)!.seq);
    let summary: string;
    try {
      const prior = conv.summary ? `先前的摘要：\n${conv.summary}\n\n` : "";
      const fast = this.options.fast ?? (async (r: RoleChatRequest, c: { userId: string }) => (await aiFor(this.app).chat("fast", r, { userId: c.userId })).text);
      summary = (await fast({ messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: `${prior}<data name="transcript">\n${transcriptText(older).slice(-60_000)}\n</data>` }], maxTokens: 2000 }, { userId: user.id })).trim();
      if (!summary) throw new Error("empty summary");
    } catch (e) {
      this.app.log.warn({ err: e }, "agent compaction summary failed; dropping older turns");
      summary = `${conv.summary ? `${conv.summary}\n` : ""}（較早的對話已省略，摘要服務暫時無法使用。）`;
    }
    // An unfinished plan set in the summarised part would vanish with its tool call: keep it next to the summary.
    const planUse = older.flatMap((r) => (r.role === "assistant" ? r.content : [])).filter((b): b is ToolUseBlock => b.type === "tool_use" && b.name === "update_plan").at(-1);
    const reminder = planUse ? planReminder(planUse.input as Plan) : null;
    summary = summary.slice(0, 8000 - (reminder?.length ?? 0) - 1) + (reminder ? `\n${reminder}` : "");
    await this.db.query("UPDATE conversations SET summary=$2, summary_until=$3 WHERE id=$1", [conv.id, summary, until]);
    await this.db.query("INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'compaction',$2,$3)", [conv.id, JSON.stringify([{ type: "compaction", until }]), "較早的對話已整理成摘要（只影響 AI 看到的內容）。"]);
    conv.summary = summary;
    conv.summary_until = String(until);
    rows = await load();
    return toModelMessages(rows, { summary, summaryUntil: until, clearOldResults: true, ...keep });
  }

  private toolCtx(conv: ConversationRow, user: CurrentUser, run: RunRow, signal: AbortSignal, autopilot: boolean): AgentToolContext {
    return { app: this.app, db: this.db, user, source: "agent", conversationId: conv.id, runId: run.id, autopilot, signal, vision: () => this.visionNow() };
  }

  /** Whether the assistant role accepts images now (images in the context would otherwise fail the call). */
  async visionNow(): Promise<boolean> {
    if (this.options.vision) return this.options.vision();
    if (this.options.model) return false;
    return (await aiFor(this.app).capabilities("assistant").catch(() => ({ vision: false }))).vision;
  }

  /**
   * Records the calls of a step. Reads run immediately (in order, so a taint they cause applies to the writes of the
   * same step); writes and deletes then go through the policy. Returns a notice when the run must stop after this step.
   */
  private async proposeCalls(run: RunRow, conv: ConversationRow, user: CurrentUser, messageId: string, calls: ToolUseBlock[], writer: EventWriter, signal: AbortSignal): Promise<[string, string] | null> {
    let stop: [string, string] | null = null;
    const prior = (await this.db.query<{ tool: string; args: unknown; status: string }>("SELECT tool,args,status FROM tool_calls WHERE run_id=$1", [run.id])).rows.map((r) => ({ ...r, key: `${r.tool}:${stable(r.args)}` }));
    const settings = await getAgentSettings(this.db, user.id);
    const memoryOn = conv.mode === "chat" && settings.memory_enabled && conv.memory_enabled;
    const userText = (await this.db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq DESC LIMIT 20", [conv.id])).rows.map((r) => r.text).join("\n");
    type Planned = { pos: number; use: ToolUseBlock; def: AgentToolDef | null; args: Record<string, unknown> | null; error: string | null; status?: string };
    const planned: Planned[] = calls.map((use, pos) => {
      const def = getAgentTool(use.name);
      if (!def || !(def.modes ?? ["chat"]).includes(conv.mode) || (def.name === "remember" && !memoryOn))
        return { pos, use, def: null, args: null, error: `沒有名為 ${use.name} 的工具。` };
      if (use.input && typeof use.input === "object" && "__invalid_json" in (use.input as object)) return { pos, use, def, args: null, error: "工具參數不是有效的 JSON，請重新呼叫。" };
      const parsed = def.input.safeParse(use.input ?? {});
      if (!parsed.success) return { pos, use, def, args: null, error: `參數不正確：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("；")}` };
      return { pos, use, def, args: parsed.data as Record<string, unknown>, error: null };
    });
    const insert = async (p: Planned, fields: Partial<ToolCallRow>) => {
      const row = (await this.db.query<ToolCallRow>(
        `INSERT INTO tool_calls(run_id,conversation_id,message_id,step,position,provider_call_id,tool,args,risk,status,approved_via,approval_reason,summary,target,result_text,error,finished_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $10 IN ('failed','denied') THEN now() END) RETURNING *`,
        [run.id, conv.id, messageId, run.step, p.pos, p.use.id, p.use.name, JSON.stringify(p.args ?? (p.use.input && typeof p.use.input === "object" ? p.use.input : {})), p.def?.risk ?? "read",
          fields.status, fields.approved_via ?? null, fields.approval_reason ?? null, fields.summary ?? "", fields.target ? JSON.stringify(fields.target) : null, fields.result_text ?? null, fields.error ?? null],
      )).rows[0]!;
      await writer.emit("tool_call", (await this.toolCallEvent(this.db, row.id)).data);
      return row;
    };
    const fail = (p: Planned, message: string, summary = "") => insert(p, { status: "failed", error: message, summary, result_text: envelope(p.use.name, `錯誤：${message}`, { untrusted: false, error: true }) });

    // Pass 1: invalid calls, repeats, reads. Reads run concurrently (codex runs parallel-safe tools in parallel);
    // open-world reads wait for them, because a taint they cause decides whether an outbound call must ask.
    const writes: Planned[] = [];
    const reads: { p: Planned; summary: string; note?: string }[] = [];
    for (const p of planned) {
      if (signal.aborted) return null;
      if (!p.def || !p.args) {
        await fail(p, p.error ?? "工具呼叫不正確。");
        continue;
      }
      const key = `${p.def.name}:${stable(p.args)}`;
      const same = prior.filter((x) => x.key === key);
      let summary = "";
      try {
        summary = p.def.summarize(p.args as never);
      } catch {
        summary = p.def.title;
      }
      if (same.some((x) => x.status === "denied")) {
        await insert(p, { status: "denied", summary, result_text: "使用者已經拒絕過相同的操作。請不要重試；說明或詢問下一步。" });
        continue;
      }
      prior.push({ tool: p.def.name, args: p.args, status: "proposed", key });
      if (same.length + 1 >= this.limits.repeat) {
        await fail(p, "重複呼叫相同的工具與參數太多次，已停止。", summary);
        stop = ["repeat", "AI 重複執行相同的操作，已先停止。可以換個說法再試一次。"];
        continue;
      }
      if (p.def.risk !== "read") {
        writes.push(p);
        continue;
      }
      reads.push({ p, summary, ...(same.length ? { note: REPEAT_NOTE } : {}) });
    }
    const local = reads.filter((r) => !r.p.def!.openWorld);
    const rows = [];
    for (const r of local) rows.push({ row: await insert(r.p, { status: "approved", summary: r.summary }), note: r.note });
    const width = Math.max(1, this.options.readConcurrency ?? 4);
    for (let i = 0; i < rows.length; i += width) {
      if (signal.aborted) return null;
      await Promise.all(rows.slice(i, i + width).map((x) => this.executeCall(x.row, conv, user, run, writer, signal, x.note)));
    }
    for (const r of reads.filter((x) => x.p.def!.openWorld)) {
      if (signal.aborted) return null;
      const decision = decide({ risk: "read", openWorld: true, autopilot: false, tainted: await this.isTainted(run.id), granted: false, autopilotWrites: 0, autopilotWriteLimit: 0 });
      if (decision.run) {
        const row = await insert(r.p, { status: "approved", summary: r.summary });
        await this.executeCall(row, conv, user, run, writer, signal, r.note);
      } else {
        await insert(r.p, { status: "pending_approval", approval_reason: decision.reason, summary: r.summary });
      }
    }

    // Pass 2: writes and deletes (policy with the taint the reads above may have caused).
    for (const p of writes) {
      if (signal.aborted) return null;
      const def = p.def!;
      const ctx = this.toolCtx(conv, user, run, signal, false);
      let summary = def.title;
      try {
        summary = def.summarize(p.args as never);
      } catch {
        // keep the title
      }
      const tainted = await this.isTainted(run.id);
      const pre = def.precheck ? await def.precheck(p.args as never, { tainted, userText, ctx }) : null;
      if (pre) {
        await fail(p, pre, summary);
        continue;
      }
      let target = null;
      try {
        target = def.target ? await def.target(p.args as never, ctx) : null;
      } catch (e) {
        await fail(p, errorText(e), summary);
        continue;
      }
      const fresh = (await this.db.query<{ autopilot: boolean }>("SELECT autopilot FROM conversations WHERE id=$1", [conv.id])).rows[0];
      const counts = (await this.db.query<{ autopilot_writes: number }>("SELECT autopilot_writes FROM agent_runs WHERE id=$1", [run.id])).rows[0]!;
      const granted = ((await this.db.query("SELECT 1 FROM conversation_grants WHERE conversation_id=$1 AND tool=$2 AND scope=$3", [conv.id, def.name, grantScope(target)])).rowCount ?? 0) > 0;
      const decision = def.requireCard?.(p.args as never) ? ({ run: false, reason: def.risk === "destructive" ? "destructive" : "write" } as const) : decide({ risk: def.risk, alwaysAsk: def.alwaysAsk, openWorld: def.openWorld, autopilot: !!fresh?.autopilot && conv.mode === "chat", tainted, granted, autopilotWrites: counts.autopilot_writes, autopilotWriteLimit: this.limits.autopilotWrites });
      if (decision.run) {
        if (decision.via === "autopilot") await this.db.query("UPDATE agent_runs SET autopilot_writes=autopilot_writes+1 WHERE id=$1", [run.id]);
        const row = await insert(p, { status: "approved", approved_via: decision.via ?? undefined, summary, target: target ?? undefined });
        await this.executeCall(row, conv, user, run, writer, signal);
      } else {
        await insert(p, { status: "pending_approval", approval_reason: decision.reason, summary, target: target ?? undefined });
      }
    }
    return stop ?? (await this.failureGuard(run.id, messageId));
  }

  /**
   * Consecutive failed calls (unknown tool, bad arguments, tool errors) across the run: the third gets a "change
   * approach" note in its result, the sixth stops the run (src/agent/guards.ts).
   */
  private async failureGuard(runId: string, messageId: string): Promise<[string, string] | null> {
    const all = (await this.db.query<RunCall & { id: string; message_id: string }>("SELECT id, message_id, tool, risk, status, step FROM tool_calls WHERE run_id=$1 ORDER BY step, position", [runId])).rows;
    const streak = failureStreak(all);
    if (!streak) return null;
    const before = failureStreak(all.filter((c) => c.message_id !== messageId));
    if (before < FAILURE_NOTE_AT && streak >= FAILURE_NOTE_AT) {
      const last = [...all].reverse().find((c) => c.status === "failed")!;
      const note = failureNote(FAILURE_NOTE_AT)!;
      await this.db.query("UPDATE tool_calls SET result_text = coalesce(result_text,'') || $2 WHERE id=$1", [last.id, `\n${note}`]);
    }
    if (streak >= FAILURE_STOP) return ["stuck", `AI 連續 ${streak} 次工具呼叫失敗，已先停止。可以換個說法、提供更多資訊，或按「繼續」再試一次。`];
    return null;
  }

  private async isTainted(runId: string) {
    return (await this.db.query<{ tainted: boolean }>("SELECT tainted FROM agent_runs WHERE id=$1", [runId])).rows[0]?.tainted ?? false;
  }

  /** Runs the approved calls of the open step. Returns true while any call still waits for the user. */
  private async runApproved(run: RunRow, conv: ConversationRow, user: CurrentUser, messageId: string, writer: EventWriter, signal: AbortSignal) {
    const calls = (await this.db.query<ToolCallRow>("SELECT * FROM tool_calls WHERE message_id=$1 ORDER BY position", [messageId])).rows;
    for (const c of calls) {
      if (signal.aborted) return false;
      if (c.status === "approved") await this.executeCall(c, conv, user, run, writer, signal);
    }
    const pending = await this.db.query("SELECT 1 FROM tool_calls WHERE message_id=$1 AND status='pending_approval' LIMIT 1", [messageId]);
    return (pending.rowCount ?? 0) > 0;
  }

  private async executeCall(row: ToolCallRow, conv: ConversationRow, user: CurrentUser, run: RunRow, writer: EventWriter, signal: AbortSignal, note?: string) {
    const claimed = await this.db.query("UPDATE tool_calls SET status='running' WHERE id=$1 AND status='approved'", [row.id]);
    if (!claimed.rowCount) return;
    await writer.emit("tool_call", (await this.toolCallEvent(this.db, row.id)).data);
    const def = getAgentTool(row.tool);
    const args = row.edited_args ?? row.args;
    try {
      if (!def) throw new HttpError(400, "這個工具已不存在。");
      const res = await def.execute(def.input.parse(args) as never, this.toolCtx(conv, user, run, signal, row.approved_via === "autopilot"));
      const body = res.text ?? JSON.stringify(res.data, null, 0);
      const text = envelope(row.tool, capResult(body), { untrusted: !!res.untrusted || !!def.openWorld, source: res.source }) + (note ? `\n${note}` : "");
      const images = res.images?.length ? await storeToolImages(this.app.storage, conv.id, row.id, res.images.slice(0, 6)) : undefined;
      await this.db.query("UPDATE tool_calls SET status='done', result=$2, result_text=$3, finished_at=now() WHERE id=$1", [row.id, JSON.stringify({ data: res.data, links: res.links ?? [], source: res.source ?? null, untrusted: !!res.untrusted, ...(images ? { images } : {}), ...(res.undo && row.approved_via !== "user" ? { undo: res.undo } : {}) }), text]);
      if (res.untrusted || def.openWorld) {
        await this.db.query(
          `UPDATE agent_runs SET tainted=true, taint_sources=CASE WHEN $2::text IS NULL OR taint_sources ? $2 THEN taint_sources ELSE (taint_sources || to_jsonb($2::text)) END WHERE id=$1`,
          [run.id, res.source ?? def.title],
        );
      }
    } catch (e) {
      const message = errorText(e);
      if (!(e instanceof HttpError) && !isPlatformError(e) && !(e instanceof AiError)) this.app.log.warn({ err: e, tool: row.tool }, "agent tool failed");
      await this.db.query("UPDATE tool_calls SET status='failed', error=$2, result_text=$3, finished_at=now() WHERE id=$1", [row.id, message, envelope(row.tool, `錯誤：${message}`, { untrusted: false, error: true })]);
    }
    await writer.emit("tool_call", (await this.toolCallEvent(this.db, row.id)).data);
  }

  /** Title from the first exchange via role `fast` (fallback: the first words of the user's message). */
  private async maybeTitle(conv: ConversationRow, user: CurrentUser) {
    const cur = (await this.db.query<{ title: string; title_source: string }>("SELECT title,title_source FROM conversations WHERE id=$1", [conv.id])).rows[0];
    if (!cur || cur.title || cur.title_source === "user") return;
    const first = (await this.db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq LIMIT 1", [conv.id])).rows[0]?.text ?? "";
    if (!first) return;
    let title = "";
    try {
      const fast = this.options.fast ?? (async (r: RoleChatRequest, c: { userId: string }) => (await aiFor(this.app).chat("fast", r, { userId: c.userId })).text);
      title = await fast(
        { messages: [{ role: "system", content: "為下面這段對話開頭取一個 4–16 字的繁體中文標題。只輸出標題本身，不要引號或標點。" }, { role: "user", content: `<data>\n${first.slice(0, 1000)}\n</data>` }], maxTokens: 400 },
        { userId: user.id },
      );
    } catch {
      title = "";
    }
    title = title.replace(/\n?data: \[DONE\]\s*$/, "").replace(/^["「『]|["」』。.]$/g, "").split("\n")[0]!.trim().slice(0, 40);
    if (!title) title = first.replace(/\s+/g, " ").slice(0, 24);
    const row = (await this.db.query<ConversationRow>("UPDATE conversations SET title=$2 WHERE id=$1 AND title='' AND title_source='auto' RETURNING *", [conv.id, title])).rows[0];
    if (row) await insertEvent(this.db, conv.id, null, "conversation", { conversation: conversationView(row) });
  }
}

const runtimes = new WeakMap<object, AgentRuntime>();
/** The runtime bound to this app's database pool (one per process). */
export function agentFor(app: FastifyInstance, options?: AgentOptions): AgentRuntime {
  let r = runtimes.get(app.db);
  if (!r) runtimes.set(app.db, (r = new AgentRuntime(app, options)));
  return r;
}
