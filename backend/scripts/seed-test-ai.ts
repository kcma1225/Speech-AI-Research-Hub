/**
 * Staging/testing seed (NOT a migration): registers the user's test gateway as a generic OpenAI-compatible account,
 * syncs its model profiles, saves a fallback group「測試（最便宜）」(glm/glm-5.3-flash → glm/glm-5-turbo) and
 * bulk-binds the chat roles to it.
 * Idempotent; talks to a running hub through the admin API, so it works against any stack.
 *
 *   set -a; . <scratchpad>/test-llm.env; set +a
 *   HUB_URL=http://127.0.0.1:18090 HUB_OWNER_NAME=admin HUB_OWNER_PASSWORD=<admin password> npx tsx scripts/seed-test-ai.ts
 *
 * The API key is read from TEST_LLM_API_KEY at run time and stored encrypted by the hub; never commit it.
 */
const HUB = (process.env.HUB_URL ?? "http://127.0.0.1:18090").replace(/\/+$/, "");
const base = process.env.TEST_LLM_BASE_URL;
const key = process.env.TEST_LLM_API_KEY;
if (!base || !key) {
  console.error("Set TEST_LLM_BASE_URL and TEST_LLM_API_KEY.");
  process.exit(2);
}
const PROVIDER_NAME = "測試閘道（OpenAI 相容）";
const GROUP_NAME = "測試（最便宜）";
const ROLES = ["assistant", "writing", "slides", "analysis", "fast"];
const origin = new URL(HUB).origin;
let cookie = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HUB}/api${path}`, {
    method,
    headers: { origin, cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.code ?? ""} ${data.error ?? ""}`);
  return data as T;
}

await api("POST", "/auth/login", { username: process.env.HUB_OWNER_NAME ?? "admin", password: process.env.HUB_OWNER_PASSWORD ?? "" });

const { providers } = await api<{ providers: Array<{ id: string; name: string; family: string }> }>("GET", "/admin/ai/providers");
let provider = providers.find((p) => p.family === "llm" && p.name === PROVIDER_NAME);
const form = { config: { baseUrl: base, timeoutMs: 120_000, supportsTools: true }, secrets: { apiKey: key } };
if (provider) await api("PATCH", `/admin/ai/providers/${provider.id}`, form);
else provider = (await api("POST", "/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: PROVIDER_NAME, ...form })).provider;
console.log(`provider: ${PROVIDER_NAME} (${provider!.id})`);

const sync = await api<{ count: number; models: Array<{ id: string; model_id: string }> }>("POST", `/admin/ai/providers/${provider!.id}/sync`);
console.log(`models synced: ${sync.count}`);
const modelRef = (id: string) => {
  const m = sync.models.find((x) => x.model_id === id);
  return m ? { model_id: m.id } : { provider_id: provider!.id, model: id };
};

const { groups } = await api<{ groups: Array<{ id: string; name: string }> }>("GET", "/admin/ai/groups");
const groupBody = {
  name: GROUP_NAME,
  capability: "chat",
  strategy: "fallback",
  description: "測試用：最便宜的模型，失敗時改用 glm-5-turbo。",
  members: [
    { ...modelRef("glm/glm-5.3-flash"), params: { timeout_ms: 120_000, max_retries: 1 } },
    { ...modelRef("glm/glm-5-turbo"), params: { timeout_ms: 120_000, max_retries: 1 } },
  ],
};
const existing = groups.find((g) => g.name === GROUP_NAME);
const group = existing ? (await api("PUT", `/admin/ai/groups/${existing.id}`, groupBody)).group : (await api("POST", "/admin/ai/groups", groupBody)).group;
console.log(`group: ${GROUP_NAME} (${group.id})`);

const bound = await api<{ bindings: Array<{ role: string; status: { state: string } | null }> }>("PUT", "/admin/ai/bindings", { roles: ROLES, target: { group_id: group.id } });
for (const b of bound.bindings.filter((x) => ROLES.includes(x.role))) console.log(`bound ${b.role} → ${b.status?.state ?? "?"}`);
const test = await api("POST", `/admin/ai/providers/${provider!.id}/test`, {});
console.log(`probe: ${test.probe.ok ? "ok" : "failed"} — ${test.probe.detail_zh}`);
