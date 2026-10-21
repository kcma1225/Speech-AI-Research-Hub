import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourceName } from "./types.js";

// ---------------------------------------------------------------- rate limiting

export interface RateLimitOptions {
  /** Minimum spacing between request starts, ms (token refill interval). */
  intervalMs: number;
  /** Bucket size: how many requests may start back-to-back. Default 1. */
  burst?: number;
  /** Max requests in flight. Default 1. */
  concurrency?: number;
}

/** Token bucket + concurrency gate. One instance per external source, shared by all callers. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private active = 0;
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Earliest time the next request may start (set by Retry-After / Backoff headers). */
  private pausedUntil = 0;

  constructor(readonly opts: RateLimitOptions) {
    this.tokens = opts.burst ?? 1;
  }

  /** Pause all requests from this limiter for `ms` (server asked us to back off). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private refill(): void {
    const now = Date.now();
    const burst = this.opts.burst ?? 1;
    const add = (now - this.last) / this.opts.intervalMs;
    if (add > 0) {
      this.tokens = Math.min(burst, this.tokens + add);
      this.last = now;
    }
  }

  private pump(): void {
    if (this.timer) return;
    const conc = this.opts.concurrency ?? 1;
    while (this.queue.length && this.active < conc) {
      const now = Date.now();
      if (now < this.pausedUntil) return this.wait(this.pausedUntil - now);
      this.refill();
      if (this.tokens < 1) return this.wait(Math.ceil((1 - this.tokens) * this.opts.intervalMs));
      this.tokens -= 1;
      this.active++;
      this.queue.shift()!();
    }
  }

  private wait(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, ms));
    this.timer.unref?.();
  }
}

/** Default limits per source (research doc Part C). */
export type LimiterName = Exclude<SourceName, "pdf"> | "download";

export const DEFAULT_LIMITS: Record<LimiterName, RateLimitOptions> = {
  arxiv: { intervalMs: 3000, burst: 1, concurrency: 1 }, // ToU: 1 request / 3 s, one connection
  s2: { intervalMs: 1000, burst: 1, concurrency: 1 }, // key: 1 RPS
  openalex: { intervalMs: 100, burst: 5, concurrency: 3 }, // ≤10/s
  crossref: { intervalMs: 334, burst: 3, concurrency: 3 }, // polite list pool: 3/s, concurrency 3
  unpaywall: { intervalMs: 200, burst: 2, concurrency: 2 },
  acl: { intervalMs: 1000, burst: 1, concurrency: 1 },
  isca: { intervalMs: 2000, burst: 1, concurrency: 1 },
  zotero: { intervalMs: 500, burst: 2, concurrency: 1 },
  grobid: { intervalMs: 50, burst: 4, concurrency: 2 },
  download: { intervalMs: 200, burst: 3, concurrency: 3 },
};

const shared = new Map<string, RateLimiter>();

/** Process-wide limiter for a source, so rebuilding clients (e.g. after a key change) keeps the limits. */
export function sharedLimiter(name: LimiterName): RateLimiter {
  let l = shared.get(name);
  if (!l) {
    l = new RateLimiter(DEFAULT_LIMITS[name]);
    shared.set(name, l);
  }
  return l;
}

// ---------------------------------------------------------------- errors

/** External source failure. `message` is 繁中 for the UI; `status` is the HTTP status (0 = network/timeout). */
export class SourceError extends Error {
  constructor(
    readonly source: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const SOURCE_LABEL: Record<string, string> = {
  openalex: "OpenAlex", s2: "Semantic Scholar", arxiv: "arXiv", crossref: "Crossref", acl: "ACL Anthology",
  isca: "ISCA Archive", unpaywall: "Unpaywall", zotero: "Zotero", grobid: "GROBID", download: "PDF 下載",
};
export const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s;

// ---------------------------------------------------------------- fetch

export interface RequestOptions {
  source: string;
  limiter?: RateLimiter;
  headers?: Record<string, string>;
  method?: string;
  body?: RequestInit["body"];
  timeoutMs?: number;
  /** Retries for 429/5xx/network errors (default 2). Respects Retry-After. */
  retries?: number;
  /** Statuses returned to the caller instead of thrown (e.g. 404 → "not found"). */
  okStatuses?: number[];
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after") ?? res.headers.get("backoff");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(n * 1000, 60_000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.min(Math.max(0, t - Date.now()), 60_000) : undefined;
}

/** Rate-limited fetch with timeout and polite retries. Throws SourceError. */
export async function request(url: string, opts: RequestOptions): Promise<Response> {
  const retries = opts.retries ?? 2;
  const label = sourceLabel(opts.source);
  for (let attempt = 0; ; attempt++) {
    const run = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        return await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body, signal: ctrl.signal, redirect: "follow" });
      } finally {
        clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    };
    let res: Response;
    try {
      res = opts.limiter ? await opts.limiter.schedule(run) : await run();
    } catch (e) {
      if (opts.signal?.aborted) throw new SourceError(opts.source, 0, `${label} 請求已取消`);
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const timeout = (e as Error).name === "AbortError";
      throw new SourceError(opts.source, 0, timeout ? `${label} 回應逾時` : `無法連線到 ${label}`);
    }
    // Zotero sends Backoff on success too.
    const backoff = res.headers.get("backoff");
    if (backoff && opts.limiter) opts.limiter.pause(Math.min(Number(backoff) * 1000 || 0, 60_000));
    if (res.ok || opts.okStatuses?.includes(res.status)) return res;
    if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < retries) {
      const wait = retryAfterMs(res) ?? 1000 * 2 ** attempt;
      opts.limiter?.pause(wait);
      await res.body?.cancel().catch(() => {});
      if (!opts.limiter) await sleep(wait);
      continue;
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 429) throw new SourceError(opts.source, 429, `${label} 請求太頻繁，請稍後再試`);
    if (res.status === 401 || res.status === 403) throw new SourceError(opts.source, res.status, `${label} 拒絕存取（API key 無效或未設定）`);
    throw new SourceError(opts.source, res.status, `${label} 回應錯誤（HTTP ${res.status}）`);
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions): Promise<{ status: number; data: T | null; headers: Headers }> {
  const res = await request(url, { okStatuses: [404], ...opts, headers: { accept: "application/json", ...opts.headers } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, data: null, headers: res.headers };
  }
  try {
    return { status: res.status, data: (await res.json()) as T, headers: res.headers };
  } catch {
    throw new SourceError(opts.source, res.status, `${sourceLabel(opts.source)} 回應的 JSON 格式錯誤`);
  }
}

export async function requestText(url: string, opts: RequestOptions): Promise<{ status: number; text: string | null; headers: Headers }> {
  const res = await request(url, { okStatuses: [404], ...opts });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, text: null, headers: res.headers };
  }
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** User-Agent with a contact address (Crossref polite pool asks for one). */
export function userAgent(contactEmail?: string): string {
  return `SpeechAIResearchHub/3 (+https://speech-ai-hub.gugulu.tw${contactEmail ? `; mailto:${contactEmail}` : ""})`;
}

// ---------------------------------------------------------------- SSRF guard

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a, b] = [p[0]!, p[1]!];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateV4(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

/** Reject non-http(s) URLs and hosts that resolve to private/loopback addresses (user-supplied URLs). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("download", 0, "網址格式錯誤");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SourceError("download", 0, "只支援 http/https 網址");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new SourceError("download", 0, `找不到主機 ${host}`);
  if (addrs.some(isPrivateIp)) throw new SourceError("download", 0, "不允許連到內部網路位址");
  return u;
}
