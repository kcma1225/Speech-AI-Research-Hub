/**
 * Unified AI model: messages, tools, chat requests/stream events, embeddings, probes.
 * Vendor-neutral; every codec translates to and from these shapes.
 */
import type { AiError } from "./errors.js";

// ---------------------------------------------------------------- content

export interface TextBlock {
  type: "text";
  text: string;
}

export type ImageSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; url: string; mediaType?: string };

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

/**
 * Audio input (speech transcription by multimodal chat models). Inline base64 only; `mediaType` is the audio MIME
 * type (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`…). Only the openai-chat (`input_audio`) and gemini
 * (`inlineData`) codecs send it; every other codec rejects it with `unsupported` (see codecs/shared.ts).
 */
export interface AudioBlock {
  type: "audio";
  source: { kind: "base64"; mediaType: string; data: string };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | AudioBlock | ToolUseBlock | ToolResultBlock;

/** Codec ids (one per wire protocol). */
export type CodecId =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini"
  | "bedrock-converse"
  | "ollama-native"
  | "cohere"
  | "voyage-embed"
  | "jina-embed"
  | "tei-embed";

/**
 * Opaque vendor state attached to an assistant turn (thinking blocks + signatures,
 * `reasoning_content`, encrypted reasoning items, Gemini thought signatures...).
 * Store it with the message and send it back unchanged; a codec only replays state
 * whose `codec` matches its own and silently drops anything else.
 */
export interface ProviderState {
  codec: CodecId;
  providerId?: string;
  model?: string;
  data: unknown;
}

export interface SystemMessage {
  role: "system";
  content: string | TextBlock[];
}
export interface UserMessage {
  role: "user";
  content: string | Array<TextBlock | ImageBlock | AudioBlock | ToolResultBlock>;
}
export interface AssistantMessage {
  role: "assistant";
  content: string | Array<TextBlock | ToolUseBlock>;
  /** Reasoning text shown to users (informational; replay uses providerState). */
  reasoning?: string;
  providerState?: ProviderState;
}
/** Tool results; equivalent to a user message made of tool_result blocks. */
export interface ToolMessage {
  role: "tool";
  content: ToolResultBlock[];
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------- tools

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the input object. */
  inputSchema: JsonSchema;
  strict?: boolean;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

// ---------------------------------------------------------------- chat request

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReasoningOptions {
  /** Preferred knob; translated per vendor (clamped where the vendor has fewer levels). */
  effort?: ReasoningEffort;
  /** Token budget for vendors that take one (Anthropic ≤4.5, Gemini 2.5, DashScope, Cohere, Bedrock-Claude). */
  budgetTokens?: number;
  /** false = ask the vendor to turn thinking off (not every model allows it). */
  enabled?: boolean;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: JsonSchema; strict?: boolean };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  maxTokens?: number;
  /**
   * Context to allocate on servers that size it per request (Ollama `num_ctx`). The platform sets it from the
   * model profile's manual context window; hosted APIs ignore it.
   */
  contextLength?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  reasoning?: ReasoningOptions;
  responseFormat?: ResponseFormat;
  /**
   * Vendor passthrough. Only keys listed in the provider entry's `params` whitelist are sent
   * (dotted keys address nested fields, e.g. `options.num_ctx`); others are dropped.
   */
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Request timeout; for streams it is the time to first byte and the max idle gap. Default 120 s. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------- stream events

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "content_filter"
  | "context_window"
  | "other";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argsDelta: string }
  /** `input` is the parsed arguments; `null` with `invalidJson: true` when the model sent broken JSON. */
  | { type: "tool_call_end"; index: number; id: string; name: string; input: unknown; argsJson: string; invalidJson?: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason; providerState?: ProviderState; model?: string }
  /** Error after the stream started (HTTP 200). Always the last event. */
  | { type: "error"; error: AiError };

export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: ToolUseBlock[];
  stopReason: StopReason;
  usage: Usage;
  providerState?: ProviderState;
  model?: string;
  /** Ready to append to the conversation history (includes providerState). */
  message: AssistantMessage;
}

// ---------------------------------------------------------------- embeddings

export interface EmbedRequest {
  model: string;
  inputs: string[];
  inputType: "query" | "document";
  dimensions?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dims: number;
  usage: { inputTokens?: number };
}

// ---------------------------------------------------------------- models / probe

export interface ModelInfo {
  id: string;
  label?: string;
  kind?: "chat" | "embedding" | "asr" | "other";
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Default vector size (embedding models). */
  dims?: number;
  /** USD per 1M tokens, when the listing publishes prices (OpenRouter, Together…). */
  inputPrice?: number;
  outputPrice?: number;
  /** Capability hints when the vendor publishes them. */
  hints?: { tools?: boolean; vision?: boolean; audioInput?: boolean; reasoning?: boolean; jsonSchema?: boolean; params?: string[] };
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /** 繁中 one-line summary for the admin UI. */
  detail_zh: string;
  modelCount?: number;
  error?: AiError;
}
