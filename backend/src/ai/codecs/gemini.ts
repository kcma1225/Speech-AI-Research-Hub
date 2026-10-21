/**
 * Google Gemini generateContent (AI Studio with API key; Vertex AI with service account).
 * Model parts (incl. thoughtSignature) round-trip verbatim via providerState.
 */
import { AiError, classifyHttpError } from "../errors.js";
import { guardStream, modelsDetail, send, sendJson, sseEvents, timedProbe, type Call } from "../providers/http.js";
import type { ChatEvent, ChatMessage, ChatRequest, EmbedRequest, ModelInfo, StopReason, Usage } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import {
  applyEmbedTemplate,
  assistantParts,
  batchSize,
  blocksOf,
  chunk,
  ensureToolsSupported,
  finishBody,
  finishVectors,
  genToolId,
  makeState,
  num,
  stateFor,
  textOf,
  toolNamesById,
  toolResultText,
  wholeToolCall,
} from "./shared.js";

export interface GeminiState {
  /** The model turn's parts exactly as received (text/thought/functionCall + thoughtSignature). */
  parts: Record<string, unknown>[];
}

const isVertex = (ctx: CodecContext) => ctx.entry.auth.type === "google_service_account";
const modelPath = (ctx: CodecContext, model: string) => `${isVertex(ctx) ? "/publishers/google" : ""}/models/${encodeURIComponent(model.replace(/^models\//, ""))}`;

function guessMime(url: string) {
  const ext = /\.(\w+)(?:\?|$)/.exec(url)?.[1]?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

export function toGeminiContents(messages: ChatMessage[]): Array<{ role: "user" | "model"; parts: Record<string, unknown>[] }> {
  const names = toolNamesById(messages);
  const out: Array<{ role: "user" | "model"; parts: Record<string, unknown>[] }> = [];
  const push = (role: "user" | "model", parts: Record<string, unknown>[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const st = stateFor<GeminiState>(m, "gemini");
      if (st?.parts?.length) {
        push("model", st.parts);
        continue;
      }
      const { text, toolUses } = assistantParts(m);
      const parts: Record<string, unknown>[] = [];
      if (text) parts.push({ text });
      for (const t of toolUses) parts.push({ functionCall: { name: t.name, args: t.input ?? {}, ...(t.id.startsWith("gem_") ? {} : { id: t.id }) } });
      push("model", parts);
      continue;
    }
    const blocks = m.role === "tool" ? m.content : blocksOf(m.content);
    const parts: Record<string, unknown>[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const name = names.get(b.tool_use_id) ?? "tool";
        const text = toolResultText(b);
        parts.push({
          functionResponse: {
            name,
            ...(b.tool_use_id.startsWith("gem_") ? {} : { id: b.tool_use_id }),
            response: b.is_error ? { error: text } : { result: text },
          },
        });
      } else if (b.type === "text" && b.text) parts.push({ text: b.text });
      else if (b.type === "image") {
        parts.push(
          b.source.kind === "base64"
            ? { inlineData: { mimeType: b.source.mediaType, data: b.source.data } }
            : { fileData: { fileUri: b.source.url, mimeType: b.source.mediaType ?? guessMime(b.source.url) } },
        );
      }
    }
    push("user", parts);
  }
  return out;
}

const LEVEL: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function buildGeminiBody(ctx: CodecContext, req: ChatRequest): Record<string, unknown> {
  ensureToolsSupported(ctx, req);
  const body: Record<string, unknown> = { contents: toGeminiContents(req.messages) };
  const system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.topP !== undefined) gen.topP = req.topP;
  if (req.stop?.length) gen.stopSequences = req.stop;
  if (req.responseFormat?.type === "json_schema") {
    gen.responseMimeType = "application/json";
    gen.responseJsonSchema = req.responseFormat.schema;
  } else if (req.responseFormat?.type === "json_object") gen.responseMimeType = "application/json";
  const r = req.reasoning;
  if (r) {
    const tc: Record<string, unknown> = { includeThoughts: r.enabled !== false && r.effort !== "none" };
    if (r.enabled === false || r.effort === "none") tc.thinkingBudget = 0;
    else if (r.budgetTokens) tc.thinkingBudget = r.budgetTokens;
    else if (r.effort) tc.thinkingLevel = LEVEL[r.effort] ?? "high";
    gen.thinkingConfig = tc;
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.inputSchema })) }];
    const tc = req.toolChoice;
    if (tc) {
      body.toolConfig = {
        functionCallingConfig:
          tc === "auto" ? { mode: "AUTO" } : tc === "none" ? { mode: "NONE" } : tc === "required" ? { mode: "ANY" } : { mode: "ANY", allowedFunctionNames: [tc.name] },
      };
    }
  }
  return finishBody(ctx, body, req);
}

