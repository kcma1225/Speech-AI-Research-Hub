/**
 * OpenAI Chat Completions (and every compatible server): `POST {base}/chat/completions`
 * SSE, `GET {base}/models`, `POST {base}/embeddings`.
 */
import { AiError, type AiErrorCode } from "../errors.js";
import { guardStream, joinUrl, modelsDetail, parseJsonLoose, send, sendJson, serverRoot, sseEvents, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, ContentBlock, EmbedRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import {
  applyEmbedTemplate,
  assistantParts,
  batchSize,
  blocksOf,
  chunk,
  clampEffort,
  decodeBase64Floats,
  ensureToolsSupported,
  finishBody,
  finishVectors,
  imageDataUrl,
  makeState,
  num,
  stateFor,
  textOf,
  toolResultImages,
  toolResultText,
  ToolCalls,
} from "./shared.js";

export interface OpenAiChatState {
  /** Reasoning text and the field it came in (resent under the same key). */
  reasoningKey?: string;
  reasoning?: string;
}

// ---------------------------------------------------------------- request

/**
 * Chat Completions tool messages carry text only: images of tool results (page renders) follow the tool messages as
 * one user message, so they are not dropped silently.
 */
function pushToolImages(out: Record<string, unknown>[], results: ContentBlock[]) {
  const images = results.flatMap((b) => (b.type === "tool_result" ? toolResultImages(b) : []));
  if (!images.length) return;
  out.push({ role: "user", content: [{ type: "text", text: "(Images returned by the tool call above.)" }, ...images.map((img) => ({ type: "image_url", image_url: { url: imageDataUrl(img) } }))] });
}

export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.content) });
    } else if (m.role === "tool") {
      for (const b of m.content) out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b) || (b.is_error ? "error" : "") });
      pushToolImages(out, m.content);
    } else if (m.role === "user") {
      const blocks = blocksOf(m.content);
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const b of results) out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b) || (b.is_error ? "error" : "") });
      pushToolImages(out, results);
      const rest = blocks.filter((b) => b.type !== "tool_result");
      if (!rest.length) continue;
      if (rest.every((b) => b.type === "text")) {
        out.push({ role: "user", content: rest.map((b) => (b.type === "text" ? b.text : "")).join("") });
      } else {
        out.push({
          role: "user",
          content: rest.map((b) => (b.type === "text" ? { type: "text", text: b.text } : b.type === "image" ? { type: "image_url", image_url: { url: imageDataUrl(b) } } : null)).filter(Boolean),
        });
      }
    } else {
      const { text, toolUses } = assistantParts(m);
      const msg: Record<string, unknown> = { role: "assistant", content: text || (toolUses.length ? null : "") };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }));
      }
      const st = stateFor<OpenAiChatState>(m, "openai-chat");
      if (st?.reasoningKey && st.reasoning) msg[st.reasoningKey] = st.reasoning;
      out.push(msg);
    }
  }
  return out;
}

export function buildChatBody(ctx: CodecContext, req: ChatRequest, stream: boolean): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  const q = ctx.quirks;
  const body: Record<string, unknown> = { model: req.model, messages: toOpenAiMessages(req.messages), stream };
  if (stream && q.streamUsage !== false) body.stream_options = { include_usage: true };
  if (req.maxTokens) body[q.maxTokensField ?? "max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop?.length) body.stop = req.stop;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema, ...(t.strict ? { strict: true } : {}) },
    }));
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", function: { name: req.toolChoice.name } };
    if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
  }
  if (req.responseFormat?.type === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: req.responseFormat.strict ?? true } };
  } else if (req.responseFormat?.type === "json_object") body.response_format = { type: "json_object" };
  applyReasoning(body, ctx, req);
  return finishBody(ctx, body, req);
}

