/**
 * Token refresh policy with single-flight semantics.
 *
 * Refresh tokens ROTATE: using one twice (two concurrent refreshes) or aborting a refresh after it
 * was sent can invalidate the account (`refresh_token_reused` / `_invalidated`). Therefore:
 *
 * 1. Cross-process: the CALLER holds a Postgres row lock on the provider account for the whole
 *    read → refresh → write sequence:
 *
 *      BEGIN;
 *      SELECT … FROM ai_provider_accounts WHERE id = $1 FOR UPDATE;   -- re-read tokens under the lock
 *      const r = await refreshIfNeeded(tokens, Date.now(), { key: id });
 *      if (r.refreshed) UPDATE … SET ciphertext = encrypt(r.tokens) …;
 *      COMMIT;
 *
 *    Re-reading after taking the lock means a request that waited behind another one sees the
 *    already-rotated tokens and does not refresh again.
 * 2. In-process: concurrent calls with the same `key` share one in-flight refresh promise.
 * 3. The refresh HTTP request is never aborted by a caller's AbortSignal (none is accepted here);
 *    it only has its own timeout. If the process dies between the HTTP call and COMMIT, the
 *    new refresh token is lost: the account will need a re-login (accepted risk).
 * 4. Permanent failures (`reauthRequired`) → caller marks the account `needs_reauth`.
 */
import { CHATGPT, refreshChatgptTokens } from "./chatgpt.js";
import { CLAUDE, refreshClaudeTokens } from "./claude.js";
import type { OAuthHttp, OAuthTokens } from "./types.js";

export type RefreshOptions = {
  /** Account id; concurrent calls with the same key share one refresh. */
  key?: string;
  http?: OAuthHttp;
  /** Refresh when the access token expires within this window (default per provider: 5 min). */
  skewMs?: number;
  /** Also refresh when the last refresh is older than this (ChatGPT: 8 days, like Codex). */
  maxAgeMs?: number;
  /** Force a refresh (e.g. after a 401 from the API; do it once, then give up). */
  force?: boolean;
  /** Injected refresh function (tests / other providers). */
  refresh?: (tokens: OAuthTokens, http: OAuthHttp, now: number) => Promise<OAuthTokens>;
};

const inflight = new Map<string, Promise<OAuthTokens>>();

export function needsRefresh(tokens: OAuthTokens, now: number, opts: Pick<RefreshOptions, "skewMs" | "maxAgeMs" | "force"> = {}): boolean {
  if (!tokens.refreshToken) return false; // setup-token / long-lived: nothing to do
  if (opts.force) return true;
  const skew = opts.skewMs ?? (tokens.provider === "chatgpt" ? CHATGPT.refreshSkewMs : CLAUDE.refreshSkewMs);
  if (tokens.expiresAt != null && tokens.expiresAt - now <= skew) return true;
  const maxAge = opts.maxAgeMs ?? (tokens.provider === "chatgpt" ? CHATGPT.maxTokenAgeMs : undefined);
  return maxAge != null && now - tokens.obtainedAt >= maxAge;
}

export async function refreshIfNeeded(tokens: OAuthTokens, now: number, opts: RefreshOptions = {}): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
  if (!needsRefresh(tokens, now, opts)) return { tokens, refreshed: false };
  const fn = opts.refresh ?? (tokens.provider === "chatgpt" ? refreshChatgptTokens : refreshClaudeTokens);
  const key = opts.key ? `${tokens.provider}:${opts.key}` : undefined;
  const existing = key ? inflight.get(key) : undefined;
  if (existing) return { tokens: await existing, refreshed: true };
  const p = fn(tokens, opts.http ?? {}, now);
  if (key) {
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => undefined);
  }
  return { tokens: await p, refreshed: true };
}
