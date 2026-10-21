/**
 * OpenAI Responses API (OpenAI, Azure v1, xAI, Perplexity Agent API, Groq): `POST {base}/responses`
 * with typed SSE events. Stateless: `store:false` and encrypted reasoning items are replayed
 * through providerState.
 */
import { AiError, classifyHttpError } from "../errors.js";
import { guardStream, modelsDetail, send, sseEvents, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { listOpenAiModels, openAiEmbed } from "./openai-chat.js";
import { assistantParts, blocksOf, ensureToolsSupported, finishBody, imageDataUrl, makeState, num, stateFor, textOf, toolResultImages, toolResultText, ToolCalls } from "./shared.js";

export interface ResponsesState {
  /** Raw reasoning output items (with encrypted_content), replayed verbatim before the turn. */
  reasoningItems: unknown[];
}

export function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: unknown[] } {
  const input: unknown[] = [];
  const sys: string[] = [];
  let seenNonSystem = false;
  for (const m of messages) {
    if (m.role === "system") {
      if (!seenNonSystem) sys.push(textOf(m.content));
      else input.push({ role: "developer", content: textOf(m.content) });
      continue;
    }
    seenNonSystem = true;
    if (m.role === "tool") {
      for (const b of m.content) input.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolResultText(b) || (b.is_error ? "error" : "") });
      // function_call_output is text only: tool images (page renders) follow as one user message.
      const imgs = m.content.flatMap((b) => toolResultImages(b));
      if (imgs.length) input.push({ role: "user", content: [{ type: "input_text", text: "(Images returned by the tool call above.)" }, ...imgs.map((i) => ({ type: "input_image", image_url: imageDataUrl(i) }))] });
    } else if (m.role === "user") {
      const blocks = blocksOf(m.content);
      for (const b of blocks) if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolResultText(b) || (b.is_error ? "error" : "") });
      const parts = blocks
        .map((b) => (b.type === "text" ? { type: "input_text", text: b.text } : b.type === "image" ? { type: "input_image", image_url: imageDataUrl(b) } : null))
        .filter(Boolean);
      if (parts.length) input.push({ role: "user", content: parts });
    } else {
      const st = stateFor<ResponsesState>(m, "openai-responses");
      if (st?.reasoningItems?.length) input.push(...st.reasoningItems);
      const { text, toolUses } = assistantParts(m);
      if (text) input.push({ role: "assistant", content: text });
      for (const t of toolUses) input.push({ type: "function_call", call_id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) });
    }
  }
  return { instructions: sys.filter(Boolean).join("\n\n") || undefined, input };
}

export function buildResponsesBody(ctx: CodecContext, req: ChatRequest): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  const { instructions, input } = toResponsesInput(req.messages);
  const body: Record<string, unknown> = { model: req.model, input, stream: true };
  if (instructions) body.instructions = instructions;
  if (ctx.quirks.responsesStore !== true) {
    body.store = false;
    if (ctx.quirks.includeEncryptedReasoning !== false) body.include = ["reasoning.encrypted_content"];
  }
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.inputSchema, strict: t.strict ?? false }));
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", name: req.toolChoice.name };
    if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
  }
  if (req.responseFormat?.type === "json_schema") {
    body.text = { format: { type: "json_schema", name: req.responseFormat.name, schema: req.responseFormat.schema, strict: req.responseFormat.strict ?? true } };
  } else if (req.responseFormat?.type === "json_object") body.text = { format: { type: "json_object" } };
  if (req.reasoning) {
    const r = req.reasoning;
    const effort = r.enabled === false ? "none" : r.effort;
    if (effort) body.reasoning = { effort, summary: "auto" };
  }
  return finishBody(ctx, body, req);
}

function usageOf(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num((u.output_tokens_details as Record<string, unknown>)?.reasoning_tokens),
    cacheReadTokens: num((u.input_tokens_details as Record<string, unknown>)?.cached_tokens),
  };
}

function eventError(ctx: CodecContext, e: Record<string, unknown> | undefined, statusGuess = 500): AiError {
  const code = String(e?.code ?? e?.type ?? "");
  const message = String(e?.message ?? "");
  const status =
    /rate_limit/.test(code) ? 429 : /server_is_overloaded|overloaded/.test(code) ? 503 : /context_length|invalid_prompt|invalid_request/.test(code) ? 400 : /insufficient_quota/.test(code) ? 429 : statusGuess;
  const err = ctx.quirks.mapError?.({ status, body: { error: { code, message } } }) ?? classifyHttpError({ status, body: { error: { code, message } }, providerId: ctx.entry.id });
  err.midStream = true;
  return err;
}

