/**
 * What the engine and playbooks work with: the run, the owner (permissions), the model port with budget accounting,
 * read tools of the assistant (same permission checks and taint flags), events and small helpers.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import type { Storage } from "../lib/storage.js";
import type { CurrentUser } from "../lib/auth.js";
import type { ChatMessage, ChatResult, ContentBlock, ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "../ai/types.js";
import { capResult, envelope } from "../agent/prompt.js";
import { getAgentTool, toolJsonSchema, type AgentToolContext } from "../agent/tools/registry.js";
import { addUsage, getRun, insertWorkflowEvent, markTainted } from "./store.js";
import { llm, llmJson, type LlmRequest } from "./llm.js";
import type { ChatRole } from "../ai/platform/roles.js";
import { WorkflowStop, type ModelPort, type Requirement, type RunRow, type StepRole } from "./types.js";
import { notesLanguage, requirementsBlock, targetLanguage } from "./requirements.js";
import { briefBlock, type Brief } from "./brief.js";
import type { RouteState } from "./route.js";

/**
 * Calls that never get the user's requirements block: extracting them, goal planning, figure location, the blocked
 * question (shown to the user), search-query planning / paper picking, the visual scoring and the step judge (verify.ts
 * gives it only the requirements of its own scope).
 */
const NO_REQUIREMENTS = new Set(["requirements", "goal_plan", "goal_replan", "locate_figure", "blocked", "topic_plan", "topic_select", "visual_qa", "verify"]);

/**
 * Adds the Brief (deliverable, the user's own words, 「未指定」; brief.ts) and the requirements block to the system prompt
 * (and a language reminder after the task for producers).
 */
export function withRequirements(req: LlmRequest, reqs: Requirement[], brief?: Brief | null): LlmRequest {
  if (NO_REQUIREMENTS.has(req.purpose.split(":")[0]!)) return req;
  const verifier = req.role === "verifier";
  const block = [briefBlock(brief, verifier ? "verifier" : "producer"), reqs.length ? requirementsBlock(reqs, verifier ? "verifier" : "producer") : ""].filter(Boolean).join("\n\n");
  if (!block) return req;
  const messages = [...req.messages];
  const sys = messages.findIndex((m) => m.role === "system");
  const head = messages[sys];
  if (head?.role === "system" && typeof head.content === "string") messages[sys] = { role: "system", content: `${head.content}\n\n${block}` };
  else messages.unshift({ role: "system", content: block });
  const lang = targetLanguage(reqs);
  const notes = notesLanguage(reqs);
  // Cheap models drift back to the default language at the end of a long brief: remind them right after the task.
  if (!verifier && lang) {
    const last = messages.map((m) => m.role).lastIndexOf("user");
    const m = messages[last];
    const note = notes && notes !== lang
      ? (lang === "en" ? "（提醒：投影片本體全部用英文，講稿 ::: {.notes} 用繁體中文口語、專有名詞用英文。Reminder: slide text in English only; speaker notes in Traditional Chinese.）" : "（提醒：投影片本體用繁體中文，講稿 ::: {.notes} 用英文。）")
      : lang === "en" ? "（提醒：成果全部用英文。Reminder: write the output in English only.）" : "（提醒：成果用繁體中文。）";
    if (m?.role === "user" && typeof m.content === "string") messages[last] = { role: "user", content: `${m.content}\n\n${note}` };
  }
  return { ...req, messages };
}

export type EnvDeps = {
  db: Db;
  storage: Storage;
  /** The backend app (routes/tests) or an ai-worker shim with db/storage/log/notifier/config (no collab). */
  app: FastifyInstance;
  model: ModelPort;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
  signal: AbortSignal;
  jobId: string | null;
  /** Max wait for a deck preview render (tests shorten it). */
  previewWaitMs?: number;
  /** Max wait for a LaTeX compile. */
  compileWaitMs?: number;
  progress?: (stage: string, pct: number) => Promise<void>;
  /** The AI platform itself, for helpers that take it (vision layout review); absent in tests. */
  platform?: import("../ai/platform/platform.js").AiPlatform;
};

