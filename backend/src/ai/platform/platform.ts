/**
 * AiPlatform: the only way modules reach models. Code asks for a role; the platform resolves the role's route
 * tree, applies the strategy, retries/falls back, logs every attempt (no content) and keeps role health.
 */
import { EventEmitter } from "node:events";
import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db.js";
import { startLiveSession, transcribe as asrTranscribe, type AsrCheckpoint, type LiveOptions, type LiveSession, type Transcript, type TranscribeRequest } from "../asr/index.js";
import { AiError } from "../errors.js";
import { runClaudeCli } from "../oauth/index.js";
import { aggregateChat, type ChatEvent, type ChatRequest, type ChatResult, type EmbedResult, type Usage } from "../providers/index.js";
import { leaves, resolveRole, resolveTarget, runRoute, RouteExhausted, type AttemptFailure, type GroupNode, type ModelLeaf, type RunHooks } from "../router/index.js";
import { getProvider } from "../providers/index.js";
import { activeSpace, getSpace, liveSpaces, type EmbeddingSpace } from "../embedding/spaces.js";
import { CallLogger, CallRecorder, pruneCallLog, type CallContext } from "./call-log.js";
import { asrConfig, forgetClients, llmClient, type ClientFactoryOptions } from "./clients.js";
import { llmUnavailable, PlatformError, visionUnavailable } from "./errors.js";
import { boundProviders, deriveAll, loadRecent, probeProvider, type RoleStatus } from "./health.js";
import { forgetCachedTokens } from "./oauth-store.js";
import { splitChatParams } from "./params.js";
import { AI_ROLES, type AiRole, type ChatRole, type RoleState } from "./roles.js";
import { loadSnapshot, providerSecrets, type ConfigSnapshot, type ProviderRecord } from "./store.js";
import { hasImages, modelVision } from "./vision.js";
import { resolveProfile, syncStaleModels } from "./models.js";

export type RoleChatRequest = Omit<ChatRequest, "model">;
/** Which model served a call. `routeId` is a deprecated alias of `groupId ?? ""`. */
export type RouteInfo = { role: AiRole; routeId: string; groupId: string | null; modelRef: string; providerId: string; providerKind: string; model: string; fallbackIndex: number };
/** Smallest limits across the role's models (null when no model reports one). */
export type RoleLimits = { contextWindow: number | null; maxOutputTokens: number | null };

const routeInfo = (role: AiRole, l: ModelLeaf, fallbackIndex: number): RouteInfo => ({
  role,
  routeId: l.groupId ?? "",
  groupId: l.groupId,
  modelRef: l.modelRef,
  providerId: l.provider.id,
  providerKind: l.provider.kind,
  model: l.model,
  fallbackIndex,
});

/** Codecs whose wire format requires max_tokens on every request. */
const NEEDS_MAX_TOKENS = new Set(["anthropic-messages", "bedrock-converse"]);
const DEFAULT_REQUIRED_MAX_TOKENS = 8192;
export type AiCallContext = CallContext & {
  signal?: AbortSignal;
  /** Called once the member that will serve the call is known (before the first event). */
  onRoute?: (info: RouteInfo) => void;
};

export type PublicRoleStatus = { state: RoleState; message_zh: string; /** Image input available (see vision.ts). */ vision: boolean };
export type RoleCapabilities = { vision: boolean };
export type PublicStatus = { roles: Record<AiRole, PublicRoleStatus>; search_mode: "semantic" | "keyword_only"; updated_at: string };

export type TranscribeContext = AiCallContext & {
  /** Checkpoint saved by a previous attempt (as passed to `onCheckpoint`); reused only on the same member. */
  resume?: MemberCheckpoint;
  onCheckpoint?: (cp: MemberCheckpoint) => void | Promise<void>;
  /** Glossary terms substituted into the member's `{glossary}` prompt template. */
  glossary?: string[];
};
export type MemberCheckpoint = { memberId: string; model: string; asr: AsrCheckpoint };

