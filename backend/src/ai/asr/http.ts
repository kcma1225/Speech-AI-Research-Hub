import { openAsBlob } from "node:fs";
import { asrErr, AiError } from "./err.js";
import type { AsrProviderConfig, AudioPart } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Combines the caller's signal with a timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof AiError) return r;
  if (r instanceof Error && r.name === "TimeoutError") return asrErr("timeout", "ASR request timed out", { cause: r });
  return r instanceof Error ? r : new DOMException("Aborted", "AbortError");
}

/** fetch with timeout + network-error mapping. Does not check status. */
export async function vendorFetch(
  cfg: AsrProviderConfig,
  url: string,
  init: RequestInit & { timeoutMs?: number },
  signal?: AbortSignal,
): Promise<Response> {
  const f = cfg.fetch ?? fetch;
  const s = withTimeout(signal, init.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: s });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (s.aborted) throw asrErr("timeout", `timeout calling ${host(url)}`, { cause: e });
    throw asrErr("unavailable", `network error calling ${host(url)}: ${(e as Error).message}`, {
      reason: "network",
      cause: e,
    });
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Reads the body as text (bounded) for error messages; never includes request credentials. */
async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

/** Extracts a vendor error code and message from common JSON error shapes. */
export function vendorErrorInfo(text: string): { code?: string; message: string } {
  try {
    const j = JSON.parse(text) as Record<string, any>;
    const e = j.error ?? j;
    if (typeof e === "string") return { message: e };
    const code = e.code ?? e.type ?? e.status ?? j.err_code ?? j.__type ?? e.detail?.status;
    const message =
      e.message ?? j.err_msg ?? j.message ?? (typeof j.detail === "string" ? j.detail : j.detail?.message) ??
      (Array.isArray(j.detail) ? j.detail.map((d: any) => d.msg).join("; ") : undefined) ?? text;
    return { code: code != null ? String(code) : undefined, message: String(message) };
  } catch {
    return { message: text };
  }
}

/** Maps a non-2xx response to an AiError. */
export async function errorFromResponse(res: Response, vendor: string): Promise<AiError> {
  const text = await bodyText(res);
  const { code, message } = vendorErrorInfo(text);
  const detail = `${vendor} HTTP ${res.status}${code ? ` ${code}` : ""}: ${message}`.slice(0, 600);
  const opts = { status: res.status, vendorCode: code, retryAfterMs: retryAfter(res) };
  const lc = `${code ?? ""} ${message}`.toLowerCase();
  if (/insufficient_quota|payment|quota|credit|billing/.test(lc) && res.status !== 401) return asrErr("quota_exhausted", detail, opts);
  if (res.status < 500 && /throttl|limitexceeded|too_many_requests|rate_limit|resource_exhausted/.test(lc)) return asrErr("rate_limited", detail, opts);
  if (res.status < 500 && /unrecognizedclient|accessdenied|invalidsignature|signaturedoesnotmatch|expiredtoken|invalid_auth|unauthenticated|permission_denied/.test(lc))
    return asrErr("auth_failed", detail, opts);
  switch (res.status) {
    case 401:
    case 403:
      return asrErr("auth_failed", detail, opts);
    case 402:
      return asrErr("quota_exhausted", detail, opts);
    case 404:
      return /model/.test(lc) ? asrErr("model_not_found", detail, opts) : asrErr("bad_request", detail, opts);
    case 408:
    case 504:
      return asrErr("timeout", detail, opts);
    case 413:
      return asrErr("bad_request", detail, { ...opts, reason: "too_large" });
    case 415:
      return asrErr("bad_request", detail, { ...opts, reason: "unsupported_format" });
    case 429:
      return asrErr("rate_limited", detail, opts);
    case 503:
    case 529:
      return asrErr(res.status === 529 || /overload/.test(lc) ? "overloaded" : "unavailable", detail, opts);
  }
  if (res.status >= 500) return asrErr("unavailable", detail, opts);
  if (/longer than|too long|maximum.*(duration|length|seconds)|duration.*exceed/.test(lc))
    return asrErr("bad_request", detail, { ...opts, reason: "too_long" });
  if (/too large|file size|exceeds.*size|payload/.test(lc)) return asrErr("bad_request", detail, { ...opts, reason: "too_large" });
  if (/format|codec|decode|unsupported|corrupt/.test(lc)) return asrErr("bad_request", detail, { ...opts, reason: "unsupported_format" });
  return asrErr("bad_request", detail, opts);
}

export async function expectJson<T = any>(res: Response, vendor: string): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res, vendor);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw asrErr("unavailable", `${vendor}: response is not JSON`);
  }
}

export async function expectOk(res: Response, vendor: string): Promise<void> {
  if (!res.ok) throw await errorFromResponse(res, vendor);
  await res.body?.cancel().catch(() => undefined);
}

export async function fileBlob(part: AudioPart): Promise<Blob> {
  return openAsBlob(part.path, { type: part.mime });
}

export const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function str(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function requireStr(fields: Record<string, unknown>, key: string, kind: string): string {
  const v = str(fields, key);
  if (!v) throw asrErr("bad_request", `${kind}: missing field ${key}`);
  return v;
}

export function num(fields: Record<string, unknown>, key: string): number | undefined {
  const v = fields[key];
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function bool(fields: Record<string, unknown>, key: string, dflt = false): boolean {
  const v = fields[key];
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return dflt;
}

/** Poll loop with backoff (interval → ×1.5 up to 60 s), honours signal. */
export async function pollUntil<T>(
  fn: () => Promise<{ done: true; value: T } | { done: false }>,
  opts: { intervalMs: number; maxMs: number; signal: AbortSignal; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.maxMs;
  let wait = opts.intervalMs;
  for (;;) {
    const r = await fn();
    if (r.done) return r.value;
    if (Date.now() + wait > deadline) throw asrErr("timeout", `${opts.what}: still running after ${Math.round(opts.maxMs / 1000)} s`);
    await sleep(wait, opts.signal);
    wait = Math.min(Math.round(wait * 1.5), Math.max(opts.intervalMs, 60_000));
  }
}
