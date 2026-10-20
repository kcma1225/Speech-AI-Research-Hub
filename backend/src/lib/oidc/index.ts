import { createHash, createPrivateKey, generateKeyPairSync, sign, timingSafeEqual, type JsonWebKey, type KeyObject } from "node:crypto";
import type { Config } from "../../config.js";
import type { Db } from "../../db.js";

/**
 * Minimal OpenID Connect provider for one first-party client (Aldine). See docs/architecture.md "OIDC provider".
 * Issuer = `<APP_ORIGIN>/api/oidc`, so every endpoint (incl. discovery) is under nginx's `/api/` proxy.
 */

export const OIDC_PREFIX = "/oidc";
/** The token endpoint is a server-to-server POST without our Origin; the CSRF hook exempts exactly this route. */
export const OIDC_TOKEN_ROUTE = `/api${OIDC_PREFIX}/token`;
export const CODE_TTL_SECONDS = 60;
export const ACCESS_TOKEN_TTL_SECONDS = 300;
export const ID_TOKEN_TTL_SECONDS = 300;
/**
 * Hub users have no email. Aldine needs one for admins (ALDINE_ADMIN_EMAILS) and for inviting collaborators, so
 * we emit `<hub user id>@<domain>`: stable across renames, unique per user, and `.invalid` (RFC 6761) can never
 * receive mail or belong to anyone else.
 */
export const SYNTHETIC_EMAIL_DOMAIN = "users.speech-ai-hub.invalid";
export const syntheticEmail = (userId: string) => `${userId}@${SYNTHETIC_EMAIL_DOMAIN}`;

export type OidcClient = { clientId: string; secret: string; redirectUris: string[] };

/** The configured client, or null when the provider is off. */
export function oidcClient(config: Config): OidcClient | null {
  if (!config.LATEX_OIDC_CLIENT_ID || !config.LATEX_OIDC_CLIENT_SECRET) return null;
  const explicit = config.LATEX_OIDC_REDIRECT_URIS.split(",").map(uri => uri.trim()).filter(Boolean);
  const derived = config.LATEX_URL ? [`${config.LATEX_URL.replace(/\/+$/, "")}/api/auth/oauth/oidc/callback`] : [];
  const redirectUris = (explicit.length ? explicit : derived).filter(isAbsoluteHttpUrl);
  if (!redirectUris.length) return null;
  return { clientId: config.LATEX_OIDC_CLIENT_ID, secret: config.LATEX_OIDC_CLIENT_SECRET, redirectUris };
}

function isAbsoluteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.hash;
  } catch {
    return false;
  }
}

export const issuerOf = (config: Config) => `${new URL(config.APP_ORIGIN).origin}/api${OIDC_PREFIX}`;

export function discoveryDocument(config: Config) {
  const issuer = issuerOf(config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    scopes_supported: ["openid", "profile", "email"],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "name", "preferred_username", "email", "email_verified"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Constant-time string comparison (hashing first hides the length). */
export function safeEqual(a: string, b: string) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export const pkceS256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Claims about the user released for the granted scopes (ID token and userinfo). */
export function userClaims(user: { id: string; name: string }, scope: string) {
  const scopes = new Set(scope.split(" "));
  return {
    sub: user.id,
    ...(scopes.has("profile") ? { name: user.name, preferred_username: user.name } : {}),
    // email_verified: Aldine (OIDC_EMAIL_VERIFIED=require) ignores unverified addresses. Safe because the
    // address is synthetic: nobody can receive mail there, and Aldine never links an SSO identity to a
    // password account or to another subject that merely shares the address.
    ...(scopes.has("email") ? { email: syntheticEmail(user.id), email_verified: true } : {}),
  };
}

// --- Signing key -------------------------------------------------------------------------------------------

type SigningKey = { kid: string; privateKey: KeyObject; publicJwk: JsonWebKey };
const keyCache = new WeakMap<Db, Promise<SigningKey>>();

/** The active ES256 signing key, generated and stored on first use (race-safe via the one-active unique index). */
export function signingKey(db: Db): Promise<SigningKey> {
  let pending = keyCache.get(db);
  if (!pending) {
    pending = loadOrCreateKey(db);
    pending.catch(() => keyCache.delete(db));
    keyCache.set(db, pending);
  }
  return pending;
}

async function loadOrCreateKey(db: Db): Promise<SigningKey> {
  const select = () => db.query<{ kid: string; private_key_pem: string; public_jwk: JsonWebKey }>(
    "SELECT kid,private_key_pem,public_jwk FROM oidc_signing_keys WHERE active",
  );
  let row = (await select()).rows[0];
  if (!row) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const kid = jwkThumbprint(jwk);
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" };
    await db.query(
      "INSERT INTO oidc_signing_keys(kid,alg,private_key_pem,public_jwk) VALUES($1,'ES256',$2,$3) ON CONFLICT DO NOTHING",
      [kid, privateKey.export({ format: "pem", type: "pkcs8" }) as string, JSON.stringify(publicJwk)],
    );
    row = (await select()).rows[0];
    if (!row) throw new Error("OIDC signing key could not be created");
  }
  return { kid: row.kid, privateKey: createPrivateKey(row.private_key_pem), publicJwk: row.public_jwk };
}

/** RFC 7638 thumbprint of an EC public key. */
function jwkThumbprint(jwk: JsonWebKey) {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
}

/** All published public keys (the active one plus any kept for rotation). */
export async function jwks(db: Db) {
  await signingKey(db);
  const result = await db.query<{ public_jwk: JsonWebKey }>("SELECT public_jwk FROM oidc_signing_keys ORDER BY active DESC, created_at DESC");
  return { keys: result.rows.map(row => row.public_jwk) };
}

/** Compact JWS (ES256, IEEE P1363 signature). */
export async function signJwt(db: Db, payload: object) {
  const key = await signingKey(db);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", typ: "JWT", kid: key.kid })}.${encode(payload)}`;
  const signature = sign("sha256", Buffer.from(input), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}
