/** Subscription OAuth flows against a mock token server; request decoration; refresh single-flight. */
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CLAUDE,
  CLAUDE_OAUTH_WARNINGS_ZH,
  claudeSetupToken,
  decorateClaudeRequest,
  decorateCodexRequest,
  exchangeClaudeCode,
  isReauthRequired,
  mapCodexError,
  parseCodexModels,
  parseCodexRateLimits,
  parsePastedClaudeCode,
  pollChatgptDeviceLogin,
  refreshIfNeeded,
  startChatgptDeviceLogin,
  startClaudeLogin,
  type OAuthTokens,
} from "../src/ai/oauth/index.js";

type Rec = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
async function mock(handler: (r: Rec) => { status?: number; json?: unknown }) {
  const requests: Rec[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const rec = { method: req.method!, path: new URL(req.url!, "http://x").pathname, headers: req.headers, body };
    requests.push(rec);
    const r = handler(rec);
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const idToken = jwt({ email: "a@lab.tw", "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "plus" } });

describe("ChatGPT device-code login", () => {
  it("start → pending polls → exchange → tokens with account id", async () => {
    let polls = 0;
    const m = await mock((r) => {
      if (r.path === "/usercode") return { json: { device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" } };
      if (r.path === "/devtoken") return ++polls < 3 ? { status: polls === 1 ? 403 : 404, json: {} } : { json: { authorization_code: "auth_code", code_challenge: "c", code_verifier: "ver" } };
      if (r.path === "/token") return { json: { id_token: idToken, access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "rt_1" } };
      return { status: 404 };
    });
    const http = { endpoints: { userCodeUrl: `${m.url}/usercode`, deviceTokenUrl: `${m.url}/devtoken`, tokenUrl: `${m.url}/token` } };
    const login = await startChatgptDeviceLogin(http, 1000);
    expect(login).toMatchObject({ deviceAuthId: "dev_1", userCode: "ABCD-1234", intervalSec: 5, verificationUrl: "https://auth.openai.com/codex/device", expiresAt: 1000 + 15 * 60_000 });
    expect(JSON.parse(m.requests[0]!.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    expect((await pollChatgptDeviceLogin(login, http, 2000)).status).toBe("pending");
    expect((await pollChatgptDeviceLogin(login, http, 3000)).status).toBe("pending");
    const done = await pollChatgptDeviceLogin(login, http, 4000);
    expect(done.status).toBe("complete");
    const tokens = (done as { tokens: OAuthTokens }).tokens;
    expect(tokens).toMatchObject({ provider: "chatgpt", refreshToken: "rt_1", accountId: "acct_123", planType: "plus", email: "a@lab.tw", expiresAt: 2_000_000_000_000, obtainedAt: 4000 });
    const ex = new URLSearchParams(m.requests.at(-1)!.body);
    expect(Object.fromEntries(ex)).toEqual({ grant_type: "authorization_code", code: "auth_code", redirect_uri: "https://auth.openai.com/deviceauth/callback", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code_verifier: "ver" });
    expect((await pollChatgptDeviceLogin(login, http, login.expiresAt + 1)).status).toBe("expired");
    await m.close();
  });

  it("404 on usercode → device login not enabled (unsupported)", async () => {
    const m = await mock(() => ({ status: 404 }));
    const e = await startChatgptDeviceLogin({ endpoints: { userCodeUrl: `${m.url}/x` } }).catch((x) => x);
    expect(e.code).toBe("unsupported");
    await m.close();
  });
});

describe("refreshIfNeeded", () => {
  const base: OAuthTokens = { provider: "chatgpt", accessToken: "at_0", refreshToken: "rt_0", idToken, accountId: "acct_123", expiresAt: 10 * 60_000, obtainedAt: 0 };

  it("no-op when fresh; refreshes inside the 5 min window with rotation; single-flight per key", async () => {
    let n = 0;
    const m = await mock((r) => {
      n++;
      const b = JSON.parse(r.body);
      expect(b).toMatchObject({ grant_type: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", refresh_token: "rt_0" });
      return { json: { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 } };
    });
    const http = { endpoints: { tokenUrl: `${m.url}/token` } };
    expect(await refreshIfNeeded(base, 60_000, { http })).toEqual({ tokens: base, refreshed: false });
    const now = 6 * 60_000;
    const [a, b] = await Promise.all([refreshIfNeeded(base, now, { http, key: "acc1" }), refreshIfNeeded(base, now, { http, key: "acc1" })]);
    expect(n).toBe(1);
    expect(a.tokens).toBe(b.tokens);
    expect(a.tokens).toMatchObject({ accessToken: "at_1", refreshToken: "rt_1", idToken, accountId: "acct_123", expiresAt: now + 3600_000, obtainedAt: now });
    // 8-day max age (Codex policy) even if the access token looks valid
    await refreshIfNeeded({ ...base, expiresAt: 100 * 86400_000 }, 9 * 86400_000, { http });
    expect(n).toBe(2);
    // setup-token style (no refresh token): never refreshed
    expect((await refreshIfNeeded({ provider: "claude", accessToken: "sk-ant-oat01-x", obtainedAt: 0, expiresAt: 1 }, 10, { http })).refreshed).toBe(false);
    await m.close();
  });

  it("permanent failures set reauthRequired; transient ones do not", async () => {
    let mode = "reused";
    const m = await mock(() =>
      mode === "reused" ? { status: 400, json: { error: { code: "refresh_token_reused", message: "x" } } } : mode === "grant" ? { status: 400, json: { error: "invalid_grant" } } : { status: 503, json: {} },
    );
    const http = { endpoints: { tokenUrl: `${m.url}/token` } };
    const run = () => refreshIfNeeded(base, 9 * 60_000 + 1, { http, force: true }).catch((e) => e);
    let e = await run();
    expect(e.code).toBe("auth_failed");
    expect(isReauthRequired(e)).toBe(true);
    expect(e.message).not.toContain("rt_0");
    mode = "grant";
    expect(isReauthRequired(await run())).toBe(true);
    mode = "503";
    e = await run();
    expect(e.code).toBe("unavailable");
    expect(isReauthRequired(e)).toBe(false);
    await m.close();
  });

  it("Claude refresh omits scope", async () => {
    const m = await mock(() => ({ json: { access_token: "sk-ant-oat01-new", refresh_token: "sk-ant-ort01-new", expires_in: 28800 } }));
    const t: OAuthTokens = { provider: "claude", accessToken: "sk-ant-oat01-old", refreshToken: "sk-ant-ort01-old", expiresAt: 0, obtainedAt: 0 };
    const r = await refreshIfNeeded(t, 1000, { http: { endpoints: { tokenUrl: `${m.url}/t` } } });
    expect(JSON.parse(m.requests[0]!.body)).toEqual({ grant_type: "refresh_token", client_id: CLAUDE.clientId, refresh_token: "sk-ant-ort01-old" });
    expect(r.tokens).toMatchObject({ accessToken: "sk-ant-oat01-new", refreshToken: "sk-ant-ort01-new", expiresAt: 1000 + 28800_000 });
    await m.close();
  });
});

describe("Codex request decoration", () => {
  it("store:false, stream, encrypted reasoning, strips max_output_tokens, headers", () => {
    const tokens: OAuthTokens = { provider: "chatgpt", accessToken: "at", idToken, obtainedAt: 0 };
    const d = decorateCodexRequest({ tokens, body: { model: "gpt-6-sol", input: [], store: true, max_output_tokens: 100, include: ["x"] }, sessionId: "conv-1" });
    expect(d.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(d.body).toEqual({ model: "gpt-6-sol", input: [], store: false, stream: true, include: ["x", "reasoning.encrypted_content"], prompt_cache_key: "conv-1" });
    expect(d.headers).toMatchObject({ authorization: "Bearer at", "chatgpt-account-id": "acct_123", originator: "codex_cli_rs", "session-id": "conv-1", accept: "text/event-stream" });
  });

  it("models, rate-limit headers, usage_limit_reached", () => {
    expect(parseCodexModels({ models: [{ slug: "a", display_name: "A", visibility: "list", context_window: 1 }, { slug: "h", visibility: "hide" }] })).toEqual([{ id: "a", label: "A", contextWindow: 1 }]);
    const h = new Headers({ "x-codex-primary-used-percent": "42.5", "x-codex-primary-reset-at": "1700000000" });
    expect(parseCodexRateLimits(h)).toMatchObject({ primaryUsedPercent: 42.5, primaryResetAt: 1_700_000_000_000 });
    const e = mapCodexError(429, { error: { type: "usage_limit_reached", plan_type: "plus", resets_at: 1000 } }, 400_000)!;
    expect(e.code).toBe("quota_exhausted");
    expect(e.retryAfterMs).toBe(600_000);
    expect(mapCodexError(400, { response: { error: { code: "context_length_exceeded" } } })!.code).toBe("context_too_long");
    expect(mapCodexError(500, {})).toBeUndefined();
  });
});

describe("Claude copy-code login", () => {
  it("authorize URL with PKCE S256, paste parsing, exchange with state check", async () => {
    const p = startClaudeLogin({}, 0);
    const u = new URL(p.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(u.searchParams.get("scope")).toContain("user:inference");
    expect(p.authorizeUrl).not.toContain(p.verifier);

    expect(parsePastedClaudeCode(" abc#xyz ")).toEqual({ code: "abc", state: "xyz" });
    expect(parsePastedClaudeCode("https://platform.claude.com/oauth/code/callback?code=c1&state=s1")).toEqual({ code: "c1", state: "s1" });
    expect(parsePastedClaudeCode("bare")).toEqual({ code: "bare" });

    const m = await mock(() => ({ json: { access_token: "sk-ant-oat01-a", refresh_token: "sk-ant-ort01-r", expires_in: 3600, account: { email_address: "me@lab.tw", uuid: "u1" } } }));
    const http = { endpoints: { tokenUrl: `${m.url}/token` } };
    await expect(exchangeClaudeCode(`code1#wrong`, p, http, 1000)).rejects.toMatchObject({ code: "bad_request" });
    expect(m.requests).toHaveLength(0);
    await expect(exchangeClaudeCode(`code1#${p.state}`, p, http, CLAUDE.pendingTtlMs + 1)).rejects.toMatchObject({ code: "bad_request" });
    const t = await exchangeClaudeCode(`code1#${p.state}`, p, http, 1000);
    expect(JSON.parse(m.requests[0]!.body)).toEqual({ grant_type: "authorization_code", client_id: CLAUDE.clientId, code: "code1", state: p.state, redirect_uri: CLAUDE.redirectUri, code_verifier: p.verifier });
    expect(t).toMatchObject({ provider: "claude", accessToken: "sk-ant-oat01-a", refreshToken: "sk-ant-ort01-r", email: "me@lab.tw", expiresAt: 1000 + 3600_000 });
    await m.close();
  });

  it("bad code → 400 invalid_grant → reauth", async () => {
    const m = await mock(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Invalid code" } }));
    const p = startClaudeLogin({}, 0);
    const e = await exchangeClaudeCode("x", p, { endpoints: { tokenUrl: m.url } }, 1).catch((x) => x);
    expect(e.code).toBe("auth_failed");
    expect(isReauthRequired(e)).toBe(true);
    await m.close();
  });

  it("decorates Messages requests: bearer, betas, identity system block first", () => {
    const d = decorateClaudeRequest({ accessToken: "sk-ant-oat01-a", body: { model: "claude-x", system: "你是實驗室助理", messages: [] }, headers: { "x-api-key": "nope", "anthropic-beta": "interleaved-thinking-2025-05-14" } });
    expect(d.url).toBe("https://api.anthropic.com/v1/messages");
    expect(d.headers["x-api-key"]).toBeUndefined();
    expect(d.headers.authorization).toBe("Bearer sk-ant-oat01-a");
    expect(d.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14");
    expect(d.headers["user-agent"]).toMatch(/^claude-cli\//);
    expect(d.body.system).toEqual([{ type: "text", text: CLAUDE.systemPrefix }, { type: "text", text: "你是實驗室助理" }]);
    const again = decorateClaudeRequest({ accessToken: "t", body: d.body });
    expect(again.body.system).toEqual(d.body.system);
    expect(decorateClaudeRequest({ accessToken: "t", body: {} }).body.system).toEqual([{ type: "text", text: CLAUDE.systemPrefix }]);
  });

  it("setup-token and warnings", () => {
    expect(claudeSetupToken("sk-ant-oat01-long", 0)).toEqual({ provider: "claude", accessToken: "sk-ant-oat01-long", obtainedAt: 0, expiresAt: 365 * 24 * 3600_000 });
    expect(() => claudeSetupToken("sk-ant-api03-x")).toThrow();
    expect(CLAUDE_OAUTH_WARNINGS_ZH.join("")).toContain("2026-04-04");
  });
});
