/**
 * Model catalog lookup: normalises a vendor model id (gateway prefixes, Bedrock region/vendor prefixes, Ollama
 * tags, Fireworks "v3p1" spelling, dates) and returns the first matching family's default profile fields.
 */
import { ASR_CATALOG, LLM_CATALOG } from "./families.js";
import type { CatalogEntry, ModelCapability, ProfileFields } from "./types.js";

export * from "./types.js";
export { LLM_CATALOG, ASR_CATALOG } from "./families.js";

/** "openrouter/anthropic/claude-sonnet-4.5" → "claude-sonnet-4-5"; "us.anthropic.claude-3-5-haiku-20241022-v1:0" → "claude-3-5-haiku-20241022-v1". */
export function normalizeModelId(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Path-style ids (gateways, "models/…", "accounts/x/models/…", "@cf/meta/…"): the last segment names the model.
  s = s.split("/").filter(Boolean).pop() ?? s;
  // Bedrock / Vertex style "us.anthropic.claude…", "meta.llama3-1…".
  s = s.replace(/^(?:(?:us|eu|apac|au|jp|global|anthropic|meta|amazon|cohere|mistral|ai21|deepseek|qwen|openai|writer|twelvelabs)\.)+/, "");
  // Ollama tags: "llama3.1:8b" → "llama3.1-8b"; ":latest" / ":0" (Bedrock version) dropped.
  s = s.replace(/:(latest|\d+)$/, "").replace(/:/g, "-");
  // Fireworks "llama-v3p1-70b" → "llama-3.1-70b"; "qwen2p5" → "qwen2.5".
  s = s.replace(/(\d)p(\d)/g, "$1.$2").replace(/^llama-v(\d)/, "llama-$1");
  // Anthropic dotted aliases on gateways: "claude-sonnet-4.5" → "claude-sonnet-4-5", "claude-3.5-sonnet" → "claude-3-5-sonnet".
  if (s.startsWith("claude")) s = s.replace(/(\d)\.(\d)/g, "$1-$2");
  // "meta-llama-3.1" → "llama-3.1"
  s = s.replace(/^meta-llama/, "llama");
  return s;
}

/** Models a listing returns that are not chat, embedding or speech-to-text (hidden from pickers by default). */
const NON_TEXT = /^(dall-e|gpt-image|chatgpt-image|imagen|veo|sora|tts|.*-tts(-|$)|text-moderation|omni-moderation|.*moderation|davinci|babbage|computer-use|.*-realtime|.*image-generation|flux|stable-diffusion|sd3|.*-ocr|.*rerank)/;

export function looksNonText(modelId: string): boolean {
  return NON_TEXT.test(normalizeModelId(modelId));
}

const EMBED_HINT = /(embed|^bge|^e5-|^gte-|minilm|^nomic|^mxbai|arctic-embed|^voyage|^jina-(embeddings|clip))/;

export type CatalogMatch = { entry: CatalogEntry | null; fields: ProfileFields };

/**
 * Catalog defaults for a model. `family` is the account family (`asr` accounts only hold speech models).
 * Without a catalog entry the capability is still guessed (embedding-looking names → embedding).
 */
export function catalogLookup(modelId: string, family: "llm" | "asr"): CatalogMatch {
  const id = normalizeModelId(modelId);
  if (family === "asr") {
    const entry = ASR_CATALOG.find((e) => e.match.test(id)) ?? null;
    return { entry, fields: { capability: "asr" } };
  }
  const entry = LLM_CATALOG.find((e) => e.match.test(id)) ?? null;
  if (entry) return { entry, fields: { ...entry.fields } };
  const asr = ASR_CATALOG.find((e) => e.match.test(id));
  if (asr) return { entry: asr, fields: { capability: "asr" } };
  const capability: ModelCapability = EMBED_HINT.test(id) ? "embedding" : "chat";
  return { entry: null, fields: { capability } };
}
