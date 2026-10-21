/**
 * Auth strategies: API-key headers, Google service-account JWT bearer, Azure (api-key |
 * Entra client credentials), AWS (SigV4 | Bedrock API key), OAuth (token from caller).
 * Access tokens are cached in-process until ~5 min before expiry.
 */
import { createHash, createHmac, createSign } from "node:crypto";
import { AiError } from "../errors.js";
import type { AuthSpec, ProviderEntry } from "./entry.js";

export interface SignableRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export interface AuthProvider {
  apply(req: SignableRequest, signal?: AbortSignal): Promise<void>;
}

export interface AuthOptions {
  fetch: typeof fetch;
  /** OAuth extension point: returns a fresh access token (refresh is the caller's job). */
  oauthTokenProvider?: () => Promise<string>;
  now?: () => number;
}

type AuthFactory = (
  spec: AuthSpec,
  entry: ProviderEntry,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  opts: AuthOptions,
) => AuthProvider;

const factories = new Map<string, AuthFactory>();

/** Extension point: register/override an auth strategy by `AuthSpec.type`. */
export function registerAuthStrategy(type: string, factory: AuthFactory) {
  factories.set(type, factory);
}

export function createAuth(
  entry: ProviderEntry,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  opts: AuthOptions,
): AuthProvider {
  const f = factories.get(entry.auth.type);
  if (!f) throw new AiError("unsupported", { vendorMessage: `auth type ${entry.auth.type}`, providerId: entry.id });
  return f(entry.auth, entry, config, secrets, opts);
}

const authMissing = (entry: ProviderEntry, what: string) =>
  new AiError("auth_failed", { vendorMessage: `missing credential: ${what}`, providerId: entry.id });

// ---------------------------------------------------------------- api key / none / oauth

registerAuthStrategy("none", () => ({ apply: async () => {} }));

function headerApplier(header: string, scheme: string | undefined, token: string) {
  return (h: Headers) => h.set(header, scheme ? `${scheme} ${token}` : token);
}

registerAuthStrategy("api_key", (spec, entry, _config, secrets) => {
  if (spec.type !== "api_key") throw new Error("bad spec");
  const key = secrets[spec.secretKey ?? "apiKey"]?.trim();
  const scheme = spec.scheme ?? (spec.header.toLowerCase() === "authorization" ? "Bearer" : undefined);
  return {
    apply: async (req) => {
      if (!key) {
        if (spec.optional) return;
        throw authMissing(entry, spec.secretKey ?? "apiKey");
      }
      headerApplier(spec.header, scheme, key)(req.headers);
    },
  };
});

registerAuthStrategy("oauth", (spec, entry, _config, secrets, opts) => {
  if (spec.type !== "oauth") throw new Error("bad spec");
  return {
    apply: async (req) => {
      const token = opts.oauthTokenProvider ? await opts.oauthTokenProvider() : secrets.accessToken;
      if (!token) throw authMissing(entry, "accessToken");
      headerApplier(spec.header ?? "authorization", spec.scheme ?? "Bearer", token)(req.headers);
    },
  };
});

// ---------------------------------------------------------------- token cache

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();

async function cachedToken(key: string, now: number, fetcher: () => Promise<CachedToken>): Promise<string> {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - 300_000 > now) return hit.token;
  let p = inflight.get(key);
  if (!p) {
    p = fetcher().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const t = await p;
  tokenCache.set(key, t);
  return t.token;
}

/** Test helper. */
export function clearTokenCache() {
  tokenCache.clear();
}

// ---------------------------------------------------------------- Google service account

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

export function parseServiceAccount(raw: string | undefined, providerId?: string): ServiceAccount {
  try {
    const sa = JSON.parse(raw ?? "") as ServiceAccount & { type?: string };
    if (!sa.client_email || !sa.private_key) throw new Error("fields");
    return sa;
  } catch {
    throw new AiError("auth_failed", { vendorMessage: "invalid service account JSON", providerId });
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export async function googleAccessToken(sa: ServiceAccount, scope: string, opts: AuthOptions, signal?: AbortSignal, providerId?: string) {
  const now = (opts.now ?? Date.now)();
  return cachedToken(`gsa:${sa.client_email}:${scope}`, now, async () => {
    const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat, exp: iat + 3600 }));
    let sig: string;
    try {
      sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");
    } catch (e) {
      throw new AiError("auth_failed", { vendorMessage: "service account private_key cannot sign", providerId, cause: e });
    }
    const res = await opts.fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
      signal,
    }).catch((e: unknown) => {
      throw new AiError("unavailable", { vendorMessage: `token endpoint: ${String(e)}`, providerId, cause: e });
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new AiError(res.status >= 500 ? "unavailable" : "auth_failed", { status: res.status, vendorMessage: json.error_description ?? "token exchange failed", providerId });
    }
    return { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  });
}

