/**
 * Built-in model catalog: sensible defaults for well-known model families, matched on the normalised model id
 * (see index.ts). Values are the vendors' published limits at the time of writing and only fill fields the
 * provider's own listing does not report; admins can override any field per model. First match wins, so more
 * specific patterns come first. Prices are deliberately not included (they change often; listings that report
 * them, e.g. OpenRouter/Together, fill them in).
 */
import type { CatalogEntry, ModelCapability } from "./types.js";

type Flags = { vision?: boolean; audio?: boolean; tools?: boolean; reasoning?: boolean; json?: boolean };

const chat = (id: string, match: RegExp, context_window: number | undefined, max_output_tokens: number | undefined, f: Flags = {}): CatalogEntry => ({
  id,
  match,
  fields: {
    capability: "chat",
    ...(context_window ? { context_window } : {}),
    ...(max_output_tokens ? { max_output_tokens } : {}),
    vision: f.vision ?? false,
    audio_input: f.audio ?? false,
    tools: f.tools ?? true,
    reasoning: f.reasoning ?? false,
    ...(f.json !== undefined ? { json_schema: f.json } : {}),
  },
});
const embed = (id: string, match: RegExp, embedding_dims: number, context_window?: number): CatalogEntry => ({
  id,
  match,
  fields: { capability: "embedding", embedding_dims, ...(context_window ? { context_window } : {}), vision: false, tools: false, reasoning: false },
});
const asr = (id: string, match: RegExp): CatalogEntry => ({ id, match, fields: { capability: "asr" as ModelCapability } });

const V = { vision: true } as const;
const VR = { vision: true, reasoning: true } as const;
const VRJ = { vision: true, reasoning: true, json: true } as const;
const VJ = { vision: true, json: true } as const;
const R = { reasoning: true } as const;
/** Gemini-style: images + audio (+ reasoning, structured output). */
const VARJ = { vision: true, audio: true, reasoning: true, json: true } as const;
const VAJ = { vision: true, audio: true, json: true } as const;

// ---------------------------------------------------------------- embeddings (before chat: ids like "qwen3-embedding")

export const EMBEDDING: CatalogEntry[] = [
  embed("openai.text-embedding-3-large", /^text-embedding-3-large/, 3072, 8191),
  embed("openai.text-embedding-3-small", /^text-embedding-3-small/, 1536, 8191),
  embed("openai.text-embedding-ada-002", /^text-embedding-ada-002/, 1536, 8191),
  embed("google.gemini-embedding", /^gemini-embedding/, 3072, 2048),
  embed("google.text-embedding-004", /^(text-embedding-00[45]|text-multilingual-embedding-002)/, 768, 2048),
  embed("cohere.embed-v4", /^embed-v4/, 1536, 128000),
  embed("cohere.embed-v3-light", /^embed-(english|multilingual)-light-v3/, 384, 512),
  embed("cohere.embed-v3", /^embed-(english|multilingual)-v3/, 1024, 512),
  embed("voyage.voyage-3-lite", /^voyage-3-lite/, 512, 32000),
  embed("voyage", /^voyage-/, 1024, 32000),
  embed("jina.jina-embeddings-v4", /^jina-embeddings-v4/, 2048, 32768),
  embed("jina.jina-embeddings-v3", /^jina-embeddings-v3/, 1024, 8192),
  embed("jina.jina-clip-v2", /^jina-clip-v2/, 1024, 8192),
  embed("mistral.mistral-embed", /^mistral-embed/, 1024, 8192),
  embed("mistral.codestral-embed", /^codestral-embed/, 1536, 8192),
  embed("qwen.qwen3-embedding-8b", /^qwen3-embedding-8b/, 4096, 32768),
  embed("qwen.qwen3-embedding-4b", /^qwen3-embedding-4b/, 2560, 32768),
  embed("qwen.qwen3-embedding-0.6b", /^qwen3-embedding(-0\.6b)?$|^qwen3-embedding-0\.6b/, 1024, 32768),
  embed("qwen.text-embedding-v4", /^text-embedding-v4/, 1024, 8192),
  embed("qwen.text-embedding-v3", /^text-embedding-v3/, 1024, 8192),
  embed("zhipu.embedding-3", /^embedding-3/, 2048, 8192),
  embed("zhipu.embedding-2", /^embedding-2/, 1024, 512),
  embed("baai.bge-m3", /^bge-m3/, 1024, 8192),
  embed("baai.bge-large", /^bge-large/, 1024, 512),
  embed("baai.bge-base", /^bge-base/, 768, 512),
  embed("baai.bge-small", /^bge-small/, 384, 512),
  embed("nomic.nomic-embed-text", /^nomic-embed-text/, 768, 8192),
  embed("mixedbread.mxbai-embed-large", /^mxbai-embed-large/, 1024, 512),
  embed("snowflake.arctic-embed2", /^snowflake-arctic-embed2/, 1024, 8192),
  embed("snowflake.arctic-embed", /^snowflake-arctic-embed/, 1024, 512),
  embed("sbert.all-minilm", /^(all-)?minilm/, 384, 256),
  embed("e5.multilingual-e5-large", /^(multilingual-)?e5-large/, 1024, 512),
  embed("e5.e5-mistral-7b", /^e5-mistral-7b/, 4096, 32768),
  embed("alibaba.gte-qwen2-7b", /^gte-qwen2-7b/, 3584, 32768),
  embed("ibm.granite-embedding-278m", /^granite-embedding.*278m/, 768, 512),
  embed("ibm.granite-embedding", /^granite-embedding/, 384, 512),
  embed("amazon.titan-embed-text-v2", /^titan-embed-text-v2/, 1024, 8192),
  embed("amazon.titan-embed", /^titan-embed/, 1536, 8192),
];