export type ToolOutcome = { ok: boolean; text: string; data: unknown; untrusted: boolean; source?: string; images?: { mediaType: string; data: Buffer; label?: string }[] };

const ACTIVITY_LABEL = (tool: string, args: Record<string, unknown>) => {
  const def = getAgentTool(tool);
  try {
    return def ? def.summarize(args as never) : tool;
  } catch {
    return def?.title ?? tool;
  }
};

/** Data blocks of a producer prompt that are not source material (the draft itself, earlier versions, verifier views). */
const NOT_SOURCES = new Set(["previous_version", "output", "final", "changed", "slide", "slides"]);
const DATA_BLOCK_RE = /<data name="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/data>/g;

/** The source blocks of a prompt, in order (`<data name=…>` blocks except the output / previous versions). */
export function sourceBlocks(messages: ChatMessage[]): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    for (const b of m.content.matchAll(DATA_BLOCK_RE)) if (!NOT_SOURCES.has(b[1]!)) out.push({ name: b[1]!, text: b[2]! });
  }
  return out;
}

const PRODUCER_ROLES = new Set<StepRole>(["writer", "designer", "integrator", "coder", "planner", "researcher"]);

export class WorkflowEnv {
  run!: RunRow;
  private t0 = Date.now();
  private activeBase = 0;
  /** Step id → key / fix round (ai_call_log columns), set by the engine before each round. */
  private stepMeta = new Map<string, { key: string; round: number }>();
  /**
   * Step id → the source blocks its producer was given in this round (verify.ts judges with exactly these: same blocks,
   * same order, no other truncation). Captured from the prompts of `call` / `callJson`.
   */
  readonly stepSources = new Map<string, { name: string; text: string }[]>();

  constructor(readonly deps: EnvDeps, run: RunRow, readonly user: CurrentUser) {
    this.run = run;
    this.activeBase = run.usage?.active_ms ?? 0;
  }

  get db() {
    return this.deps.db;
  }
  get storage() {
    return this.deps.storage;
  }
  get signal() {
    return this.deps.signal;
  }

  async refresh() {
    const r = await getRun(this.db, this.run.id);
    if (r) this.run = r;
    return this.run;
  }

  activeMs() {
    return this.activeBase + (Date.now() - this.t0);
  }

  async saveActive() {
    await this.db.query("UPDATE workflow_runs SET usage = usage || jsonb_build_object('active_ms', $2::bigint) WHERE id=$1", [this.run.id, this.activeMs()]);
  }

  async setState(patch: Record<string, unknown>) {
    await this.db.query("UPDATE workflow_runs SET state = state || $2::jsonb, updated_at=now() WHERE id=$1", [this.run.id, JSON.stringify(patch)]);
    this.run.state = { ...this.run.state, ...patch };
  }

  state<T>(key: string): T | undefined {
    return this.run.state?.[key] as T | undefined;
  }

  async event(type: "activity" | "log" | "verdict", data: Record<string, unknown>) {
    await insertWorkflowEvent(this.db, this.run.id, type, data).catch(() => undefined);
  }

  activity(stepKey: string, role: StepRole | "orchestrator", text: string) {
    return this.event("activity", { step_key: stepKey, role, text: text.slice(0, 160) });
  }

  note(text: string, level: "info" | "warn" = "info") {
    return this.event("log", { level, text: text.slice(0, 400) });
  }

  /** Guidance the user added (補充指示), for prompts. */
  guidanceText() {
    // Setup answers (which study / paper) are inputs the playbook already used, not instructions for the content.
    const g = (this.run.guidance ?? []).filter((x) => !x.setup);
    return g.length ? `使用者在執行中補充的指示（優先遵守）：\n${g.map((x) => `- ${x.text}`).join("\n")}` : "";
  }

