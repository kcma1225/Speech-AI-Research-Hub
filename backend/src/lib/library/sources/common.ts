import type { RateLimiter } from "../http.js";

export interface SourceOptions {
  /** Override the API base URL (tests, mirrors). */
  baseUrl?: string;
  /** Override the shared per-source limiter (tests). */
  limiter?: RateLimiter;
  /** Contact address for polite pools / User-Agent. */
  contactEmail?: string;
  timeoutMs?: number;
}

export interface SearchOptions {
  /** Max results from this source (each source caps it to its API maximum). */
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  signal?: AbortSignal;
}

export const clampLimit = (n: number | undefined, max: number, dflt = 10): number => Math.max(1, Math.min(max, Math.floor(n ?? dflt)));

export const trimSlash = (s: string): string => s.replace(/\/+$/, "");
