/**
 * Speech-to-text by a multimodal chat model (Gemini, gpt-audio, Qwen-Omni, Voxtral…) bound to the `asr` role.
 *
 * Plugs into the normal ASR orchestrator (transcribe.ts) as an adapter, so chunking at silences (≤ 10 min by
 * default, `max_chunk_sec` overrides), prompt chaining with the previous chunk's tail, per-chunk retries,
 * checkpoints/resume, chunk merging and OpenCC conversion are shared with the dedicated ASR vendors. Each chunk is
 * one chat call: an `audio` content block (base64) + instructions asking for strict JSON segments with times
 * relative to the chunk (llm-transcript.ts parses and repairs the answer). The platform supplies `chat`, which
 * runs the request on the member's account (codec mapping, auth, profile limits) without routing.
 */
import { readFile } from "node:fs/promises";
import type { AudioBlock, ChatRequest, CodecId, StopReason, TextBlock, Usage } from "../../types.js";
import { asrErr } from "../err.js";
import { buildTranscribePrompt, parseLlmTranscript } from "../llm-transcript.js";
import { r3 } from "../normalize.js";
import type { AdapterCallInput, AsrAdapter, AsrCapabilities, AsrProviderConfig, AudioFormat, ChunkResult } from "../types.js";

export type LlmChatFn = (req: Omit<ChatRequest, "model">) => Promise<{ text: string; stopReason: StopReason; usage: Usage; model?: string }>;

export type LlmAsrOptions = {
  chat: LlmChatFn;
  /** The account's chat protocol (decides the audio formats it can carry). */
  codec: CodecId;
  /** Max output tokens of the model (profile), to size the answer. */
  maxOutputTokens?: number;
  /** Ask for JSON mode (Gemini `responseMimeType`); off for gateways that reject response_format. */
  jsonMode?: boolean;
  /** Reasoning models: keep thinking short (the answer budget is the transcript). */
  reasoning?: boolean;
  /** Accumulates token usage over all chunks (call log). */
  usage?: Usage;
};

const MB = 1024 * 1024;
/** Default chunk: long enough for context, short enough that timestamps don't drift and the answer fits. */
export const LLM_ASR_CHUNK_SEC = 600;

/** Audio formats per protocol: OpenAI documents wav + mp3 for `input_audio`; Gemini takes ogg/opus, flac, mp3, wav… */
export function llmAudioFormats(codec: CodecId): AudioFormat[] {
  return codec === "gemini" ? ["ogg", "mp3", "flac", "wav", "m4a"] : ["mp3", "wav"];
}

export function llmAsrCapabilities(codec: CodecId): AsrCapabilities {
  return {
    diarization: true,
    wordTimestamps: false,
    // Gemini inline requests are capped at 20 MB in total (base64 adds a third); OpenAI-style bodies similarly.
    maxBytes: 12 * MB,
    maxDurationSec: LLM_ASR_CHUNK_SEC,
    preferredChunkSec: LLM_ASR_CHUNK_SEC,
    async: false,
    streaming: false,
    prompt: true,
    keyterms: 300,
    formats: llmAudioFormats(codec),
    traditionalNative: false,
  };
}

const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", webm: "audio/webm", mp4: "audio/mp4" };

function mimeOf(path: string, given: string): string {
  const ext = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return MIME[ext] ?? (given.startsWith("audio/") ? given : "audio/mpeg");
}

/** Output budget: ~25 tokens per spoken second covers dense zh/en speech plus JSON overhead. */
export function answerBudget(durationSec: number, maxOutputTokens?: number, reasoning = false): number {
  // Reasoning models spend output tokens on thinking before the transcript: leave headroom.
  const want = Math.max(1024, Math.ceil(durationSec * 25) + 512) + (reasoning ? 4096 : 0);
  return Math.min(want, maxOutputTokens ?? 16384, 32768);
}

export function llmAsrAdapter(opts: LlmAsrOptions): AsrAdapter {
  return {
    kind: "llm_audio",
    capabilities: () => llmAsrCapabilities(opts.codec),
    async probe() {
      /* health comes from the LLM account's own probe (model listing) */
    },
    async transcribe(_cfg: AsrProviderConfig, input: AdapterCallInput): Promise<ChunkResult> {
      const dur = input.part.durationSec ?? 0;
      const data = (await readFile(input.part.path)).toString("base64");
      const { system, user } = buildTranscribePrompt({
        durationSec: dur,
        language: input.language,
        extraLanguages: input.extraLanguages,
        diarize: input.diarize,
        keyterms: input.keyterms,
        prompt: input.prompt,
      });
      const audio: AudioBlock = { type: "audio", source: { kind: "base64", mediaType: mimeOf(input.part.path, input.part.mime), data } };
      const content: Array<TextBlock | AudioBlock> = [{ type: "text", text: user }, audio];
      const res = await opts.chat({
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        maxTokens: answerBudget(dur, opts.maxOutputTokens, opts.reasoning),
        temperature: 0,
        ...(opts.jsonMode ? { responseFormat: { type: "json_object" as const } } : {}),
        ...(opts.reasoning ? { reasoning: { effort: "low" as const } } : {}),
        signal: input.signal,
      });
      if (opts.usage) {
        opts.usage.inputTokens = (opts.usage.inputTokens ?? 0) + (res.usage.inputTokens ?? 0);
        opts.usage.outputTokens = (opts.usage.outputTokens ?? 0) + (res.usage.outputTokens ?? 0);
      }
      if (res.stopReason === "content_filter") throw asrErr("content_filtered", "the model refused to transcribe this audio (content filter)");
      const parsed = parseLlmTranscript(res.text, dur, { diarize: input.diarize });
      if (res.stopReason === "max_tokens" && parsed.coveredSec < dur * 0.9) {
        // The answer was cut off: let the orchestrator re-plan this part at half the length.
        throw asrErr("bad_request", `answer truncated at ${parsed.coveredSec}s of ${dur}s (max tokens)`, { reason: "too_long" });
      }
      if (!parsed.segments.length && res.text.trim() && !/"segments"\s*:\s*\[\s*\]/.test(res.text)) {
        // Something came back but it is neither JSON nor timestamped lines nor plain text we could keep.
        throw asrErr("unavailable", "the model answer could not be parsed as a transcript", { retryable: true });
      }
      return {
        text: parsed.text,
        segments: parsed.segments,
        language: parsed.language ?? (input.language && input.language !== "auto" ? input.language : null),
        durationSec: r3(dur),
        warnings: parsed.warnings,
      };
    },
  };
}
