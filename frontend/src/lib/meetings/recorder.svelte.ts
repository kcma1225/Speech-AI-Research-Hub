import { api, ApiError } from "#lib/api.ts";
import workletUrl from "./pcm-worklet.js?url&no-inline";

/**
 * Browser meeting recorder.
 * - MediaRecorder (Opus/WebM, or MP4 on Safari) with a 10 s timeslice; every chunk is uploaded right away with
 *   `PUT /api/meetings/:id/recordings/:mediaId/chunks/:part/:seq` (retried with backoff, never dropped), so a crash or a
 *   reload loses at most the last few seconds. A reload continues the same recording in a new part.
 * - Level meter (AnalyserNode), elapsed time, pause/resume, screen wake lock.
 * - Optional live captions: an AudioWorklet sends PCM16 16 kHz frames over `/api/meetings/:id/live` (role asr_live);
 *   captions are only shown, the stored transcript comes from the recording.
 */

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping" | "error";
export type Caption = { id: string; text: string; start: number; end: number; final: boolean };
type Pending = { part: number; seq: number; blob: Blob };
type Saved = { mediaId: string; part: number; elapsed: number; mime: string };

const TIMESLICE_MS = 10_000;
const storeKey = (meetingId: string) => `hub-rec:${meetingId}`;