const FINISH: Record<string, StopReason> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  BLOCKLIST: "content_filter",
  IMAGE_SAFETY: "content_filter",
  LANGUAGE: "other",
  OTHER: "other",
};

export function mapGeminiError(input: { status: number; body: unknown; headers?: Headers | null }): AiError | undefined {
  const e = (input.body as { error?: { status?: string; message?: string } })?.error;
  if (!e) return undefined;
  const msg = e.message ?? "";
  if (e.status === "NOT_FOUND" || (input.status === 404 && /model/i.test(msg))) return new AiError("model_not_found", { status: input.status, vendorCode: e.status, vendorMessage: msg });
  if (e.status === "INVALID_ARGUMENT" && /token|too long|exceeds the maximum/i.test(msg)) return new AiError("context_too_long", { status: input.status, vendorCode: e.status, vendorMessage: msg });
  if (e.status === "FAILED_PRECONDITION" && /billing/i.test(msg)) return new AiError("quota_exhausted", { status: input.status, vendorCode: e.status, vendorMessage: msg });
  if (/API key.*(invalid|expired|leaked)|API_KEY_INVALID/i.test(msg)) return new AiError("auth_failed", { status: input.status, vendorCode: e.status, vendorMessage: msg });
  return undefined;
}

async function* parseGeminiStream(ctx: CodecContext, res: Response, call: Call, model: string): AsyncGenerator<ChatEvent> {
  const parts: Record<string, unknown>[] = [];
  let usage: Usage | undefined;
  let stop: StopReason | undefined;
  let toolIndex = 0;
  let respModel: string | undefined;
  let any = false;
  for await (const ev of sseEvents(res, call)) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    any = true;
    if (d.error) {
      const status = num((d.error as Record<string, unknown>).code) ?? 500;
      const err = mapGeminiError({ status, body: d }) ?? classifyHttpError({ status, body: d, providerId: ctx.entry.id });
      err.midStream = true;
      throw err;
    }
    if (typeof d.modelVersion === "string") respModel = d.modelVersion;
    const pf = d.promptFeedback as Record<string, unknown> | undefined;
    if (pf?.blockReason) throw new AiError("content_filtered", { vendorCode: String(pf.blockReason), providerId: ctx.entry.id, midStream: true });
    const um = d.usageMetadata as Record<string, unknown> | undefined;
    if (um) {
      usage = {
        inputTokens: num(um.promptTokenCount),
        outputTokens: (num(um.candidatesTokenCount) ?? 0) + (num(um.thoughtsTokenCount) ?? 0) || undefined,
        reasoningTokens: num(um.thoughtsTokenCount),
        cacheReadTokens: num(um.cachedContentTokenCount),
      };
    }
    const cand = ((d.candidates as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
    if (!cand) continue;
    const cparts = (((cand.content as Record<string, unknown>)?.parts as Record<string, unknown>[]) ?? []) as Record<string, unknown>[];
    for (const p of cparts) {
      if (p.functionCall) {
        const fc = p.functionCall as Record<string, unknown>;
        const id = typeof fc.id === "string" && fc.id ? fc.id : genToolId("gem");
        parts.push({ ...p });
        for (const e of wholeToolCall(toolIndex++, id, String(fc.name ?? ""), fc.args ?? {})) yield e;
        continue;
      }
      if (typeof p.text === "string") {
        const thought = p.thought === true;
        if (p.text) yield thought ? { type: "reasoning_delta", text: p.text } : { type: "text_delta", text: p.text };
        const last = parts[parts.length - 1];
        if (last && typeof last.text === "string" && (last.thought === true) === thought && !last.functionCall && !(last.thoughtSignature && p.thoughtSignature)) {
          last.text += p.text;
          if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
        } else parts.push({ ...p });
        continue;
      }
      if (p.thoughtSignature) {
        const last = parts[parts.length - 1];
        if (last && !last.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
        else parts.push({ ...p });
      }
    }
    if (typeof cand.finishReason === "string") {
      if (cand.finishReason === "MALFORMED_FUNCTION_CALL") throw new AiError("bad_request", { vendorCode: cand.finishReason, providerId: ctx.entry.id, midStream: true });
      stop = FINISH[cand.finishReason] ?? "other";
    }
  }
  if (!any) throw new AiError("unavailable", { vendorMessage: "empty stream", providerId: ctx.entry.id, midStream: true });
  if (usage) yield { type: "usage", usage };
  yield {
    type: "done",
    stopReason: toolIndex > 0 && (!stop || stop === "end_turn") ? "tool_use" : (stop ?? "end_turn"),
    model: respModel ?? model,
    providerState: makeState(ctx, "gemini", model, parts.length ? { parts } : undefined),
  };
}

async function listGeminiModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]> {
  if (isVertex(ctx)) return (ctx.quirks.staticModels ?? []).map((id) => ({ id }));
  const out: ModelInfo[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: "1000" });
    if (token) q.set("pageToken", token);
    const json = (await sendJson(ctx, { url: `/models?${q}`, signal, mapError: mapGeminiError })) as { models?: Record<string, unknown>[]; nextPageToken?: string };
    for (const m of json.models ?? []) {
      const methods = (m.supportedGenerationMethods as string[]) ?? [];
      out.push({
        id: String(m.name ?? "").replace(/^models\//, ""),
        label: typeof m.displayName === "string" ? m.displayName : undefined,
        kind: methods.includes("generateContent") ? "chat" : methods.some((x) => /embed/i.test(x)) ? "embedding" : "other",
        contextWindow: num(m.inputTokenLimit),
        maxOutputTokens: num(m.outputTokenLimit),
        ...(m.thinking === true ? { hints: { reasoning: true } } : {}),
      });
    }
    if (!json.nextPageToken) break;
    token = json.nextPageToken;
  }
  return out;
}

