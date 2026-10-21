import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, migrationsDir } from "../src/migrate.js";
import { hasTestDb } from "./helpers.js";

/** 0101_ai_models_routing.sql on v1-shaped routing data (named routes, role → route, hints, spaces, call log). */
describe.skipIf(!hasTestDb)("migration 0101 (model profiles + groups)", () => {
  const name = `t_${randomBytes(6).toString("hex")}`;
  let pool: pg.Pool;
  let before: string;
  const log = { info: () => {} };
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    before = await mkdtemp(path.join(tmpdir(), "mig-"));
    for (const file of await readdir(migrationsDir)) if (file < "0101") await copyFile(path.join(migrationsDir, file), path.join(before, file));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(before, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("converts routes into direct model bindings and groups without losing behaviour", async () => {
    await migrate(pool as never, log, before);
    const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    const prov = async (name: string, kind = "openai-compatible", config = {}) =>
      (await q<{ id: string }>("INSERT INTO ai_providers(family,kind,category,name,auth_type,config) VALUES('llm',$1,'local',$2,'none',$3) RETURNING id", [kind, name, JSON.stringify(config)]))[0]!.id;
    const gw = await prov("閘道");
    const ol = await prov("本機", "ollama", { numCtx: 16384, baseUrl: "http://x" });
    const route = async (name: string, strategy: string, capability = "chat") => (await q<{ id: string }>("INSERT INTO ai_routes(name,capability,strategy) VALUES($1,$2,$3) RETURNING id", [name, capability, strategy]))[0]!.id;
    const member = (r: string, pos: number, m: { p?: string; model?: string; child?: string; params?: object; weight?: number }) =>
      pool.query("INSERT INTO ai_route_members(route_id,position,provider_id,model,child_route_id,weight,params) VALUES($1,$2,$3,$4,$5,$6,$7)", [
        r,
        pos,
        m.p ?? null,
        m.model ?? null,
        m.child ?? null,
        m.weight ?? 1,
        JSON.stringify(m.params ?? {}),
      ]);
    // single-model route bound to two roles; also nested inside a fallback route
    const cheap = await route("便宜", "fallback");
    await member(cheap, 0, { p: gw, model: "glm/glm-5.3-flash", params: { timeout_ms: 120000, max_tokens: 500, vision: "yes" } });
    const main = await route("主要", "load_balance");
    await member(main, 0, { p: gw, model: "glm/glm-5-turbo", weight: 3 });
    await member(main, 1, { child: cheap, weight: 1 });
    await member(main, 2, { p: ol, model: "qwen3:8b" });
    const emb = await route("嵌入", "single", "embedding");
    await member(emb, 0, { p: gw, model: "bge-m3", params: { dimensions: 512 } });
    for (const [role, r] of [["writing", cheap], ["fast", cheap], ["assistant", main], ["embedding", emb]] as const) await pool.query("INSERT INTO ai_role_routes(role,route_id) VALUES($1,$2)", [role, r]);
    await pool.query("INSERT INTO ai_model_hints(provider_id,model,hints) VALUES($1,'glm/glm-5-turbo','{\"vision\":false,\"tools\":true}'),($1,'listed-only','{\"vision\":true}')", [gw]);
    await pool.query("UPDATE ai_providers SET model_hints_at=now() WHERE id=$1", [gw]);
    const space = (await q<{ id: string }>("INSERT INTO embedding_spaces(label,route_id,provider_kind,model,dims,status) VALUES('x',$1,'openai-compatible','bge-m3',512,'active') RETURNING id", [emb]))[0]!.id;
    await pool.query(
      "INSERT INTO ai_call_log(call_id,final,role,capability,route_id,provider_id,provider_kind,model,started_at,ok) VALUES(gen_random_uuid(),true,'assistant','chat',$1,$2,'openai-compatible','glm/glm-5-turbo',now(),true),(gen_random_uuid(),true,'writing','chat',$3,$2,'openai-compatible','glm/glm-5.3-flash',now(),true)",
      [main, gw, cheap],
    );

    await migrate(pool as never, log); // applies 0101 (and anything after it)

    const models = await q<{ id: string; provider_id: string; model_id: string; origin: string; listed: boolean; api: object; overrides: object }>("SELECT id,provider_id,model_id,origin,listed,api,overrides FROM ai_models ORDER BY model_id COLLATE \"C\"");
    const m = (id: string) => models.find((x) => x.model_id === id)!;
    expect(models.map((x) => x.model_id)).toEqual(["bge-m3", "glm/glm-5-turbo", "glm/glm-5.3-flash", "listed-only", "qwen3:8b"]);
    expect(m("glm/glm-5-turbo")).toMatchObject({ origin: "sync", listed: true, api: { vision: false, tools: true } });
    expect(m("glm/glm-5.3-flash")).toMatchObject({ origin: "manual", overrides: { vision: true } });
    expect(m("bge-m3").overrides).toEqual({ capability: "embedding" });
    expect(m("qwen3:8b").overrides).toEqual({ context_window: 16384 });
    expect((await q<{ config: object }>("SELECT config FROM ai_providers WHERE id=$1", [ol]))[0]!.config).toEqual({ baseUrl: "http://x" });

    // Only the multi-member route became a group (same id); the nested single-model route is inlined.
    const groups = await q<{ id: string; name: string; strategy: string }>("SELECT id,name,strategy FROM ai_groups");
    expect(groups).toEqual([{ id: main, name: "主要", strategy: "load_balance" }]);
    const members = await q<{ position: number; model_ref: string | null; child_group_id: string | null; weight: number; params: object }>("SELECT position,model_ref,child_group_id,weight,params FROM ai_group_members ORDER BY position");
    expect(members).toEqual([
      { position: 0, model_ref: m("glm/glm-5-turbo").id, child_group_id: null, weight: 3, params: {} },
      { position: 1, model_ref: m("glm/glm-5.3-flash").id, child_group_id: null, weight: 1, params: { timeout_ms: 120000 } },
      { position: 2, model_ref: m("qwen3:8b").id, child_group_id: null, weight: 1, params: {} },
    ]);
    const bindings = await q<{ role: string; model_ref: string | null; group_id: string | null; params: object }>("SELECT role,model_ref,group_id,params FROM ai_role_bindings ORDER BY role");
    expect(bindings).toEqual([
      { role: "assistant", model_ref: null, group_id: main, params: {} },
      { role: "embedding", model_ref: m("bge-m3").id, group_id: null, params: { dimensions: 512 } },
      { role: "fast", model_ref: m("glm/glm-5.3-flash").id, group_id: null, params: { timeout_ms: 120000 } },
      { role: "writing", model_ref: m("glm/glm-5.3-flash").id, group_id: null, params: { timeout_ms: 120000 } },
    ]);
    expect((await q("SELECT model_ref,group_id,params FROM embedding_spaces WHERE id=$1", [space]))[0]).toEqual({ model_ref: m("bge-m3").id, group_id: null, params: { dimensions: 512 } });
    const logs = await q<{ group_id: string | null; model_ref: string | null; role: string }>("SELECT role,group_id,model_ref FROM ai_call_log ORDER BY role");
    expect(logs).toEqual([
      { role: "assistant", group_id: main, model_ref: m("glm/glm-5-turbo").id },
      { role: "writing", group_id: null, model_ref: m("glm/glm-5.3-flash").id },
    ]);
    const gone = await q<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name IN ('ai_routes','ai_route_members','ai_role_routes','ai_model_hints')");
    expect(gone[0]!.n).toBe("0");
    expect((await q("SELECT models_synced_at FROM ai_providers WHERE id=$1", [gw]))[0]!.models_synced_at).toBeTruthy();
  });
});
