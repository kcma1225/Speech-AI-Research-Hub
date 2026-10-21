import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { audit, currentUser, randomToken, sha256 } from "../lib/auth.js";
import { notFound } from "../lib/http.js";
import {
  ACCESS_TOKEN_TTL_SECONDS, CODE_TTL_SECONDS, discoveryDocument, ID_TOKEN_TTL_SECONDS, issuerOf, jwks, OIDC_PREFIX,
  oidcClient, pkceS256, safeEqual, signJwt, userClaims,
} from "../lib/oidc/index.js";

/**
 * OpenID Connect provider for Aldine (authorization code flow, PKCE S256, first-party client, no consent screen).
 * Off (404) unless LATEX_OIDC_CLIENT_ID/SECRET are set. Protocol errors use the RFC 6749 shape
 * `{ error: <code>, error_description: <繁中> }`, because the client parses `error` as a code.
 */

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** A single-valued string parameter; repeated parameters are invalid (RFC 6749 §3.1). */
const single = (value: unknown) => (typeof value === "string" ? value : undefined);

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).header("Cache-Control", "no-store").header("Pragma", "no-cache").send({ error, error_description: description });
}

const oidc: FastifyPluginAsync = async app => {
  const client = oidcClient(app.config);
  const issuer = issuerOf(app.config);

  // Token requests are application/x-www-form-urlencoded (scoped to this plugin).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook("onRequest", async () => {
    if (!client) throw notFound();
  });

  app.get(`${OIDC_PREFIX}/.well-known/openid-configuration`, async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return discoveryDocument(app.config);
  });

  app.get(`${OIDC_PREFIX}/jwks`, async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return jwks(app.db);
  });

  app.get(`${OIDC_PREFIX}/authorize`, async (request, reply) => {
    const c = client!;
    const query = request.query as Record<string, unknown>;
    const clientId = single(query.client_id);
    const redirectUri = single(query.redirect_uri);
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    // Never redirect to an unverified URI: show the error here instead.
    if (!clientId || !safeEqual(clientId, c.clientId)) return reply.code(400).send({ error: "未知的登入用戶端。" });
    if (!redirectUri || !c.redirectUris.includes(redirectUri)) return reply.code(400).send({ error: "登入的返回網址不正確。" });

    const state = single(query.state);
    const back = (params: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [key, value] of Object.entries({ ...params, ...(state !== undefined ? { state } : {}), iss: issuer })) url.searchParams.set(key, value);
      return reply.redirect(url.href, 302);
    };
    const fail = (error: string, description: string) => back({ error, error_description: description });

    if (state !== undefined && state.length > 1024) return fail("invalid_request", "state 太長。");
    if (single(query.response_type) !== "code") return fail("unsupported_response_type", "只支援 response_type=code。");
    const scopes = (single(query.scope) ?? "").split(" ").filter(Boolean);
    if (!scopes.includes("openid")) return fail("invalid_scope", "scope 必須包含 openid。");
    const scope = ["openid", "profile", "email"].filter(name => scopes.includes(name)).join(" ");
    const nonce = single(query.nonce);
    if (nonce !== undefined && (nonce.length === 0 || nonce.length > 255)) return fail("invalid_request", "nonce 不正確。");
    const challenge = single(query.code_challenge);
    const method = single(query.code_challenge_method);
    if (challenge !== undefined || method !== undefined) {
      if (method !== "S256") return fail("invalid_request", "只支援 PKCE S256。");
      if (!challenge || !CHALLENGE.test(challenge)) return fail("invalid_request", "code_challenge 不正確。");
    }

    const user = await currentUser(request);
    if (!user) {
      if (single(query.prompt)?.split(" ").includes("none")) return fail("login_required", "請先登入 Speech-AI Hub。");
      // The login page navigates back to this exact URL (same-origin path) after signing in.
      return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`, 302);
    }

    const code = randomToken();
    await app.db.query("DELETE FROM oidc_codes WHERE expires_at < now() - interval '1 hour'");
    await app.db.query(
      `INSERT INTO oidc_codes(code_hash,client_id,redirect_uri,user_id,scope,nonce,code_challenge,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now() + make_interval(secs => $8))`,
      [sha256(code), c.clientId, redirectUri, user.id, scope, nonce ?? null, challenge ?? null, CODE_TTL_SECONDS],
    );
    return back({ code });
  });

  app.post(`${OIDC_PREFIX}/token`, async (request, reply) => {
    const c = client!;
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;

    // Client authentication: client_secret_basic (Aldine's default) or client_secret_post, not both.
    let clientId: string | undefined;
    let secret: string | undefined;
    const header = request.headers.authorization;
    if (header?.startsWith("Basic ")) {
      if (body.client_secret !== undefined) return oauthError(reply, 400, "invalid_request", "只能使用一種用戶端驗證方式。");
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        // RFC 6749 §2.3.1: both halves are form-encoded.
        const formDecode = (value: string) => { try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch { return undefined; } };
        clientId = formDecode(decoded.slice(0, colon));
        secret = formDecode(decoded.slice(colon + 1));
      }
    } else {
      clientId = single(body.client_id);
      secret = single(body.client_secret);
    }
    const clientOk = clientId !== undefined && secret !== undefined && safeEqual(clientId, c.clientId) && safeEqual(secret, c.secret);
    if (!clientOk) {
      reply.header("WWW-Authenticate", 'Basic realm="speech-ai-hub"');
      return oauthError(reply, 401, "invalid_client", "用戶端驗證失敗。");
    }
    if (single(body.client_id) !== undefined && single(body.client_id) !== c.clientId) return oauthError(reply, 400, "invalid_request", "client_id 不一致。");

    if (single(body.grant_type) !== "authorization_code") return oauthError(reply, 400, "unsupported_grant_type", "只支援 authorization_code。");
    const code = single(body.code);
    const redirectUri = single(body.redirect_uri);
    const verifier = single(body.code_verifier);
    if (!code || !redirectUri) return oauthError(reply, 400, "invalid_request", "缺少 code 或 redirect_uri。");

    // Single use: the row is deleted by whoever presents the code first.
    const row = (await app.db.query<{
      client_id: string; redirect_uri: string; user_id: string; scope: string; nonce: string | null; code_challenge: string | null;
      expired: boolean; name: string | null; username: string | null; disabled: boolean | null;
    }>(
      `WITH consumed AS (DELETE FROM oidc_codes WHERE code_hash=$1 RETURNING *)
       SELECT c.client_id,c.redirect_uri,c.user_id,c.scope,c.nonce,c.code_challenge,(c.expires_at <= now()) AS expired,
              u.name,u.username,(u.disabled_at IS NOT NULL) AS disabled
         FROM consumed c LEFT JOIN users u ON u.id=c.user_id`,
      [sha256(code)],
    )).rows[0];
    const invalidGrant = () => oauthError(reply, 400, "invalid_grant", "登入代碼無效或已過期，請重新登入。");
    if (!row || row.expired || row.client_id !== c.clientId || row.redirect_uri !== redirectUri) return invalidGrant();
    if (row.code_challenge) {
      if (!verifier || !PKCE_VALUE.test(verifier) || !safeEqual(pkceS256(verifier), row.code_challenge)) return invalidGrant();
    } else if (verifier !== undefined) {
      return invalidGrant(); // a verifier for a code issued without a challenge: PKCE downgrade
    }
    if (!row.name || !row.username || row.disabled) return invalidGrant();

    const now = Math.floor(Date.now() / 1000);
    const user = { id: row.user_id, name: row.name, username: row.username };
    const idToken = await signJwt(app.db, {
      iss: issuer,
      aud: c.clientId,
      iat: now,
      exp: now + ID_TOKEN_TTL_SECONDS,
      ...(row.nonce ? { nonce: row.nonce } : {}),
      ...userClaims(user, row.scope),
    });
    const accessToken = randomToken();
    await app.db.query("DELETE FROM oidc_access_tokens WHERE expires_at < now() - interval '1 hour'");
    await app.db.query(
      "INSERT INTO oidc_access_tokens(token_hash,client_id,user_id,scope,expires_at) VALUES($1,$2,$3,$4,now() + make_interval(secs => $5))",
      [sha256(accessToken), c.clientId, user.id, row.scope, ACCESS_TOKEN_TTL_SECONDS],
    );
    await audit(request, user.id, "oidc_sign_in", "user", user.id, { client_id: c.clientId, ip: request.ip });
    return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache").send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      id_token: idToken,
      scope: row.scope,
    });
  });

  app.get(`${OIDC_PREFIX}/userinfo`, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const row = token
      ? (await app.db.query<{ id: string; name: string; username: string; scope: string }>(
          `SELECT u.id,u.name,u.username,t.scope FROM oidc_access_tokens t JOIN users u ON u.id=t.user_id
            WHERE t.token_hash=$1 AND t.expires_at > now() AND u.disabled_at IS NULL`,
          [sha256(token)],
        )).rows[0]
      : undefined;
    if (!row) {
      reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return oauthError(reply, 401, "invalid_token", "存取權杖無效或已過期。");
    }
    reply.header("Cache-Control", "no-store");
    return userClaims(row, row.scope);
  });
};

export default oidc;
