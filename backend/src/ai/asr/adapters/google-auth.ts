/** Google service-account → OAuth2 access token (JWT bearer grant, RS256). Cached per account in memory. */
import { createSign } from "node:crypto";
import { asrErr } from "../err.js";
import { expectJson, vendorFetch } from "../http.js";
import type { AsrProviderConfig } from "../types.js";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string; project_id?: string };

const cache = new Map<string, { token: string; exp: number }>();
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function parseServiceAccount(raw: unknown): ServiceAccount {
  let sa: any = raw;
  if (typeof raw === "string") {
    try {
      sa = JSON.parse(raw);
    } catch {
      throw asrErr("auth_failed", "google: service_account_json is not valid JSON");
    }
  }
  if (!sa?.client_email || !sa?.private_key) throw asrErr("auth_failed", "google: service account needs client_email and private_key");
  return sa as ServiceAccount;
}

export async function googleAccessToken(cfg: AsrProviderConfig, signal?: AbortSignal, now = Date.now()): Promise<string> {
  const sa = parseServiceAccount(cfg.fields.service_account_json);
  const hit = cache.get(sa.client_email);
  if (hit && hit.exp - 60_000 > now) return hit.token;
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud, iat, exp: iat + 3600 }));
  let sig: string;
  try {
    sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key, "base64url");
  } catch (e) {
    throw asrErr("auth_failed", "google: cannot sign with private_key", { cause: e });
  }
  const res = await vendorFetch(
    cfg,
    aud,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
      timeoutMs: 15_000,
    },
    signal,
  );
  if (res.status === 400) {
    await res.body?.cancel();
    throw asrErr("auth_failed", "google: token exchange rejected (check the service account)", { status: 400 });
  }
  const j = await expectJson<{ access_token: string; expires_in?: number }>(res, "google-oauth");
  cache.set(sa.client_email, { token: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export const clearGoogleTokenCache = () => cache.clear();