  /** From 50 % of the pooled budget on, sub-agents are told to be direct. */
  budgetHint() {
    const b = this.run.budget;
    const u = this.run.usage;
    const used = Math.max(u.calls / b.max_calls, (u.tokens_in + u.tokens_out) / b.max_tokens, this.activeMs() / (b.max_minutes * 60_000));
    return used >= 0.5 ? `（這個工作流程的額度已用掉約 ${Math.round(used * 100)}%：請直接、精簡地完成，不要多餘的讀取。）` : "";
  }

  /** Throws WorkflowStop when the run was cancelled/paused (between calls) or a budget is exhausted. */
  async checkpoint(opts: { allowPause?: boolean } = {}) {
    if (this.signal.aborted) throw new WorkflowStop("cancelled", "已停止。");
    const r = await this.refresh();
    if (r.status === "cancelled") throw new WorkflowStop("cancelled", "已停止。");
    if (opts.allowPause && r.pause_requested) throw new WorkflowStop("paused", "已暫停。");
    const b = r.budget;
    const u = r.usage;
    if (u.calls >= b.max_calls) throw new WorkflowStop("budget_calls", `已用完子代理呼叫額度（${b.max_calls} 次）。`);
    if (u.tokens_in + u.tokens_out >= b.max_tokens) throw new WorkflowStop("budget_tokens", "已用完 token 額度。");
    if (this.activeMs() >= b.max_minutes * 60_000) throw new WorkflowStop("budget_time", `已達執行時間上限（${b.max_minutes} 分鐘）。`);
  }

  /** One model call counted against the run (and the step when given). */
  async call(req: LlmRequest, stepId?: string): Promise<ChatResult> {
    this.captureSources(req, stepId);
    return llm(this.hooks(stepId), withRequirements(req, this.requirements(), this.brief()));
  }

  async callJson<T>(req: LlmRequest, valid: (v: unknown) => v is T, stepId?: string) {
    this.captureSources(req, stepId);
    return llmJson<T>(this.hooks(stepId), withRequirements(req, this.requirements(), this.brief()), valid);
  }

  /** The engine names the step (and its fix round) a call belongs to. */
  trackStep(stepId: string, key: string, round: number) {
    this.stepMeta.set(stepId, { key, round });
  }

  /** A producer call of a step: its source blocks (merged by name: a later call's block with the same name replaces it). */
  private captureSources(req: LlmRequest, stepId?: string) {
    if (!stepId || !PRODUCER_ROLES.has(req.role as StepRole) || /^(?:verify|visual_qa|requirement_fix|title_translate|ask_options|blocked|locate_figure)/.test(req.purpose)) return;
    const blocks = sourceBlocks(req.messages);
    if (!blocks.length) return;
    const prev = this.stepSources.get(stepId) ?? [];
    const merged = [...prev.filter((p) => !blocks.some((b) => b.name === p.name)), ...blocks];
    this.stepSources.set(stepId, merged);
  }

  /** The run's fixed Brief (brief.ts): read-only for playbooks and sub-agents. */
  brief(): Brief | null {
    return this.run.brief ?? null;
  }

  /** The routing decision (route.ts: deliverable, playbook, deck mode / edit kind, batch): playbooks execute it, never re-detect it. */
  route(): RouteState | null {
    return (this.run.state?.route as RouteState | undefined) ?? null;
  }

  /** The user's requirements (requirements.ts), injected into every sub-agent call. */
  requirements(): Requirement[] {
    const r = this.run.state?.requirements;
    return Array.isArray(r) ? (r as Requirement[]) : [];
  }

