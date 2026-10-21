/**
 * Cohere v2: `POST /v2/chat` (typed SSE events), `POST /v2/embed` (input_type, output_dimension),
 * `GET /v1/models`.
 */
import { AiError } from "../errors.js";
import { guardStream, modelsDetail, send, sendJson, sseEvents, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, EmbedRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { assistantParts, batchSize, blocksOf, chunk, ensureAudioSupported, ensureToolsSupported, finishBody, finishVectors, imageDataUrl, makeState, num, stateFor, textOf, toolResultText, ToolCalls } from "./shared.js";

export interface CohereState {
  toolPlan?: string;
  thinking?: string;
}

export function toCohereMessages(messages: ChatMessage[]) {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: textOf(m.content) });
    else if (m.role === "assistant") {
      const { text, toolUses } = assistantParts(m);
      const st = stateFor<CohereState>(m, "cohere");
      const msg: Record<string, unknown> = { role: "assistant" };
      const content: Record<string, unknown>[] = [];
      if (st?.thinking) content.push({ type: "thinking", thinking: st.thinking });
      if (text) content.push({ type: "text", text });
      if (content.length) msg.content = content;
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }));
        if (st?.toolPlan) msg.tool_plan = st.toolPlan;
      }
      out.push(msg);
    } else {
      const blocks = m.role === "tool" ? m.content : blocksOf(m.content);
      for (const b of blocks) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b) || (b.is_error ? "error" : "") });
      const rest = blocks.filter((b) => b.type === "text" || b.type === "image");
      if (rest.length) {
        out.push({
          role: "user",
          content: rest.every((b) => b.type === "text")
            ? rest.map((b) => (b.type === "text" ? b.text : "")).join("")
            : rest.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "image_url", image_url: { url: b.type === "image" ? imageDataUrl(b) : "" } })),
        });
      }
    }
  }
  return out;
}

export function buildCohereBody(ctx: CodecContext, req: ChatRequest): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  ensureAudioSupported(ctx, req, "cohere");
  const body: Record<string, unknown> = { model: req.model, messages: toCohereMessages(req.messages), stream: true };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.p = req.topP;
  if (req.stop?.length) body.stop_sequences = req.stop.slice(0, 5);
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
    if (req.toolChoice === "required" || typeof req.toolChoice === "object") body.tool_choice = "REQUIRED";
    else if (req.toolChoice === "none") body.tool_choice = "NONE";
  }
  if (req.responseFormat?.type === "json_schema") body.response_format = { type: "json_object", json_schema: req.responseFormat.schema };
  else if (req.responseFormat?.type === "json_object") body.response_format = { type: "json_object" };
  const r = req.reasoning;
  if (r) {
    if (r.enabled === false || r.effort === "none") body.thinking = { type: "disabled" };
    else body.thinking = { type: "enabled", ...(r.budgetTokens ? { token_budget: r.budgetTokens } : {}) };
  }
  return finishBody(ctx, body, req);
}

const FINISH: Record<string, StopReason> = { COMPLETE: "end_turn", STOP_SEQUENCE: "stop_sequence", MAX_TOKENS: "max_tokens", TOOL_CALL: "tool_use" };