export type PlatformOptions = ClientFactoryOptions & {
  /** Background runtime (LISTEN, probes). Off in tests unless started explicitly. */
  probeIntervalMs?: number;
  snapshotTtlMs?: number;
  rng?: () => number;
  sleep?: RunHooks["sleep"];
  claudeCli?: typeof runClaudeCli;
  transcribeImpl?: typeof asrTranscribe;
};

const PROBE_LOCK = 473_931;

export class AiPlatform {
  readonly logger: CallLogger;
  private snap?: Promise<ConfigSnapshot>;
  private snapAt = 0;
  private statusCache?: { roles: RoleStatus[]; at: number; searchMode: PublicStatus["search_mode"] };
  private events = new EventEmitter();
  private listener?: pg.PoolClient;
  private timers: NodeJS.Timeout[] = [];
  private leader = false;
  private recomputeTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastPrune = 0;

  constructor(readonly db: Db, readonly log: FastifyBaseLogger | Pick<FastifyBaseLogger, "warn" | "info" | "error">, readonly opts: PlatformOptions = {}) {
    this.logger = new CallLogger(db, log);
    this.logger.onWritten = (rows) => {
      if (rows.some((r) => !r.ok) && this.statusCache) this.statusCache.at = 0;
      if (rows.some((r) => !r.ok) || this.statusCache?.roles.some((s) => s.state !== "ok" && s.state !== "unconfigured")) this.scheduleRecompute();
    };
    this.events.setMaxListeners(1000);
  }

  // ---------------------------------------------------------------- config

  snapshot(): Promise<ConfigSnapshot> {
    const ttl = this.opts.snapshotTtlMs ?? 30_000;
    if (!this.snap || Date.now() - this.snapAt > ttl) {
      this.snapAt = Date.now();
      this.snap = loadSnapshot(this.db);
      this.snap.catch(() => (this.snap = undefined));
    }
    return this.snap;
  }

  /** Drop caches after a config change (admin writes call this, other processes get NOTIFY ai_config). */
  invalidate() {
    this.snap = undefined;
    forgetClients();
    forgetCachedTokens();
    this.scheduleRecompute(200);
  }

  private hooks(ctx: AiCallContext | undefined, extra: Partial<RunHooks> = {}): RunHooks {
    return { signal: ctx?.signal, rng: this.opts.rng, sleep: this.opts.sleep, ...extra };
  }

  private async tree(role: AiRole, rec: CallRecorder): Promise<GroupNode> {
    const snap = await this.snapshot();
    let tree: GroupNode | null;
    try {
      tree = resolveRole(snap, role);
    } catch (e) {
      rec.exhausted("route_invalid");
      throw e;
    }
    if (!tree || !tree.members.length) {
      rec.exhausted("llm_unavailable", tree?.id ?? null);
      throw llmUnavailable(role, "unconfigured");
    }
    return tree;
  }

  /** Records the failure of a call and converts router errors into platform errors. */
  private fail(role: AiRole, rec: CallRecorder, e: unknown, routeId: string | null): never {
    if (e instanceof RouteExhausted) {
      rec.failures(e.failures);
      rec.exhausted("llm_unavailable", routeId);
      throw llmUnavailable(role, "all_failed", e.attempts());
    }
    const failures = (e as { routeFailures?: AttemptFailure[] }).routeFailures;
    if (failures?.length) {
      const last = failures[failures.length - 1]!;
      rec.failures(failures.slice(0, -1));
      rec.finish(last.leaf, { ok: false, startedAt: last.startedAt, errorCode: (e as AiError).code, retries: last.retries, fallbackIndex: last.fallbackIndex });
    } else rec.exhausted(e instanceof AiError ? e.code : "unavailable", routeId);
    throw e;
  }

  // ---------------------------------------------------------------- vision

  /** Vision support of one member's model (profile, else detection). */
  leafVision(leaf: Pick<ModelLeaf, "provider" | "model" | "profile">) {
    return modelVision(leaf.provider, leaf.model, leaf.profile);
  }

