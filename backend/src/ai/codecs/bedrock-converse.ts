/**
 * AWS Bedrock Converse / ConverseStream (binary event-stream), SigV4 or Bedrock API key.
 * Embeddings via InvokeModel (Titan v2, Cohere on Bedrock).
 */
import { AiError, classifyHttpError } from "../errors.js";
import { EventStreamDecoder } from "../providers/eventstream.js";
import { byteChunks, guardStream, modelsDetail, send, sendJson, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, EmbedRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { applyEmbedTemplate, assistantParts, blocksOf, ensureAudioSupported, ensureToolsSupported, finishBody, finishVectors, makeState, num, stateFor, textOf, toolResultImages, toolResultText, ToolCalls } from "./shared.js";

export interface BedrockState {
  /** reasoningContent blocks ({reasoningText:{text,signature}} | {redactedContent}). */
  reasoning: Record<string, unknown>[];
}

function imageBlock(b: { source: { kind: string; mediaType?: string; data?: string } }, providerId: string) {
  if (b.source.kind !== "base64") throw new AiError("unsupported", { vendorMessage: "Bedrock needs inline image bytes", providerId });
  const format = (b.source.mediaType ?? "image/png").split("/")[1]?.replace("jpg", "jpeg") ?? "png";
  return { image: { format, source: { bytes: b.source.data } } };
}

export function toConverseMessages(messages: ChatMessage[], providerId: string) {
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
      const st = stateFor<BedrockState>(m, "bedrock-converse");
      const { text, toolUses } = assistantParts(m);
      const content: Record<string, unknown>[] = (st?.reasoning ?? []).map((r) => ({ reasoningContent: r }));
      if (text) content.push({ text });
      for (const t of toolUses) content.push({ toolUse: { toolUseId: t.id, name: t.name, input: t.input ?? {} } });
      push("assistant", content);
      continue;
    }
    const blocks = m.role === "tool" ? m.content : blocksOf(m.content);
    const content: Record<string, unknown>[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const txt = toolResultText(b);
        content.push({
          toolResult: {
            toolUseId: b.tool_use_id,
            content: [...(txt ? [{ text: txt }] : []), ...toolResultImages(b).map((i) => imageBlock(i, providerId))],
            status: b.is_error ? "error" : "success",
          },
        });
      } else if (b.type === "text" && b.text) content.push({ text: b.text });
      else if (b.type === "image") content.push(imageBlock(b, providerId));
    }
    push("user", content);
  }
  return out;
}

export function buildConverseBody(ctx: CodecContext, req: ChatRequest): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  ensureAudioSupported(ctx, req, "bedrock-converse");
  if (req.responseFormat?.type === "json_schema") throw new AiError("unsupported", { vendorMessage: "structured output via Converse is not wired", providerId: ctx.entry.id });
  const body: Record<string, unknown> = { messages: toConverseMessages(req.messages, ctx.entry.id) };
  const system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean);
  if (system.length) body.system = system.map((text) => ({ text }));
  const inf: Record<string, unknown> = {};
  if (req.maxTokens) inf.maxTokens = req.maxTokens;
  if (req.temperature !== undefined) inf.temperature = req.temperature;
  if (req.topP !== undefined) inf.topP = req.topP;
  if (req.stop?.length) inf.stopSequences = req.stop;
  if (Object.keys(inf).length) body.inferenceConfig = inf;
  const hasToolHistory = req.messages.some((m) => m.role === "assistant" && assistantParts(m).toolUses.length);
  if (req.tools?.length && req.toolChoice !== "none") {
    const tc = req.toolChoice;
    body.toolConfig = {
      tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } } })),
      ...(tc === "required" ? { toolChoice: { any: {} } } : typeof tc === "object" ? { toolChoice: { tool: { name: tc.name } } } : tc === "auto" ? { toolChoice: { auto: {} } } : {}),
    };
  } else if (req.tools?.length && hasToolHistory) {
    // Converse requires toolConfig when history has toolUse blocks.
    body.toolConfig = { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } } })) };
  }
  const r = req.reasoning;
  if (r && /anthropic\./.test(req.model)) {
    const amrf: Record<string, unknown> = {};
    if (r.enabled === false || r.effort === "none") amrf.thinking = { type: "disabled" };
    else if (r.budgetTokens) amrf.thinking = { type: "enabled", budget_tokens: Math.max(1024, r.budgetTokens) };
    else if (r.effort) {
      amrf.thinking = { type: "adaptive" };
      amrf.output_config = { effort: r.effort === "minimal" ? "low" : r.effort };
    }
    if (Object.keys(amrf).length) body.additionalModelRequestFields = amrf;
  } else if (r?.effort) {
    body.additionalModelRequestFields = { reasoning_effort: r.effort };
  }
  return finishBody(ctx, body, req);
}

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  guardrail_intervened: "content_filter",
  content_filtered: "content_filter",
  model_context_window_exceeded: "context_window",
};