function applyReasoning(body: Record<string, unknown>, ctx: CodecContext, req: ChatRequest) {
  const r = req.reasoning;
  if (!r) return;
  const off = r.enabled === false || r.effort === "none";
  switch (ctx.quirks.reasoningStyle ?? "openai_effort") {
    case "openai_effort":
      if (r.effort) body.reasoning_effort = r.effort;
      else if (r.enabled === false) body.reasoning_effort = "none";
      break;
    case "thinking_type":
      body.thinking = { type: off ? "disabled" : "enabled" };
      if (!off && r.effort) body.reasoning_effort = clampEffort(r.effort, ["low", "high", "max"]);
      break;
    case "dashscope":
      body.enable_thinking = !off;
      if (!off && r.budgetTokens) body.thinking_budget = r.budgetTokens;
      break;
    case "chat_template_kwargs":
      body.chat_template_kwargs = { ...(body.chat_template_kwargs as object), enable_thinking: !off };
      if (!off && r.effort && r.effort !== "none") body.reasoning_effort = r.effort;
      break;
    case "reasoning_object":
      body.reasoning = off ? { enabled: false } : r.budgetTokens ? { max_tokens: r.budgetTokens } : r.effort ? { effort: r.effort } : { enabled: true };
      break;
    case "none":
      break;
  }
}

// ---------------------------------------------------------------- response

const FINISH: Record<string, StopReason> = {
  stop: "end_turn",
  eos: "end_turn",
  end_turn: "end_turn",
  length: "max_tokens",
  max_tokens: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  tool_use: "tool_use",
  content_filter: "content_filter",
  sensitive: "content_filter",
  stop_sequence: "stop_sequence",
  model_context_window_exceeded: "context_window",
};

const FINISH_ERRORS: Record<string, AiErrorCode> = { error: "unavailable", network_error: "unavailable" };

export function usageFromOpenAi(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  const ctd = u.completion_tokens_details as Record<string, unknown> | undefined;
  const ptd = u.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: num(u.prompt_tokens) ?? num(u.input_tokens),
    outputTokens: num(u.completion_tokens) ?? num(u.output_tokens),
    reasoningTokens: num(ctd?.reasoning_tokens),
    cacheReadTokens: num(ptd?.cached_tokens) ?? num(u.prompt_cache_hit_tokens),
  };
}

function inStreamError(ctx: CodecContext, err: unknown): AiError {
  const e = (typeof err === "object" && err ? err : { message: String(err) }) as Record<string, unknown>;
  const status = num(e.code) ?? num(e.status) ?? 500;
  const body = { error: e };
  const mapped = ctx.quirks.mapError?.({ status, body });
  if (mapped) {
    mapped.midStream = true;
    return mapped;
  }
  const msg = String(e.message ?? "");
  const code: AiErrorCode = /rate/i.test(msg) || status === 429 ? "rate_limited" : /overload|capacity/i.test(msg) || status === 503 || status === 529 ? "overloaded" : /context|too long/i.test(msg) ? "context_too_long" : /moderat|filter|safety/i.test(msg) || status === 403 ? "content_filtered" : status === 400 ? "bad_request" : "unavailable";
  return new AiError(code, { status, vendorMessage: msg, vendorCode: e.code != null ? String(e.code) : undefined, providerId: ctx.entry.id, midStream: true });
}