export function savedRecording(meetingId: string): Saved | null {
  try {
    const raw = localStorage.getItem(storeKey(meetingId));
    const v = raw ? (JSON.parse(raw) as Saved) : null;
    return v && typeof v.mediaId === "string" ? v : null;
  } catch {
    return null;
  }
}
export function forgetRecording(meetingId: string) {
  try {
    localStorage.removeItem(storeKey(meetingId));
  } catch {}
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
const baseType = (mime: string) => (mime.startsWith("audio/mp4") ? "audio/mp4" : mime.startsWith("audio/ogg") ? "audio/ogg" : "audio/webm");

export const recordingSupported = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";

export class MeetingRecorder {
  state = $state<RecorderState>("idle");
  elapsed = $state(0);
  level = $state(0);
  pending = $state(0);
  uploadTrouble = $state(false);
  error = $state<string | null>(null);
  wakeLock = $state(false);
  live = $state<"off" | "connecting" | "on" | "error">("off");
  liveError = $state<string | null>(null);
  captions = $state<Caption[]>([]);
  partial = $state<Caption | null>(null);
  mediaId = $state<string | null>(null);

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private lock: WakeLockSentinel | null = null;
  private part = 0;
  private seq = 0;
  private mime = "";
  private queue: Pending[] = [];
  private uploading = false;
  private base = 0;
  private startedAt = 0;
  private raf = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private stopped: (() => void) | null = null;

  constructor(private readonly meetingId: string, private readonly opts: { liveCaptions: boolean }) {}

  /** Starts a new recording, or continues `resume` (a recording left unfinished by a reload) in a new part. */
  async start(resume?: { mediaId: string; nextPart: number; elapsed: number; mime?: string }) {
    if (this.state !== "idle" && this.state !== "error") return;
    this.state = "starting";
    this.error = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.state = "error";
      this.error = (e as DOMException).name === "NotAllowedError" ? "denied" : "nodevice";
      return;
    }
    this.mime = resume?.mime ?? pickMime();
    try {
      if (resume) {
        this.mediaId = resume.mediaId;
        this.part = resume.nextPart;
        this.base = resume.elapsed;
      } else {
        const r = await api.post<{ media: { id: string } }>(`/meetings/${this.meetingId}/recordings`, { mime: this.mime || "audio/webm" });
        this.mediaId = r.media.id;
        this.part = 0;
        this.base = 0;
      }
    } catch (e) {
      this.cleanup();
      this.state = "error";
      this.error = (e as Error).message;
      return;
    }
    this.seq = 0;
    this.persist();
    this.recorder = new MediaRecorder(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: 48_000 });
    this.recorder.ondataavailable = e => {
      if (e.data.size) this.enqueue({ part: this.part, seq: this.seq++, blob: e.data });
    };
    this.recorder.onstop = () => this.stopped?.();
    this.recorder.start(TIMESLICE_MS);
    this.startedAt = performance.now();
    this.state = "recording";
    this.tick = setInterval(() => this.updateElapsed(), 250);
    this.meter();
    void this.acquireLock();
    document.addEventListener("visibilitychange", this.onVisible);
    if (this.opts.liveCaptions) void this.openLive();
  }

  pause() {
    if (this.state !== "recording" || !this.recorder) return;
    this.recorder.pause();
    // Flush what was recorded so far, so a reload while paused loses nothing.
    try {
      this.recorder.requestData();
    } catch {}
    this.updateElapsed();
    this.base = this.elapsed;
    this.state = "paused";
    this.worklet?.port.postMessage({ paused: true });
    this.persist();
  }

  resume() {
    if (this.state !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.startedAt = performance.now();
    this.state = "recording";
    this.worklet?.port.postMessage({ paused: false });
  }

  /** Stops, uploads what is left, then finishes the recording on the server (concatenate + transcode). */
  async stop(): Promise<{ mediaId: string; duration: number; captions: Caption[] } | null> {
    if (!this.recorder || (this.state !== "recording" && this.state !== "paused")) return null;
    this.updateElapsed();
    const duration = this.elapsed;
    this.state = "stopping";
    await new Promise<void>(resolve => {
      this.stopped = resolve;
      this.recorder!.stop();
    });
    this.closeLive();
    this.cleanup();
    await this.drain();
    const mediaId = this.mediaId!;
    await api.post(`/meetings/${this.meetingId}/recordings/${mediaId}/finish`, { duration_sec: Math.round(duration * 10) / 10 });
    forgetRecording(this.meetingId);
    const captions = [...this.captions];
    this.state = "idle";
    this.elapsed = 0;
    return { mediaId, duration, captions };
  }

  /** Releases the microphone etc. without finishing (component unmount; the recording can be continued later). */
  dispose() {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {}
    }
    this.closeLive();
    this.cleanup();
  }

  // ---------------------------------------------------------------- internals

  private ticks = 0;
  private updateElapsed() {
    if (this.state === "recording") this.elapsed = this.base + (performance.now() - this.startedAt) / 1000;
    if (++this.ticks % 20 === 0) this.persist();
  }

  private persist() {
    if (!this.mediaId) return;
    try {
      localStorage.setItem(storeKey(this.meetingId), JSON.stringify({ mediaId: this.mediaId, part: this.part, elapsed: this.elapsed, mime: this.mime } satisfies Saved));
    } catch {}
  }

  private enqueue(item: Pending) {
    this.queue.push(item);
    this.pending = this.queue.length;
    this.persist();
    void this.pump();
  }

  private async pump() {
    if (this.uploading) return;
    this.uploading = true;
    let delay = 1000;
    while (this.queue.length) {
      const item = this.queue[0]!;
      try {
        const res = await fetch(`/api/meetings/${this.meetingId}/recordings/${this.mediaId}/chunks/${item.part}/${item.seq}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": baseType(this.mime) },
          body: item.blob,
        });
        if (res.status === 409 || res.status === 404 || res.status === 403) {
          // Recording finished/removed elsewhere or access lost: nothing more to send.
          this.queue = [];
          break;
        }
        if (!res.ok) throw new ApiError(res.status, "upload");
        this.queue.shift();
        this.pending = this.queue.length;
        this.uploadTrouble = false;
        delay = 1000;
      } catch {
        this.uploadTrouble = true;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(30_000, delay * 2);
      }
    }
    this.pending = this.queue.length;
    this.uploading = false;
  }

  private async drain() {
    for (let i = 0; i < 600 && (this.queue.length || this.uploading); i++) {
      if (!this.uploading) void this.pump();
      await new Promise(r => setTimeout(r, 250));
    }
  }

  private meter() {
    if (!this.stream) return;
    try {
      this.ctx = new AudioContext();
      // Created after awaits (outside the click), so it may start suspended.
      void this.ctx.resume().catch(() => {});
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      const data = new Float32Array(this.analyser.fftSize);
      let last = 0;
      const loop = (now: number) => {
        this.raf = requestAnimationFrame(loop);
        if (now - last < 66 || !this.analyser) return;
        last = now;
        this.analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const rms = Math.sqrt(sum / data.length);
        // ~ -60 dB → 0, 0 dB → 1
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        this.level = this.state === "recording" ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0;
      };
      this.raf = requestAnimationFrame(loop);
    } catch {
      this.ctx = null;
    }
  }

  private onVisible = () => {
    // Tab hidden (phone locked, app switched, about to close): flush the current chunk now.
    if (document.visibilityState === "hidden" && this.recorder?.state === "recording") {
      try {
        this.recorder.requestData();
      } catch {}
    }
    if (document.visibilityState === "visible" && (this.state === "recording" || this.state === "paused") && !this.lock) void this.acquireLock();
  };

  private async acquireLock() {
    try {
      if (!("wakeLock" in navigator)) return;
      this.lock = await navigator.wakeLock.request("screen");
      this.wakeLock = true;
      this.lock.addEventListener("release", () => {
        this.lock = null;
        this.wakeLock = false;
      });
    } catch {
      this.wakeLock = false;
    }
  }

  private async openLive() {
    if (!this.ctx || !this.stream) return;
    this.live = "connecting";
    this.liveError = null;
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.ctx, "pcm16-downsampler");
      source.connect(this.worklet);
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/meetings/${this.meetingId}/live?rate=16000`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.worklet.port.onmessage = e => {
        if (ws.readyState === WebSocket.OPEN && this.state === "recording") ws.send(e.data as ArrayBuffer);
      };
      ws.onmessage = e => this.onLive(typeof e.data === "string" ? e.data : "");
      ws.onclose = () => {
        if (this.live !== "error") this.live = "off";
      };
      ws.onerror = () => {
        this.live = "error";
      };
    } catch {
      this.live = "error";
    }
  }

  private onLive(raw: string) {
    let msg: { type?: string; itemId?: string; text?: string; error?: string } = {};
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const now = this.base + (this.state === "recording" ? (performance.now() - this.startedAt) / 1000 : 0);
    if (msg.type === "ready") this.live = "on";
    else if (msg.type === "error") {
      this.live = "error";
      this.liveError = msg.error ?? null;
    } else if (msg.type === "partial" && msg.text) {
      const prev = this.partial;
      this.partial = { id: msg.itemId ?? "p", text: msg.text, start: prev && prev.id === msg.itemId ? prev.start : Math.max(0, now - 2), end: now, final: false };
    } else if (msg.type === "final" && msg.text?.trim()) {
      const prev = this.partial;
      const start = prev && prev.id === msg.itemId ? prev.start : Math.max(0, now - 3);
      this.captions = [...this.captions, { id: msg.itemId ?? String(this.captions.length), text: msg.text.trim(), start, end: now, final: true }].slice(-500);
      this.partial = null;
    }
  }

  private closeLive() {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" }));
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.worklet?.disconnect();
    this.worklet = null;
    if (this.live === "on" || this.live === "connecting") this.live = "off";
  }

  private cleanup() {
    clearInterval(this.tick);
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    void this.lock?.release().catch(() => {});
    this.lock = null;
    this.wakeLock = false;
    this.level = 0;
    this.recorder = null;
  }
}
