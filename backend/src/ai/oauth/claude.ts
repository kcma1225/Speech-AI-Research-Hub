/**
 * Claude subscription via Claude Code's OAuth client, "copy code" flow (EXPERIMENTAL).
 * The admin opens the authorize URL, signs in on claude.ai, copies the displayed `code#state`
 * and pastes it into the hub. Anthropic's terms forbid this for third-party apps, and since
 * 2026-04-04 such usage is billed as "extra usage" per token, not against plan limits.
 * Alternative: paste a one-year `claude setup-token` token (no refresh), or use the CLI adapter.
 */
import type { OAuthHttp, OAuthTokens } from "./types.js";
import { expiryFrom, oauthErr, pkcePair, postToken, randomState, tokenError } from "./util.js";

export const CLAUDE = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  apiBaseUrl: "https://api.anthropic.com",
  /** First system block required for OAuth tokens. */
  systemPrefix: "You are Claude Code, Anthropic's official CLI for Claude.",
  betas: ["claude-code-20250219", "oauth-2025-04-20"],
  /** Claude Code version reported in user-agent; stale versions have been flagged before. */
  cliVersion: "2.1.304",
  refreshSkewMs: 5 * 60_000,
  /** PKCE/state lifetime for a pending login (caller enforces it). */
  pendingTtlMs: 10 * 60_000,
} as const;

const ep = (http: OAuthHttp, k: keyof typeof CLAUDE) => (http.endpoints?.[k] as string | undefined) ?? (CLAUDE[k] as string);

/** Pending login to keep server-side (bound to the admin session, ≤ 10 min). Never put verifier in a URL. */
export type ClaudePendingLogin = { state: string; verifier: string; createdAt: number; authorizeUrl: string };

export function startClaudeLogin(http: OAuthHttp = {}, now = Date.now()): ClaudePendingLogin {
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const q = new URLSearchParams({
    code: "true",
    client_id: ep(http, "clientId"),
    response_type: "code",
    redirect_uri: ep(http, "redirectUri"),
    scope: ep(http, "scopes"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { state, verifier, createdAt: now, authorizeUrl: `${ep(http, "authorizeUrl")}?${q}` };
}

/** Accepts `code#state`, a full callback URL (`?code=…&state=…`), or a bare code. */
export function parsePastedClaudeCode(input: string): { code: string; state?: string } {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    const code = u.searchParams.get("code") ?? "";
    const state = u.searchParams.get("state") ?? (u.hash ? u.hash.slice(1) : undefined);
    return { code, state: state || undefined };
  }
  const i = s.indexOf("#");
  return i >= 0 ? { code: s.slice(0, i), state: s.slice(i + 1) || undefined } : { code: s };
}

/** Exchanges the pasted code. Validates `state` against the pending login. */
export async function exchangeClaudeCode(pasted: string, pending: ClaudePendingLogin, http: OAuthHttp = {}, now = Date.now()): Promise<OAuthTokens> {
  if (now - pending.createdAt > CLAUDE.pendingTtlMs) throw oauthErr("bad_request", "claude: login expired, start again");
  const { code, state } = parsePastedClaudeCode(pasted);
  if (!code) throw oauthErr("bad_request", "claude: empty code");
  if (state && state !== pending.state) throw oauthErr("bad_request", "claude: state mismatch");
  const { status, json } = await postToken(
    http,
    ep(http, "tokenUrl"),
    { grant_type: "authorization_code", client_id: ep(http, "clientId"), code, state: pending.state, redirect_uri: ep(http, "redirectUri"), code_verifier: pending.verifier },
    "json",
  );
  if (status !== 200 || !json.access_token) throw tokenError("claude code exchange", status, json);
  return claudeTokensFrom(json, undefined, now);
}

export function claudeTokensFrom(json: any, prev: OAuthTokens | undefined, now: number): OAuthTokens {
  return {
    provider: "claude",
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? prev?.refreshToken,
    expiresAt: expiryFrom(json, json.access_token, now),
    obtainedAt: now,
    scope: json.scope ?? prev?.scope,
    email: json.account?.email_address ?? prev?.email,
    accountId: json.account?.uuid ?? prev?.accountId,
    planType: prev?.planType,
  };
}

/** Rotating refresh. `scope` must be omitted (the endpoint rejects it). */
export async function refreshClaudeTokens(tokens: OAuthTokens, http: OAuthHttp = {}, now = Date.now()): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw oauthErr("auth_failed", "claude: no refresh token (setup-token expired?)", { reauth: true });
  const { status, json } = await postToken(http, ep(http, "tokenUrl"), { grant_type: "refresh_token", client_id: ep(http, "clientId"), refresh_token: tokens.refreshToken }, "json");
  if (status !== 200 || !json.access_token) throw tokenError("claude refresh", status, json);
  return claudeTokensFrom(json, tokens, now);
}

export const isClaudeOAuthToken = (t: string) => t.includes("sk-ant-oat");

/** A pasted `claude setup-token` value (≈1 year, inference only, no refresh). */
export function claudeSetupToken(token: string, now = Date.now()): OAuthTokens {
  const t = token.trim();
  if (!isClaudeOAuthToken(t)) throw oauthErr("bad_request", "claude: not a Claude Code OAuth token (expected sk-ant-oat…)");
  return { provider: "claude", accessToken: t, obtainedAt: now, expiresAt: now + 365 * 24 * 3600_000 };
}

// ---------------------------------------------------------------- request decoration

type SystemBlock = { type: "text"; text: string; [k: string]: unknown };

/**
 * Decorates an Anthropic Messages API request (built by the `anthropic-messages` codec) for an
 * OAuth token: Bearer auth (no x-api-key), Claude Code betas + user-agent, and the required
 * identity system block in front of the real system prompt.
 */
export function decorateClaudeRequest(input: {
  accessToken: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  cliVersion?: string;
}): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  delete headers["x-api-key"];
  const betas = new Set<string>(CLAUDE.betas);
  for (const b of (headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) betas.add(b);
  Object.assign(headers, {
    authorization: `Bearer ${input.accessToken}`,
    "anthropic-version": headers["anthropic-version"] ?? "2023-06-01",
    "anthropic-beta": [...betas].join(","),
    "user-agent": `claude-cli/${input.cliVersion ?? CLAUDE.cliVersion} (external, cli)`,
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  });
  const body = { ...input.body };
  const prefix: SystemBlock = { type: "text", text: CLAUDE.systemPrefix };
  const sys = body.system;
  if (sys == null || sys === "") body.system = [prefix];
  else if (typeof sys === "string") body.system = sys.startsWith(CLAUDE.systemPrefix) ? [prefix, { type: "text", text: sys.slice(CLAUDE.systemPrefix.length).trim() }].filter((b) => b.text) : [prefix, { type: "text", text: sys }];
  else if (Array.isArray(sys)) body.system = (sys[0] as SystemBlock | undefined)?.text === CLAUDE.systemPrefix ? sys : [prefix, ...sys];
  return { url: `${CLAUDE.apiBaseUrl}/v1/messages`, headers, body };
}