async function* parseChatStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const tools = new ToolCalls();
  const fields = ctx.quirks.reasoningFields ?? ["reasoning_content", "reasoning"];
  let reasoningKey: string | undefined;
  let reasoning = "";
  let stop: StopReason | undefined;
  let usage: Usage | undefined;
  let sawDone = false;
  let respModel: string | undefined;
  const finishErrors = { ...FINISH_ERRORS, ...ctx.quirks.finishReasonErrors };

  for await (const ev of sseEvents(res, call)) {
    const data = ev.data.trim();
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (chunk.error) throw inStreamError(ctx, chunk.error);
    if (ev.event === "error") throw inStreamError(ctx, chunk);
    if (typeof chunk.model === "string") respModel = chunk.model;
    const u = usageFromOpenAi(chunk.usage as Record<string, unknown> | undefined);
    if (u) usage = u;
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
    const choice = choices[0];
    if (!choice) continue;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    for (const f of fields) {
      const r = delta[f];
      if (typeof r === "string" && r) {
        reasoningKey ??= f;
        if (f === reasoningKey) {
          reasoning += r;
          yield { type: "reasoning_delta", text: r };
        }
        break;
      }
    }
    if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
    let tcs = delta.tool_calls as unknown;
    if (tcs && !Array.isArray(tcs)) tcs = [tcs]; // TGI sends an object
    if (Array.isArray(tcs)) {
      for (let pos = 0; pos < tcs.length; pos++) {
        const tc = tcs[pos] as Record<string, unknown>;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        const key = num(tc.index) ?? (typeof tc.id === "string" && tc.id ? tc.id : pos);
        const args = fn.arguments ?? fn.parameters;
        for (const e of tools.push(key, {
          id: tc.id != null ? String(tc.id) : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          args: typeof args === "string" ? args : args != null ? JSON.stringify(args) : undefined,
        }))
          yield e;
      }
    }
    const fr = choice.finish_reason;
    if (typeof fr === "string" && fr) {
      if (finishErrors[fr]) {
        const err = (choice.error ?? chunk.error) as Record<string, unknown> | undefined;
        throw new AiError(finishErrors[fr]!, { vendorCode: fr, vendorMessage: err ? String(err.message ?? "") : undefined, providerId: ctx.entry.id, midStream: true });
      }
      stop = FINISH[fr] ?? "other";
    }
  }
  if (!sawDone && !stop) throw new AiError("unavailable", { vendorMessage: "stream ended without finish_reason", providerId: ctx.entry.id, midStream: true });
  for (const e of tools.endAll()) yield e;
  if (usage) yield { type: "usage", usage };
  if (tools.count && (!stop || stop === "end_turn")) stop = "tool_use";
  yield {
    type: "done",
    stopReason: stop ?? "end_turn",
    model: respModel ?? model,
    providerState: makeState(ctx, "openai-chat", model, reasoningKey ? ({ reasoningKey, reasoning } satisfies OpenAiChatState) : undefined),
  };
}

// ---------------------------------------------------------------- models / embeddings