// ---------------------------------------------------------------- speech

export const ASR: CatalogEntry[] = [
  asr("openai.transcribe", /^(gpt-[\w.-]*transcribe|whisper)/),
  asr("deepgram.nova", /^nova-/),
  asr("assemblyai.universal", /^(universal|best|nano|slam)/),
  asr("google.chirp", /^(chirp|long$|latest_long|telephony)/),
  asr("elevenlabs.scribe", /^scribe/),
  asr("mistral.voxtral", /^voxtral/),
  asr("whisper.local", /(faster-)?whisper|distil-whisper|sensevoice|paraformer|funasr|breeze-asr/),
];

// ---------------------------------------------------------------- chat

export const OPENAI: CatalogEntry[] = [
  chat("openai.gpt-5-chat", /^gpt-5(\.\d+)?-chat/, 128000, 16384, VJ),
  chat("openai.gpt-5-codex", /^gpt-5(\.\d+)?-codex/, 400000, 128000, VRJ),
  chat("openai.gpt-5-pro", /^gpt-5(\.\d+)?-pro/, 400000, 272000, VRJ),
  chat("openai.gpt-5", /^gpt-5/, 400000, 128000, VRJ),
  chat("openai.gpt-4.1", /^gpt-4\.1/, 1047576, 32768, VJ),
  chat("openai.gpt-4o-audio", /^gpt-4o(-mini)?-audio/, 128000, 16384, { audio: true }),
  chat("openai.gpt-audio", /^gpt-audio/, 128000, 16384, { audio: true }),
  chat("openai.gpt-4o-realtime", /^gpt-4o(-mini)?-(realtime|search)/, 128000, 16384, { tools: false }),
  chat("openai.gpt-4o", /^(gpt-4o|chatgpt-4o)/, 128000, 16384, VJ),
  chat("openai.gpt-4-turbo", /^gpt-4-turbo/, 128000, 4096, V),
  chat("openai.gpt-4", /^gpt-4(-\d|$)/, 8192, 8192),
  chat("openai.gpt-3.5-turbo", /^gpt-3\.5-turbo/, 16385, 4096),
  chat("openai.o3-mini", /^o3-mini/, 200000, 100000, { reasoning: true, json: true }),
  chat("openai.o1-mini", /^o1-mini/, 128000, 65536, { reasoning: true, tools: false }),
  chat("openai.o-series", /^o[134](-|$)/, 200000, 100000, VRJ),
  chat("openai.codex-mini", /^codex-mini/, 200000, 100000, VR),
  chat("openai.gpt-oss", /^gpt-oss/, 131072, 32768, R),
];