registerAuthStrategy("google_service_account", (spec, entry, _config, secrets, opts) => {
  if (spec.type !== "google_service_account") throw new Error("bad spec");
  const scope = spec.scope ?? "https://www.googleapis.com/auth/cloud-platform";
  return {
    apply: async (req, signal) => {
      if (secrets.apiKey && !secrets.serviceAccountJson) {
        req.headers.set("x-goog-api-key", secrets.apiKey); // Vertex express mode
        return;
      }
      const sa = parseServiceAccount(secrets.serviceAccountJson, entry.id);
      req.headers.set("authorization", `Bearer ${await googleAccessToken(sa, scope, opts, signal, entry.id)}`);
    },
  };
});

// ---------------------------------------------------------------- Azure

registerAuthStrategy("azure", (spec, entry, config, secrets, opts) => {
  if (spec.type !== "azure") throw new Error("bad spec");
  const mode = String(config.authMode ?? "api_key");
  const scope = String(config.entraScope || spec.entraScope || "https://ai.azure.com/.default");
  return {
    apply: async (req, signal) => {
      if (mode !== "entra") {
        if (!secrets.apiKey) throw authMissing(entry, "apiKey");
        req.headers.set("api-key", secrets.apiKey);
        return;
      }
      const tenant = String(config.tenantId ?? "");
      const clientId = String(config.clientId ?? "");
      const clientSecret = secrets.clientSecret;
      if (!tenant || !clientId || !clientSecret) throw authMissing(entry, "tenantId/clientId/clientSecret");
      const now = (opts.now ?? Date.now)();
      const token = await cachedToken(`azure:${tenant}:${clientId}:${scope}`, now, async () => {
        const res = await opts.fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope }),
          signal,
        }).catch((e: unknown) => {
          throw new AiError("unavailable", { vendorMessage: `entra: ${String(e)}`, providerId: entry.id, cause: e });
        });
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
        if (!res.ok || !json.access_token) throw new AiError("auth_failed", { status: res.status, vendorMessage: json.error_description, providerId: entry.id });
        return { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
      });
      req.headers.set("authorization", `Bearer ${token}`);
    },
  };
});

// ---------------------------------------------------------------- AWS

const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

/** RFC 3986 encoding as SigV4 expects. */
function awsEncode(s: string) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Signs a request in place with AWS Signature V4 (non-S3: path segments double-encoded).
 * `url.pathname` must already be encoded once (as sent on the wire).
 */
export function signSigV4(req: SignableRequest, creds: AwsCredentials, region: string, service: string, now = new Date(), opts: { contentSha256Header?: boolean } = {}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(req.body);
  req.headers.set("host", req.url.host);
  req.headers.set("x-amz-date", amzDate);
  if (opts.contentSha256Header !== false) req.headers.set("x-amz-content-sha256", payloadHash);
  if (creds.sessionToken) req.headers.set("x-amz-security-token", creds.sessionToken);
  const canonicalUri =
    req.url.pathname
      .split("/")
      .map((seg) => awsEncode(seg))
      .join("/") || "/";
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const names = [...req.headers.keys()].map((k) => k.toLowerCase()).filter((k) => k === "host" || k === "content-type" || k.startsWith("x-amz-")).sort();
  const canonicalHeaders = names.map((n) => `${n}:${(req.headers.get(n) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [req.method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  req.headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  // fetch sets Host itself; undici rejects a manual Host header.
  req.headers.delete("host");
}

registerAuthStrategy("aws", (spec, entry, config, secrets, opts) => {
  if (spec.type !== "aws") throw new Error("bad spec");
  const mode = String(config.authMode ?? "sigv4");
  const region = String(config.region ?? "us-east-1");
  return {
    apply: async (req) => {
      if (mode === "bedrock_api_key") {
        if (!secrets.apiKey) throw authMissing(entry, "apiKey");
        req.headers.set("authorization", `Bearer ${secrets.apiKey}`);
        return;
      }
      if (!config.accessKeyId || !secrets.secretAccessKey) throw authMissing(entry, "accessKeyId/secretAccessKey");
      // Control-plane hosts (bedrock.<region>) sign as "bedrock" too.
      signSigV4(
        req,
        { accessKeyId: String(config.accessKeyId), secretAccessKey: secrets.secretAccessKey, sessionToken: secrets.sessionToken || undefined },
        region,
        spec.service ?? "bedrock",
        new Date((opts.now ?? Date.now)()),
      );
    },
  };
});
