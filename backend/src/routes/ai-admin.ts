import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit, requireAdmin } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { isAiError, fromThrown } from "../ai/errors.js";
import { AI_ROLES, aiFor, isPlatformError, PlatformError, type AiRole } from "../ai/platform/index.js";
import {
  addModel,
  bindRoles,
  createProvider,
  deleteGroup,
  deleteModel,
  deleteProvider,
  draftProvider,
  exportSettings,
  getProviderRow,
  groupAsRoute,
  importSettings,
  patchModel,
  publicBinding,
  publicGroup,
  publicModel,
  publicProvider,
  registryPayload,
  routeInputToGroup,
  saveGroup,
  updateProvider,
  type TargetInput,
} from "../ai/platform/admin-service.js";
import { callStats, listCalls, STAT_WINDOWS, type StatWindow } from "../ai/platform/call-log.js";
import { encryptJson, decryptJson, oauthAad, sessionAad } from "../ai/platform/crypto.js";
import { probeProvider } from "../ai/platform/health.js";
import { clearTokens, saveTokens } from "../ai/platform/oauth-store.js";
import { llmClient } from "../ai/platform/clients.js";
import { loadSnapshot, type ProviderRecord } from "../ai/platform/store.js";
import { detectVision } from "../ai/platform/vision.js";
import { recordApiFact, resolveProfile, syncModels, syncStaleModels } from "../ai/platform/models.js";
import { PROFILE_FIELDS } from "../ai/catalog/index.js";
import { leaves, resolveTarget } from "../ai/router/index.js";
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
const capability = z.enum(["chat", "embedding", "asr"]);
const modelIdText = z.string().trim().min(1).max(300);
const memberInput = z.object({
  model_id: uuid.nullish(),
  provider_id: uuid.nullish(),
  model: z.string().trim().max(300).nullish(),
  child_group_id: uuid.nullish(),
  weight: z.number().int().min(1).max(1000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
const groupInput = z.object({
  name,
  capability,
  strategy: z.enum(["fallback", "round_robin", "load_balance"]),
  description: z.string().max(500).optional(),
  members: z.array(memberInput).max(32),
});
/** Deprecated v1 shape (scripts, older tests). */
const routeInput = z.object({
  name,
  capability,
  strategy: z.enum(["single", "fallback", "round_robin", "load_balance"]),
  description: z.string().max(500).optional(),
  members: z.array(memberInput.extend({ child_route_id: uuid.nullish() })).max(32),
});
const targetInput = z.union([
  z.object({ model_id: uuid }).strict(),
  z.object({ group_id: uuid }).strict(),
  z.object({ provider_id: uuid, model: modelIdText }).strict(),
]);
const profilePatch = z.partialRecord(z.enum(PROFILE_FIELDS as [string, ...string[]]), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]));

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
    let models: Array<{ id: string; label?: string; kind?: string; vision?: boolean }> = [];
    let modelsError: { error: string; code: string; hint: string } | null = null;
    let synced: number | null = null;
    if (probe.ok || p.family === "asr") {
      try {
        // Saved accounts store the listing as model profiles ("測試連線" = "同步模型").
        const listed = saved ? await syncModels(app.db, p) : p.family === "llm" && p.kind !== "claude-cli" ? { models: await llmClient(app.db, p).listModels(), count: null } : { models: [], count: null };
        synced = saved ? listed.count : null;
        models = listed.models.map((m) => {
          const prof = resolveProfile(p, { model_id: m.id, api: {}, overrides: {} });
          return { id: m.id, label: m.label, kind: m.kind ?? prof.fields.capability, ...(m.hints?.vision !== undefined ? { vision: m.hints.vision } : {}) };
        });
        if (saved) platform.invalidate();
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
          const dims = r.dims || r.vectors[0]?.length;
          check = { ok: true, latencyMs: Date.now() - t0, detail_zh: `向量維度 ${dims}。`, dims };
          // A measured fact: the profile learns the model's vector size.
          if (saved && dims) await recordApiFact(app.db, p.id, body.model, { embedding_dims: dims, capability: "embedding" });
        } else {
          const r = await platform.chatOnce(p, body.model);
          check = { ok: true, latencyMs: Date.now() - t0, detail_zh: `模型回應正常（${r.length} 字）。` };
        }
      } catch (e) {
        const err = isPlatformError(e) ? null : fromThrown(e);
        check = { ok: false, latencyMs: Date.now() - t0, detail_zh: err?.message_zh ?? (e as PlatformError).message_zh, error: err?.toResponse() ?? (e as PlatformError).toResponse() };
      }
    }
    return { probe, models, models_error: modelsError, models_synced: synced, check };
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

  // ---------------------------------------------------------------- model profiles

  app.get("/admin/ai/models", async (request) => {
    await requireAdmin(request);
    const q = parse(z.object({ provider_id: uuid.optional() }), request.query);
    const snap = await loadSnapshot(app.db);
    const models = [...snap.models.values()].filter((m) => !q.provider_id || m.provider_id === q.provider_id);
    return { models: models.map((m) => publicModel(m, snap)) };
  });

  /** Add a model id the listing does not show (or an account without a listing). */
  app.post("/admin/ai/models", async (request, reply) => {
    const user = await requireAdmin(request);
    const body = parse(z.object({ provider_id: uuid, model_id: modelIdText, overrides: profilePatch.optional() }), request.body);
    const m = await addModel(platform, body);
    await audit(request, user.id, "ai.model.create", "ai_model", m.id, { model: body.model_id });
    return reply.code(201).send({ model: m });
  });

  /** Enable/hide in pickers; manual overrides per field (`null` clears back to provider/catalog data). */
  app.patch("/admin/ai/models/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(z.object({ enabled: z.boolean().optional(), overrides: profilePatch.optional() }), request.body);
    const m = await patchModel(platform, id, body);
    await audit(request, user.id, "ai.model.update", "ai_model", id, { enabled: body.enabled, fields: Object.keys(body.overrides ?? {}) });
    return { model: m };
  });

  /** Bulk enable/hide (e.g. "hide every image model"). */
  app.post("/admin/ai/models/visibility", async (request) => {
    const user = await requireAdmin(request);
    const body = parse(z.object({ ids: z.array(uuid).min(1).max(5000), enabled: z.boolean() }), request.body);
    const r = await app.db.query("UPDATE ai_models SET enabled=$2, updated_at=now() WHERE id = ANY($1::uuid[])", [body.ids, body.enabled]);
    await audit(request, user.id, "ai.model.visibility", "ai_model", null, { count: r.rowCount, enabled: body.enabled });
    platform.invalidate();
    return { updated: r.rowCount ?? 0 };
  });

  app.delete("/admin/ai/models/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteModel(platform, id);
    await audit(request, user.id, "ai.model.delete", "ai_model", id);
    return { ok: true };
  });

  /** 同步模型: re-read the account's model list into profiles. */
  app.post("/admin/ai/providers/:id/sync", async (request) => {
    await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const p = await getProviderRow(app.db, id);
    let count: number;
    try {
      count = (await syncModels(app.db, p)).count;
    } catch (e) {
      throw isPlatformError(e) ? e : fromThrown(e);
    }
    platform.invalidate();
    const snap = await loadSnapshot(app.db);
    return { count, models: [...snap.models.values()].filter((m) => m.provider_id === id).map((m) => publicModel(m, snap)) };
  });

  /** Vision detection for one account + model (badges); re-reads a stale model listing first. */
  app.get("/admin/ai/vision", async (request) => {
    await requireAdmin(request);
    const q = parse(z.object({ provider_id: uuid, model: z.string().trim().min(1).max(300) }), request.query);
    const p = await getProviderRow(app.db, q.provider_id);
    if (p.family !== "llm") return { detected: false, source: "vendor" };
    if ((await syncStaleModels(app.db, [p])) > 0) platform.invalidate();
    const snap = await loadSnapshot(app.db);
    const row = [...snap.models.values()].find((m) => m.provider_id === p.id && m.model_id === q.model);
    return detectVision(p, q.model, row?.profile ?? resolveProfile(p, { model_id: q.model, api: {}, overrides: {} }));
  });

  // ---------------------------------------------------------------- groups

  const listGroups = async () => {
    const snap = await loadSnapshot(app.db);
    return [...snap.groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")).map((g) => publicGroup(g, snap));
  };

  app.get("/admin/ai/groups", async (request) => {
    await requireAdmin(request);
    return { groups: await listGroups() };
  });

  app.post("/admin/ai/groups", async (request, reply) => {
    const user = await requireAdmin(request);
    const body = parse(groupInput, request.body);
    const r = await saveGroup(platform, null, body);
    await audit(request, user.id, "ai.group.create", "ai_group", r.group.id, { name: body.name });
    return reply.code(201).send(r);
  });

  app.put("/admin/ai/groups/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(groupInput, request.body);
    const r = await saveGroup(platform, id, body);
    await audit(request, user.id, "ai.group.update", "ai_group", id, { name: body.name });
    return r;
  });

  app.delete("/admin/ai/groups/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteGroup(platform, id);
    await audit(request, user.id, "ai.group.delete", "ai_group", id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- role bindings

  const bindingsPayload = async () => {
    const snap = await loadSnapshot(app.db);
    const status = await platform.statusDetail();
    return AI_ROLES.map((role) => ({ ...publicBinding(role, snap), status: status.find((s) => s.role === role) ?? null }));
  };

  app.get("/admin/ai/bindings", async (request) => {
    await requireAdmin(request);
    return { bindings: await bindingsPayload() };
  });

  /** Bulk bind: every role in `roles` → one model or group (`target: null` unbinds them). */
  const bulkBody = z.object({ roles: z.array(z.enum(AI_ROLES)).min(1).max(AI_ROLES.length), target: targetInput.nullable(), params: z.record(z.string(), z.unknown()).optional() });
  app.put("/admin/ai/bindings", async (request) => {
    const user = await requireAdmin(request);
    const body = parse(bulkBody, request.body);
    const r = await bindRoles(platform, body.roles as AiRole[], body.target as TargetInput | null, body.params, user.id);
    await audit(request, user.id, "ai.role.bind", "ai_role", null, { roles: body.roles, target: body.target });
    await platform.recompute();
    return { bindings: await bindingsPayload(), created_space: r.space, warnings: r.warnings };
  });

  app.put("/admin/ai/bindings/:role", async (request) => {
    const user = await requireAdmin(request);
    const { role } = parse(z.object({ role: z.enum(AI_ROLES) }), request.params);
    const body = parse(bulkBody.omit({ roles: true }), request.body);
    const r = await bindRoles(platform, [role as AiRole], body.target as TargetInput | null, body.params, user.id);
    await audit(request, user.id, "ai.role.bind", "ai_role", null, { roles: [role], target: body.target });
    await platform.recompute();
    return { bindings: await bindingsPayload(), created_space: r.space, warnings: r.warnings };
  });

  /** Live chips for the routing diagram: per model (attempts) and per role (calls), last 24 h. */
  app.get("/admin/ai/overview", async (request) => {
    await requireAdmin(request);
    const stats = await callStats(app.db, "24h");
    return { window: stats.window, models: stats.members, roles: stats.roles };
  });

  // ---------------------------------------------------------------- legacy routes API (deprecated aliases)

  app.get("/admin/ai/routes", async (request) => {
    await requireAdmin(request);
    return { routes: (await listGroups()).map(groupAsRoute) };
  });

  app.post("/admin/ai/routes", async (request, reply) => {
    const user = await requireAdmin(request);
    const body = parse(routeInput, request.body);
    const r = await saveGroup(platform, null, routeInputToGroup(body));
    await audit(request, user.id, "ai.group.create", "ai_group", r.group.id, { name: body.name });
    return reply.code(201).send({ route: groupAsRoute(r.group), group: r.group, warnings: r.warnings });
  });

  app.put("/admin/ai/routes/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(routeInput, request.body);
    const r = await saveGroup(platform, id, routeInputToGroup(body));
    await audit(request, user.id, "ai.group.update", "ai_group", id, { name: body.name });
    return { route: groupAsRoute(r.group), group: r.group, warnings: r.warnings };
  });

  app.delete("/admin/ai/routes/:id", async (request) => {
    const user = await requireAdmin(request);
    const { id } = parse(idParams, request.params);
    await deleteGroup(platform, id);
    await audit(request, user.id, "ai.group.delete", "ai_group", id);
    return { ok: true };
  });

  app.get("/admin/ai/roles", async (request) => {
    await requireAdmin(request);
    const b = await bindingsPayload();
    return { roles: b.map((x) => ({ role: x.role, route_id: x.target?.type === "group" ? x.target.group_id : null, target: x.target, status: x.status })) };
  });

  app.put("/admin/ai/roles/:role", async (request) => {
    const user = await requireAdmin(request);
    const { role } = parse(z.object({ role: z.enum(AI_ROLES) }), request.params);
    const { route_id } = parse(z.object({ route_id: uuid.nullable() }), request.body);
    const r = await bindRoles(platform, [role as AiRole], route_id ? { group_id: route_id } : null, undefined, user.id);
    await audit(request, user.id, "ai.role.bind", "ai_role", null, { roles: [role], target: route_id ? { group_id: route_id } : null });
    const status = await platform.recompute();
    return { role, route_id, status: status.find((s) => s.role === role) ?? null, created_space: r.space };
  });

  // ---------------------------------------------------------------- health

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

  /** `target` (model or group) or the deprecated `route_id` (= group id). */
  const embeddingBody = z.object({ target: z.union([z.object({ model_id: uuid }), z.object({ group_id: uuid })]).optional(), route_id: uuid.optional(), params: z.record(z.string(), z.unknown()).optional() });
  const embeddingTarget = (b: z.infer<typeof embeddingBody>) => {
    const t = b.target as { model_id?: string; group_id?: string } | undefined;
    if (t?.model_id) return { model_ref: t.model_id, group_id: null, params: b.params ?? {} };
    const g = t?.group_id ?? b.route_id;
    if (!g) throw new PlatformError("route_invalid", { message_zh: "請選擇 embedding 模型或群組。" });
    return { model_ref: null, group_id: g, params: {} };
  };

  app.get("/admin/ai/embedding", async (request) => {
    await requireAdmin(request);
    return embeddingOverview(platform);
  });

  app.post("/admin/ai/embedding/precheck", async (request) => {
    await requireAdmin(request);
    const target = embeddingTarget(parse(embeddingBody, request.body));
    const snap = await loadSnapshot(app.db);
    const tree = resolveTarget(snap, target, "embedding", "embedding");
    if (!leaves(tree).length) throw new PlatformError("route_invalid", { message_zh: "這個群組沒有成員。" });
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
    const target = embeddingTarget(parse(embeddingBody, request.body));
    const space = await startSwitch(platform, await loadSnapshot(app.db), target, user.id);
    await audit(request, user.id, "ai.embedding.switch_start", "embedding_space", space.id, { target });
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
