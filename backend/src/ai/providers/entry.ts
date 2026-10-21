/**
 * Shape of a provider registry entry. An entry is data (defaults, auth, admin form,
 * capabilities, param whitelist, quirks) plus a few optional hooks; the wire protocol
 * lives in a codec.
 */
import type { AiError } from "../errors.js";
import type { CodecId } from "../types.js";

export type Bilingual = { zh: string; en: string };

export type FieldType = "text" | "url" | "secret" | "select" | "number" | "boolean" | "json";

export interface FormField {
  key: string;
  label: Bilingual;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  help_zh?: string;
  placeholder?: string;
  /** Render as a textarea (service-account JSON, header maps...). */
  multiline?: boolean;
  options?: Array<{ value: string; label: Bilingual }>;
  /** Show (and validate) only when another field has one of these values. */
  showIf?: { key: string; equals: unknown[] };
}

/**
 * Auth strategies. `secretKey` names the form field that holds the credential.
 * - api_key: header (`authorization` gets the `Bearer ` scheme) — `optional` for local servers.
 * - google_service_account: SA JSON → OAuth2 JWT-bearer → Bearer token (cached ~1 h).
 * - azure: config.authMode `api_key` (header `api-key`) | `entra` (client-credentials).
 * - aws: config.authMode `sigv4` | `bedrock_api_key` (Bearer).
 * - oauth: token supplied by the caller (`ClientOptions.oauthTokenProvider` or secrets.accessToken);
 *   subscription logins (ChatGPT/Claude) plug in here.
 */
export type AuthSpec =
  | { type: "none" }
  | { type: "api_key"; header: string; scheme?: "Bearer"; secretKey?: string; optional?: boolean }
  | { type: "google_service_account"; scope?: string }
  | { type: "azure"; entraScope?: string }
  | { type: "aws"; service?: string }
  | { type: "oauth"; header?: string; scheme?: "Bearer" };

export type AuthType = AuthSpec["type"];

export interface Capabilities {
  chat: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  embeddings: boolean;
  listModels: boolean;
  jsonSchema?: boolean;
}

/** One passthrough request parameter the admin may set per route member. */
export interface ParamSpec {
  /** Body key; dotted keys address nested objects (`options.num_ctx`). */
  key: string;
  type: "number" | "integer" | "string" | "boolean" | "json" | "select";
  label: Bilingual;
  help_zh?: string;
  default?: unknown;
  /** Send `default` even when the caller did not set it. */
  sendDefault?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

export type ReasoningStyle =
  /** `reasoning_effort` top-level (OpenAI chat, Groq, Mistral, Ollama /v1, LM Studio, Cerebras, xAI chat). */
  | "openai_effort"
  /** `thinking:{type}` + `reasoning_effort` (DeepSeek, Zhipu, Moonshot). */
  | "thinking_type"
  /** `enable_thinking` + `thinking_budget` (DashScope). */
  | "dashscope"
  /** `chat_template_kwargs.enable_thinking` (vLLM, SGLang, llama.cpp). */
  | "chat_template_kwargs"
  /** `reasoning:{effort|max_tokens, enabled}` (OpenRouter, Together). */
  | "reasoning_object"
  | "none";

export interface Quirks {
  /** Path appended to the base URL for chat (codec default otherwise). */
  chatPath?: string;
  /** Models listing path, `null` when the vendor has none (use staticModels / manual entry). */
  modelsPath?: string | null;
  /** Health path relative to the server root (base URL minus a trailing `/v1`). */
  healthPath?: string;
  embeddingsPath?: string;
  /** Example model ids offered when the vendor has no listing endpoint. */
  staticModels?: string[];
  /** Always merged into the chat body (e.g. Fireworks `context_length_exceeded_behavior`). */
  fixedBody?: Record<string, unknown>;
  /** Headers always sent. */
  fixedHeaders?: Record<string, string>;
  reasoningStyle?: ReasoningStyle;
  /** Fields read for streamed reasoning, in priority order (openai-chat). */
  reasoningFields?: string[];
  /** Send `stream_options.include_usage` (openai-chat). Default true. */
  streamUsage?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Never sent even if requested (vendor returns 400). */
  stripFields?: string[];
  /** openai-responses: `store:false` (default true) and encrypted-reasoning include. */
  responsesStore?: boolean;
  includeEncryptedReasoning?: boolean;
  /** Embedding batch size. */
  embedBatchSize?: number;
  /** Send `dimensions` on OpenAI-style embeddings. Default true. */
  sendDimensions?: boolean;
  /** Vendor-specific error mapping, tried before the codec's own and the generic one. */
  mapError?: (input: { status: number; body: unknown; headers?: Headers | null }) => AiError | undefined;
  /** Mid-stream finish_reason values that mean failure (Zhipu `network_error`...). */
  finishReasonErrors?: Record<string, import("../errors.js").AiErrorCode>;
  /** Admin-facing warnings (繁中), e.g. Ollama num_ctx. */
  warnings_zh?: string[];
  /** Chat path model probe: model id used for a 1-token probe when there is no listing endpoint. */
  probeModel?: string;
}

export interface ProviderEntry {
  id: string;
  label: Bilingual;
  category: "external" | "local";
  /** Default codec; `codecFor` may pick another one from the account config. */
  codec: CodecId;
  /** Extra codec used for embeddings when different from the chat codec (e.g. Cohere native). */
  embedCodec?: CodecId;
  defaultBaseUrl?: string;
  auth: AuthSpec;
  fields: FormField[];
  capabilities: Capabilities;
  params: ParamSpec[];
  quirks: Quirks;
  docsUrl?: string;
  /** Short admin help (繁中). */
  help_zh?: string;
  // ---- hooks (not serialised to the UI) ----
  resolveBaseUrl?: (config: Record<string, unknown>, secrets: Record<string, string>) => string;
  codecFor?: (config: Record<string, unknown>) => CodecId;
  /** Extra headers computed from the account config (OpenAI org/project, OpenRouter referer...). */
  resolveHeaders?: (config: Record<string, unknown>) => Record<string, string>;
  /** Quirk overrides computed from the account config (generic endpoint toggles). */
  resolveQuirks?: (config: Record<string, unknown>) => Partial<Quirks>;
}

/** JSON-safe view for the admin UI. */
export type PublicProviderEntry = Omit<ProviderEntry, "resolveBaseUrl" | "codecFor" | "resolveHeaders" | "resolveQuirks" | "quirks"> & {
  quirks: Omit<Quirks, "mapError">;
};