async function geminiEmbed(ctx: CodecContext, req: EmbedRequest) {
  const inputs = applyEmbedTemplate(ctx, req.inputs, req.inputType);
  const model = req.model.replace(/^models\//, "");
  const taskType = /^gemini-embedding-2/.test(model) ? undefined : req.inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const vectors: number[][] = [];
  let tokens = 0;
  for (const batch of chunk(inputs, batchSize(ctx, isVertex(ctx) ? 5 : 100))) {
    if (isVertex(ctx)) {
      const json = (await sendJson(ctx, {
        url: `${modelPath(ctx, model)}:predict`,
        body: { instances: batch.map((content) => ({ content, ...(taskType ? { task_type: taskType } : {}) })), parameters: req.dimensions ? { outputDimensionality: req.dimensions } : {} },
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        mapError: mapGeminiError,
      })) as { predictions?: Array<{ embeddings?: { values?: number[]; statistics?: { token_count?: number } } }> };
      for (const p of json.predictions ?? []) {
        vectors.push(p.embeddings?.values ?? []);
        tokens += p.embeddings?.statistics?.token_count ?? 0;
      }
    } else {
      const json = (await sendJson(ctx, {
        url: `${modelPath(ctx, model)}:batchEmbedContents`,
        body: {
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            ...(taskType ? { taskType } : {}),
            ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
          })),
        },
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        mapError: mapGeminiError,
      })) as { embeddings?: Array<{ values?: number[] }> };
      for (const e of json.embeddings ?? []) vectors.push(e.values ?? []);
    }
  }
  if (vectors.length !== inputs.length) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId: ctx.entry.id });
  return finishVectors(ctx, vectors, model, tokens || undefined);
}

export const geminiCodec: Codec = {
  id: "gemini",
  mapError: mapGeminiError,
  listModels: listGeminiModels,
  async *chatStream(ctx, req) {
    const body = buildGeminiBody(ctx, req);
    const { res, call } = await send(ctx, {
      url: `${modelPath(ctx, req.model)}:streamGenerateContent?alt=sse`,
      body,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      headers: { accept: "text/event-stream" },
      mapError: mapGeminiError,
    });
    yield* guardStream(call, parseGeminiStream(ctx, res, call, req.model));
  },
  embed: geminiEmbed,
  probe(ctx, signal) {
    return timedProbe(async () => {
      if (isVertex(ctx)) {
        const model = String(ctx.config.probeModel || ctx.quirks.probeModel || "");
        if (!model) {
          await ctx.auth.apply({ method: "GET", url: new URL(ctx.baseUrl), headers: new Headers(), body: "" }, signal);
          return { detail_zh: "服務帳戶驗證成功（未設定測試模型，未檢查專案權限）。" };
        }
        await sendJson(ctx, { url: `${modelPath(ctx, model)}:countTokens`, body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] }, signal, mapError: mapGeminiError });
        return { detail_zh: "連線成功，專案與模型可用。" };
      }
      const json = (await sendJson(ctx, { url: "/models?pageSize=50", signal, mapError: mapGeminiError })) as { models?: unknown[] };
      return modelsDetail(json.models?.length ?? 0);
    });
  },
};
