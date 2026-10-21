/**
 * Shared HTTP plumbing for codecs: timeouts (time-to-first-byte + idle), abort,
 * auth, error mapping, tolerant JSON parsing, SSE / NDJSON readers.
 */
import { AiError, classifyHttpError, fromThrown } from "../errors.js";
import type { CodecContext } from "../codecs/codec.js";
import type { ProbeResult } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;

export type ErrorMapper = (input: { status: number; body: unknown; headers?: Headers | null }) => AiError | undefined;

/** A single request lifecycle with a re-armable deadline. */
export class Call {
  private ctrl = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  timedOut = false;
  readonly signal: AbortSignal;

  constructor(
    private readonly userSignal: AbortSignal | undefined,
    private readonly timeoutMs: number,
    readonly providerId: string,
  ) {
    this.signal = userSignal ? AbortSignal.any([userSignal, this.ctrl.signal]) : this.ctrl.signal;
    this.arm();
  }

  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.ctrl.abort(new Error("timeout"));
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  done() {
    clearTimeout(this.timer);
  }

  abort() {
    this.done();
    this.ctrl.abort(new Error("closed"));
  }

  wrap(e: unknown, midStream = false): AiError {
    const err = fromThrown(e, {
      timedOut: this.timedOut,
      cancelled: this.userSignal?.aborted,
      providerId: this.providerId,
      midStream,
    });
    if (midStream) err.midStream = true;
    err.providerId ??= this.providerId;
    return err;
  }
}

export interface SendOptions {
  method?: "GET" | "POST";
  /** Absolute URL or a path appended to ctx.baseUrl. */
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  mapError?: ErrorMapper;
  /** Skip auth (health endpoints). */
  noAuth?: boolean;
}

export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Strip a trailing `/v1` (or `/api`) to get the server root (for health endpoints). */
export function serverRoot(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/(v1|api|openai\/v1)$/, "");
}

/** Sends a request; resolves on 2xx with the Response and its Call (caller must call call.done()). */
export async function send(ctx: CodecContext, opts: SendOptions): Promise<{ res: Response; call: Call }> {
  const call = new Call(opts.signal, opts.timeoutMs ?? ctx.timeoutMs, ctx.entry.id);
  const url = new URL(joinUrl(ctx.baseUrl, opts.url));
  const headers = new Headers({ accept: "application/json", ...ctx.quirks.fixedHeaders, ...opts.headers });
  const extra = ctx.config.extraHeaders;
  if (extra && typeof extra === "object") for (const [k, v] of Object.entries(extra)) if (typeof v === "string") headers.set(k, v);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const method = opts.method ?? (body !== undefined ? "POST" : "GET");
  let res: Response;
  try {
    if (!opts.noAuth) await ctx.auth.apply({ method, url, headers, body: body ?? "" }, call.signal);
    res = await ctx.fetch(url, { method, headers, body, signal: call.signal });
  } catch (e) {
    call.done();
    throw call.wrap(e);
  }
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    call.done();
    throw mapHttp(ctx, res.status, parseJsonLoose(text) ?? text, res.headers, opts.mapError);
  }
  return { res, call };
}

export function mapHttp(ctx: CodecContext, status: number, body: unknown, headers: Headers | null, mapper?: ErrorMapper): AiError {
  const input = { status, body, headers };
  const err = ctx.quirks.mapError?.(input) ?? mapper?.(input) ?? classifyHttpError({ ...input, providerId: ctx.entry.id });
  err.providerId ??= ctx.entry.id;
  return err;
}

/** JSON request → parsed JSON body (tolerates a trailing `data: [DONE]`). */
export async function sendJson<T = unknown>(ctx: CodecContext, opts: SendOptions): Promise<T> {
  const { res, call } = await send(ctx, opts);
  try {
    const text = await res.text();
    const parsed = parseJsonLoose(text);
    if (parsed === undefined) throw new AiError("unavailable", { vendorMessage: "invalid JSON response", providerId: ctx.entry.id });
    return parsed as T;
  } catch (e) {
    throw call.wrap(e);
  } finally {
    call.done();
  }
}

/**
 * Parses JSON, tolerating gateways that append SSE trailers (`data: [DONE]`) or wrap a
 * single JSON in `data:` lines. Returns undefined when nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const lines = t.split(/\r?\n/);
  const nonSse = lines.filter((l) => !/^data:\s*\[DONE\]\s*$/.test(l.trim()));
  try {
    return JSON.parse(nonSse.join("\n"));
  } catch {
    /* fall through */
  }
  const datas = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((d) => d && d !== "[DONE]");
  for (let i = datas.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(datas[i]!);
    } catch {
      /* next */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- stream readers

/** Raw byte chunks; re-arms the call deadline on each chunk. */
export async function* byteChunks(res: Response, call: Call): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      call.arm();
      if (value) yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

export async function* textLines(res: Response, call: Call): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of byteChunks(res, call)) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  buf += dec.decode();
  if (buf) yield buf.replace(/\r$/, "");
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Server-Sent Events parser (comments ignored; multi-line data joined with \n). */
export async function* sseEvents(res: Response, call: Call): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of textLines(res, call)) {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (idx < 0 && line.trim().startsWith("{")) data.push(line); // bare JSON line (non-SSE gateway)
  }
  if (data.length) yield { event, data: data.join("\n") };
}

/** NDJSON objects (one per line). */
export async function* ndjson(res: Response, call: Call): AsyncGenerator<unknown> {
  for await (const line of textLines(res, call)) {
    const t = line.trim();
    if (!t) continue;
    const v = parseJsonLoose(t);
    if (v !== undefined) yield v;
  }
}

/**
 * Runs a streaming body, converting thrown errors to a final `error` event.
 * Errors before the first event are thrown (so routers can fall back cleanly).
 */
export async function* guardStream<T extends { type: string }>(
  call: Call,
  gen: AsyncGenerator<T>,
): AsyncGenerator<T | { type: "error"; error: AiError }> {
  try {
    for await (const ev of gen) yield ev;
  } catch (e) {
    yield { type: "error", error: call.wrap(e, true) };
  } finally {
    call.abort();
  }
}

// ---------------------------------------------------------------- probes

export async function timedProbe(fn: () => Promise<{ detail_zh: string; modelCount?: number }>): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ok: true, latencyMs: Date.now() - t0, ...r };
  } catch (e) {
    const err = e instanceof AiError ? e : fromThrown(e);
    return { ok: false, latencyMs: Date.now() - t0, detail_zh: err.message_zh, error: err };
  }
}

export function modelsDetail(n: number) {
  return { detail_zh: n > 0 ? `連線成功，取得 ${n} 個模型。` : "連線成功。", modelCount: n };
}

// ---------------------------------------------------------------- misc

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Deep-merge plain objects (b wins). */
export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av)) {
      out[k] = deepMerge(av as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}