export const ANTHROPIC: CatalogEntry[] = [
  chat("anthropic.claude-opus-4.5+", /^claude-opus-4-[5-9]|^claude-opus-[5-9]/, 200000, 64000, VRJ),
  chat("anthropic.claude-opus-4", /^claude-opus-4|^claude-4-opus/, 200000, 32000, VR),
  chat("anthropic.claude-sonnet-4", /^claude-sonnet-[4-9]|^claude-4-sonnet/, 200000, 64000, VRJ),
  chat("anthropic.claude-haiku-4", /^claude-haiku-[4-9]/, 200000, 64000, VRJ),
  chat("anthropic.claude-3.7-sonnet", /^claude-3-7-sonnet/, 200000, 64000, VR),
  chat("anthropic.claude-3.5-sonnet", /^claude-3-5-sonnet/, 200000, 8192, V),
  chat("anthropic.claude-3.5-haiku", /^claude-3-5-haiku/, 200000, 8192, V),
  chat("anthropic.claude-3", /^claude-3/, 200000, 4096, V),
  // Claude Code CLI aliases.
  chat("anthropic.cli-alias", /^(opus|sonnet|haiku)$/, 200000, 32000, { vision: true, reasoning: true, tools: false }),
  chat("anthropic.claude", /^claude/, 200000, 8192, V),
];

export const GOOGLE: CatalogEntry[] = [
  chat("google.gemini-tts", /^gemini-.*-tts/, 32768, 16384, { tools: false }),
  chat("google.gemini-3", /^gemini-3/, 1048576, 65536, VARJ),
  chat("google.gemini-2.5", /^gemini-2\.5/, 1048576, 65536, VARJ),
  chat("google.gemini-2.0", /^gemini-2\.0/, 1048576, 8192, VAJ),
  chat("google.gemini-1.5-pro", /^gemini-1\.5-pro/, 2097152, 8192, VAJ),
  chat("google.gemini-1.5", /^gemini-1\.5/, 1048576, 8192, VAJ),
  chat("google.gemini", /^gemini/, 1048576, 8192, { vision: true, audio: true }),
  chat("google.gemma-3n", /^gemma-?3n/, 32768, 8192, { vision: true, tools: false }),
  chat("google.gemma-3-1b", /^gemma-?3[:-]1b/, 32768, 8192, { tools: false }),
  chat("google.gemma-3", /^gemma-?3/, 131072, 8192, { vision: true, tools: false }),
  chat("google.gemma", /^gemma/, 8192, 8192, { tools: false }),
];

