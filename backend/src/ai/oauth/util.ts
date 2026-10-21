import { createHash, randomBytes } from "node:crypto";
import { AiError, type AiErrorCode } from "../errors.js";
import type { OAuthHttp } from "./types.js";

/** Decodes a JWT payload without verifying it (we only read our own tokens' claims). */
export function decodeJwtPayload(jwt: string | undefined): Record<string, any> | undefined {
  if (!jwt) return undefined;
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const randomState = () => randomBytes(24).toString("base64url");

/** AiError with a `reauthRequired` flag: the stored credential is dead, the admin must sign in again. */
export type OAuthError = AiError & { reauthRequired?: boolean };

export function oauthErr(code: AiErrorCode, detail: string, opts: { status?: number; vendorCode?: string; reauth?: boolean; retryAfterMs?: number; cause?: unknown } = {}): OAuthError {
  const e: OAuthError = new AiError(code, { vendorMessage: detail, status: opts.status, vendorCode: opts.vendorCode, retryAfterMs: opts.retryAfterMs, cause: opts.cause });
  if (opts.reauth) e.reauthRequired = true;
  return e;
}

export const isReauthRequired = (e: unknown) => !!(e as OAuthError | null)?.reauthRequired;

/**
 * POST to a token endpoint. Response bodies of token endpoints are never put in error messages
 * (they can echo credentials); only status and the OAuth `error` code are kept.
 * `signal` is intentionally not supported for refreshes (see refresh.ts).
 */
export async function postToken(
  http: OAuthHttp,
  url: string,
  body: Record<string, string>,
  encoding: "json" | "form",
  signal?: AbortSignal,
): Promise<{ status: number; json: any }> {
  const f = http.fetch ?? fetch;
  const t = AbortSignal.timeout(http.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": encoding === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
      body: encoding === "json" ? JSON.stringify(body) : new URLSearchParams(body),
      signal: signal ? AbortSignal.any([signal, t]) : t,
    });
  } catch (e) {
    throw oauthErr(t.aborted ? "timeout" : "unavailable", `token endpoint unreachable: ${(e as Error).name}`, { cause: undefined });
  }
  const text = await res.text().catch(() => "");
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/** OAuth error code from a token-endpoint body (`error`, `error.code`, `code`). */
export function oauthErrorCode(json: any): string | undefined {
  const e = json?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") return e.code ?? e.type;
  return json?.code ?? json?.detail?.code;
}

export function expiryFrom(json: { expires_in?: number }, accessToken: string, now: number): number | undefined {
  if (typeof json.expires_in === "number") return now + json.expires_in * 1000;
  const exp = decodeJwtPayload(accessToken)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

const PERMANENT = /refresh_token_(expired|reused|invalidated)|invalid_grant|invalid_refresh_token|token_expired|invalid_client/;

/** Classifies a failed token-endpoint call; permanent failures set `reauthRequired`. */
export function tokenError(what: string, status: number, json: any): AiError {
  const code = oauthErrorCode(json);
  const permanent = status === 401 || (code != null && PERMANENT.test(code));
  if (permanent) return oauthErr("auth_failed", `${what}: ${code ?? `HTTP ${status}`} (re-login required)`, { status, vendorCode: code, reauth: true });
  if (status === 429) return oauthErr("rate_limited", `${what}: HTTP 429`, { status, vendorCode: code });
  if (status >= 500 || status === 0) return oauthErr("unavailable", `${what}: HTTP ${status}`, { status, vendorCode: code });
  return oauthErr("bad_request", `${what}: ${code ?? `HTTP ${status}`}`, { status, vendorCode: code });
}