  /** What a role can do right now: `vision` = an image request would find a member that accepts images. */
  async capabilities(role: AiRole): Promise<RoleCapabilities> {
    const st = (await this.statusDetail()).find((s) => s.role === role);
    return { vision: st?.state !== "unavailable" && st?.state !== "unconfigured" && st?.detail.vision === true };
  }

  /** Annotates chat roles' status with per-member vision and the role's `vision` flag. */
  private async annotateVision(roles: RoleStatus[]) {
    const snap = await this.snapshot();
    for (const s of roles) {
      if (!s.detail.members?.length || (s.role !== "assistant" && s.role !== "writing" && s.role !== "slides" && s.role !== "analysis" && s.role !== "fast")) continue;
      for (const m of s.detail.members) {
        const p = snap.providers.get(m.providerId);
        if (!p) continue;
        const v = modelVision(p, m.model, snap.models.get(m.modelRef)?.profile);
        m.vision = v.vision;
        m.vision_source = v.source;
      }
      s.detail.vision = s.detail.members.some((m) => m.vision && m.health !== "down");
    }
  }

  /** Smallest context window / max output across the role's models (for callers that budget prompts). */
  async limits(role: AiRole): Promise<RoleLimits> {
    const snap = await this.snapshot();
    let tree: GroupNode | null = null;
    try {
      tree = resolveRole(snap, role);
    } catch {
      /* invalid binding: no limits */
    }
    const ls = tree ? leaves(tree) : [];
    const min = (xs: Array<number | undefined>) => {
      const v = xs.filter((x): x is number => typeof x === "number");
      return v.length ? Math.min(...v) : null;
    };
    return { contextWindow: min(ls.map((l) => l.profile.fields.context_window)), maxOutputTokens: min(ls.map((l) => l.profile.fields.max_output_tokens)) };
  }

  // ---------------------------------------------------------------- chat

  private chatRequest(leaf: Pick<ModelLeaf, "provider" | "model" | "params" | "profile">, req: RoleChatRequest): ChatRequest {
    const p = splitChatParams("chat", leaf.provider.kind, leaf.params);
    const out: ChatRequest = { ...req, model: leaf.model };
    const prof = leaf.profile.fields;
    if (p.temperature !== undefined) out.temperature = p.temperature;
    if (p.topP !== undefined) out.topP = p.topP;
    // Limits come from the model profile: never ask for more output than the model allows.
    if (prof.max_output_tokens && out.maxTokens) out.maxTokens = Math.min(out.maxTokens, prof.max_output_tokens);
    if (out.maxTokens === undefined) {
      const entry = getProvider(leaf.provider.kind);
      const codec = entry?.codecFor?.(leaf.provider.config) ?? entry?.codec;
      if (codec && NEEDS_MAX_TOKENS.has(codec)) out.maxTokens = Math.min(prof.max_output_tokens ?? DEFAULT_REQUIRED_MAX_TOKENS, Math.max(DEFAULT_REQUIRED_MAX_TOKENS, Number(leaf.provider.config.defaultMaxTokens) || 0));
    }
    // Local servers that allocate context per request (Ollama num_ctx) get the admin's manual context window.
    if (leaf.profile.sources.context_window === "manual" && prof.context_window) out.contextLength = prof.context_window;
    if (p.timeoutMs !== undefined) out.timeoutMs = p.timeoutMs;
    if (p.reasoningEffort) out.reasoning = { ...req.reasoning, effort: p.reasoningEffort };
    if (Object.keys(p.passthrough).length) out.params = { ...req.params, ...p.passthrough };
    return out;
  }