  private hooks(stepId?: string) {
    const meta = stepId ? this.stepMeta.get(stepId) ?? (stepId.startsWith("plan-") ? { key: stepId.slice(5), round: 0 } : undefined) : undefined;
    return {
      model: this.deps.model,
      userId: this.user.id,
      jobId: this.deps.jobId ?? undefined,
      signal: this.signal,
      workflowId: this.run.id,
      stepKey: meta?.key,
      round: meta?.round,
      beforeCall: () => this.checkpoint(),
      afterCall: async (u: { tokensIn: number; tokensOut: number }) => {
        await addUsage(this.db, this.run.id, { calls: 1, tokens_in: u.tokensIn, tokens_out: u.tokensOut });
        if (stepId && /^[0-9a-f-]{36}$/i.test(stepId)) await this.db.query("UPDATE workflow_steps SET tokens_in=tokens_in+$2, tokens_out=tokens_out+$3 WHERE id=$1", [stepId, u.tokensIn, u.tokensOut]);
      },
    };
  }

  vision(role: ChatRole = "assistant") {
    return this.deps.model.vision(role).catch(() => false);
  }

  toolContext(): AgentToolContext {
    return { app: this.deps.app, db: this.db, user: this.user, source: "agent", conversationId: this.run.conversation_id, runId: null, autopilot: false, signal: this.signal, vision: () => this.vision() };
  }

