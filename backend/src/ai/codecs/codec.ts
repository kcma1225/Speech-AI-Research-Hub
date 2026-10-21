import type { ChatEvent, ChatRequest, CodecId, EmbedRequest, EmbedResult, ModelInfo, ProbeResult } from "../types.js";
import type { AiError } from "../errors.js";
import type { ProviderEntry, Quirks } from "../providers/entry.js";
import type { AuthProvider } from "../providers/auth.js";

export interface CodecContext {
  entry: ProviderEntry;
  /** Account config with form defaults applied (non-secret). */
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Resolved base URL without trailing slash. */
  baseUrl: string;
  auth: AuthProvider;
  fetch: typeof fetch;
  quirks: Quirks;
  /** Default request timeout (ms). */
  timeoutMs: number;
}

export interface Codec {
  id: CodecId;
  listModels(ctx: CodecContext, signal?: AbortSignal): Promise<ModelInfo[]>;
  chatStream?(ctx: CodecContext, req: ChatRequest): AsyncGenerator<ChatEvent>;
  embed?(ctx: CodecContext, req: EmbedRequest): Promise<EmbedResult>;
  probe(ctx: CodecContext, signal?: AbortSignal): Promise<ProbeResult>;
  /** Vendor error table; return undefined to fall back to the generic classifier. */
  mapError?(input: { status: number; body: unknown; headers?: Headers | null }): AiError | undefined;
}
