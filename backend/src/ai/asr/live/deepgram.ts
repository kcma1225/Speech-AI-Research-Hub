/**
 * Deepgram live: `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=…&interim_results=true`
 * with `Authorization: Token <key>`. Binary PCM frames in; `Results` messages out
 * (`is_final` marks the final text of a span). KeepAlive every 8 s; CloseStream on close.
 */
import type WebSocket from "ws";
import { requireStr, str, trimSlash } from "../http.js";
import { asrErr } from "../err.js";
import { mapLanguage } from "../normalize.js";
import { scriptConverter } from "../opencc.js";
import type { AsrProviderConfig } from "../types.js";
import { connectVendor } from "./socket.js";
import type { LiveAdapter, LiveOptions, LiveSession } from "./types.js";

export function deepgramLiveUrl(cfg: AsrProviderConfig, opts: LiveOptions): string {
  const base = trimSlash((cfg.baseUrl ?? str(cfg.fields, "base_url") ?? "https://api.deepgram.com").replace(/^http/, "ws"));
  const q = new URLSearchParams({
    model: cfg.model ?? str(cfg.fields, "live_model") ?? "nova-3",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    endpointing: "300",
  });
  q.set("language", mapLanguage(opts.language, "bcp47") ?? "zh-TW");
  if (opts.diarize) q.set("diarize", "true");
  for (const k of opts.keyterms ?? []) q.append("keyterm", k);
  return `${base}/v1/listen?${q}`;
}

export const deepgramLive: LiveAdapter = {
  kind: "deepgram",
  async start(cfg, opts) {
    const ws: WebSocket = await connectVendor(deepgramLiveUrl(cfg, opts), { authorization: `Token ${requireStr(cfg.fields, "api_key", "deepgram")}` }, { signal: opts.signal });
    const conv = scriptConverter(opts.convertScript ?? "none");
    let closed = false;
    let seq = 0;
    const done = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    const keepAlive = setInterval(() => {
      if (!closed) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, Number(cfg.fields.keepalive_ms ?? 8000));
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let ev: any;
      try {
        ev = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (ev.type === "Results") {
        const alt = ev.channel?.alternatives?.[0];
        const text = String(alt?.transcript ?? "");
        const itemId = `dg-${seq}`;
        if (ev.is_final) {
          if (text) {
            const sp = alt?.words?.[0]?.speaker;
            opts.onEvent({ type: "final", itemId, text: conv(text), start: ev.start, end: ev.start + ev.duration, speaker: sp != null ? String(sp) : null });
          }
          seq++;
        } else if (text) opts.onEvent({ type: "partial", itemId, text: conv(text) });
      } else if (ev.type === "SpeechStarted") opts.onEvent({ type: "speech", state: "started" });
      else if (ev.type === "UtteranceEnd") opts.onEvent({ type: "speech", state: "stopped" });
      else if (ev.type === "Error" || ev.err_code) opts.onEvent({ type: "error", error: asrErr("bad_request", `deepgram live: ${ev.description ?? ev.err_msg ?? ""}`, { vendorCode: ev.err_code }) });
    });
    ws.on("close", (code, reason) => {
      closed = true;
      clearInterval(keepAlive);
      opts.onEvent({ type: "closed", reason: `${code} ${String(reason)}`.trim() });
    });
    ws.on("error", (e) => opts.onEvent({ type: "error", error: asrErr("unavailable", `deepgram live: ${e.message}`) }));
    opts.signal?.addEventListener("abort", () => ws.close(1000), { once: true });
    const session: LiveSession = {
      sendAudio(pcm) {
        if (!closed) ws.send(pcm, { binary: true });
      },
      commit() {
        if (!closed) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      async close() {
        if (!closed) ws.send(JSON.stringify({ type: "CloseStream" })); // server flushes, then closes
        const t = setTimeout(() => ws.terminate(), Number(cfg.fields.close_grace_ms ?? 5000));
        await done;
        clearTimeout(t);
      },
    };
    return session;
  },
};
