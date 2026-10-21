/**
 * Anthropic Messages API (direct, and Claude on Vertex via rawPredict / streamRawPredict).
 * Thinking / redacted_thinking blocks round-trip through providerState unchanged.
 */
import { AiError, classifyHttpError, parseRetryAfter } from "../errors.js";
import { guardStream, modelsDetail, send, sendJson, sseEvents, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { assistantParts, blocksOf, ensureAudioSupported, ensureToolsSupported, finishBody, makeState, num, stateFor, textOf, toolResultImages, toolResultText, ToolCalls } from "./shared.js";

export interface AnthropicState {
  /** thinking / redacted_thinking blocks, in order, with signatures. */
  thinking: Record<string, unknown>[];
}

const imageBlock = (b: { source: { kind: string; mediaType?: string; data?: string; url?: string } }) =>
  b.source.kind === "base64"
    ? { type: "image", source: { type: "base64", media_type: b.source.mediaType, data: b.source.data } }
    : { type: "image", source: { type: "url", url: b.source.url } };

export function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> = [];
  const push = (role: "user" | "assistant", content: Record<string, unknown>[]) => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const st = stateFor<AnthropicState>(m, "anthropic-messages");
      const { text, toolUses } = assistantParts(m);
      const content: Record<string, unknown>[] = [...(st?.thinking ?? [])];
      if (text) content.push({ type: "text", text });
      for (const t of toolUses) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} });
      push("assistant", content);
      continue;
    }
    const blocks = m.role === "tool" ? m.content : blocksOf(m.content);
    const content: Record<string, unknown>[] = [];
    // tool_result blocks must come first in a user turn
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const imgs = toolResultImages(b);
      const txt = toolResultText(b);
      content.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: imgs.length ? [...(txt ? [{ type: "text", text: txt }] : []), ...imgs.map(imageBlock)] : txt,
        ...(b.is_error ? { is_error: true } : {}),
      });
    }
    for (const b of blocks) {
      if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
      else if (b.type === "image") content.push(imageBlock(b));
    }
    push("user", content);
  }
  return out;
}

export function buildAnthropicBody(ctx: CodecContext, req: ChatRequest, vertex: boolean): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  ensureAudioSupported(ctx, req, "anthropic-messages");
  const system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  const body: Record<string, unknown> = {
    max_tokens: req.maxTokens ?? Number(ctx.config.defaultMaxTokens ?? 8192),
    messages: toAnthropicMessages(req.messages),
    stream: true,
  };
  if (vertex) body.anthropic_version = "vertex-2023-10-16";
  else body.model = req.model;
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema, ...(t.strict ? { strict: true } : {}) }));
    const tc = req.toolChoice;
    const choice: Record<string, unknown> | undefined =
      tc === undefined ? undefined : tc === "auto" ? { type: "auto" } : tc === "none" ? { type: "none" } : tc === "required" ? { type: "any" } : { type: "tool", name: tc.name };
    if (choice && req.parallelToolCalls === false) choice.disable_parallel_tool_use = true;
    else if (!choice && req.parallelToolCalls === false) body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    if (choice) body.tool_choice = choice;
  }
  const outputConfig: Record<string, unknown> = {};
  if (req.responseFormat?.type === "json_schema") outputConfig.format = { type: "json_schema", schema: req.responseFormat.schema };
  const r = req.reasoning;
  if (r) {
    if (r.enabled === false || r.effort === "none") body.thinking = { type: "disabled" };
    else if (r.budgetTokens) body.thinking = { type: "enabled", budget_tokens: Math.max(1024, r.budgetTokens) };
    else if (r.effort || r.enabled) {
      body.thinking = { type: "adaptive" };
      if (r.effort) outputConfig.effort = r.effort === "minimal" ? "low" : r.effort;
    }
  }
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  return finishBody(ctx, body, req);
}

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  tool_use: "tool_use",
  pause_turn: "other",
  refusal: "content_filter",
  model_context_window_exceeded: "context_window",
};