async function* parseCohereStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const tools = new ToolCalls();
  let toolPlan = "";
  let thinking = "";
  let stop: StopReason | undefined;
  let usage: Usage | undefined;
  let finished = false;
  for await (const ev of sseEvents(res, call)) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(d.type ?? ev.event ?? "");
    const delta = (d.delta ?? {}) as Record<string, unknown>;
    const message = (delta.message ?? {}) as Record<string, unknown>;
    if (type === "content-delta") {
      const c = (message.content ?? {}) as Record<string, unknown>;
      if (typeof c.thinking === "string" && c.thinking) {
        thinking += c.thinking;
        yield { type: "reasoning_delta", text: c.thinking };
      }
      if (typeof c.text === "string" && c.text) yield { type: "text_delta", text: c.text };
    } else if (type === "tool-plan-delta") {
      const tp = message.tool_plan;
      if (typeof tp === "string" && tp) {
        toolPlan += tp;
        yield { type: "reasoning_delta", text: tp };
      }
    } else if (type === "tool-call-start" || type === "tool-call-delta") {
      const tc = (message.tool_calls ?? {}) as Record<string, unknown>;
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      for (const e of tools.push(Number(d.index ?? 0), { id: typeof tc.id === "string" ? tc.id : undefined, name: typeof fn.name === "string" ? fn.name : undefined, args: typeof fn.arguments === "string" ? fn.arguments : undefined })) yield e;
    } else if (type === "tool-call-end") {
      for (const e of tools.end(Number(d.index ?? 0))) yield e;
    } else if (type === "message-end") {
      const fr = String(delta.finish_reason ?? "COMPLETE");
      if (fr === "ERROR" || fr === "TIMEOUT") {
        throw new AiError(fr === "TIMEOUT" ? "timeout" : "unavailable", { vendorCode: fr, vendorMessage: typeof delta.error === "string" ? delta.error : undefined, providerId: ctx.entry.id, midStream: true });
      }
      stop = FINISH[fr] ?? "other";
      const u = (delta.usage ?? {}) as Record<string, unknown>;
      const t = (u.tokens ?? u.billed_units ?? {}) as Record<string, unknown>;
      usage = { inputTokens: num(t.input_tokens), outputTokens: num(t.output_tokens), cacheReadTokens: num(u.cached_tokens) };
      finished = true;
      break;
    }
  }
  if (!finished) throw new AiError("unavailable", { vendorMessage: "stream ended before message-end", providerId: ctx.entry.id, midStream: true });
  for (const e of tools.endAll()) yield e;
  if (usage) yield { type: "usage", usage };
  const st: CohereState = {};
  if (toolPlan) st.toolPlan = toolPlan;
  if (thinking) st.thinking = thinking;
  yield { type: "done", stopReason: stop ?? "end_turn", model, providerState: makeState(ctx, "cohere", model, st) };
}

export function mapCohereError(input: { status: number; body: unknown; headers?: Headers | null }): AiError | undefined {
  const msg = String((input.body as Record<string, unknown>)?.message ?? "");
  if (input.status === 498 || input.status === 499) return new AiError("auth_failed", { status: input.status, vendorMessage: msg });
  if (input.status === 422 && /too long|too many tokens|context/i.test(msg)) return new AiError("context_too_long", { status: input.status, vendorMessage: msg });
  return undefined;
}

async function listCohereModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  const json = (await sendJson(ctx, { url: "/v1/models?page_size=1000", signal, mapError: mapCohereError })) as { models?: Array<Record<string, unknown>> };
  return (json.models ?? []).map((m) => {
    const eps = (m.endpoints as string[]) ?? [];
    return {
      id: String(m.name),
      kind: eps.includes("chat") ? "chat" : eps.includes("embed") ? "embedding" : "other",
      contextWindow: num(m.context_length),
      ...(Array.isArray(m.features) ? { hints: { tools: (m.features as string[]).includes("tools"), vision: (m.features as string[]).includes("vision") } } : {}),
    } satisfies ModelInfo;
  });
}

export async function cohereEmbed(ctx: CodecContext, req: EmbedRequest) {
  const vectors: number[][] = [];
  let tokens = 0;
  for (const batch of chunk(req.inputs, Math.min(96, batchSize(ctx, 96)))) {
    const body: Record<string, unknown> = {
      model: req.model,
      texts: batch,
      input_type: req.inputType === "query" ? "search_query" : "search_document",
      embedding_types: ["float"],
      truncate: ctx.config.truncate === false ? "NONE" : "END",
    };
    if (req.dimensions) body.output_dimension = req.dimensions;
    const json = (await sendJson(ctx, { url: "/v2/embed", body, signal: req.signal, timeoutMs: req.timeoutMs, mapError: mapCohereError })) as {
      embeddings?: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };
    vectors.push(...(json.embeddings?.float ?? []));
    tokens += json.meta?.billed_units?.input_tokens ?? 0;
  }
  if (vectors.length !== req.inputs.length) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId: ctx.entry.id });
  return finishVectors(ctx, vectors, req.model, tokens || undefined);
}

export const cohereCodec: Codec = {
  id: "cohere",
  mapError: mapCohereError,
  listModels: listCohereModels,
  async *chatStream(ctx, req) {
    const body = buildCohereBody(ctx, req);
    const { res, call } = await send(ctx, { url: "/v2/chat", body, signal: req.signal, timeoutMs: req.timeoutMs, headers: { accept: "text/event-stream" }, mapError: mapCohereError });
    yield* guardStream(call, parseCohereStream(ctx, res, call, req.model));
  },
  embed: cohereEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      const json = (await sendJson(ctx, { url: "/v1/models?page_size=1", signal, mapError: mapCohereError })) as { models?: unknown[] };
      return modelsDetail(json.models?.length ?? 0);
    });
  },
};