  private async startChat(leaf: Pick<ModelLeaf, "provider" | "model" | "params" | "profile">, req: RoleChatRequest, signal?: AbortSignal) {
    const r = { ...this.chatRequest(leaf, req), signal };
    let gen: AsyncGenerator<ChatEvent>;
    if (leaf.provider.kind === "claude-cli") {
      const secrets = providerSecrets(leaf.provider);
      if (!secrets.oauthToken) throw new AiError("auth_failed", { vendorMessage: "claude-cli: setup-token missing", providerId: leaf.provider.id });
      const c = leaf.provider.config;
      gen = (this.opts.claudeCli ?? runClaudeCli)(r, {
        oauthToken: secrets.oauthToken,
        command: typeof c.command === "string" && c.command ? c.command : undefined,
        maxBudgetUsd: typeof c.maxBudgetUsd === "number" ? c.maxBudgetUsd : undefined,
        timeoutMs: r.timeoutMs ?? (typeof c.timeoutMs === "number" ? c.timeoutMs : undefined),
      });
    } else gen = llmClient(this.db, leaf.provider, this.opts).chatStream(r);
    const t0 = Date.now();
    const first = await gen.next();
    // An error before any content is still safe to fall back from.
    if (!first.done && first.value.type === "error") {
      await gen.return(undefined);
      throw Object.assign(first.value.error, { midStream: false });
    }
    return { first, gen, ttftMs: Date.now() - t0 };
  }

  /** Streams a chat turn for `role`. Pre-stream failures fall back; errors after the first event arrive as an `error` event. */
  async *chatStream(role: ChatRole, req: RoleChatRequest, ctx: AiCallContext = {}): AsyncGenerator<ChatEvent> {
    const rec = new CallRecorder(this.logger, { role, capability: "chat", stream: true, ctx });
    const tree = await this.tree(role, rec);
    // Image requests only go to members that accept images (never silently stripped; see vision.ts).
    const hints = hasImages(req.messages);
    const skip = hints ? (leaf: ModelLeaf) => (modelVision(leaf.provider, leaf.model, leaf.profile).vision ? null : ("no_vision" as const)) : undefined;
    let run;
    try {
      run = await runRoute(tree, (leaf) => this.startChat(leaf, req, ctx.signal), this.hooks(ctx, skip ? { skip } : {}));
    } catch (e) {
      if (e instanceof RouteExhausted && hints) {
        const real = e.failures.filter((f) => f.skipped !== "no_vision");
        if (!real.some((f) => !f.skipped)) {
          rec.failures(real);
          rec.exhausted("vision_unavailable", tree.id);
          throw visionUnavailable(role);
        }
        e.failures.splice(0, e.failures.length, ...real);
      }
      this.fail(role, rec, e, tree.id);
    }
    rec.failures(run.failures.filter((f) => f.skipped !== "no_vision"));
    const { leaf } = run;
    ctx.onRoute?.(routeInfo(role, leaf, run.fallbackIndex));
    const usage: Usage = {};
    let ok = false;
    let errorCode: string | undefined = "cancelled";
    try {
      let r = run.value.first;
      while (!r.done) {
        const ev = r.value;
        if (ev.type === "usage") Object.assign(usage, ev.usage);
        if (ev.type === "done") {
          ok = true;
          errorCode = undefined;
        }
        if (ev.type === "error") {
          ok = false;
          errorCode = ev.error.code;
        }
        yield ev;
        if (ev.type === "error" || ev.type === "done") break;
        r = await run.value.gen.next();
      }
    } catch (e) {
      errorCode = e instanceof AiError ? e.code : "unavailable";
      throw e;
    } finally {
      await run.value.gen.return(undefined).catch(() => undefined);
      rec.finish(leaf, { ok, startedAt: run.startedAt, errorCode, retries: run.retries, fallbackIndex: run.fallbackIndex, ttftMs: run.value.ttftMs, usage });
    }
  }

