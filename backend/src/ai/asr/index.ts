/** Public ASR API. See docs/ai-asr-oauth.md. */
import { AiError, fromThrown } from "../errors.js";
import { asrErr } from "./err.js";
import { deepgramLive } from "./live/deepgram.js";
import { openaiLive } from "./live/openai.js";
import type { LiveAdapter, LiveOptions, LiveSession } from "./live/types.js";
import { asrAdapterFor } from "./registry.js";
import type { AsrProviderConfig } from "./types.js";

export * from "./types.js";
export type { LiveAdapter, LiveEvent, LiveOptions, LiveSession } from "./live/types.js";
export { transcribe, withRetries, formatOf, type TranscribeDeps } from "./transcribe.js";
export { ASR_REGISTRY, ASR_MEMBER_PARAMS, getAsrEntry, asrAdapterFor, asrCapabilities, publicAsrRegistry, type AsrRegistryEntry } from "./registry.js";
export { convertScript, convertTranscript, scriptConverter } from "./opencc.js";
export { planChunks, mergeChunks, parseSilencedetect, chainPrompt, promptTail, ffmpegTools, type MediaTools, type Silence } from "./chunking.js";
export { segmentsFromWords, normaliseSpeakers, mapLanguage, joinTokens } from "./normalize.js";
export { asrReasonOf, type AsrReason } from "./err.js";
export { resamplePcm16 } from "./live/socket.js";

const LIVE: Record<string, LiveAdapter> = { openai: openaiLive, deepgram: deepgramLive };

export const liveKinds = () => Object.keys(LIVE);

/** Opens a live caption session (server side). Throws `unsupported` for kinds without live support. */
export async function startLiveSession(cfg: AsrProviderConfig, opts: LiveOptions): Promise<LiveSession> {
  const a = LIVE[cfg.kind];
  if (!a) throw asrErr("unsupported", `${cfg.kind} has no live transcription`);
  return a.start(cfg, opts);
}

export type AsrProbeResult = { ok: boolean; latencyMs: number; detail_zh: string; error?: AiError };

/** Cheap health probe for the `asr` role (periodic). Never throws. */
export async function probeAsr(cfg: AsrProviderConfig, signal?: AbortSignal): Promise<AsrProbeResult> {
  const t0 = Date.now();
  try {
    const a = asrAdapterFor(cfg.kind);
    if (!a) throw asrErr("unsupported", `unknown ASR kind ${cfg.kind}`);
    await a.probe(cfg, signal);
    return { ok: true, latencyMs: Date.now() - t0, detail_zh: "連線正常。" };
  } catch (e) {
    const error = fromThrown(e);
    return { ok: false, latencyMs: Date.now() - t0, detail_zh: error.message_zh, error };
  }
}

/** Best-effort remote cleanup of an async vendor job (cancel button / job reaped for good). */
export async function cancelAsrJob(cfg: AsrProviderConfig, vendorJobId: string): Promise<void> {
  const a = asrAdapterFor(cfg.kind);
  for (const id of vendorJobId.split(",").filter(Boolean)) await a?.cancel?.(cfg, id).catch(() => undefined);
}
