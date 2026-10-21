/**
 * Encrypted OAuth token storage with cross-process single-flight refresh:
 * BEGIN → SELECT … FOR UPDATE → re-read → refreshIfNeeded → UPDATE → COMMIT (docs/ai-asr-oauth.md "Refresh").
 * The refresh request is never aborted by callers (rotating refresh tokens break when interrupted).
 */
import type { Db } from "../../db.js";
import { transaction } from "../../db.js";
import { AiError } from "../errors.js";
import { isReauthRequired, needsRefresh, OAUTH_REAUTH_ZH, refreshIfNeeded, type OAuthHttp, type OAuthTokens, type RefreshOptions } from "../oauth/index.js";
import { decryptJson, encryptJson, oauthAad } from "./crypto.js";
import type { OAuthMeta } from "./store.js";

export type TokenStoreOptions = { http?: OAuthHttp; now?: () => number; refresh?: RefreshOptions["refresh"] };

const cache = new Map<string, OAuthTokens>();

export function metaFor(tokens: OAuthTokens, status: OAuthMeta["status"] = "connected"): OAuthMeta {
  return { status, email: tokens.email, planType: tokens.planType, expiresAt: tokens.expiresAt, connectedAt: tokens.obtainedAt };
}

/** Stores freshly obtained tokens (login completed / setup-token pasted). */
export async function saveTokens(db: Pick<Db, "query">, providerId: string, tokens: OAuthTokens) {
  cache.delete(providerId);
  await db.query("UPDATE ai_providers SET oauth_tokens=$2, oauth_meta=$3, updated_at=now() WHERE id=$1", [
    providerId,
    encryptJson(tokens, oauthAad(providerId)),
    JSON.stringify(metaFor(tokens)),
  ]);
}

export async function clearTokens(db: Pick<Db, "query">, providerId: string) {
  cache.delete(providerId);
  await db.query(`UPDATE ai_providers SET oauth_tokens=NULL, oauth_meta='{"status":"none"}', updated_at=now() WHERE id=$1`, [providerId]);
}

export function forgetCachedTokens(providerId?: string) {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}

/** Returns valid tokens for a subscription account, refreshing under a row lock when needed. */
export async function getTokens(db: Db, providerId: string, opts: TokenStoreOptions = {}): Promise<OAuthTokens> {
  const now = opts.now ?? Date.now;
  const hit = cache.get(providerId);
  if (hit && !needsRefresh(hit, now())) return hit;
  try {
    const tokens = await transaction(db, async (client) => {
      const row = (await client.query<{ oauth_tokens: Buffer | null }>("SELECT oauth_tokens FROM ai_providers WHERE id=$1 FOR UPDATE", [providerId])).rows[0];
      if (!row?.oauth_tokens) throw new AiError("auth_failed", { vendorMessage: "subscription account not signed in", providerId });
      const current = decryptJson<OAuthTokens>(row.oauth_tokens, oauthAad(providerId));
      const r = await refreshIfNeeded(current, now(), { key: providerId, http: opts.http, refresh: opts.refresh });
      if (r.refreshed) {
        await client.query("UPDATE ai_providers SET oauth_tokens=$2, oauth_meta=$3 WHERE id=$1", [
          providerId,
          encryptJson(r.tokens, oauthAad(providerId)),
          JSON.stringify(metaFor(r.tokens)),
        ]);
      }
      return r.tokens;
    });
    cache.set(providerId, tokens);
    return tokens;
  } catch (e) {
    if (isReauthRequired(e)) {
      cache.delete(providerId);
      await db
        .query(`UPDATE ai_providers SET oauth_meta = oauth_meta || '{"status":"needs_reauth"}'::jsonb WHERE id=$1`, [providerId])
        .catch(() => undefined);
      throw new AiError("auth_failed", { vendorMessage: OAUTH_REAUTH_ZH, providerId, retryable: false });
    }
    throw e;
  }
}