  /** Admin "test" button: one tiny generation on a specific account + model (bypasses routing; not logged). */
  async chatOnce(provider: ProviderRecord, model: string): Promise<string> {
    const snap = await this.snapshot();
    const row = [...snap.models.values()].find((m) => m.provider_id === provider.id && m.model_id === model);
    const leaf = { provider, model, params: {}, profile: row?.profile ?? resolveProfile(provider, { model_id: model, api: {}, overrides: {} }) };
    const { first, gen } = await this.startChat(leaf, { messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: 16 });
    async function* all() {
      if (!first.done) yield first.value;
      yield* gen;
    }
    return (await aggregateChat(all())).text;
  }

  /** Non-streaming convenience: the whole turn as a ChatResult (throws AiError / PlatformError). */
  async chat(role: ChatRole, req: RoleChatRequest, ctx: AiCallContext = {}): Promise<ChatResult & { route?: RouteInfo }> {
    let route: RouteInfo | undefined;
    const result = await aggregateChat(this.chatStream(role, req, { ...ctx, onRoute: (i) => ((route = i), ctx.onRoute?.(i)) }));
    return { ...result, route };
  }

  // ---------------------------------------------------------------- embeddings

  async embedWithLeaf(leaf: Pick<ModelLeaf, "provider" | "model" | "params">, inputs: string[], inputType: "query" | "document", signal?: AbortSignal): Promise<EmbedResult> {
    const p = splitChatParams("embedding", leaf.provider.kind, leaf.params);
    return llmClient(this.db, leaf.provider, this.opts).embed({ model: leaf.model, inputs, inputType, dimensions: p.dimensions, timeoutMs: p.timeoutMs, signal });
  }

  /**
   * Embeds texts in the active space (or `spaceId`). Fallback only happens between members of the space's route,
   * which the fingerprint check guarantees are the same model.
   */
  async embed(inputs: string[], inputType: "query" | "document", opts: AiCallContext & { spaceId?: string } = {}): Promise<EmbedResult & { spaceId: string }> {
    const rec = new CallRecorder(this.logger, { role: "embedding", capability: "embedding", stream: false, ctx: opts });
    const space = opts.spaceId ? await getSpace(this.db, opts.spaceId) : await activeSpace(this.db);
    if (!space?.model_ref && !space?.group_id) {
      rec.exhausted("llm_unavailable");
      throw llmUnavailable("embedding", "unconfigured");
    }
    const snap = await this.snapshot();
    let tree: GroupNode;
    try {
      tree = resolveTarget(snap, { model_ref: space.model_ref, group_id: space.group_id, params: space.params ?? {} }, "embedding", "embedding");
    } catch (e) {
      rec.exhausted("route_invalid", space.group_id);
      throw e;
    }
    let run;
    try {
      run = await runRoute(
        tree,
        async (leaf) => {
          const r = await this.embedWithLeaf(leaf, inputs, inputType, opts.signal);
          if (r.dims && r.dims !== space.dims) throw new AiError("unsupported", { vendorMessage: `dimension ${r.dims} ≠ space ${space.dims}`, providerId: leaf.provider.id });
          return r;
        },
        this.hooks(opts),
      );
    } catch (e) {
      this.fail("embedding", rec, e, tree.id);
    }
    rec.failures(run.failures);
    rec.finish(run.leaf, { ok: true, startedAt: run.startedAt, retries: run.retries, fallbackIndex: run.fallbackIndex, usage: { inputTokens: run.value.usage.inputTokens } });
    return { ...run.value, spaceId: space.id };
  }

  /** For indexers: vectors for every live space (active + one being built by a switch). */
  async embedForIndex(inputs: string[], ctx: AiCallContext = {}): Promise<Array<{ space: EmbeddingSpace; vectors: number[][] }>> {
    const out: Array<{ space: EmbeddingSpace; vectors: number[][] }> = [];
    for (const space of await liveSpaces(this.db)) {
      const r = await this.embed(inputs, "document", { ...ctx, spaceId: space.id });
      out.push({ space, vectors: r.vectors });
    }
    return out;
  }