export function parseModelList(json: unknown): ModelInfo[] {
  const arr = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : Array.isArray((json as { models?: unknown })?.models) ? (json as { models: unknown[] }).models : [];
  return arr
    .map((raw): ModelInfo | null => {
      const m = raw as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null;
      if (!id) return null;
      const caps = (m.capabilities ?? {}) as Record<string, unknown>;
      const type = String(m.type ?? caps.type ?? "");
      const info: ModelInfo = { id };
      if (typeof m.name === "string" && m.name !== id) info.label = m.name;
      else if (typeof m.display_name === "string") info.label = m.display_name;
      const ctxLen = num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_length) ?? num(m.max_model_len) ?? num((m.top_provider as Record<string, unknown>)?.context_length) ?? num(caps.contextWindow) ?? num(caps.context_window);
      if (ctxLen) info.contextWindow = ctxLen;
      const top = (m.top_provider ?? {}) as Record<string, unknown>;
      const maxOut = num(m.max_output_tokens) ?? num(m.max_completion_tokens) ?? num(top.max_completion_tokens) ?? num(caps.maxOutput) ?? num(caps.max_output_tokens);
      if (maxOut) info.maxOutputTokens = maxOut;
      // Kind: explicit type (Together "chat"/"embedding"/"audio", LM Studio "llm"/"vlm"/"embeddings"), then the id.
      if (/embed/i.test(type) || /embed/i.test(id)) info.kind = "embedding";
      else if (/^(transcribe|audio|stt|speech-to-text)$/i.test(type)) info.kind = "asr";
      else if (/^(image|moderation|rerank|tts|audio-tts|language-image)$/i.test(type)) info.kind = "other";
      else if (type === "chat" || type === "llm" || type === "vlm" || type === "language" || caps.completion_chat === true || m.supports_chat === true) info.kind = "chat";
      const dims = num(m.dimensions) ?? num(m.embedding_dimensions) ?? num(caps.dimensions);
      if (dims && info.kind === "embedding") info.dims = dims;
      // Prices → USD per 1M tokens. OpenRouter: strings per token; Together: numbers per 1M tokens.
      const pricing = m.pricing as Record<string, unknown> | undefined;
      if (pricing && typeof pricing === "object") {
        const perToken = (v: unknown) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) * 1e6 : undefined);
        const inP = perToken(pricing.prompt) ?? (typeof pricing.input === "number" && pricing.input >= 0 ? pricing.input : undefined);
        const outP = perToken(pricing.completion) ?? (typeof pricing.output === "number" && pricing.output >= 0 ? pricing.output : undefined);
        if (inP !== undefined) info.inputPrice = Math.round(inP * 10000) / 10000;
        if (outP !== undefined) info.outputPrice = Math.round(outP * 10000) / 10000;
      }
      const hints: NonNullable<ModelInfo["hints"]> = {};
      const b = (v: unknown) => (typeof v === "boolean" ? v : undefined);
      hints.tools = b(caps.function_calling) ?? b(caps.tools) ?? b(caps.tool_calling) ?? b(caps.trained_for_tool_use) ?? b(m.supports_tools) ?? b(m.supports_function_calling);
      hints.vision = b(caps.vision) ?? b(caps.image_input) ?? b(m.supports_image_input) ?? b(m.supports_image_in) ?? b(m.supports_vision) ?? (type === "vlm" ? true : undefined);
      hints.reasoning = b(caps.reasoning) ?? b(caps.thinking) ?? b(m.supports_reasoning);
      hints.jsonSchema = b(caps.structured_outputs) ?? b(caps.json_schema) ?? b(m.supports_response_schema);
      if (Array.isArray(m.supported_parameters)) {
        hints.params = m.supported_parameters.map(String);
        hints.tools ??= hints.params.includes("tools");
        hints.reasoning ??= hints.params.includes("reasoning") || hints.params.includes("include_reasoning") ? true : undefined;
        hints.jsonSchema ??= hints.params.includes("structured_outputs") ? true : undefined;
      }
      const arch = m.architecture as Record<string, unknown> | undefined;
      if (Array.isArray(arch?.input_modalities)) hints.vision ??= (arch.input_modalities as unknown[]).includes("image");
      for (const k of Object.keys(hints) as (keyof typeof hints)[]) if (hints[k] === undefined) delete hints[k];
      if (Object.keys(hints).length) info.hints = hints;
      return info;
    })
    .filter((m): m is ModelInfo => m !== null);
}

export async function listOpenAiModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  const path = ctx.quirks.modelsPath;
  if (path === null) return (ctx.quirks.staticModels ?? []).map((id) => ({ id }));
  const json = await sendJson(ctx, { url: path ?? "/models", signal });
  return parseModelList(json);
}

export async function openAiEmbed(ctx: CodecContext, req: EmbedRequest) {
  const inputs = applyEmbedTemplate(ctx, req.inputs, req.inputType);
  const vectors: number[][] = [];
  let tokens = 0;
  let model = req.model;
  for (const batch of chunk(inputs, batchSize(ctx, 64))) {
    const body: Record<string, unknown> = { model: req.model, input: batch, encoding_format: "float" };
    if (req.dimensions && ctx.quirks.sendDimensions !== false && ctx.config.sendDimensions !== false) body.dimensions = req.dimensions;
    if (ctx.config.embedInputTypeField && typeof ctx.config.embedInputTypeField === "string") body[ctx.config.embedInputTypeField] = req.inputType;
    const json = (await sendJson(ctx, { url: ctx.quirks.embeddingsPath ?? "/embeddings", body, signal: req.signal, timeoutMs: req.timeoutMs })) as Record<string, unknown>;
    const data = (json.data ?? []) as Array<{ embedding: number[] | string; index?: number }>;
    if (!Array.isArray(data) || data.length !== batch.length) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId: ctx.entry.id });
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const d of data) vectors.push(typeof d.embedding === "string" ? decodeBase64Floats(d.embedding) : d.embedding);
    tokens += num((json.usage as Record<string, unknown>)?.prompt_tokens) ?? num((json.usage as Record<string, unknown>)?.total_tokens) ?? 0;
    if (typeof json.model === "string") model = json.model;
  }
  return finishVectors(ctx, vectors, model, tokens || undefined);
}

