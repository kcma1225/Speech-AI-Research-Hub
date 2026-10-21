/**
 * OpenAI Realtime transcription session (server-side WebSocket).
 * `wss://api.openai.com/v1/realtime?intent=transcription`, `session.update` with a transcription
 * session, `input_audio_buffer.append` (base64 PCM16 24 kHz), events
 * `conversation.item.input_audio_transcription.delta|completed`.
 * Turn detection: server VAD by default; `gpt-live-transcribe` uses manual commits (turn_detection null).
 */
import type WebSocket from "ws";
import { asrErr } from "../err.js";
import { str, trimSlash } from "../http.js";
import { mapLanguage } from "../normalize.js";
import { scriptConverter } from "../opencc.js";
import type { AsrProviderConfig } from "../types.js";
import { connectVendor, resamplePcm16 } from "./socket.js";
import type { LiveAdapter, LiveOptions, LiveSession } from "./types.js";

const RATE = 24_000;

export function realtimeUrl(cfg: AsrProviderConfig): string {
  const base = trimSlash(str(cfg.fields, "realtime_url") ?? (cfg.baseUrl ?? str(cfg.fields, "base_url") ?? "https://api.openai.com/v1").replace(/^http/, "ws"));
  return `${base}/realtime?intent=transcription`;
}

export function sessionUpdate(cfg: AsrProviderConfig, opts: LiveOptions) {
  const model = cfg.model ?? str(cfg.fields, "live_model") ?? "gpt-4o-transcribe";
  const manual = /live-transcribe/.test(model) || str(cfg.fields, "turn_detection") === "manual";
  const transcription: Record<string, unknown> = { model };
  const lang = mapLanguage(opts.language, "iso1");
  if (lang) transcription.language = lang;
  if (opts.prompt) transcription.prompt = opts.prompt;
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: RATE },
          noise_reduction: { type: "far_field" },
          transcription,
          turn_detection: manual ? null : { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
        },
      },
    },
  };
}

export const openaiLive: LiveAdapter = {
  kind: "openai",
  async start(cfg, opts) {
    const key = str(cfg.fields, "api_key");
    if (!key) throw asrErr("auth_failed", "openai live: missing api_key");
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    const project = str(cfg.fields, "project");
    if (project) headers["openai-project"] = project;
    const ws: WebSocket = await connectVendor(realtimeUrl(cfg), headers, { signal: opts.signal });
    const conv = scriptConverter(opts.convertScript ?? "s2twp");
    const partial = new Map<string, string>();
    let closed = false;
    const done = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.send(JSON.stringify(sessionUpdate(cfg, opts)));
    ws.on("message", (raw) => {
      let ev: any;
      try {
        ev = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (ev.type) {
        case "conversation.item.input_audio_transcription.delta": {
          const t = (partial.get(ev.item_id) ?? "") + (ev.delta ?? "");
          partial.set(ev.item_id, t);
          opts.onEvent({ type: "partial", itemId: ev.item_id, text: conv(t) });
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          partial.delete(ev.item_id);
          opts.onEvent({ type: "final", itemId: ev.item_id, text: conv(String(ev.transcript ?? "")) });
          break;
        case "input_audio_buffer.speech_started":
          opts.onEvent({ type: "speech", state: "started" });
          break;
        case "input_audio_buffer.speech_stopped":
          opts.onEvent({ type: "speech", state: "stopped" });
          break;
        case "conversation.item.input_audio_transcription.failed":
        case "error": {
          const e = ev.error ?? {};
          const code = /auth|api key/i.test(`${e.code} ${e.message}`) ? "auth_failed" : /rate|limit/i.test(String(e.code)) ? "rate_limited" : /quota/i.test(String(e.code)) ? "quota_exhausted" : "bad_request";
          opts.onEvent({ type: "error", error: asrErr(code, `openai realtime: ${e.code ?? ""} ${e.message ?? ""}`.trim(), { vendorCode: e.code }) });
          break;
        }
      }
    });
    ws.on("close", (code, reason) => {
      closed = true;
      opts.onEvent({ type: "closed", reason: `${code} ${String(reason)}`.trim() });
    });
    ws.on("error", (e) => opts.onEvent({ type: "error", error: asrErr("unavailable", `openai realtime: ${e.message}`) }));
    opts.signal?.addEventListener("abort", () => ws.close(1000), { once: true });
    const session: LiveSession = {
      sendAudio(pcm) {
        if (closed) return;
        const audio = resamplePcm16(pcm, opts.sampleRate, RATE).toString("base64");
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      },
      commit() {
        if (!closed) ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      },
      async close() {
        if (!closed) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          // Give the vendor a moment to deliver the last `completed` event.
          await new Promise((r) => setTimeout(r, Number(cfg.fields.close_grace_ms ?? 1500)));
          ws.close(1000);
        }
        await done;
      },
    };
    return session;
  },
};