  /** Search mode for the search module: semantic needs an active space and a working embedding role. */
  async embeddingState(): Promise<{ mode: "semantic" | "keyword_only"; space: EmbeddingSpace | null; reason_zh?: string }> {
    const space = await activeSpace(this.db);
    if (!space) return { mode: "keyword_only", space: null, reason_zh: "尚未設定語意搜尋。" };
    const st = (await this.statusDetail()).find((s) => s.role === "embedding");
    if (st?.state === "unavailable") return { mode: "keyword_only", space, reason_zh: st.message_zh };
    // An unbound role means the admin turned semantic search off, even though the space still remembers its model.
    if (!st || st.state === "unconfigured") return { mode: "keyword_only", space, reason_zh: "尚未設定語意搜尋。" };
    return { mode: "semantic", space };
  }

  // ---------------------------------------------------------------- speech

  async transcribe(req: Omit<TranscribeRequest, "resume" | "onCheckpoint">, ctx: TranscribeContext & { role?: "asr" } = {}): Promise<Transcript & { route?: RouteInfo }> {
    const role = ctx.role ?? "asr";
    const rec = new CallRecorder(this.logger, { role, capability: "asr", stream: false, ctx });
    const tree = await this.tree(role, rec);
    let run;
    try {
      run = await runRoute(
        tree,
        async (leaf) => {
          const prm = leaf.params;
          const cfg = asrConfig(leaf.provider, leaf.model, prm, this.opts.fetch);
          const glossary = (ctx.glossary ?? []).join("、");
          const template = typeof prm.prompt_template === "string" ? prm.prompt_template : undefined;
          const resume = ctx.resume && ctx.resume.memberId === leaf.memberId && ctx.resume.model === leaf.model ? ctx.resume.asr : undefined;
          return (this.opts.transcribeImpl ?? asrTranscribe)(cfg, {
            ...req,
            language: req.language ?? (typeof prm.language === "string" ? prm.language : undefined),
            extraLanguages: req.extraLanguages ?? (Array.isArray(prm.extra_languages) ? (prm.extra_languages as string[]) : undefined),
            diarize: req.diarize ?? (typeof prm.diarization === "boolean" ? prm.diarization : undefined),
            wordTimestamps: req.wordTimestamps ?? (typeof prm.word_timestamps === "boolean" ? prm.word_timestamps : undefined),
            convertScript: req.convertScript ?? (typeof prm.convert_script === "string" ? (prm.convert_script as TranscribeRequest["convertScript"]) : undefined),
            keyterms: req.keyterms ?? (prm.use_glossary_keyterms !== false ? ctx.glossary : undefined),
            prompt: req.prompt ?? (template ? template.replaceAll("{glossary}", glossary ? `詞彙：${glossary}` : "") : undefined),
            signal: ctx.signal,
            resume,
            onCheckpoint: ctx.onCheckpoint ? (cp) => ctx.onCheckpoint!({ memberId: leaf.memberId, model: leaf.model, asr: cp }) : undefined,
          });
        },
        this.hooks(ctx, { defaultRetries: 0 }),
      );
    } catch (e) {
      this.fail(role, rec, e, tree.id);
    }
    rec.failures(run.failures);
    rec.finish(run.leaf, { ok: true, startedAt: run.startedAt, retries: run.retries, fallbackIndex: run.fallbackIndex });
    return { ...run.value, route: routeInfo(role, run.leaf, run.fallbackIndex) };
  }

