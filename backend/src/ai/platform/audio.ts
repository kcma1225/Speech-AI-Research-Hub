/**
 * Audio input support per model: can a multimodal chat model transcribe speech for the `asr` role?
 *
 * Same precedence as vision (vision.ts): manual override > the vendor's model listing (`capabilities.audioInput`,
 * `architecture.input_modalities`…) > the built-in catalog (true) > a model-name heuristic > catalog false >
 * vendor (Gemini: every current chat model takes audio). Only codecs with an audio content part can carry it
 * (openai-chat `input_audio`, gemini `inlineData`); every other protocol (Anthropic, Responses, Bedrock, Ollama
 * native, Cohere, Claude CLI) is always "no", whatever the profile says, because the request could not be sent.
 */
import { AUDIO_CODECS } from "../codecs/shared.js";
import { getProvider } from "../providers/index.js";
import type { ResolvedProfile } from "./models.js";
import type { ProviderRecord } from "./store.js";

export type AudioSource = "override" | "model_list" | "catalog" | "name" | "vendor" | "unknown";
export type MemberAudio = { audio: boolean; detected: boolean; source: AudioSource; overridden: boolean; /** The account's wire protocol can send audio at all. */ codec_ok: boolean };

// Chat model families that take audio input (only used when neither the listing nor the catalog decides).
const AUDIO_NAME =
  /(gpt-4o(-mini)?-audio|gpt-audio|gemini-(1\.5|2|3)|gemini-(flash|pro)-latest|qwen[\d.]*-omni|qwen2?-audio|voxtral|phi-?4-multimodal|minicpm-o|ultravox|step-audio|kimi-audio|mimo-audio|gemma-?3n)/i;
const NOT_AUDIO = /(embed|tts|image|imagen|veo|-live|native-audio-dialog)/i;

/** The account's chat protocol (`codecFor` may pick another one from its config). */
export function chatCodecOf(provider: Pick<ProviderRecord, "kind" | "config">) {
  const entry = getProvider(provider.kind);
  if (!entry) return undefined;
  return entry.codecFor?.(provider.config ?? {}) ?? entry.codec;
}

/**
 * Protocol used for audio requests. Accounts that default to the Responses API but can speak Chat Completions
 * (OpenAI, Azure: `apiStyle`) send audio over Chat Completions (the Responses API takes no audio input), so
 * `configPatch` switches that one request's client.
 */
export function audioCodecOf(provider: Pick<ProviderRecord, "kind" | "config">): { codec: ReturnType<typeof chatCodecOf>; configPatch?: Record<string, unknown> } {
  const base = chatCodecOf(provider);
  if (!base || AUDIO_CODECS.has(base)) return { codec: base };
  const entry = getProvider(provider.kind);
  if (entry?.codecFor?.({ ...(provider.config ?? {}), apiStyle: "chat" }) === "openai-chat") return { codec: "openai-chat", configPatch: { apiStyle: "chat" } };
  return { codec: base };
}

export function modelAudio(provider: Pick<ProviderRecord, "kind" | "config" | "family">, model: string, profile: Pick<ResolvedProfile, "fields" | "sources"> | null | undefined): MemberAudio {
  const no = (source: AudioSource, codec_ok: boolean): MemberAudio => ({ audio: false, detected: false, source, overridden: false, codec_ok });
  if (provider.family === "asr") return no("vendor", false);
  if (provider.kind === "claude-cli") return no("vendor", false);
  const { codec } = audioCodecOf(provider);
  if (!codec || !AUDIO_CODECS.has(codec)) return no("vendor", false);
  if (profile && profile.fields.capability !== "chat") return no("catalog", true);
  const v = profile?.fields.audio_input;
  const src = profile?.sources.audio_input;
  if (v !== undefined && src === "manual") return { audio: v, detected: v, source: "override", overridden: true, codec_ok: true };
  if (v !== undefined && src === "provider_api") return { audio: v, detected: v, source: "model_list", overridden: false, codec_ok: true };
  if (v === true && src === "catalog") return { audio: true, detected: true, source: "catalog", overridden: false, codec_ok: true };
  if (AUDIO_NAME.test(model) && !NOT_AUDIO.test(model)) return { audio: true, detected: true, source: "name", overridden: false, codec_ok: true };
  if (v === false && src === "catalog") return no("catalog", true);
  if (codec === "gemini" && /gemini/i.test(model) && !NOT_AUDIO.test(model)) return { audio: true, detected: true, source: "vendor", overridden: false, codec_ok: true };
  return no("unknown", true);
}
