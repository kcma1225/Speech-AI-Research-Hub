/** Live captions: OpenAI realtime + Deepgram live against mock WebSocket servers. */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { resamplePcm16, startLiveSession, type LiveEvent } from "../src/ai/asr/index.js";

async function wsMock(onConn: (ws: WebSocket, req: import("node:http").IncomingMessage) => void, opts: { reject?: number } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: opts.reject ? (_info, cb) => cb(false, opts.reject) : undefined,
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", onConn);
  const url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("live ASR", () => {
  it("OpenAI realtime: session.update, resampled base64 audio, delta/completed → partial/final (s2twp)", async () => {
    const received: any[] = [];
    let headers: Record<string, unknown> = {};
    let path = "";
    const m = await wsMock((ws, req) => {
      headers = req.headers;
      path = req.url!;
      ws.on("message", (raw) => {
        const ev = JSON.parse(String(raw));
        received.push(ev);
        if (ev.type === "input_audio_buffer.append" && received.filter((e) => e.type === "input_audio_buffer.append").length === 1) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "it1", delta: "软" }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "it1", delta: "件" }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "it1", transcript: "软件很好" }));
        }
      });
    });
    const events: LiveEvent[] = [];
    const s = await startLiveSession(
      { kind: "openai", baseUrl: `${m.url}/v1`, model: "gpt-4o-transcribe", fields: { api_key: "sk-live", close_grace_ms: 10 } },
      { sampleRate: 16000, language: "zh-TW", prompt: "會議", onEvent: (e) => events.push(e) },
    );
    s.sendAudio(Buffer.alloc(3200)); // 100 ms @16 kHz
    await until(() => events.some((e) => e.type === "final"));
    await s.close();
    expect(path).toBe("/v1/realtime?intent=transcription");
    expect(headers.authorization).toBe("Bearer sk-live");
    const upd = received[0];
    expect(upd.type).toBe("session.update");
    expect(upd.session.type).toBe("transcription");
    expect(upd.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(upd.session.audio.input.transcription).toEqual({ model: "gpt-4o-transcribe", language: "zh", prompt: "會議" });
    expect(upd.session.audio.input.turn_detection.type).toBe("server_vad");
    const append = received.find((e) => e.type === "input_audio_buffer.append");
    expect(Buffer.from(append.audio, "base64").length).toBe(4800); // resampled to 24 kHz
    expect(received.at(-1).type).toBe("input_audio_buffer.commit");
    expect(events.filter((e) => e.type === "partial").map((e) => (e as any).text)).toEqual(["軟", "軟體"]);
    expect(events.find((e) => e.type === "final")).toMatchObject({ itemId: "it1", text: "軟體很好" });
    expect(events.at(-1)!.type).toBe("closed");
    await m.close();
  });

  it("OpenAI handshake 401 → auth_failed", async () => {
    const m = await wsMock(() => undefined, { reject: 401 });
    const e = await startLiveSession({ kind: "openai", baseUrl: m.url, fields: { api_key: "bad" } }, { sampleRate: 24000, onEvent: () => undefined }).catch((x) => x);
    expect(e.code).toBe("auth_failed");
    await m.close();
  });

  it("Deepgram live: query, Token auth, binary audio, interim/final, CloseStream", async () => {
    const got: { binary: number; text: string[] } = { binary: 0, text: [] };
    let reqUrl = "";
    let auth: unknown;
    const m = await wsMock((ws, req) => {
      reqUrl = req.url!;
      auth = req.headers.authorization;
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          got.binary += (raw as Buffer).length;
          ws.send(JSON.stringify({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "大家" }] } }));
          ws.send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, start: 0, duration: 1.5, channel: { alternatives: [{ transcript: "大家好", words: [{ word: "大家好", speaker: 0 }] }] } }));
          return;
        }
        const ev = JSON.parse(String(raw));
        got.text.push(ev.type);
        if (ev.type === "CloseStream") ws.close(1000, "done");
      });
    });
    const events: LiveEvent[] = [];
    const s = await startLiveSession(
      { kind: "deepgram", baseUrl: m.url, fields: { api_key: "dg" } },
      { sampleRate: 16000, language: "zh-TW", diarize: true, keyterms: ["BERT"], onEvent: (e) => events.push(e) },
    );
    s.sendAudio(Buffer.alloc(320));
    await until(() => events.some((e) => e.type === "final"));
    await s.close();
    const q = new URL(reqUrl, "http://x").searchParams;
    expect(auth).toBe("Token dg");
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
    expect(q.get("language")).toBe("zh-TW");
    expect(q.get("diarize")).toBe("true");
    expect(q.getAll("keyterm")).toEqual(["BERT"]);
    expect(got.binary).toBe(320);
    expect(got.text).toContain("CloseStream");
    expect(events.filter((e) => e.type !== "closed")).toEqual([
      { type: "partial", itemId: "dg-0", text: "大家" },
      { type: "final", itemId: "dg-0", text: "大家好", start: 0, end: 1.5, speaker: "0" },
    ]);
    await m.close();
  });

  it("kinds without live support → unsupported; resampler is identity at equal rates", async () => {
    const e = await startLiveSession({ kind: "assemblyai", fields: {} }, { sampleRate: 16000, onEvent: () => undefined }).catch((x) => x);
    expect(e.code).toBe("unsupported");
    const b = Buffer.from([1, 0, 2, 0]);
    expect(resamplePcm16(b, 16000, 16000)).toBe(b);
  });
});