const ERROR_TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

export function mapAnthropicError(input: { status: number; body: unknown; headers?: Headers | null }): AiError | undefined {
  const err = (input.body as { error?: { type?: string; message?: string } })?.error;
  if (!err?.type) return undefined;
  const base = { status: input.status, vendorCode: err.type, vendorMessage: err.message };
  if (err.type === "rate_limit_error") {
    const ra = parseRetryAfter(input.headers);
    // A spend-cap 429 has no retry-after → not worth retrying.
    return new AiError("rate_limited", { ...base, retryAfterMs: ra, retryable: ra !== undefined || !input.headers });
  }
  if (err.type === "billing_error") return new AiError("quota_exhausted", base);
  if (err.type === "not_found_error") return new AiError("model_not_found", base);
  if (err.type === "invalid_request_error" && /prompt is too long|too many tokens|context/i.test(err.message ?? "")) return new AiError("context_too_long", base);
  if (err.type === "invalid_request_error" && /spend limit|credit balance/i.test(err.message ?? "")) return new AiError("quota_exhausted", base);
  return classifyHttpError({ status: ERROR_TYPE_STATUS[err.type] ?? input.status, body: input.body, headers: input.headers });
}

async function* parseAnthropicStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const tools = new ToolCalls();
  const blocks = new Map<number, Record<string, unknown>>();
  const thinking: Record<string, unknown>[] = [];
  const usage: Usage = {};
  let stop: StopReason | undefined;
  let respModel: string | undefined;
  let finished = false;

  for await (const ev of sseEvents(res, call)) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(d.type ?? ev.event ?? "");
    if (type === "error") {
      const status = ERROR_TYPE_STATUS[String((d.error as Record<string, unknown>)?.type)] ?? 500;
      const e = mapAnthropicError({ status, body: d }) ?? new AiError("unavailable", { vendorMessage: JSON.stringify(d.error ?? d) });
      e.midStream = true;
      throw e;
    }
    if (type === "message_start") {
      const msg = (d.message ?? {}) as Record<string, unknown>;
      if (typeof msg.model === "string") respModel = msg.model;
      const u = (msg.usage ?? {}) as Record<string, unknown>;
      usage.inputTokens = num(u.input_tokens);
      usage.cacheReadTokens = num(u.cache_read_input_tokens);
      usage.cacheWriteTokens = num(u.cache_creation_input_tokens);
      if (num(u.output_tokens)) usage.outputTokens = num(u.output_tokens);
    } else if (type === "content_block_start") {
      const idx = Number(d.index);
      const cb = { ...((d.content_block ?? {}) as Record<string, unknown>) };
      blocks.set(idx, cb);
      if (cb.type === "tool_use") {
        for (const e of tools.push(idx, { id: String(cb.id ?? ""), name: String(cb.name ?? "") })) yield e;
      } else if (cb.type === "text" && typeof cb.text === "string" && cb.text) {
        yield { type: "text_delta", text: cb.text };
      } else if (cb.type === "thinking") {
        cb.thinking = String(cb.thinking ?? "");
        cb.signature = String(cb.signature ?? "");
        if (cb.thinking) yield { type: "reasoning_delta", text: cb.thinking as string };
      }
    } else if (type === "content_block_delta") {
      const idx = Number(d.index);
      const delta = (d.delta ?? {}) as Record<string, unknown>;
      const cb = blocks.get(idx);
      if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
      else if (delta.type === "input_json_delta") for (const e of tools.push(idx, { args: String(delta.partial_json ?? "") })) yield e;
      else if (delta.type === "thinking_delta" && cb) {
        cb.thinking = String(cb.thinking ?? "") + String(delta.thinking ?? "");
        if (delta.thinking) yield { type: "reasoning_delta", text: String(delta.thinking) };
      } else if (delta.type === "signature_delta" && cb) cb.signature = String(cb.signature ?? "") + String(delta.signature ?? "");
    } else if (type === "content_block_stop") {
      const idx = Number(d.index);
      const cb = blocks.get(idx);
      if (cb?.type === "tool_use") for (const e of tools.end(idx)) yield e;
      else if (cb?.type === "thinking" || cb?.type === "redacted_thinking") thinking.push(cb);
    } else if (type === "message_delta") {
      const delta = (d.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === "string") stop = STOP[delta.stop_reason] ?? "other";
      const u = (d.usage ?? {}) as Record<string, unknown>;
      if (num(u.output_tokens) !== undefined) usage.outputTokens = num(u.output_tokens);
      if (num(u.input_tokens) !== undefined) usage.inputTokens = num(u.input_tokens);
      const otd = u.output_tokens_details as Record<string, unknown> | undefined;
      if (num(otd?.thinking_tokens) !== undefined) usage.reasoningTokens = num(otd?.thinking_tokens);
    } else if (type === "message_stop") {
      finished = true;
      break;
    }
  }
  if (!finished) throw new AiError("unavailable", { vendorMessage: "stream ended before message_stop", providerId: ctx.entry.id, midStream: true });
  for (const e of tools.endAll()) yield e;
  yield { type: "usage", usage };
  yield { type: "done", stopReason: stop ?? "end_turn", model: respModel ?? model, providerState: makeState(ctx, "anthropic-messages", model, thinking.length ? { thinking } : undefined) };
}