export const CHINA: CatalogEntry[] = [
  // DeepSeek
  chat("deepseek.reasoner", /^deepseek-reasoner/, 128000, 64000, { reasoning: true, json: true }),
  chat("deepseek.chat", /^deepseek-chat/, 128000, 8192, { json: true }),
  chat("deepseek.r1", /^deepseek-r1/, 131072, 32768, { reasoning: true, tools: false }),
  chat("deepseek.v3", /^deepseek-v3/, 131072, 32768, R),
  chat("deepseek.coder", /^deepseek-coder/, 131072, 8192),
  chat("deepseek", /^deepseek/, 131072, 8192),
  // Qwen (Alibaba)
  chat("qwen.qwen3-vl", /^qwen3-vl/, 262144, 32768, VR),
  chat("qwen.qwen2.5-vl", /^qwen2\.5-vl|^qwen-vl/, 131072, 8192, V),
  chat("qwen.qvq", /^qvq/, 131072, 16384, { vision: true, reasoning: true, tools: false }),
  chat("qwen.qwen3-max", /^qwen3?-max/, 262144, 65536, R),
  chat("qwen.qwen3-coder", /^qwen3-coder/, 262144, 65536),
  chat("qwen.qwen3-omni", /^qwen3-omni/, 65536, 16384, { vision: true, audio: true }),
  chat("qwen.qwen2.5-omni", /^qwen2\.5-omni|^qwen-omni/, 32768, 8192, { vision: true, audio: true, tools: false }),
  chat("qwen.qwen-audio", /^qwen2?-audio/, 32768, 8192, { audio: true, tools: false }),
  chat("qwen.qwen3-next", /^qwen3-next/, 262144, 32768, R),
  chat("qwen.qwen-plus", /^qwen-plus/, 1000000, 32768, R),
  chat("qwen.qwen-flash", /^qwen-(flash|turbo)/, 1000000, 32768, R),
  chat("qwen.qwq", /^qwq/, 131072, 32768, R),
  chat("qwen.qwen3", /^qwen3/, 131072, 32768, R),
  chat("qwen.qwen2.5", /^qwen2\.5/, 131072, 8192),
  chat("qwen", /^qwen/, 32768, 8192),
  // Zhipu GLM
  chat("zhipu.glm-v", /^glm-\d(\.\d+)?v/, 131072, 32768, VR),
  chat("zhipu.glm-5", /^glm-5/, 200000, 128000, R),
  chat("zhipu.glm-4.6+", /^glm-4\.[6-9]/, 200000, 128000, R),
  chat("zhipu.glm-4.5", /^glm-4\.5/, 131072, 98304, R),
  chat("zhipu.glm-4-long", /^glm-4-long/, 1000000, 4096),
  chat("zhipu.glm-4", /^glm-4/, 131072, 4096),
  chat("zhipu.glm-z1", /^glm-z1/, 131072, 32768, R),
  chat("zhipu.glm", /^(chat)?glm/, 131072, 8192),
  // Moonshot Kimi
  chat("moonshot.kimi-k2.5", /^kimi-k2\.5/, 262144, 32768, VR),
  chat("moonshot.kimi-k2-thinking", /^kimi-k2-thinking/, 262144, 32768, R),
  chat("moonshot.kimi-k2", /^kimi-k2/, 262144, 16384),
  chat("moonshot.kimi-vl", /^kimi-.*vl|^moonshot-v1-.*vision/, 131072, 8192, V),
  chat("moonshot.kimi-latest", /^kimi-latest/, 131072, 8192, V),
  chat("moonshot.moonshot-v1-128k", /^moonshot-v1-128k/, 131072, 4096),
  chat("moonshot.moonshot-v1-32k", /^moonshot-v1-32k/, 32768, 4096),
  chat("moonshot.moonshot-v1-8k", /^moonshot-v1-8k/, 8192, 4096),
  chat("moonshot.kimi", /^kimi/, 131072, 8192),
  // MiniMax, ERNIE, Doubao, Yi, Step
  chat("minimax.m2", /^minimax-m2/, 204800, 131072, R),
  chat("minimax.m1", /^minimax-m1/, 1000000, 80000, R),
  chat("minimax", /^(minimax|abab)/, 245760, 8192),
  chat("baidu.ernie-4.5-vl", /^ernie-4\.5.*vl/, 131072, 16384, V),
  chat("baidu.ernie", /^ernie/, 131072, 12288),
  chat("bytedance.doubao-seed", /^doubao-seed/, 262144, 32768, VR),
  chat("bytedance.doubao", /^doubao/, 131072, 16384),
  chat("01ai.yi", /^yi-/, 32768, 4096),
  chat("stepfun.step", /^step-/, 65536, 8192),
];