async function* parseResponsesStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const tools = new ToolCalls();
  const reasoningItems: unknown[] = [];
  let usage: Usage | undefined;
  let stop: StopReason | undefined;
  let respModel: string | undefined;
  let finished = false;
  let refused = false;

  for await (const ev of sseEvents(res, call)) {
    if (ev.data.trim() === "[DONE]") break;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(d.type ?? ev.event ?? "");
    switch (type) {
      case "response.output_text.delta":
        if (typeof d.delta === "string" && d.delta) yield { type: "text_delta", text: d.delta };
        break;
      case "response.refusal.delta":
        refused = true;
        if (typeof d.delta === "string" && d.delta) yield { type: "text_delta", text: d.delta };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof d.delta === "string" && d.delta) yield { type: "reasoning_delta", text: d.delta };
        break;
      case "response.output_item.added": {
        const item = (d.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          const key = String(item.id ?? d.output_index);
          for (const e of tools.push(key, { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), args: typeof item.arguments === "string" ? item.arguments : undefined })) yield e;
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = String(d.item_id ?? d.output_index);
        for (const e of tools.push(key, { args: String(d.delta ?? "") })) yield e;
        break;
      }
      case "response.function_call_arguments.done":
        if (typeof d.arguments === "string") tools.setArgs(String(d.item_id ?? d.output_index), d.arguments);
        break;
      case "response.output_item.done": {
        const item = (d.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          const key = String(item.id ?? d.output_index);
          if (typeof item.arguments === "string") tools.setArgs(key, item.arguments);
          for (const e of tools.end(key)) yield e;
        } else if (item.type === "reasoning") {
          reasoningItems.push(item);
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const r = (d.response ?? {}) as Record<string, unknown>;
        usage = usageOf(r.usage as Record<string, unknown>);
        if (typeof r.model === "string") respModel = r.model;
        const reason = String((r.incomplete_details as Record<string, unknown>)?.reason ?? "");
        stop = type === "response.incomplete" ? (reason === "content_filter" ? "content_filter" : reason === "max_output_tokens" ? "max_tokens" : "other") : undefined;
        // Collect reasoning items from the final response if output_item.done was not streamed.
        if (!reasoningItems.length && Array.isArray(r.output)) for (const it of r.output as Record<string, unknown>[]) if (it.type === "reasoning") reasoningItems.push(it);
        finished = true;
        break;
      }
      case "response.failed": {
        const r = (d.response ?? {}) as Record<string, unknown>;
        throw eventError(ctx, r.error as Record<string, unknown>);
      }
      case "error":
        throw eventError(ctx, (d.error as Record<string, unknown>) ?? d);
      default:
        break;
    }
    if (finished) break;
  }
  if (!finished) throw new AiError("unavailable", { vendorMessage: "stream ended before response.completed", providerId: ctx.entry.id, midStream: true });
  for (const e of tools.endAll()) yield e;
  if (usage) yield { type: "usage", usage };
  yield {
    type: "done",
    stopReason: stop ?? (refused ? "content_filter" : tools.count ? "tool_use" : "end_turn"),
    model: respModel ?? model,
    providerState: makeState(ctx, "openai-responses", model, reasoningItems.length ? ({ reasoningItems } satisfies ResponsesState) : undefined),
  };
}

export const openAiResponsesCodec: Codec = {
  id: "openai-responses",
  listModels: listOpenAiModels,
  async *chatStream(ctx, req) {
    const body = buildResponsesBody(ctx, req);
    const { res, call } = await send(ctx, { url: ctx.quirks.chatPath ?? "/responses", body, signal: req.signal, timeoutMs: req.timeoutMs, headers: { accept: "text/event-stream" } });
    yield* guardStream(call, parseResponsesStream(ctx, res, call, req.model));
  },
  embed: openAiEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      if (ctx.quirks.modelsPath === null) return { detail_zh: "連線設定已儲存（此廠商沒有模型清單，請手動輸入模型名稱）。" };
      return modelsDetail((await listOpenAiModels(ctx, signal)).length);
    });
  },
};
