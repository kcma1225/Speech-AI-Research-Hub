/**
 * Ollama native API: `POST /api/chat` (NDJSON stream), `GET /api/tags`, `POST /api/embed`,
 * `GET /api/version`. Sends `options.num_ctx` (Ollama's 4096 default silently truncates).
 */
import { AiError, classifyHttpError } from "../errors.js";
import { guardStream, modelsDetail, ndjson, send, sendJson, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, EmbedRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { applyEmbedTemplate, assistantParts, batchSize, blocksOf, chunk, ensureToolsSupported, finishBody, finishVectors, genToolId, makeState, num, stateFor, textOf, toolNamesById, toolResultText, wholeToolCall } from "./shared.js";

export interface OllamaState {
  thinking?: string;
}

export function toOllamaMessages(messages: ChatMessage[], providerId: string) {
  const names = toolNamesById(messages);
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.content) });
    } else if (m.role === "assistant") {
      const { text, toolUses } = assistantParts(m);
      const msg: Record<string, unknown> = { role: "assistant", content: text };
      if (toolUses.length) msg.tool_calls = toolUses.map((t) => ({ function: { name: t.name, arguments: t.input ?? {} } }));
      const st = stateFor<OllamaState>(m, "ollama-native");
      if (st?.thinking) msg.thinking = st.thinking;
      out.push(msg);
    } else {
      const blocks = m.role === "tool" ? m.content : blocksOf(m.content);
      for (const b of blocks) if (b.type === "tool_result") out.push({ role: "tool", content: toolResultText(b), tool_name: names.get(b.tool_use_id) ?? "" });
      const text = blocks.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("");
      const images = blocks.filter((b) => b.type === "image").map((b) => {
        if (b.type !== "image" || b.source.kind !== "base64") throw new AiError("unsupported", { vendorMessage: "Ollama needs base64 images", providerId });
        return b.source.data;
      });
      if (text || images.length) out.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
    }
  }
  return out;
}

/** Ollama allocates `num_ctx` tokens (its 4096 default silently truncates): the model profile's manual context window, else 8192. */
export const OLLAMA_DEFAULT_NUM_CTX = 8192;

function options(ctx: CodecContext, extra: Record<string, unknown> = {}, contextLength?: number) {
  const o: Record<string, unknown> = { ...extra };
  o.num_ctx = num(contextLength) ?? num(Number(ctx.config.numCtx)) ?? OLLAMA_DEFAULT_NUM_CTX;
  const user = ctx.config.options;
  if (user && typeof user === "object") Object.assign(o, user);
  return o;
}

export function buildOllamaBody(ctx: CodecContext, req: ChatRequest): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  const opt: Record<string, unknown> = {};
  if (req.maxTokens) opt.num_predict = req.maxTokens;
  if (req.temperature !== undefined) opt.temperature = req.temperature;
  if (req.topP !== undefined) opt.top_p = req.topP;
  if (req.stop?.length) opt.stop = req.stop;
  const body: Record<string, unknown> = { model: req.model, messages: toOllamaMessages(req.messages, ctx.entry.id), stream: true, options: options(ctx, opt, req.contextLength) };
  if (ctx.config.keepAlive) body.keep_alive = ctx.config.keepAlive;
  if (req.tools?.length && req.toolChoice !== "none") {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
  }
  if (req.responseFormat?.type === "json_schema") body.format = req.responseFormat.schema;
  else if (req.responseFormat?.type === "json_object") body.format = "json";
  const r = req.reasoning;
  const cfgThink = ctx.config.think;
  if (r) {
    if (r.enabled === false || r.effort === "none") body.think = false;
    else if (r.effort && ["low", "medium", "high"].includes(r.effort)) body.think = r.effort;
    else body.think = true;
  } else if (cfgThink && cfgThink !== "default") body.think = cfgThink === "true" ? true : cfgThink === "false" ? false : cfgThink;
  return finishBody(ctx, body, req);
}

async function* parseOllamaStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  let thinking = "";
  let toolIndex = 0;
  let stop: StopReason | undefined;
  let usage: Usage | undefined;
  let finished = false;
  for await (const raw of ndjson(res, call)) {
    const d = raw as Record<string, unknown>;
    if (d.error) {
      const msg = String(d.error);
      const status = /not found/i.test(msg) ? 404 : /context|too long/i.test(msg) ? 400 : 500;
      const err = classifyHttpError({ status, body: { error: msg }, providerId: ctx.entry.id });
      err.midStream = true;
      throw err;
    }
    const msg = (d.message ?? {}) as Record<string, unknown>;
    if (typeof msg.thinking === "string" && msg.thinking) {
      thinking += msg.thinking;
      yield { type: "reasoning_delta", text: msg.thinking };
    }
    if (typeof msg.content === "string" && msg.content) yield { type: "text_delta", text: msg.content };
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Record<string, unknown>[]) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        for (const e of wholeToolCall(toolIndex++, typeof tc.id === "string" && tc.id ? tc.id : genToolId(), String(fn.name ?? ""), fn.arguments ?? {})) yield e;
      }
    }
    if (d.done === true) {
      finished = true;
      const reason = String(d.done_reason ?? "stop");
      stop = reason === "length" ? "max_tokens" : reason === "stop" ? "end_turn" : "other";
      usage = { inputTokens: num(d.prompt_eval_count), outputTokens: num(d.eval_count) };
      break;
    }
  }
  if (!finished) throw new AiError("unavailable", { vendorMessage: "stream ended before done", providerId: ctx.entry.id, midStream: true });
  if (usage) yield { type: "usage", usage };
  yield {
    type: "done",
    stopReason: toolIndex > 0 && stop === "end_turn" ? "tool_use" : (stop ?? "end_turn"),
    model,
    providerState: makeState(ctx, "ollama-native", model, thinking ? { thinking } : undefined),
  };
}