function isVertex(ctx: CodecContext) {
  return ctx.entry.auth.type === "google_service_account";
}

async function listAnthropicModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  if (isVertex(ctx)) return (ctx.quirks.staticModels ?? []).map((id) => ({ id }));
  const out: ModelInfo[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ limit: "1000" });
    if (after) q.set("after_id", after);
    const json = (await sendJson(ctx, { url: `/models?${q}`, signal, mapError: mapAnthropicError })) as {
      data?: Array<Record<string, unknown>>;
      has_more?: boolean;
      last_id?: string;
    };
    for (const m of json.data ?? []) {
      const caps = (m.capabilities ?? {}) as Record<string, unknown>;
      out.push({
        id: String(m.id),
        label: typeof m.display_name === "string" ? m.display_name : undefined,
        kind: "chat",
        contextWindow: num(m.max_input_tokens),
        maxOutputTokens: num(m.max_tokens),
        hints: { tools: true, vision: caps.image_input !== undefined ? Boolean(caps.image_input) : true, reasoning: caps.thinking !== undefined ? true : undefined, jsonSchema: caps.structured_outputs !== undefined ? Boolean(caps.structured_outputs) : undefined },
      });
    }
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return out;
}

export const anthropicCodec: Codec = {
  id: "anthropic-messages",
  mapError: mapAnthropicError,
  listModels: listAnthropicModels,
  async *chatStream(ctx, req) {
    const vertex = isVertex(ctx);
    const body = buildAnthropicBody(ctx, req, vertex);
    const url = vertex ? `/publishers/anthropic/models/${encodeURIComponent(req.model)}:streamRawPredict` : (ctx.quirks.chatPath ?? "/messages");
    const { res, call } = await send(ctx, { url, body, signal: req.signal, timeoutMs: req.timeoutMs, headers: { accept: "text/event-stream" }, mapError: mapAnthropicError });
    yield* guardStream(call, parseAnthropicStream(ctx, res, call, req.model));
  },
  probe(ctx, signal) {
    return timedProbe(async () => {
      if (isVertex(ctx)) {
        await ctx.auth.apply({ method: "GET", url: new URL(ctx.baseUrl), headers: new Headers(), body: "" }, signal);
        return { detail_zh: "服務帳戶驗證成功。" };
      }
      const json = (await sendJson(ctx, { url: "/models?limit=1", signal, mapError: mapAnthropicError })) as { data?: unknown[] };
      return modelsDetail(json.data?.length ?? 0);
    });
  },
};