// ---------------------------------------------------------------- codec

export const openAiChatCodec: Codec = {
  id: "openai-chat",
  listModels: listOpenAiModels,
  async *chatStream(ctx, req) {
    const body = buildChatBody(ctx, req, true);
    const { res, call } = await send(ctx, { url: ctx.quirks.chatPath ?? "/chat/completions", body, signal: req.signal, timeoutMs: req.timeoutMs, headers: { accept: "text/event-stream" } });
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && !ct.includes("stream")) {
      // Server ignored stream:true; replay the whole response as events.
      yield* guardStream(call, replayNonStream(ctx, res, req.model));
      return;
    }
    yield* guardStream(call, parseChatStream(ctx, res, call, req.model));
  },
  embed: openAiEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      if (ctx.quirks.healthPath) {
        const { call } = await send(ctx, { url: joinUrl(serverRoot(ctx.baseUrl), ctx.quirks.healthPath), signal, noAuth: true });
        call.done();
      }
      if (ctx.quirks.modelsPath === null) {
        if (ctx.quirks.probeModel || ctx.config.probeModel) {
          await sendJson(ctx, { url: ctx.quirks.chatPath ?? "/chat/completions", body: { model: String(ctx.config.probeModel || ctx.quirks.probeModel), messages: [{ role: "user", content: "hi" }], max_tokens: 1 }, signal });
          return { detail_zh: "連線成功。" };
        }
        return { detail_zh: "連線設定已儲存（此廠商沒有模型清單，請手動輸入模型名稱）。" };
      }
      return modelsDetail((await listOpenAiModels(ctx, signal)).length);
    });
  },
};

/** Non-streaming JSON body → events (also used when servers ignore stream:true). */
async function* replayNonStream(ctx: CodecContext, res: Response, model: string): AsyncGenerator<ChatEvent> {
  const json = parseJsonLoose(await res.text()) as Record<string, unknown> | undefined;
  if (!json) throw new AiError("unavailable", { vendorMessage: "invalid JSON", providerId: ctx.entry.id, midStream: true });
  if (json.error) throw inStreamError(ctx, json.error);
  const choice = ((json.choices as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
  const msg = (choice?.message ?? {}) as Record<string, unknown>;
  const fields = ctx.quirks.reasoningFields ?? ["reasoning_content", "reasoning"];
  let reasoningKey: string | undefined;
  let reasoning = "";
  for (const f of fields)
    if (typeof msg[f] === "string" && msg[f]) {
      reasoningKey = f;
      reasoning = msg[f] as string;
      yield { type: "reasoning_delta", text: reasoning };
      break;
    }
  if (typeof msg.content === "string" && msg.content) yield { type: "text_delta", text: msg.content };
  const tools = new ToolCalls();
  let tcs = msg.tool_calls as unknown;
  if (tcs && !Array.isArray(tcs)) tcs = [tcs];
  if (Array.isArray(tcs))
    tcs.forEach((tc: Record<string, unknown>, i: number) => {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const args = fn.arguments ?? fn.parameters;
      tools.push(i, { id: tc.id != null ? String(tc.id) : undefined, name: String(fn.name ?? ""), args: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
    });
  for (const e of tools.endAll()) {
    if (e.type === "tool_call_end") {
      yield { type: "tool_call_start", index: e.index, id: e.id, name: e.name };
      yield { type: "tool_call_delta", index: e.index, argsDelta: e.argsJson };
    }
    if (e.type !== "tool_call_start" && e.type !== "tool_call_delta") yield e;
  }
  const u = usageFromOpenAi(json.usage as Record<string, unknown>);
  if (u) yield { type: "usage", usage: u };
  const fr = String(choice?.finish_reason ?? "stop");
  yield {
    type: "done",
    stopReason: tools.count ? "tool_use" : (FINISH[fr] ?? "other"),
    model: typeof json.model === "string" ? json.model : model,
    providerState: makeState(ctx, "openai-chat", model, reasoningKey ? { reasoningKey, reasoning } : undefined),
  };
}