const EXC: Record<string, { code: ConstructorParameters<typeof AiError>[0]; status: number }> = {
  ThrottlingException: { code: "rate_limited", status: 429 },
  ModelNotReadyException: { code: "overloaded", status: 429 },
  ServiceUnavailableException: { code: "overloaded", status: 503 },
  InternalServerException: { code: "unavailable", status: 500 },
  ModelStreamErrorException: { code: "unavailable", status: 424 },
  ModelErrorException: { code: "unavailable", status: 424 },
  ModelTimeoutException: { code: "timeout", status: 408 },
  AccessDeniedException: { code: "auth_failed", status: 403 },
  UnrecognizedClientException: { code: "auth_failed", status: 403 },
  InvalidSignatureException: { code: "auth_failed", status: 403 },
  ExpiredTokenException: { code: "auth_failed", status: 403 },
  ResourceNotFoundException: { code: "model_not_found", status: 404 },
  ServiceQuotaExceededException: { code: "quota_exhausted", status: 400 },
};

export function mapBedrockError(input: { status: number; body: unknown; headers?: Headers | null }, excType?: string): AiError | undefined {
  const raw = (excType ?? input.headers?.get("x-amzn-errortype") ?? String((input.body as Record<string, unknown>)?.__type ?? "")).split(":")[0]!.split("#").pop()!;
  // In-stream exception names are lowerCamel (throttlingException); HTTP ones UpperCamel.
  const type = raw.charAt(0).toUpperCase() + raw.slice(1);
  const b = input.body as Record<string, unknown> | undefined;
  const message = String(b?.message ?? b?.Message ?? "");
  if (type === "ValidationException") {
    if (/too long|too many tokens|context window|input length/i.test(message)) return new AiError("context_too_long", { status: input.status, vendorCode: type, vendorMessage: message });
    if (/model identifier is invalid|model.*not found|on-demand throughput/i.test(message)) return new AiError("model_not_found", { status: input.status, vendorCode: type, vendorMessage: message });
    return new AiError("bad_request", { status: input.status, vendorCode: type, vendorMessage: message });
  }
  const hit = EXC[type];
  if (hit) return new AiError(hit.code, { status: input.status || hit.status, vendorCode: type, vendorMessage: message });
  if (/Credential should be scoped to a valid region/i.test(message)) return new AiError("auth_failed", { status: input.status, vendorMessage: message });
  return undefined;
}

async function* parseConverseStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const dec = new EventStreamDecoder();
  const tools = new ToolCalls();
  const reasoning = new Map<number, Record<string, unknown>>();
  const textDec = new TextDecoder();
  let usage: Usage | undefined;
  let stop: StopReason | undefined;
  let finished = false;
  for await (const bytes of byteChunks(res, call)) {
    for (const msg of dec.push(bytes)) {
      const mtype = String(msg.headers[":message-type"] ?? "event");
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(textDec.decode(msg.payload) || "{}") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      if (mtype === "exception" || mtype === "error") {
        const exc = String(msg.headers[":exception-type"] ?? msg.headers[":error-code"] ?? "InternalServerException");
        const err = mapBedrockError({ status: 0, body: payload }, exc) ?? classifyHttpError({ status: 500, body: payload, providerId: ctx.entry.id });
        err.midStream = true;
        throw err;
      }
      const ev = String(msg.headers[":event-type"] ?? "");
      if (ev === "contentBlockStart") {
        const idx = Number(payload.contentBlockIndex);
        const tu = (payload.start as Record<string, unknown>)?.toolUse as Record<string, unknown> | undefined;
        if (tu) for (const e of tools.push(idx, { id: String(tu.toolUseId ?? ""), name: String(tu.name ?? "") })) yield e;
      } else if (ev === "contentBlockDelta") {
        const idx = Number(payload.contentBlockIndex);
        const delta = (payload.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
        else if (delta.toolUse) for (const e of tools.push(idx, { args: String((delta.toolUse as Record<string, unknown>).input ?? "") })) yield e;
        else if (delta.reasoningContent) {
          const rc = delta.reasoningContent as Record<string, unknown>;
          let cur = reasoning.get(idx);
          if (!cur) reasoning.set(idx, (cur = {}));
          if (typeof rc.text === "string") {
            const rt = ((cur.reasoningText as Record<string, unknown>) ??= { text: "" }) as Record<string, unknown>;
            rt.text = String(rt.text ?? "") + rc.text;
            yield { type: "reasoning_delta", text: rc.text };
          }
          if (typeof rc.signature === "string") {
            const rt = ((cur.reasoningText as Record<string, unknown>) ??= { text: "" }) as Record<string, unknown>;
            rt.signature = rc.signature;
          }
          if (rc.redactedContent) cur.redactedContent = rc.redactedContent;
        }
      } else if (ev === "contentBlockStop") {
        for (const e of tools.end(Number(payload.contentBlockIndex))) yield e;
      } else if (ev === "messageStop") {
        stop = STOP[String(payload.stopReason)] ?? "other";
      } else if (ev === "metadata") {
        const u = (payload.usage ?? {}) as Record<string, unknown>;
        usage = { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cacheReadTokens: num(u.cacheReadInputTokens), cacheWriteTokens: num(u.cacheWriteInputTokens) };
        finished = true;
      }
    }
  }
  if (!stop && !finished) throw new AiError("unavailable", { vendorMessage: "stream ended before messageStop", providerId: ctx.entry.id, midStream: true });
  for (const e of tools.endAll()) yield e;
  if (usage) yield { type: "usage", usage };
  const rs = [...reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  yield { type: "done", stopReason: stop ?? "end_turn", model, providerState: makeState(ctx, "bedrock-converse", model, rs.length ? { reasoning: rs } : undefined) };
}

const region = (ctx: CodecContext) => String(ctx.config.region ?? "us-east-1");
const controlPlane = (ctx: CodecContext) => `https://bedrock.${region(ctx)}.amazonaws.com`;

async function listBedrockModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  const fm = (await sendJson(ctx, { url: `${controlPlane(ctx)}/foundation-models`, signal, mapError: (i) => mapBedrockError(i) })) as {
    modelSummaries?: Array<Record<string, unknown>>;
  };
  const out: ModelInfo[] = [];
  for (const m of fm.modelSummaries ?? []) {
    const outMods = (m.outputModalities as string[]) ?? [];
    out.push({ id: String(m.modelId), label: typeof m.modelName === "string" ? m.modelName : undefined, kind: outMods.includes("EMBEDDING") ? "embedding" : outMods.includes("TEXT") ? "chat" : "other" });
  }
  try {
    const ip = (await sendJson(ctx, { url: `${controlPlane(ctx)}/inference-profiles?maxResults=1000`, signal, mapError: (i) => mapBedrockError(i) })) as {
      inferenceProfileSummaries?: Array<Record<string, unknown>>;
    };
    for (const p of ip.inferenceProfileSummaries ?? []) out.push({ id: String(p.inferenceProfileId), label: typeof p.inferenceProfileName === "string" ? p.inferenceProfileName : undefined, kind: "chat" });
  } catch {
    /* profiles are optional */
  }
  return out;
}

