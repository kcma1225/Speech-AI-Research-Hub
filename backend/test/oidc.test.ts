import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, hasTestDb, ORIGIN, type TestContext } from "./helpers.js";

const CLIENT_ID = "aldine";
const SECRET = "s".repeat(20) + randomBytes(16).toString("hex");
const REDIRECT = "https://latex.hub.test/latex/api/auth/oauth/oidc/callback";
const ISSUER = `${ORIGIN}/api/oidc`;

const b64url = (value: Buffer) => value.toString("base64url");
const basic = (id = CLIENT_ID, secret = SECRET) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};

/** Verifies a compact ES256 JWS against a JWK set; returns the payload or null. */
function verifyJwt(token: string, keys: JsonWebKey[]): Record<string, unknown> | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const { kid, alg } = JSON.parse(Buffer.from(header, "base64url").toString()) as { kid?: string; alg?: string };
  const jwk = keys.find(key => (key as { kid?: string }).kid === kid);
  if (!jwk || alg !== "ES256") return null;
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  return ok ? (JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>) : null;
}

describe.skipIf(!hasTestDb)("oidc provider", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ LATEX_OIDC_CLIENT_ID: CLIENT_ID, LATEX_OIDC_CLIENT_SECRET: SECRET, LATEX_OIDC_REDIRECT_URIS: REDIRECT });
  });
  afterAll(async () => {
    await t?.close();
  });

  const authorizeUrl = (params: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid email profile",
      state: "st-1", nonce: "n-1", ...params,
    });
    return `/api/oidc/authorize?${query}`;
  };
  const authorize = (cookie: string | undefined, params: Record<string, string> = {}) =>
    t.app.inject({ method: "GET", url: authorizeUrl(params), headers: cookie ? { cookie } : {} });
  /** Runs authorize for `cookie` and returns the redirect back to the client. */
  async function codeFor(cookie: string, params: Record<string, string> = {}) {
    const response = await authorize(cookie, params);
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    return location.searchParams;
  }
  const token = (form: Record<string, string>, headers: Record<string, string> = { authorization: basic() }) =>
    t.app.inject({
      method: "POST",
      url: "/api/oidc/token",
      // A server-to-server call: no Origin header.
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      payload: new URLSearchParams(form).toString(),
    });

  it("publishes discovery and a JWKS", async () => {
    const discovery = await t.app.inject({ method: "GET", url: "/api/oidc/.well-known/openid-configuration" });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      id_token_signing_alg_values_supported: ["ES256"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    const keys = (await t.app.inject({ method: "GET", url: "/api/oidc/jwks" })).json().keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
  });

  it("runs the code flow with PKCE and issues a verifiable ID token", async () => {
    const member = await t.login("student", "陳冠宇");
    const { verifier, challenge } = pkce();
    const params = await codeFor(member.cookie, { code_challenge: challenge, code_challenge_method: "S256" });
    expect(params.get("state")).toBe("st-1");
    expect(params.get("iss")).toBe(ISSUER);
    const code = params.get("code")!;

    const response = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 300, scope: "openid profile email" });

    const keys = (await t.app.inject({ method: "GET", url: "/api/oidc/jwks" })).json().keys;
    const claims = verifyJwt(body.id_token, keys)!;
    expect(claims).not.toBeNull();
    expect(claims).toMatchObject({
      iss: ISSUER, aud: CLIENT_ID, sub: member.id, nonce: "n-1", name: "陳冠宇",
      email: `${member.id}@users.speech-ai-hub.invalid`, email_verified: true,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    // A tampered token fails verification.
    const [h, p, s] = body.id_token.split(".");
    const forged = b64url(Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })));
    expect(verifyJwt(`${h}.${forged}.${s}`, keys)).toBeNull();
    expect(p).toBeTruthy();

    const info = await t.app.inject({ method: "GET", url: "/api/oidc/userinfo", headers: { authorization: `Bearer ${body.access_token}` } });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ sub: member.id, name: "陳冠宇", email: `${member.id}@users.speech-ai-hub.invalid` });
    expect((await t.app.inject({ method: "GET", url: "/api/oidc/userinfo", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);

    const audit = await t.db.query("SELECT 1 FROM audit_log WHERE action='oidc_sign_in' AND actor_id=$1", [member.id]);
    expect(audit.rowCount).toBe(1);
  });

  it("accepts client_secret_post", async () => {
    const member = await t.login("professor");
    const code = (await codeFor(member.cookie)).get("code")!;
    const response = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: SECRET }, {});
    expect(response.statusCode).toBe(200);
  });

  it("rejects a wrong client secret and does not burn the code", async () => {
    const member = await t.login("student");
    const { verifier, challenge } = pkce();
    const code = (await codeFor(member.cookie, { code_challenge: challenge, code_challenge_method: "S256" })).get("code")!;
    const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier };
    const wrong = await token(form, { authorization: basic(CLIENT_ID, `${SECRET}x`) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_client");
    expect((await token(form, { authorization: basic("other", SECRET) })).statusCode).toBe(401);
    expect((await token(form, {})).statusCode).toBe(401);
    expect((await token(form)).statusCode).toBe(200);
  });

  it("rejects a reused code", async () => {
    const member = await t.login("student");
    const code = (await codeFor(member.cookie)).get("code")!;
    const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT };
    expect((await token(form)).statusCode).toBe(200);
    const again = await token(form);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const member = await t.login("student");
    const code = (await codeFor(member.cookie)).get("code")!;
    await t.db.query("UPDATE oidc_codes SET expires_at=now() - interval '1 second'");
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT })).json().error).toBe("invalid_grant");
  });

  it("enforces PKCE: wrong, missing and downgraded verifiers", async () => {
    const member = await t.login("student");
    const { challenge } = pkce();
    for (const verifier of [pkce().verifier, undefined]) {
      const code = (await codeFor(member.cookie, { code_challenge: challenge, code_challenge_method: "S256" })).get("code")!;
      const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: REDIRECT };
      if (verifier) form.code_verifier = verifier;
      expect((await token(form)).json().error).toBe("invalid_grant");
    }
    const code = (await codeFor(member.cookie)).get("code")!;
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pkce().verifier })).json().error).toBe("invalid_grant");
    const plain = await codeFor(member.cookie, { code_challenge: challenge, code_challenge_method: "plain" });
    expect(plain.get("error")).toBe("invalid_request");
    expect(plain.get("code")).toBeNull();
  });

  it("rejects an unknown redirect_uri or client without redirecting", async () => {
    const member = await t.login("student");
    const cases: Record<string, string>[] = [{ redirect_uri: "https://evil.test/cb" }, { redirect_uri: `${REDIRECT}/x` }, { client_id: "other" }];
    for (const params of cases) {
      const response = await authorize(member.cookie, params);
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
    // The token request must name the same redirect_uri.
    const code = (await codeFor(member.cookie)).get("code")!;
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: "https://evil.test/cb" })).json().error).toBe("invalid_grant");
  });

  it("returns protocol errors to the client", async () => {
    const member = await t.login("student");
    expect((await codeFor(member.cookie, { scope: "email" })).get("error")).toBe("invalid_scope");
    expect((await codeFor(member.cookie, { response_type: "token" })).get("error")).toBe("unsupported_response_type");
    const code = (await codeFor(member.cookie)).get("code")!;
    expect((await token({ grant_type: "password", code, redirect_uri: REDIRECT })).json().error).toBe("unsupported_grant_type");
  });

  it("sends signed-out visitors to the hub login and back", async () => {
    const response = await authorize(undefined);
    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location.startsWith("/login?next=")).toBe(true);
    expect(new URL(location, ORIGIN).searchParams.get("next")).toBe(authorizeUrl());
    const silent = await authorize(undefined, { prompt: "none" });
    expect(new URL(silent.headers.location as string).searchParams.get("error")).toBe("login_required");
  });

  it("gives disabled users no code and no tokens", async () => {
    const member = await t.login("student");
    const code = (await codeFor(member.cookie)).get("code")!;
    await t.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [member.id]);
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT })).json().error).toBe("invalid_grant");
    // Disabled sessions no longer resolve, so authorize sends them to the login page.
    expect((await authorize(member.cookie)).headers.location).toMatch(/^\/login\?next=/);
  });

  it("keeps the Origin check on every other write", async () => {
    const { id } = await t.ownerCookie();
    expect((await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { userId: id, password: "x" } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: "/api/oidc/token/", payload: {} })).statusCode).toBe(403);
  });
});

describe.skipIf(!hasTestDb)("oidc provider (not configured)", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t?.close();
  });

  it("answers 404 on every endpoint", async () => {
    for (const url of ["/api/oidc/.well-known/openid-configuration", "/api/oidc/jwks", "/api/oidc/authorize"]) {
      expect((await t.app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    expect((await t.app.inject({ method: "POST", url: "/api/oidc/token", payload: {} })).statusCode).toBe(404);
  });
});
