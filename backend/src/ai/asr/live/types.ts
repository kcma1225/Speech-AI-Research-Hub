/**
 * Live captions (`asr_live`). The browser streams PCM16 mono to our backend WebSocket; the backend
 * opens the vendor socket server-side (vendor keys never reach the browser) and relays events.
 * Live text is ephemeral; the stored transcript always comes from batch `asr` over the recording.
 */
import type { AiError } from "../../errors.js";
import type { AsrProviderConfig } from "../types.js";

export type LiveEvent =
  /** Interim text for an utterance (replace, don't append). */
  | { type: "partial"; itemId: string; text: string }
  /** Final text for an utterance; times are seconds since session start when the vendor gives them. */
  | { type: "final"; itemId: string; text: string; start?: number; end?: number; speaker?: string | null }
  /** Vendor detected start/end of speech (optional UI hint). */
  | { type: "speech"; state: "started" | "stopped" }
  | { type: "error"; error: AiError }
  | { type: "closed"; reason?: string };

export type LiveOptions = {
  /** Sample rate of the PCM16 the caller will send (browser AudioWorklet: 16000 or 24000). */
  sampleRate: number;
  language?: string;
  prompt?: string;
  keyterms?: string[];
  diarize?: boolean;
  onEvent: (e: LiveEvent) => void;
  signal?: AbortSignal;
  /** Text conversion applied to partial/final text (OpenCC). */
  convertScript?: "none" | "s2tw" | "s2twp";
};

export interface LiveSession {
  /** PCM16 little-endian mono at `sampleRate`. Buffered until the vendor socket is ready. */
  sendAudio(pcm16: Buffer): void;
  /** Force-finalise the current utterance (OpenAI manual turns; Deepgram `Finalize`). */
  commit(): void;
  /** Flush and close; resolves when the vendor socket closed. */
  close(): Promise<void>;
}

export interface LiveAdapter {
  kind: string;
  start(cfg: AsrProviderConfig, opts: LiveOptions): Promise<LiveSession>;
}
