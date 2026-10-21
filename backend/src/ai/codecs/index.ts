import type { CodecId } from "../types.js";
import type { Codec } from "./codec.js";
import { anthropicCodec } from "./anthropic-messages.js";
import { bedrockCodec } from "./bedrock-converse.js";
import { cohereCodec } from "./cohere.js";
import { jinaCodec, teiCodec, voyageCodec } from "./embed-only.js";
import { geminiCodec } from "./gemini.js";
import { ollamaCodec } from "./ollama-native.js";
import { openAiChatCodec } from "./openai-chat.js";
import { openAiResponsesCodec } from "./openai-responses.js";

export const CODECS: Record<CodecId, Codec> = {
  "openai-chat": openAiChatCodec,
  "openai-responses": openAiResponsesCodec,
  "anthropic-messages": anthropicCodec,
  gemini: geminiCodec,
  "bedrock-converse": bedrockCodec,
  "ollama-native": ollamaCodec,
  cohere: cohereCodec,
  "voyage-embed": voyageCodec,
  "jina-embed": jinaCodec,
  "tei-embed": teiCodec,
};

export function getCodec(id: CodecId): Codec {
  return CODECS[id];
}

export type { Codec, CodecContext } from "./codec.js";
