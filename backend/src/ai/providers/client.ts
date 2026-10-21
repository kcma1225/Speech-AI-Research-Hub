/** createClient(): binds a registry entry + account config + plaintext secrets to its codec(s). */
import { AiError, fromThrown } from "../errors.js";
import { getCodec } from "../codecs/index.js";
import type { CodecContext } from "../codecs/codec.js";
import type { ChatEvent, ChatRequest, ChatResult, CodecId, EmbedRequest, EmbedResult, ModelInfo, ProbeResult, ToolUseBlock, Usage } from "../types.js";
import { createAuth } from "./auth.js";
import type { Capabilities, ProviderEntry, Quirks } from "./entry.js";
import { DEFAULT_TIMEOUT_MS } from "./http.js";
import { applyDefaults, getProvider } from "./registry.js";

export interface ClientOptions {
  /** Injected fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** OAuth extension point (subscription logins): returns a valid access token. */
  oauthTokenProvider?: () => Promise<string>;
  now?: () => number;
}

export interface AiClient {
  readonly entry: ProviderEntry;
  readonly codecId: CodecId;
  /** Entry capabilities adjusted by account config (e.g. local `supportsTools`). */
  readonly capabilities: Capabilities;
  readonly warnings_zh: string[];
  listModels(opts?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  /**
   * Streams a chat turn. Failures before the first event (HTTP errors, bad config, unsupported
   * features) are thrown as AiError; failures after the stream started arrive as a final
   * `{type:"error"}` event (error.midStream = true).
   */
  chatStream(req: ChatRequest): AsyncGenerator<ChatEvent>;
  /** Convenience: chatStream + aggregateChat. Throws AiError on any failure. */
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
  /** Cheap health/credential check; never throws. */
  probe(opts?: { signal?: AbortSignal }): Promise<ProbeResult>;
}

export function createClient(
  entryOrId: ProviderEntry | string,
  accountConfig: Record<string, unknown>,
  secrets: Record<string, string>,
  options: ClientOptions = {},
): AiClient {
  const entry = typeof entryOrId === "string" ? getProvider(entryOrId) : entryOrId;
  if (!entry) throw new AiError("unsupported", { vendorMessage: `unknown provider ${String(entryOrId)}` });
  const config = applyDefaults(entry, accountConfig ?? {});
  const quirks: Quirks = { ...entry.quirks, ...entry.resolveQuirks?.(config) };
  const headers = entry.resolveHeaders?.(config);
  if (headers && Object.keys(headers).length) quirks.fixedHeaders = { ...quirks.fixedHeaders, ...headers };

  const codecId = entry.codecFor?.(config) ?? entry.codec;
  const chatCodec = getCodec(codecId);
  const embedCodec = getCodec(entry.embedCodec ?? codecId);
  const capabilities: Capabilities = { ...entry.capabilities };
  if (typeof config.supportsTools === "boolean") capabilities.tools = capabilities.chat && config.supportsTools;
  if (!chatCodec.chatStream) capabilities.chat = capabilities.tools = false;
  if (!embedCodec.embed) capabilities.embeddings = false;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  let ctx: CodecContext | undefined;
  let ctxError: AiError | undefined;
  try {
    const base = entry.resolveBaseUrl?.(config, secrets ?? {}) ?? (config.baseUrl as string | undefined) ?? entry.defaultBaseUrl;
    if (!base) throw new AiError("bad_request", { vendorMessage: "missing base URL", providerId: entry.id });
    ctx = {
      entry,
      config,
      secrets: secrets ?? {},
      baseUrl: String(base).replace(/\/+$/, ""),
      auth: createAuth(entry, config, secrets ?? {}, { fetch: fetchImpl, oauthTokenProvider: options.oauthTokenProvider, now: options.now }),
      fetch: fetchImpl,
      quirks,
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
    };
  } catch (e) {
    ctxError = fromThrown(e, { providerId: entry.id });
  }
  const getCtx = () => {
    if (!ctx) throw ctxError!;
    return ctx;
  };
  const tag = (e: unknown) => {
    const err = fromThrown(e, { providerId: entry.id });
    err.providerId ??= entry.id;
    return err;
  };

  const client: AiClient = {
    entry,
    codecId,
    capabilities,
    warnings_zh: quirks.warnings_zh ?? [],
    async listModels(opts) {
      try {
        return await chatCodec.listModels(getCtx(), opts?.signal);
      } catch (e) {
        throw tag(e);
      }
    },
    async *chatStream(req) {
      if (!capabilities.chat || !chatCodec.chatStream) throw new AiError("unsupported", { vendorMessage: "chat not supported", providerId: entry.id });
      if (req.tools?.length && !capabilities.tools) throw new AiError("unsupported", { vendorMessage: "tools not supported", providerId: entry.id });
      let gen: AsyncGenerator<ChatEvent>;
      let first: IteratorResult<ChatEvent>;
      try {
        gen = chatCodec.chatStream(getCtx(), req);
        first = await gen.next();
      } catch (e) {
        throw tag(e);
      }
      let r = first;
      while (!r.done) {
        const ev = r.value;
        if (ev.type === "error") ev.error.providerId ??= entry.id;
        yield ev;
        if (ev.type === "error") {
          await gen.return(undefined);
          return;
        }
        r = await gen.next();
      }
    },
    chat(req) {
      return aggregateChat(client.chatStream(req));
    },
    async embed(req) {
      if (!capabilities.embeddings || !embedCodec.embed) throw new AiError("unsupported", { vendorMessage: "embeddings not supported", providerId: entry.id });
      if (!req.inputs.length) return { vectors: [], model: req.model, dims: 0, usage: {} };
      try {
        return await embedCodec.embed(getCtx(), req);
      } catch (e) {
        throw tag(e);
      }
    },
    async probe(opts) {
      if (!ctx) return { ok: false, latencyMs: 0, detail_zh: ctxError!.message_zh, error: ctxError };
      const r = await chatCodec.probe(ctx, opts?.signal);
      if (r.error) r.error.providerId ??= entry.id;
      return r;
    },
  };
  return client;
}

/** Collects a chat stream into a ChatResult; throws the AiError of an `error` event. */
export async function aggregateChat(stream: AsyncIterable<ChatEvent>): Promise<ChatResult> {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolUseBlock[] = [];
  const usage: Usage = {};
  let done: Extract<ChatEvent, { type: "done" }> | undefined;
  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_delta":
        reasoning += ev.text;
        break;
      case "tool_call_end":
        toolCalls.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.invalidJson ? {} : ev.input });
        break;
      case "usage":
        for (const [k, v] of Object.entries(ev.usage)) if (v !== undefined) (usage as Record<string, number>)[k] = v;
        break;
      case "done":
        done = ev;
        break;
      case "error":
        throw ev.error;
      default:
        break;
    }
  }
  if (!done) throw new AiError("unavailable", { vendorMessage: "stream ended without done", midStream: true });
  const content: ChatResult["message"]["content"] = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls];
  return {
    text,
    reasoning,
    toolCalls,
    stopReason: done.stopReason,
    usage,
    providerState: done.providerState,
    model: done.model,
    message: {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(done.providerState ? { providerState: done.providerState } : {}),
    },
  };
}