/** Profile facts from `POST /api/show`: context length / embedding size from model_info, capabilities list (Ollama ≥ 0.6). */
export function parseOllamaShow(json: unknown): Partial<ModelInfo> {
  const j = (json ?? {}) as { model_info?: Record<string, unknown>; capabilities?: unknown; details?: Record<string, unknown> };
  const info = j.model_info ?? {};
  const arch = typeof info["general.architecture"] === "string" ? (info["general.architecture"] as string) : "";
  const out: Partial<ModelInfo> = {};
  const ctxLen = num(info[`${arch}.context_length`]);
  if (ctxLen) out.contextWindow = ctxLen;
  const caps = Array.isArray(j.capabilities) ? (j.capabilities as unknown[]).map(String) : null;
  if (caps) {
    out.kind = caps.includes("embedding") && !caps.includes("completion") ? "embedding" : "chat";
    out.hints = { vision: caps.includes("vision"), tools: caps.includes("tools"), reasoning: caps.includes("thinking") };
  }
  const dims = num(info[`${arch}.embedding_length`]);
  if (dims && out.kind === "embedding") out.dims = dims;
  return out;
}

async function listOllamaModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  const json = (await sendJson(ctx, { url: "/api/tags", signal })) as { models?: Array<Record<string, unknown>> };
  const base: ModelInfo[] = (json.models ?? []).map((m) => {
    const id = String(m.model ?? m.name);
    const fam = String((m.details as Record<string, unknown>)?.family ?? "");
    return { id, kind: /embed|bert/i.test(`${id} ${fam}`) ? "embedding" : "chat" } satisfies ModelInfo;
  });
  // Details per model (bounded: local servers rarely hold more than a few dozen models).
  const queue = base.slice(0, 60);
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const show = await sendJson(ctx, { url: "/api/show", body: { model: m.id }, signal, timeoutMs: 10_000 });
        const extra = parseOllamaShow(show);
        Object.assign(m, { ...extra, kind: extra.kind ?? m.kind });
      } catch {
        /* keep the tag-only entry */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return base;
}

async function ollamaEmbed(ctx: CodecContext, req: EmbedRequest) {
  const inputs = applyEmbedTemplate(ctx, req.inputs, req.inputType);
  const vectors: number[][] = [];
  let tokens = 0;
  for (const batch of chunk(inputs, batchSize(ctx, 32))) {
    const body: Record<string, unknown> = { model: req.model, input: batch, truncate: ctx.config.truncate !== false };
    if (req.dimensions) body.dimensions = req.dimensions;
    if (ctx.config.keepAlive) body.keep_alive = ctx.config.keepAlive;
    const opt = options(ctx);
    if (Object.keys(opt).length) body.options = opt;
    const json = (await sendJson(ctx, { url: "/api/embed", body, signal: req.signal, timeoutMs: req.timeoutMs })) as { embeddings?: number[][]; prompt_eval_count?: number };
    vectors.push(...(json.embeddings ?? []));
    tokens += json.prompt_eval_count ?? 0;
  }
  if (vectors.length !== inputs.length) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId: ctx.entry.id });
  return finishVectors(ctx, vectors, req.model, tokens || undefined);
}

export const ollamaCodec: Codec = {
  id: "ollama-native",
  listModels: listOllamaModels,
  async *chatStream(ctx, req) {
    const body = buildOllamaBody(ctx, req);
    const { res, call } = await send(ctx, { url: "/api/chat", body, signal: req.signal, timeoutMs: req.timeoutMs });
    yield* guardStream(call, parseOllamaStream(ctx, res, call, req.model));
  },
  embed: ollamaEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      const v = (await sendJson(ctx, { url: "/api/version", signal })) as { version?: string };
      const n = (await listOllamaModels(ctx, signal)).length;
      return { detail_zh: `連線成功（Ollama ${v.version ?? "?"}），已安裝 ${n} 個模型。`, modelCount: n };
    });
  },
};