export const OPEN: CatalogEntry[] = [
  // Meta Llama (also Fireworks "llama-v3p1-…", Ollama "llama3.1:8b")
  chat("meta.llama-4", /^llama-?4/, 1048576, 16384, V),
  chat("meta.llama-3.2-vision", /^llama-?3\.2-?\d+b-vision|^llama-?3\.2-vision|^llama3\.2-vision/, 131072, 8192, V),
  chat("meta.llama-3.x", /^(meta-)?llama-?3\.[123]/, 131072, 8192),
  chat("meta.llama-3", /^(meta-)?llama-?3/, 8192, 8192, { tools: false }),
  chat("meta.llama-guard", /^llama-guard/, 131072, 1024, { tools: false }),
  chat("meta.llama", /^(meta-)?llama/, 4096, 4096, { tools: false }),
  // Mistral
  chat("mistral.voxtral", /^voxtral-(?!.*transcribe)/, 32768, 8192, { audio: true }),
  chat("mistral.magistral", /^magistral/, 131072, 40000, VR),
  chat("mistral.pixtral", /^pixtral/, 131072, 8192, V),
  chat("mistral.codestral", /^codestral/, 256000, 8192),
  chat("mistral.devstral", /^devstral/, 131072, 8192),
  chat("mistral.mistral-medium-3", /^mistral-medium(-3|-latest|-2508)/, 131072, 8192, VJ),
  chat("mistral.mistral-small-3.1+", /^mistral-small(-3\.[1-9]|-latest|-25)/, 131072, 8192, VJ),
  chat("mistral.mistral-large-3", /^mistral-large-3|^mistral-large-25(1[0-2]|[2-9])/, 262144, 8192, VJ),
  chat("mistral.mistral-large", /^mistral-large/, 131072, 8192, { json: true }),
  chat("mistral.ministral", /^ministral/, 131072, 8192),
  chat("mistral.nemo", /^(open-)?mistral-nemo/, 131072, 8192),
  chat("mistral.mixtral", /^(open-)?mixtral/, 32768, 4096),
  chat("mistral", /^(open-)?mistral/, 32768, 8192),
  // xAI Grok
  chat("xai.grok-code", /^grok-code/, 256000, 32768, R),
  chat("xai.grok-4-fast", /^grok-4(\.\d)?-fast/, 2000000, 30000, VR),
  chat("xai.grok-4", /^grok-4/, 256000, 32768, VR),
  chat("xai.grok-3-mini", /^grok-3-mini/, 131072, 16384, R),
  chat("xai.grok-vision", /^grok-.*vision/, 32768, 8192, V),
  chat("xai.grok", /^grok/, 131072, 16384),
  // Cohere
  chat("cohere.command-a-vision", /^command-a-vision/, 128000, 8000, V),
  chat("cohere.command-a-reasoning", /^command-a-reasoning/, 256000, 32000, R),
  chat("cohere.command-a", /^command-a/, 256000, 8000),
  chat("cohere.command-r", /^command-r/, 128000, 4000),
  chat("cohere.command", /^command/, 4096, 4000, { tools: false }),
  // Others
  chat("microsoft.phi-4-multimodal", /^phi-?4-multimodal/, 131072, 4096, { vision: true, audio: true, tools: false }),
  chat("microsoft.phi-4", /^phi-?4/, 16384, 4096, { tools: false }),
  chat("microsoft.phi-3", /^phi-?3/, 131072, 4096, { tools: false }),
  chat("nvidia.nemotron", /nemotron/, 131072, 8192, R),
  chat("ibm.granite", /^granite-?[34]/, 131072, 8192),
  chat("perplexity.sonar", /^sonar/, 128000, 8192, { tools: false }),
  chat("lmsys.vicuna", /^vicuna/, 4096, 2048, { tools: false }),
  chat("llava", /^(bak)?llava/, 4096, 2048, { vision: true, tools: false }),
  chat("minicpm-v", /^minicpm-?v/, 32768, 4096, { vision: true, tools: false }),
  chat("internvl", /^internvl/, 32768, 4096, { vision: true, tools: false }),
  chat("moondream", /^moondream/, 2048, 1024, { vision: true, tools: false }),
];

/** Every chat/embedding entry in match order (embeddings first: their ids often contain chat family names). */
export const LLM_CATALOG: CatalogEntry[] = [...EMBEDDING, ...OPENAI, ...ANTHROPIC, ...GOOGLE, ...CHINA, ...OPEN];
export const ASR_CATALOG: CatalogEntry[] = ASR;