  /** Opens a live caption session on the `asr_live` route (vendor keys stay server-side). */
  async liveTranscribe(opts: LiveOptions, ctx: AiCallContext & { role?: "asr_live" } = {}): Promise<LiveSession & { route: RouteInfo }> {
    const role = ctx.role ?? "asr_live";
    const rec = new CallRecorder(this.logger, { role, capability: "asr_live", stream: true, ctx });
    const tree = await this.tree(role, rec);
    let run;
    try {
      run = await runRoute(
        tree,
        (leaf) => {
          const prm = leaf.params;
          return startLiveSession(asrConfig(leaf.provider, leaf.model, prm, this.opts.fetch), {
            ...opts,
            language: opts.language ?? (typeof prm.language === "string" ? prm.language : undefined),
            diarize: opts.diarize ?? (typeof prm.diarization === "boolean" ? prm.diarization : undefined),
            convertScript: opts.convertScript ?? (typeof prm.convert_script === "string" ? (prm.convert_script as LiveOptions["convertScript"]) : undefined),
          });
        },
        this.hooks(ctx, { defaultRetries: 0 }),
      );
    } catch (e) {
      this.fail(role, rec, e, tree.id);
    }
    rec.failures(run.failures);
    rec.finish(run.leaf, { ok: true, startedAt: run.startedAt, fallbackIndex: run.fallbackIndex });
    return Object.assign(run.value, { route: routeInfo(role, run.leaf, run.fallbackIndex) });
  }

  // ---------------------------------------------------------------- health

  /** Recomputes every role's health from probes + recent calls, persists changes and notifies listeners. */
  async recompute(): Promise<RoleStatus[]> {
    await this.logger.flush();
    this.snap = undefined;
    const snap = await this.snapshot();
    const { recent, roleCalls } = await loadRecent(this.db);
    const roles = deriveAll(snap, recent, roleCalls);
    await this.annotateVision(roles);
    const prev = new Map(this.statusCache?.roles.map((r) => [r.role, r]) ?? []);
    let changed = !this.statusCache;
    for (const s of roles) {
      const res = await this.db.query(
        `INSERT INTO ai_role_status(role,state,message_zh,detail,changed_at,updated_at) VALUES($1,$2,$3,$4,now(),now())
         ON CONFLICT (role) DO UPDATE SET state=EXCLUDED.state, message_zh=EXCLUDED.message_zh, detail=EXCLUDED.detail, updated_at=now(),
           changed_at = CASE WHEN ai_role_status.state <> EXCLUDED.state THEN now() ELSE ai_role_status.changed_at END
         RETURNING (xmax = 0) AS inserted`,
        [s.role, s.state, s.message_zh, JSON.stringify(s.detail)],
      );
      const p = prev.get(s.role);
      if (res.rows[0]?.inserted || !p || p.state !== s.state || p.message_zh !== s.message_zh || Boolean(p.detail.vision) !== Boolean(s.detail.vision)) changed = true;
    }
    const searchMode = (await activeSpace(this.db)) && roles.find((r) => r.role === "embedding")?.state !== "unavailable" ? "semantic" : "keyword_only";
    if (this.statusCache?.searchMode !== searchMode) changed = true;
    this.statusCache = { roles, at: Date.now(), searchMode };
    if (changed) {
      await this.db.query("SELECT pg_notify('ai_status', '')");
      this.events.emit("status", this.publicStatus());
    }
    return roles;
  }