async function bedrockEmbed(ctx: CodecContext, req: EmbedRequest) {
  const inputs = applyEmbedTemplate(ctx, req.inputs, req.inputType);
  const url = (id: string) => `/model/${encodeURIComponent(id)}/invoke`;
  const vectors: number[][] = [];
  let tokens = 0;
  if (/cohere\./.test(req.model)) {
    for (let i = 0; i < inputs.length; i += 96) {
      const json = (await sendJson(ctx, {
        url: url(req.model),
        body: { texts: inputs.slice(i, i + 96), input_type: req.inputType === "query" ? "search_query" : "search_document", embedding_types: ["float"], ...(req.dimensions ? { output_dimension: req.dimensions } : {}) },
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        mapError: (x) => mapBedrockError(x),
      })) as { embeddings?: number[][] | { float?: number[][] } };
      const e = json.embeddings;
      vectors.push(...((Array.isArray(e) ? e : e?.float) ?? []));
    }
  } else {
    for (const text of inputs) {
      const json = (await sendJson(ctx, {
        url: url(req.model),
        body: { inputText: text, ...(req.dimensions ? { dimensions: req.dimensions } : {}), normalize: true },
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        mapError: (x) => mapBedrockError(x),
      })) as { embedding?: number[]; inputTextTokenCount?: number };
      vectors.push(json.embedding ?? []);
      tokens += json.inputTextTokenCount ?? 0;
    }
  }
  return finishVectors(ctx, vectors, req.model, tokens || undefined);
}

export const bedrockCodec: Codec = {
  id: "bedrock-converse",
  mapError: (i) => mapBedrockError(i),
  listModels: listBedrockModels,
  async *chatStream(ctx, req) {
    const body = buildConverseBody(ctx, req);
    const { res, call } = await send(ctx, {
      url: `/model/${encodeURIComponent(req.model)}/converse-stream`,
      body,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      headers: { accept: "application/vnd.amazon.eventstream" },
      mapError: (i) => mapBedrockError(i),
    });
    yield* guardStream(call, parseConverseStream(ctx, res, call, req.model));
  },
  embed: bedrockEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      try {
        return modelsDetail((await listBedrockModels(ctx, signal)).length);
      } catch (e) {
        // Bedrock API keys may not cover the control plane: fall back to a 1-token Converse.
        const model = String(ctx.config.probeModel || "");
        if (!(e instanceof AiError) || e.code !== "auth_failed" || ctx.config.authMode !== "bedrock_api_key" || !model) throw e;
        await sendJson(ctx, {
          url: `/model/${encodeURIComponent(model)}/converse`,
          body: { messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 1 } },
          signal,
          mapError: (i) => mapBedrockError(i),
        });
        return { detail_zh: "連線成功（API 金鑰無法列出模型，已用測試模型確認）。" };
      }
    });
  },
};
