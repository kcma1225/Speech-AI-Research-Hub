import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit, requireAdmin } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { isAiError, fromThrown } from "../ai/errors.js";
import { AI_ROLES, aiFor, isPlatformError, PlatformError, type AiRole } from "../ai/platform/index.js";
import {
  bindRole,
  createProvider,
  deleteProvider,
  deleteRoute,
  draftProvider,
  exportSettings,
  getProviderRow,
  importSettings,
  publicProvider,
  publicRoute,
  registryPayload,
  saveRoute,
  updateProvider,
} from "../ai/platform/admin-service.js";
import { callStats, listCalls, STAT_WINDOWS, type StatWindow } from "../ai/platform/call-log.js";
import { encryptJson, decryptJson, oauthAad, sessionAad } from "../ai/platform/crypto.js";
import { probeProvider } from "../ai/platform/health.js";
import { clearTokens, saveTokens } from "../ai/platform/oauth-store.js";
import { llmClient } from "../ai/platform/clients.js";
import { loadSnapshot, type ProviderRecord } from "../ai/platform/store.js";
import { detectVision, memberVision, refreshStaleHints, storeModelHints } from "../ai/platform/vision.js";
import { leaves, resolveRoute } from "../ai/router/index.js";
import { cancelSwitch, deleteRetiredSpace, embeddingOverview, flipSwitch, precheckRoute, startSwitch, summarize } from "../ai/embedding/switch.js";
import {
  CHATGPT,
  CLAUDE,
  claudeSetupToken,
  exchangeClaudeCode,
  pollChatgptDeviceLogin,
  revokeChatgpt,
  startChatgptDeviceLogin,
  startClaudeLogin,
  type ClaudePendingLogin,
  type DeviceLogin,
  type OAuthTokens,
} from "../ai/oauth/index.js";

