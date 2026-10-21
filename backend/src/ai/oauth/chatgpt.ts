/**
 * ChatGPT subscription via the Codex CLI device-code login (EXPERIMENTAL; private endpoint,
 * Codex's public client id). The admin must first enable "device code login" in ChatGPT
 * security settings. Calls go to `chatgpt.com/backend-api/codex/responses` (Responses API, SSE).
 */
import { AiError } from "../errors.js";
import type { OAuthHttp, OAuthTokens } from "./types.js";
import { decodeJwtPayload, expiryFrom, oauthErr, postToken, tokenError } from "./util.js";

export const CHATGPT = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  issuer: "https://auth.openai.com",
  userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  verificationUrl: "https://auth.openai.com/codex/device",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  tokenUrl: "https://auth.openai.com/oauth/token",
  revokeUrl: "https://auth.openai.com/oauth/revoke",
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  /** Device codes expire after 15 min. */
  deviceCodeTtlMs: 15 * 60_000,
  /** Codex refreshes when the access token expires within 5 min or is older than 8 days. */
  refreshSkewMs: 5 * 60_000,
  maxTokenAgeMs: 8 * 24 * 3600_000,
} as const;

const ep = (http: OAuthHttp, k: keyof typeof CHATGPT) => (http.endpoints?.[k] as string | undefined) ?? (CHATGPT[k] as string);

export type DeviceLogin = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSec: number;
  expiresAt: number;
};

/** Step 1: get a user code to show the admin. 404 → device login not enabled. */
export async function startChatgptDeviceLogin(http: OAuthHttp = {}, now = Date.now()): Promise<DeviceLogin> {
  const f = http.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(ep(http, "userCodeUrl"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: ep(http, "clientId") }),
      signal: AbortSignal.timeout(http.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw oauthErr("unavailable", `chatgpt device login unreachable: ${(e as Error).name}`);
  }
  if (res.status === 404) throw oauthErr("unsupported", "chatgpt: device code login is not enabled (ChatGPT → Settings → Security)", { status: 404 });
  if (!res.ok) throw oauthErr(res.status === 429 ? "rate_limited" : res.status >= 500 ? "unavailable" : "bad_request", `chatgpt usercode HTTP ${res.status}`, { status: res.status });
  const j = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number };
  const interval = Number(j.interval ?? 5);
  return {
    deviceAuthId: j.device_auth_id,
    userCode: String(j.user_code ?? j.usercode ?? ""),
    verificationUrl: ep(http, "verificationUrl"),
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 5,
    expiresAt: now + CHATGPT.deviceCodeTtlMs,
  };
}

export type DevicePollResult = { status: "pending" } | { status: "expired" } | { status: "complete"; tokens: OAuthTokens };

/**
 * Step 2 (call every `intervalSec`): one poll. 403/404 = still pending. On success exchanges the
 * returned authorization code + verifier for tokens.
 */
export async function pollChatgptDeviceLogin(login: DeviceLogin, http: OAuthHttp = {}, now = Date.now()): Promise<DevicePollResult> {
  if (now > login.expiresAt) return { status: "expired" };
  const f = http.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(ep(http, "deviceTokenUrl"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
      signal: AbortSignal.timeout(http.timeoutMs ?? 30_000),
    });
  } catch {
    return { status: "pending" }; // transient; keep polling until expiry
  }
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return { status: "pending" };
  }
  if (!res.ok) throw oauthErr(res.status >= 500 ? "unavailable" : "bad_request", `chatgpt device token HTTP ${res.status}`, { status: res.status });
  const j = (await res.json()) as { authorization_code: string; code_verifier: string };
  const tokens = await exchangeChatgptCode(j.authorization_code, j.code_verifier, ep(http, "deviceRedirectUri"), http, now);
  return { status: "complete", tokens };
}