  /**
   * Runs one assistant tool for a sub-agent. Only read tools (write/destructive tools do not exist in workflows);
   * open-world tools only while the run is untainted. Untrusted results taint the run.
   */
  async tool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const def = getAgentTool(name);
    if (!def) return { ok: false, text: `沒有名為 ${name} 的工具。`, data: null, untrusted: false };
    if (def.risk !== "read") return { ok: false, text: "工作流程的子代理不能使用寫入工具。", data: null, untrusted: false };
    if (def.openWorld && this.run.tainted) return { ok: false, text: "這個流程已讀過他人或外部內容，為了安全不再對外搜尋；請只用實驗室內的資料。", data: null, untrusted: false };
    const parsed = def.input.safeParse(args ?? {});
    if (!parsed.success) return { ok: false, text: `參數不正確：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("；")}`, data: null, untrusted: false };
    try {
      const res = await def.execute(parsed.data as never, this.toolContext());
      const untrusted = !!res.untrusted || !!def.openWorld;
      if (untrusted) {
        await markTainted(this.db, this.run.id, res.source ?? def.title);
        this.run.tainted = true;
      }
      const body = res.text ?? JSON.stringify(res.data);
      return { ok: true, text: envelope(name, capResult(body), { untrusted, source: res.source }), data: res.data, untrusted, source: res.source, images: res.images };
    } catch (e) {
      const msg = (e as { message_zh?: string }).message_zh ?? (e as Error).message ?? "工具執行失敗。";
      return { ok: false, text: envelope(name, `錯誤：${msg}`, { untrusted: false, error: true }), data: null, untrusted: false };
    }
  }

  /**
   * A researcher sub-agent: a bounded tool loop over the given read tools, then a final answer without tools.
   * Every tool call is shown as live activity; results go back as untrusted data envelopes.
   */
  async researcher(step: { id: string; key: string }, opts: { system: string; user: string; tools: string[]; maxToolSteps?: number; maxTokens?: number; purpose?: string }): Promise<{ text: string; toolCalls: number }> {
    const defs = opts.tools.map((n) => getAgentTool(n)).filter((d): d is NonNullable<typeof d> => !!d && d.risk === "read");
    const vision = await this.vision("assistant");
    const tools = defs.filter((d) => vision || d.name !== "view_paper_pages").map((d) => ({ name: d.name, description: d.description, inputSchema: toolJsonSchema(d) }));
    const messages: ChatMessage[] = [{ role: "system", content: opts.system }, { role: "user", content: opts.user }];
    let calls = 0;
    const max = opts.maxToolSteps ?? 60;
    const seen = new Map<string, number>();
    for (let i = 0; i < max; i++) {
      const res = await this.call({ purpose: opts.purpose ?? "research", role: "researcher", messages, tools, maxTokens: opts.maxTokens ?? 6000 }, step.id);
      if (!res.toolCalls.length) {
        if (res.text.trim()) return { text: await this.finishCut(step.id, opts.purpose ?? "research", messages, res), toolCalls: calls };
        break;
      }
      messages.push(res.message ?? { role: "assistant", content: [...(res.text ? [{ type: "text" as const, text: res.text }] : []), ...res.toolCalls] });
      const results: ToolResultBlock[] = [];
      for (const use of res.toolCalls as ToolUseBlock[]) {
        calls++;
        const args = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, unknown>;
        await this.activity(step.key, "researcher", ACTIVITY_LABEL(use.name, args));
        // Stuck guard: the same call a third time is not run again.
        const sig = `${use.name}:${JSON.stringify(args)}`;
        seen.set(sig, (seen.get(sig) ?? 0) + 1);
        const out = (seen.get(sig) ?? 0) >= 3
          ? { ok: false, text: "這個讀取已經重複多次，請改用已經讀到的內容完成任務。", data: null, untrusted: false, images: undefined }
          : opts.tools.includes(use.name) ? await this.tool(use.name, args) : { ok: false, text: `這個任務不能使用 ${use.name}。`, data: null, untrusted: false, images: undefined };
        const content: string | Array<TextBlock | ImageBlock> = out.images?.length && vision
          ? [{ type: "text", text: out.text }, ...out.images.slice(0, 3).map((im) => ({ type: "image" as const, source: { kind: "base64" as const, mediaType: im.mediaType, data: im.data.toString("base64") } }))]
          : out.text;
        results.push({ type: "tool_result", tool_use_id: use.id, content, ...(out.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "tool", content: results });
    }
    // Out of tool steps (or an empty reply): answer from what was read.
    messages.push({ role: "user", content: "請根據目前讀到的資料，直接輸出任務要求的結果（不要再呼叫工具）。" });
    const final = await this.call({ purpose: `${opts.purpose ?? "research"}:final`, role: "researcher", messages, maxTokens: opts.maxTokens ?? 6000 }, step.id);
    return { text: await this.finishCut(step.id, `${opts.purpose ?? "research"}:final`, messages, final), toolCalls: calls };
  }

  /** A researcher's answer cut at the output limit: one continuation of that answer only (units.ts), joined deterministically. */
  private async finishCut(stepId: string, purpose: string, messages: ChatMessage[], res: ChatResult): Promise<string> {
    if (res.stopReason !== "max_tokens" || !res.text.trim()) return res.text;
    const { CONTINUE_PROMPT, joinContinuation } = await import("./units.js");
    await this.note("研究者的整理在輸出上限被截斷，接續寫完這一段。");
    const more = await this.call({ purpose: `${purpose}:continue`, role: "researcher", messages: [...messages, { role: "assistant", content: res.text }, { role: "user", content: CONTINUE_PROMPT(res.text.slice(-160).replace(/\s+/g, " ").trim()) }], maxTokens: 8000 }, stepId);
    return joinContinuation(res.text, more.text);
  }

  /** Polls a job until it finishes: null = succeeded, string = error, undefined = timeout/cancelled. */
  async waitJob(jobId: string | null, timeoutMs: number): Promise<string | null | undefined> {
    if (!jobId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.signal.aborted) throw new WorkflowStop("cancelled", "已停止。");
      const job = (await this.db.query<{ status: string; error: string | null }>("SELECT status,error FROM jobs WHERE id=$1", [jobId])).rows[0];
      if (!job) return undefined;
      if (job.status === "succeeded") return null;
      if (job.status === "failed") return job.error ?? "失敗";
      if (job.status === "cancelled") return undefined;
      await new Promise((r) => setTimeout(r, 1500));
      await this.deps.progress?.("waiting_render", 50).catch(() => undefined);
    }
    return undefined;
  }
}

export type { ContentBlock };