const uuid = z.uuid();
const idParams = z.object({ id: z.uuid() });
const family = z.enum(["llm", "asr"]);
const name = z.string().trim().min(1).max(80);
const kind = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const config = z.record(z.string(), z.unknown());
const secrets = z.record(z.string(), z.string().max(64 * 1024).nullable());
const providerCreate = z.object({ family, kind, name, config: config.default({}), secrets: secrets.default({}), enabled: z.boolean().optional() });
const providerPatch = z.object({ name: name.optional(), config: config.optional(), secrets: secrets.optional(), enabled: z.boolean().optional() });
const memberInput = z.object({
  provider_id: uuid.nullish(),
  model: z.string().trim().max(200).nullish(),
  child_route_id: uuid.nullish(),
  weight: z.number().int().min(1).max(1000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
const routeInput = z.object({
  name,
  capability: z.enum(["chat", "embedding", "asr"]),
  strategy: z.enum(["single", "fallback", "round_robin", "load_balance"]),
  description: z.string().max(500).optional(),
  members: z.array(memberInput).max(32),
});

/** Every admin AI error is `{ error, code, hint }` (plus `detail` for validation issues), all 繁中. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new PlatformError("route_invalid", {
      message_zh: "欄位內容不正確。",
      hint_zh: issue ? `請檢查「${issue.path.join(".") || "內容"}」後再送出。` : "請檢查欄位內容後再送出。",
      detail: { issues: r.error.issues.map((i) => ({ key: i.path.join("."), message_zh: "格式不正確。" })) },
    });
  }
  return r.data;
}

const HTTP_HINTS: Record<number, { code: string; hint: string }> = {
  400: { code: "invalid_input", hint: "請檢查欄位內容後再送出。" },
  401: { code: "unauthorized", hint: "請重新登入。" },
  403: { code: "forbidden", hint: "模型設定只有管理員可以使用，請聯絡管理員。" },
  404: { code: "not_found", hint: "資料可能已被刪除，請重新整理頁面。" },
  409: { code: "conflict", hint: "請重新整理頁面後再試。" },
};

function sendError(error: unknown, reply: FastifyReply) {
  if (isPlatformError(error)) return reply.code(error.status).send(error.toResponse());
  if (isAiError(error)) return reply.code(502).send(error.toResponse());
  if (error instanceof HttpError) {
    const h = HTTP_HINTS[error.status] ?? { code: `http_${error.status}`, hint: "請稍後再試。" };
    return reply.code(error.status).send({ error: error.message, code: error.extra.code ?? h.code, hint: error.extra.hint ?? h.hint });
  }
  throw error;
}

export default async function aiAdmin(app: FastifyInstance) {
  const platform = aiFor(app);
  app.setErrorHandler((error: FastifyError, _request, reply) => sendError(error, reply));

  const snapshotProviders = async () => {
    const snap = await loadSnapshot(app.db);
    return { snap, providers: [...snap.providers.values()].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()) };
  };

  // ---------------------------------------------------------------- registry

  app.get("/admin/ai/registry", async (request) => {
    await requireAdmin(request);
    return registryPayload();
  });

  // ---------------------------------------------------------------- providers

  app.get("/admin/ai/providers", async (request) => {
    await requireAdmin(request);
    const { snap, providers } = await snapshotProviders();
    return { providers: providers.map((p) => publicProvider(p, snap)) };
  });

  app.post("/admin/ai/providers", async (request, reply) => {
    const user = await requireAdmin(request);
    const body = parse(providerCreate, request.body);
    const p = await createProvider(app.db, body as Parameters<typeof createProvider>[1], user.id);
    await audit(request, user.id, "ai.provider.create", "ai_provider", p.id, { kind: p.kind, family: p.family });
    platform.invalidate();
    return reply.code(201).send({ provider: publicProvider(p, await loadSnapshot(app.db)) });
  });

  app.patch("/admin/ai/providers/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(providerPatch, request.body);
    const p = await updateProvider(app.db, id, body);
    await audit(request, user.id, "ai.provider.update", "ai_provider", id, { secrets_changed: Object.keys(body.secrets ?? {}) });
    platform.invalidate();
    return { provider: publicProvider(p, await loadSnapshot(app.db)) };
  });

  app.delete("/admin/ai/providers/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteProvider(app.db, id);
    await audit(request, user.id, "ai.provider.delete", "ai_provider", id);
    platform.invalidate();
    return { ok: true };
  });

  /** Test a saved account (probe + model list; optional 1-shot model check). */
  const testBody = z.object({ model: z.string().trim().max(200).optional(), capability: z.enum(["chat", "embedding"]).optional() });
  async function runTest(p: ProviderRecord, body: z.infer<typeof testBody>, saved = false) {
    const probe = await probeProvider(app.db, p);
    let models: Array<{ id: string; label?: string; kind?: string }> = [];
    let modelsError: { error: string; code: string; hint: string } | null = null;
    if (p.family === "llm" && p.kind !== "claude-cli" && probe.ok) {
      try {
        const listed = await llmClient(app.db, p).listModels();
        models = listed.map((m) => ({ id: m.id, label: m.label, kind: m.kind, ...(m.hints?.vision !== undefined ? { vision: m.hints.vision } : {}) }));
        // Saved accounts keep the capability hints (vision detection for route members).
        if (saved) {
          await storeModelHints(app.db, p.id, listed);
          platform.invalidate();
        }
      } catch (e) {
        modelsError = fromThrown(e).toResponse();
      }
    }
    let check: { ok: boolean; latencyMs: number; detail_zh: string; dims?: number; error?: { error: string; code: string; hint: string } } | null = null;
    if (body.model && p.family === "llm") {
      const t0 = Date.now();
      try {
        if (body.capability === "embedding") {
          const r = await llmClient(app.db, p).embed({ model: body.model, inputs: ["測試 test"], inputType: "query" });
          check = { ok: true, latencyMs: Date.now() - t0, detail_zh: `向量維度 ${r.dims || r.vectors[0]?.length}。`, dims: r.dims || r.vectors[0]?.length };
        } else {
          const r = await platform.chatOnce(p, body.model);
          check = { ok: true, latencyMs: Date.now() - t0, detail_zh: `模型回應正常（${r.length} 字）。` };
        }
      } catch (e) {
        const err = isPlatformError(e) ? null : fromThrown(e);
        check = { ok: false, latencyMs: Date.now() - t0, detail_zh: err?.message_zh ?? (e as PlatformError).message_zh, error: err?.toResponse() ?? (e as PlatformError).toResponse() };
      }
    }
    return { probe, models, models_error: modelsError, check };
  }

  app.post("/admin/ai/providers/:id/test", async (request) => {
    await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(testBody, request.body ?? {});
    const p = await getProviderRow(app.db, id);
    const r = await runTest(p, body, true);
    await app.db.query("UPDATE ai_providers SET last_probe=$2, last_probe_at=now() WHERE id=$1", [
      id,
      JSON.stringify({ ok: r.probe.ok, latencyMs: r.probe.latencyMs, detail_zh: r.probe.detail_zh, code: r.probe.code, modelCount: r.probe.modelCount }),
    ]);
    platform.scheduleRecompute(300);
    return r;
  });

  /** Test an unsaved form (add/edit flow); `base_id` reuses the stored secrets of an existing account. */
  app.post("/admin/ai/providers/test", async (request) => {
    await requireAdmin(request);
    const body = parse(providerCreate.extend({ name: z.string().max(80).default("draft"), base_id: uuid.optional() }).merge(testBody), request.body);
    const p = await draftProvider(app.db, body as Parameters<typeof draftProvider>[1]);
    return runTest(p, body);
  });

  // ---------------------------------------------------------------- subscription OAuth

  app.post("/admin/ai/providers/:id/oauth/start", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const p = await getProviderRow(app.db, id);
    if (p.kind === "chatgpt") {
      let login: DeviceLogin;
      try {
        login = await startChatgptDeviceLogin();
      } catch (e) {
        throw oauthFailure(e);
      }
      const sid = await createSession(p.id, "chatgpt_device", login, new Date(login.expiresAt), user.id);
      return { session_id: sid, flow: "chatgpt_device", user_code: login.userCode, verification_url: login.verificationUrl, interval_sec: login.intervalSec, expires_at: new Date(login.expiresAt).toISOString() };
    }
    if (p.kind === "claude-oauth") {
      const login = startClaudeLogin();
      const expires = new Date(login.createdAt + CLAUDE.pendingTtlMs);
      const sid = await createSession(p.id, "claude_pkce", login, expires, user.id);
      return { session_id: sid, flow: "claude_pkce", authorize_url: login.authorizeUrl, expires_at: expires.toISOString() };
    }
    throw new PlatformError("oauth_unsupported");
  });

  async function createSession(providerId: string, flow: string, state: unknown, expires: Date, userId: string) {
    const sid = (await app.db.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
    await app.db.query("DELETE FROM ai_oauth_sessions WHERE provider_id=$1 AND status='pending'", [providerId]);
    await app.db.query("INSERT INTO ai_oauth_sessions(id,provider_id,flow,state,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6)", [
      sid,
      providerId,
      flow,
      encryptJson(state, sessionAad(sid)),
      expires,
      userId,
    ]);
    return sid;
  }

  async function loadSession(sid: string, userId: string) {
    const row = (
      await app.db.query<{ id: string; provider_id: string; flow: string; state: Buffer; status: string; expires_at: Date; created_by: string }>(
        "SELECT id,provider_id,flow,state,status,expires_at,created_by FROM ai_oauth_sessions WHERE id=$1",
        [sid],
      )
    ).rows[0];
    if (!row || row.created_by !== userId) throw new PlatformError("not_found");
    if (row.status !== "pending" || row.expires_at.getTime() < Date.now()) throw new PlatformError("oauth_session_expired");
    return row;
  }

  async function connected(providerId: string, tokens: OAuthTokens, sid: string | null, userId: string, request: Parameters<typeof audit>[0]) {
    await saveTokens(app.db, providerId, tokens);
    if (sid) await app.db.query("UPDATE ai_oauth_sessions SET status='complete' WHERE id=$1", [sid]);
    await audit(request, userId, "ai.provider.oauth_connect", "ai_provider", providerId, { provider: tokens.provider });
    platform.invalidate();
    const p = await getProviderRow(app.db, providerId);
    return { status: "complete" as const, oauth: p.oauth_meta };
  }

  app.post("/admin/ai/oauth/sessions/:id/poll", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const s = await loadSession(id, user.id);
    if (s.flow !== "chatgpt_device") throw new PlatformError("oauth_unsupported");
    const login = decryptJson<DeviceLogin>(s.state, sessionAad(s.id));
    let r;
    try {
      r = await pollChatgptDeviceLogin(login);
    } catch (e) {
      throw oauthFailure(e);
    }
    if (r.status === "pending") return { status: "pending" };
    if (r.status === "expired") {
      await app.db.query("UPDATE ai_oauth_sessions SET status='expired' WHERE id=$1", [s.id]);
      throw new PlatformError("oauth_session_expired");
    }
    return connected(s.provider_id, r.tokens, s.id, user.id, request);
  });

  app.post("/admin/ai/oauth/sessions/:id/complete", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const { code } = parse(z.object({ code: z.string().trim().min(4).max(4096) }), request.body);
    const s = await loadSession(id, user.id);
    if (s.flow !== "claude_pkce") throw new PlatformError("oauth_unsupported");
    const pending = decryptJson<ClaudePendingLogin>(s.state, sessionAad(s.id));
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeClaudeCode(code, pending);
    } catch (e) {
      throw oauthFailure(e);
    }
    return connected(s.provider_id, tokens, s.id, user.id, request);
  });

  /** Claude: paste a `claude setup-token` value instead of the browser flow. */
  app.post("/admin/ai/providers/:id/oauth/token", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const { token } = parse(z.object({ token: z.string().trim().min(10).max(4096) }), request.body);
    const p = await getProviderRow(app.db, id);
    if (p.kind !== "claude-oauth") throw new PlatformError("oauth_unsupported");
    let tokens: OAuthTokens;
    try {
      tokens = claudeSetupToken(token);
    } catch (e) {
      throw oauthFailure(e);
    }
    return connected(p.id, tokens, null, user.id, request);
  });

  app.post("/admin/ai/providers/:id/oauth/logout", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const p = await getProviderRow(app.db, id);
    if (p.kind === "chatgpt" && p.oauth_tokens) {
      const t = decryptJson<OAuthTokens>(p.oauth_tokens, oauthAad(p.id));
      await revokeChatgpt(t).catch(() => undefined);
    }
    await clearTokens(app.db, id);
    await audit(request, user.id, "ai.provider.oauth_logout", "ai_provider", id);
    platform.invalidate();
    return { ok: true, chatgpt_verification_url: p.kind === "chatgpt" ? CHATGPT.verificationUrl : undefined };
  });

  // ---------------------------------------------------------------- routes

  app.get("/admin/ai/routes", async (request) => {
    await requireAdmin(request);
    const snap = await loadSnapshot(app.db);
    const routes = [...snap.routes.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    const hints = await platform.visionHints();
    return {
      routes: routes.map((r) => {
        const out = publicRoute(r, snap);
        if (r.capability !== "chat") return out;
        return {
          ...out,
          members: out.members.map((m) => {
            const p = m.provider_id ? snap.providers.get(m.provider_id) : undefined;
            return p && m.model ? { ...m, vision: memberVision(p, m.model, m.params ?? {}, hints) } : m;
          }),
        };
      }),
    };
  });

  /** Vision detection for one account + model (route editor badge); re-reads a stale model listing first. */
  app.get("/admin/ai/vision", async (request) => {
    await requireAdmin(request);
    const q = parse(z.object({ provider_id: uuid, model: z.string().trim().min(1).max(300) }), request.query);
    const p = await getProviderRow(app.db, q.provider_id);
    if (p.family !== "llm") return { detected: false, source: "vendor" };
    if ((await refreshStaleHints(app.db, [p])) > 0) platform.invalidate();
    return detectVision(p, q.model, await platform.visionHints());
  });

  app.post("/admin/ai/routes", async (request, reply) => {
    const user = await requireAdmin(request);
    const body = parse(routeInput, request.body);
    const r = await saveRoute(platform, null, body);
    await audit(request, user.id, "ai.route.create", "ai_route", r.route.id, { name: body.name });
    return reply.code(201).send(r);
  });

  app.put("/admin/ai/routes/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(routeInput, request.body);
    const r = await saveRoute(platform, id, body);
    await audit(request, user.id, "ai.route.update", "ai_route", id, { name: body.name });
    return r;
  });

  app.delete("/admin/ai/routes/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteRoute(platform, id);
    await audit(request, user.id, "ai.route.delete", "ai_route", id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- roles + health

  app.get("/admin/ai/roles", async (request) => {
    await requireAdmin(request);
    const snap = await loadSnapshot(app.db);
    const status = await platform.statusDetail();
    return {
      roles: AI_ROLES.map((role) => ({ role, route_id: snap.roles.get(role) ?? null, status: status.find((s) => s.role === role) ?? null })),
    };
  });

  app.put("/admin/ai/roles/:role", async (request) => {
    const user = await requireAdmin(request);
    const { role } = parse(z.object({ role: z.enum(AI_ROLES) }), request.params);
    const { route_id } = parse(z.object({ route_id: uuid.nullable() }), request.body);
    const r = await bindRole(platform, role as AiRole, route_id, user.id);
    await audit(request, user.id, "ai.role.bind", "ai_role", null, { role, route_id });
    const status = await platform.recompute();
    return { role, route_id, status: status.find((s) => s.role === role) ?? null, created_space: r.space };
  });

  app.get("/admin/ai/health", async (request) => {
    await requireAdmin(request);
    return { roles: await platform.statusDetail() };
  });

  app.post("/admin/ai/health/probe", async (request) => {
    await requireAdmin(request);
    await platform.probeAll();
    return { roles: await platform.recompute() };
  });

  // ---------------------------------------------------------------- traffic

  const callQuery = z.object({
    role: z.enum(AI_ROLES).optional(),
    provider_id: uuid.optional(),
    model: z.string().max(200).optional(),
    ok: z.enum(["true", "false"]).optional(),
    error_code: z.string().max(60).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    final: z.enum(["true", "false"]).optional(),
    probes: z.enum(["true", "false"]).optional(),
  });

  app.get("/admin/ai/calls", async (request) => {
    await requireAdmin(request);
    const q = parse(callQuery, request.query);
    return listCalls(app.db, {
      role: q.role,
      providerId: q.provider_id,
      model: q.model,
      ok: q.ok === undefined ? undefined : q.ok === "true",
      errorCode: q.error_code,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      before: q.before,
      limit: q.limit,
      finalOnly: q.final === "true",
      includeProbes: q.probes === "true",
    });
  });

  app.get("/admin/ai/stats", async (request) => {
    await requireAdmin(request);
    const { window } = parse(z.object({ window: z.enum(Object.keys(STAT_WINDOWS) as [StatWindow, ...StatWindow[]]).default("24h") }), request.query);
    return callStats(app.db, window);
  });

  // ---------------------------------------------------------------- embeddings

  app.get("/admin/ai/embedding", async (request) => {
    await requireAdmin(request);
    return embeddingOverview(platform);
  });

  app.post("/admin/ai/embedding/precheck", async (request) => {
    await requireAdmin(request);
    const { route_id } = parse(z.object({ route_id: uuid }), request.body);
    const snap = await loadSnapshot(app.db);
    const tree = resolveRoute(snap, route_id);
    if (!leaves(tree).length) throw new PlatformError("route_invalid", { message_zh: "這條路由沒有成員。" });
    const pre = await precheckRoute(platform, tree);
    return {
      same_identity: pre.sameIdentity,
      comparison: pre.comparison,
      active_space: pre.activeSpace,
      candidate: summarize(pre.candidate),
      action: !pre.activeSpace ? "bind" : pre.sameIdentity ? "bind" : "switch",
    };
  });

  app.post("/admin/ai/embedding/switch", async (request, reply) => {
    const user = await requireAdmin(request);
    const { route_id } = parse(z.object({ route_id: uuid }), request.body);
    const space = await startSwitch(platform, await loadSnapshot(app.db), route_id, user.id);
    await audit(request, user.id, "ai.embedding.switch_start", "embedding_space", space.id, { route_id });
    return reply.code(201).send({ space });
  });

  app.post("/admin/ai/embedding/spaces/:id/flip", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await flipSwitch(platform, id, user.id);
    await audit(request, user.id, "ai.embedding.switch_flip", "embedding_space", id);
    return embeddingOverview(platform);
  });

  app.post("/admin/ai/embedding/spaces/:id/cancel", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await cancelSwitch(platform, id);
    await audit(request, user.id, "ai.embedding.switch_cancel", "embedding_space", id);
    return embeddingOverview(platform);
  });

  app.delete("/admin/ai/embedding/spaces/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteRetiredSpace(app.db, id);
    await audit(request, user.id, "ai.embedding.space_delete", "embedding_space", id);
    return embeddingOverview(platform);
  });

  // ---------------------------------------------------------------- export / import

  app.get("/admin/ai/export", async (request, reply) => {
    const user = await requireAdmin(request);
    const { include_secrets } = parse(z.object({ include_secrets: z.enum(["0", "1"]).default("0") }), request.query);
    const withSecrets = include_secrets === "1";
    const file = await exportSettings(app.db, withSecrets);
    await audit(request, user.id, "ai.settings.export", "ai_settings", null, { secrets: withSecrets });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("cache-control", "no-store");
    reply.header("content-disposition", `attachment; filename="ai-settings-${stamp}${withSecrets ? "-SECRET" : ""}.json"`);
    return file;
  });

  app.post("/admin/ai/import", async (request) => {
    const user = await requireAdmin(request);
    const body = parse(z.object({ file: z.unknown(), include_secrets: z.boolean().default(false) }), request.body);
    const r = await importSettings(platform, body.file, { includeSecrets: body.include_secrets, userId: user.id });
    await audit(request, user.id, "ai.settings.import", "ai_settings", null, { ...r, warnings: r.warnings.length });
    return r;
  });
}

function oauthFailure(e: unknown) {
  if (isPlatformError(e)) return e;
  const err = fromThrown(e);
  if (err.code === "unsupported")
    return new PlatformError("oauth_failed", { message_zh: "ChatGPT 尚未開啟裝置代碼登入。", hint_zh: "請先到 ChatGPT「設定 → 安全性」開啟「裝置代碼登入」，再按「開始登入」。" });
  return new PlatformError("oauth_failed", { message_zh: `訂閱帳號登入失敗：${err.message_zh}` });
}