  scheduleRecompute(delayMs = 1500) {
    if (this.stopped || this.recomputeTimer) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = undefined;
      void this.recompute().catch((err) => {
        if (!this.stopped) this.log.warn({ err }, "ai status recompute failed");
      });
    }, delayMs);
    this.recomputeTimer.unref?.();
  }

  private async reloadStatusTable() {
    const rows = (await this.db.query<{ role: AiRole; state: RoleState; message_zh: string; detail: RoleStatus["detail"] }>("SELECT role,state,message_zh,detail FROM ai_role_status")).rows;
    if (!rows.length) return this.recompute();
    const byRole = new Map(rows.map((r) => [r.role, r]));
    const roles = AI_ROLES.map((role) => byRole.get(role) ?? { role, state: "unconfigured" as const, message_zh: "", detail: {} });
    const searchMode = (await activeSpace(this.db)) && byRole.get("embedding")?.state !== "unavailable" ? "semantic" : "keyword_only";
    const before = JSON.stringify(this.statusCache ? this.publicStatus().roles : null);
    this.statusCache = { roles, at: Date.now(), searchMode };
    if (before !== JSON.stringify(this.publicStatus().roles)) this.events.emit("status", this.publicStatus());
    return roles;
  }

  /** Admin view (includes member detail). Fresh within 30 s. */
  async statusDetail(): Promise<RoleStatus[]> {
    if (!this.statusCache || Date.now() - this.statusCache.at > 30_000) await this.recompute();
    return this.statusCache!.roles;
  }

  private publicStatus(): PublicStatus {
    const roles = {} as Record<AiRole, PublicRoleStatus>;
    for (const s of this.statusCache?.roles ?? []) roles[s.role] = { state: s.state, message_zh: s.message_zh, vision: s.detail?.vision === true && (s.state === "ok" || s.state === "degraded") };
    return { roles, search_mode: this.statusCache?.searchMode ?? "keyword_only", updated_at: new Date(this.statusCache?.at ?? Date.now()).toISOString() };
  }

  /** Public status: role → state + message only (no providers, models or errors). */
  async status(): Promise<PublicStatus> {
    await this.statusDetail();
    return this.publicStatus();
  }

  onStatus(listener: (s: PublicStatus) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  /** Probes every account used by a bound role and stores the result on the account. */
  async probeAll(): Promise<void> {
    const snap = await loadSnapshot(this.db);
    await Promise.all(
      boundProviders(snap).map(async (p) => {
        const r = await probeProvider(this.db, p, this.opts);
        await this.db.query("UPDATE ai_providers SET last_probe=$2, last_probe_at=now() WHERE id=$1", [
          p.id,
          JSON.stringify({ ok: r.ok, latencyMs: r.latencyMs, detail_zh: r.detail_zh, code: r.code, modelCount: r.modelCount }),
        ]);
      }),
    );
    // Model profiles (limits, vision, tools…): cheap listing, at most every 6 h per bound account.
    await syncStaleModels(this.db, boundProviders(snap), this.opts);
    this.snap = undefined;
  }

  // ---------------------------------------------------------------- runtime

  /** Background runtime: config/status notifications in every process; probes in the advisory-lock holder only. */
  async start() {
    this.stopped = false;
    this.listener = await this.db.connect();
    this.listener.on("notification", (msg) => {
      if (msg.channel === "ai_config") {
        this.snap = undefined;
        forgetClients();
        forgetCachedTokens();
        if (this.leader) this.scheduleRecompute(300);
      } else if (msg.channel === "ai_status") void this.reloadStatusTable().catch(() => undefined);
    });
    this.listener.on("error", (err) => this.log.warn({ err }, "ai platform listener error"));
    await this.listener.query("LISTEN ai_config");
    await this.listener.query("LISTEN ai_status");
    const interval = this.opts.probeIntervalMs ?? 60_000;
    const tick = async () => {
      if (this.stopped || !this.listener) return;
      try {
        if (!this.leader) this.leader = Boolean((await this.listener.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [PROBE_LOCK])).rows[0]?.ok);
        if (this.leader) {
          await this.probeAll();
          await this.recompute();
          if (Date.now() - this.lastPrune > 3_600_000) {
            this.lastPrune = Date.now();
            await pruneCallLog(this.db);
            await this.db.query("DELETE FROM ai_oauth_sessions WHERE expires_at < now() - interval '1 day'");
          }
        } else await this.reloadStatusTable();
      } catch (err) {
        this.log.warn({ err }, "ai platform tick failed");
      }
    };
    void tick();
    this.timers.push(setInterval(() => void tick(), interval));
    this.timers.push(setInterval(() => void this.reloadStatusTable().catch(() => undefined), 30_000));
    for (const t of this.timers) t.unref?.();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    await this.logger.flush();
    if (this.listener) {
      await this.listener.query("UNLISTEN *").catch(() => undefined);
      if (this.leader) await this.listener.query("SELECT pg_advisory_unlock($1)", [PROBE_LOCK]).catch(() => undefined);
      this.listener.release();
      this.listener = undefined;
    }
    this.leader = false;
  }
}

export { PlatformError };
