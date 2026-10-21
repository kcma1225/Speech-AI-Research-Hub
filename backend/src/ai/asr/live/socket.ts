import WebSocket from "ws";
import { asrErr, type AsrError } from "../err.js";

/** Opens a vendor WebSocket with headers; maps handshake failures to AiError. */
export function connectVendor(url: string, headers: Record<string, string>, opts: { timeoutMs?: number; signal?: AbortSignal; protocols?: string[] } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts.protocols ?? [], { headers, handshakeTimeout: opts.timeoutMs ?? 15_000 });
    const fail = (e: AsrError) => {
      cleanup();
      ws.on("error", () => undefined); // terminate() before open emits an error
      ws.terminate();
      reject(e);
    };
    const onAbort = () => fail(asrErr("cancelled", "live session aborted"));
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("unexpected-response", onUnexpected);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (e: Error) => fail(/timeout/i.test(e.message) ? asrErr("timeout", `live connect: ${e.message}`) : asrErr("unavailable", `live connect: ${e.message}`, { reason: "network" }));
    const onUnexpected = (_req: unknown, res: import("node:http").IncomingMessage) => {
      const status = res.statusCode ?? 0;
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        const code = status === 401 || status === 403 ? "auth_failed" : status === 402 ? "quota_exhausted" : status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : status === 404 ? "model_not_found" : "bad_request";
        fail(asrErr(code, `live handshake HTTP ${status}: ${body.slice(0, 300)}`, { status }));
      });
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("unexpected-response", onUnexpected);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Linear resampler for PCM16 mono (e.g. 16 kHz browser audio → 24 kHz for OpenAI). */
export function resamplePcm16(input: Buffer, from: number, to: number): Buffer {
  if (from === to) return input;
  const n = Math.floor(input.length / 2);
  const outLen = Math.floor((n * to) / from);
  const out = Buffer.alloc(outLen * 2);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, n - 1);
    const frac = pos - i0;
    const s = input.readInt16LE(i0 * 2) * (1 - frac) + input.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}