/** Authorization-code exchange (device flow or a pasted loopback redirect). */
export async function exchangeChatgptCode(code: string, verifier: string, redirectUri: string, http: OAuthHttp = {}, now = Date.now()): Promise<OAuthTokens> {
  const { status, json } = await postToken(
    http,
    ep(http, "tokenUrl"),
    { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: ep(http, "clientId"), code_verifier: verifier },
    "form",
  );
  if (status !== 200 || !json.access_token) throw tokenError("chatgpt code exchange", status, json);
  return chatgptTokensFrom(json, undefined, now);
}

/** Builds the stored token set; keeps previous refresh/id tokens when the response omits them. */
export function chatgptTokensFrom(json: any, prev: OAuthTokens | undefined, now: number): OAuthTokens {
  const idToken: string | undefined = json.id_token ?? prev?.idToken;
  const claims = chatgptClaims(idToken);
  return {
    provider: "chatgpt",
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? prev?.refreshToken,
    idToken,
    expiresAt: expiryFrom(json, json.access_token, now),
    obtainedAt: now,
    scope: json.scope ?? prev?.scope,
    accountId: claims.accountId ?? prev?.accountId,
    email: claims.email ?? prev?.email,
    planType: claims.planType ?? prev?.planType,
  };
}

/** Reads account id / plan / email from the id_token (`https://api.openai.com/auth` namespace). */
export function chatgptClaims(idToken: string | undefined): { accountId?: string; planType?: string; email?: string; fedramp?: boolean } {
  const p = decodeJwtPayload(idToken);
  if (!p) return {};
  const ns = p["https://api.openai.com/auth"] ?? {};
  return {
    accountId: ns.chatgpt_account_id ?? p.chatgpt_account_id ?? p.organizations?.[0]?.id,
    planType: ns.chatgpt_plan_type ?? p.chatgpt_plan_type,
    email: p.email ?? p["https://api.openai.com/profile"]?.email,
    fedramp: ns.chatgpt_account_is_fedramp === true,
  };
}

/**
 * Refresh (rotating). Do not call directly from request paths: use `refreshIfNeeded` under the
 * account row lock. Throws OAuthError with `reauthRequired` for permanent failures.
 */
export async function refreshChatgptTokens(tokens: OAuthTokens, http: OAuthHttp = {}, now = Date.now()): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw oauthErr("auth_failed", "chatgpt: no refresh token", { reauth: true });
  const { status, json } = await postToken(
    http,
    ep(http, "tokenUrl"),
    { client_id: ep(http, "clientId"), grant_type: "refresh_token", refresh_token: tokens.refreshToken, scope: "openid profile email" },
    "json",
  );
  if (status !== 200 || !json.access_token) throw tokenError("chatgpt refresh", status, json);
  return chatgptTokensFrom(json, tokens, now);
}

