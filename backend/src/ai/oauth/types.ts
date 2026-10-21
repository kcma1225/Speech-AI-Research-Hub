/**
 * Subscription OAuth (EXPERIMENTAL, POC only): ChatGPT (Codex device-code login) and Claude
 * (Claude Code copy-code login / setup-token / CLI). Storage, encryption and row locking are the
 * caller's job; this module never logs tokens.
 */

export type SubscriptionProvider = "chatgpt" | "claude";

/** Token set as stored (encrypted) by the caller. Times are epoch ms. */
export type OAuthTokens = {
  provider: SubscriptionProvider;
  accessToken: string;
  /** Rotating: every refresh returns a new one and invalidates the old one. Absent for setup-tokens. */
  refreshToken?: string;
  idToken?: string;
  /** Access-token expiry (epoch ms); undefined = unknown / long-lived. */
  expiresAt?: number;
  /** When the last successful refresh (or login) happened. */
  obtainedAt: number;
  scope?: string;
  /** ChatGPT account id (`ChatGPT-Account-ID` header). */
  accountId?: string;
  /** Non-secret metadata for the admin UI. */
  email?: string;
  planType?: string;
};

export type OAuthHttp = {
  fetch?: typeof fetch;
  /** Override endpoints (tests / future URL moves). */
  endpoints?: Partial<Record<string, string>>;
  /** Default 30 s. Refresh requests are never aborted by callers (rotating tokens). */
  timeoutMs?: number;
};