export async function revokeChatgpt(tokens: OAuthTokens, http: OAuthHttp = {}): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken;
  await postToken(http, ep(http, "revokeUrl"), { token, token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token", client_id: ep(http, "clientId") }, "json").catch(() => undefined);
}

// ---------------------------------------------------------------- request decoration

export type CodexRequestInput = {
  tokens: OAuthTokens;
  /** OpenAI Responses API body built by the `openai-responses` codec. */
  body: Record<string, unknown>;
  /** Stable per conversation: ChatGPT derives prompt-cache affinity from it. */
  sessionId?: string;
  originator?: string;
  userAgent?: string;
  baseUrl?: string;
};

/**
 * Fields the ChatGPT backend rejects. `temperature` / `top_p` answer HTTP 400 `{"detail":"Unsupported parameter: temperature"}`
 * (seen 2026-10 with gpt-5.6-luna): the slides visual self-check and other callers that pass a temperature failed on it.
 */
export const CODEX_STRIPPED_FIELDS = ["max_output_tokens", "temperature", "top_p", "previous_response_id", "metadata", "user", "safety_identifier", "prompt_cache_retention", "background", "truncation"];

/**
 * Turns a Responses API request into a Codex backend request:
 * `store:false`, `stream:true`, encrypted reasoning included (full history is resent each turn),
 * unsupported fields removed, Codex headers added.
 */
/**
 * Codex CLI version we present. The backend filters models by `minimal_client_version` (e.g. 0.153.0 in 2026-10):
 * an old value returns an empty model list. Keep it near the current `@openai/codex` release.
 */
export const CODEX_CLIENT_VERSION = "0.163.0";

export function decorateCodexRequest(input: CodexRequestInput): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const body: Record<string, unknown> = { ...input.body, store: false, stream: true };
  for (const k of CODEX_STRIPPED_FIELDS) delete body[k];
  const include = new Set<string>(Array.isArray(body.include) ? (body.include as string[]) : []);
  include.add("reasoning.encrypted_content");
  body.include = [...include];
  if (input.sessionId && body.prompt_cache_key == null) body.prompt_cache_key = input.sessionId;
  const claims = chatgptClaims(input.tokens.idToken);
  const accountId = input.tokens.accountId ?? claims.accountId;
  if (!accountId) throw oauthErr("auth_failed", "chatgpt: account id missing from id_token", { reauth: true });
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.tokens.accessToken}`,
    "chatgpt-account-id": accountId,
    originator: input.originator ?? "codex_cli_rs",
    "user-agent": input.userAgent ?? `codex_cli_rs/${CODEX_CLIENT_VERSION} (Linux; x86_64) speech-ai-hub`,
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (input.sessionId) {
    headers["session-id"] = input.sessionId;
    headers["thread-id"] = input.sessionId;
  }
  if (claims.fedramp) headers["x-openai-fedramp"] = "true";
  return { url: `${(input.baseUrl ?? CHATGPT.codexBaseUrl).replace(/\/+$/, "")}/responses`, headers, body };
}

export const codexModelsUrl = (clientVersion = CODEX_CLIENT_VERSION, baseUrl: string = CHATGPT.codexBaseUrl) => `${baseUrl.replace(/\/+$/, "")}/models?client_version=${encodeURIComponent(clientVersion)}`;

/** Models visible in the picker (`visibility == "list"`). */
export function parseCodexModels(json: any): { id: string; label: string; contextWindow?: number }[] {
  return (json?.models ?? [])
    .filter((m: any) => (m.visibility ?? "list") === "list")
    .map((m: any) => ({ id: m.slug, label: m.display_name ?? m.slug, contextWindow: m.context_window }));
}

export type CodexRateLimits = { primaryUsedPercent?: number; primaryResetAt?: number; secondaryUsedPercent?: number; secondaryResetAt?: number; limitReached?: string };

export function parseCodexRateLimits(h: Headers): CodexRateLimits {
  const n = (k: string) => {
    const v = h.get(k);
    return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const at = (k: string) => {
    const v = n(k);
    return v != null ? (v < 1e12 ? v * 1000 : v) : undefined;
  };
  return {
    primaryUsedPercent: n("x-codex-primary-used-percent"),
    primaryResetAt: at("x-codex-primary-reset-at"),
    secondaryUsedPercent: n("x-codex-secondary-used-percent"),
    secondaryResetAt: at("x-codex-secondary-reset-at"),
    limitReached: h.get("x-codex-rate-limit-reached-type") ?? undefined,
  };
}

/** Codex-specific error table (try before the generic classifier). */
export function mapCodexError(status: number, body: any, now = Date.now()): AiError | undefined {
  const e = body?.error ?? body?.response?.error ?? {};
  const code: string | undefined = e.type ?? e.code;
  if (code === "usage_limit_reached") {
    const resetsAt = typeof e.resets_at === "number" ? e.resets_at * 1000 : undefined;
    return oauthErr("quota_exhausted", `chatgpt usage limit reached (plan ${e.plan_type ?? "?"})`, { status, vendorCode: code, retryAfterMs: resetsAt ? Math.max(0, resetsAt - now) : undefined });
  }
  if (code === "usage_not_included" || code === "insufficient_quota") return oauthErr("quota_exhausted", `chatgpt: ${code}`, { status, vendorCode: code });
  if (code === "context_length_exceeded") return oauthErr("context_too_long", "chatgpt: context_length_exceeded", { status, vendorCode: code });
  if (status === 401) return oauthErr("auth_failed", "chatgpt: access token rejected", { status, vendorCode: code });
  return undefined;
}
