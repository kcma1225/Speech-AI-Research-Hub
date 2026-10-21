/**
 * Model profiles (`ai_models`): one per account + model id. Limits and capabilities are per model, never per
 * account. Each field's effective value = manual override > provider listing (`provider_api`) > catalog, and the
 * profile remembers where every value came from (shown as a small source tag in /admin/models).
 *
 * Profiles are filled by "sync" (the account's list-models API; see codecs' listModels for per-vendor metadata
 * parsing), by the admin (manual add / override) and implicitly when a binding or group names a model id that has
 * no profile yet.
 */
import type { Db, Queryable } from "../../db.js";
import { getAsrEntry } from "../asr/index.js";
import { catalogLookup, cleanFields, looksNonText, PROFILE_FIELDS, type CatalogEntry, type FieldSource, type ModelCapability, type ProfileField, type ProfileFields } from "../catalog/index.js";
import { getProvider } from "../providers/index.js";
import type { ModelInfo } from "../types.js";
import { llmClient, type ClientFactoryOptions } from "./clients.js";
import type { ProviderRecord } from "./store.js";

export type ModelRow = {
  id: string;
  provider_id: string;
  model_id: string;
  origin: "sync" | "manual";
  listed: boolean;
  enabled: boolean;
  api: ProfileFields;
  overrides: ProfileFields;
  refreshed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ResolvedProfile = {
  /** Effective values. `capability` is always set. */
  fields: ProfileFields & { capability: ModelCapability };
  sources: Partial<Record<ProfileField, FieldSource>>;
  catalog_id: string | null;
};

export type ModelRecord = ModelRow & { profile: ResolvedProfile };

export const MODEL_COLUMNS = "id,provider_id,model_id,origin,listed,enabled,api,overrides,refreshed_at,created_at,updated_at";

/** Listings older than this are re-read by the probe leader (bound accounts only). */
export const MODELS_TTL_MS = 6 * 3_600_000;

/** Pure merge: manual > provider_api > catalog, field by field. */
export function mergeProfile(catalog: ProfileFields, api: ProfileFields, manual: ProfileFields, fallbackCapability: ModelCapability = "chat"): Omit<ResolvedProfile, "catalog_id"> {
  const fields: ProfileFields = {};
  const sources: ResolvedProfile["sources"] = {};
  for (const k of PROFILE_FIELDS) {
    const layers: Array<[FieldSource, ProfileFields]> = [
      ["manual", manual],
      ["provider_api", api],
      ["catalog", catalog],
    ];
    for (const [src, layer] of layers) {
      const v = layer[k];
      if (v !== undefined && v !== null) {
        (fields as Record<string, unknown>)[k] = v;
        sources[k] = src;
        break;
      }
    }
  }
  if (!fields.capability) {
    fields.capability = fallbackCapability;
    sources.capability = "catalog";
  }
  return { fields: fields as ResolvedProfile["fields"], sources };
}

export function resolveProfile(p: Pick<ProviderRecord, "family">, row: Pick<ModelRow, "model_id" | "api" | "overrides">): ResolvedProfile {
  const cat = catalogLookup(row.model_id, p.family);
  const merged = mergeProfile(cat.fields, cleanFields(row.api), cleanFields(row.overrides), p.family === "asr" ? "asr" : "chat");
  // An ASR account only serves speech models, whatever a manual override says.
  if (p.family === "asr") merged.fields.capability = "asr";
  return { ...merged, catalog_id: (cat.entry as CatalogEntry | null)?.id ?? null };
}

export function withProfile(p: Pick<ProviderRecord, "family">, row: ModelRow): ModelRecord {
  return { ...row, profile: resolveProfile(p, row) };
}

export async function loadModelRows(db: Queryable): Promise<ModelRow[]> {
  return (await db.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM ai_models ORDER BY provider_id, model_id`)).rows;
}

export async function getModelRow(db: Queryable, id: string): Promise<ModelRow | null> {
  return (await db.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM ai_models WHERE id=$1`, [id])).rows[0] ?? null;
}

// ---------------------------------------------------------------- listing → profile fields

/** Converts one listing entry into `provider_api` fields (only what the vendor actually reported). */
export function apiFieldsFromInfo(m: ModelInfo): ProfileFields {
  const f: ProfileFields = {};
  if (m.label && m.label !== m.id) f.display_name = m.label;
  if (m.kind === "embedding") f.capability = "embedding";
  else if (m.kind === "chat") f.capability = "chat";
  else if (m.kind === "asr") f.capability = "asr";
  if (m.contextWindow) f.context_window = m.contextWindow;
  if (m.maxOutputTokens) f.max_output_tokens = m.maxOutputTokens;
  if (m.dims) f.embedding_dims = m.dims;
  if (m.inputPrice !== undefined) f.input_price = m.inputPrice;
  if (m.outputPrice !== undefined) f.output_price = m.outputPrice;
  const h = m.hints ?? {};
  if (h.vision !== undefined) f.vision = h.vision;
  if (h.tools !== undefined) f.tools = h.tools;
  if (h.reasoning !== undefined) f.reasoning = h.reasoning;
  if (h.jsonSchema !== undefined) f.json_schema = h.jsonSchema;
  return cleanFields(f);
}

// ---------------------------------------------------------------- writes

/**
 * Replaces an account's listing: listed models are upserted with their provider fields; rows that disappeared
 * are marked unlisted, and deleted when nothing uses them, they were never edited and came from a listing.
 * Non-text models (image, TTS, moderation…) start hidden. Returns the number of listed models.
 */
export async function storeListing(db: Queryable, providerId: string, models: ModelInfo[]): Promise<number> {
  const seen = new Map<string, ModelInfo>();
  for (const m of models) if (m.id && m.id.length <= 300 && !seen.has(m.id)) seen.set(m.id, m);
  const rows = [...seen.values()].slice(0, 5000).map((m) => ({ model: m.id, api: apiFieldsFromInfo(m), hidden: looksNonText(m.id) || m.kind === "other" }));
  await db.query(
    `INSERT INTO ai_models(provider_id, model_id, origin, listed, enabled, api, refreshed_at)
     SELECT $1, x.model, 'sync', true, NOT x.hidden, x.api, now() FROM jsonb_to_recordset($2::jsonb) AS x(model text, api jsonb, hidden boolean)
     ON CONFLICT (provider_id, model_id) DO UPDATE SET api = EXCLUDED.api, listed = true, refreshed_at = now(), updated_at = now()`,
    [providerId, JSON.stringify(rows)],
  );
  const names = rows.map((r) => r.model);
  await db.query("UPDATE ai_models SET listed = false WHERE provider_id = $1 AND listed AND NOT (model_id = ANY($2::text[]))", [providerId, names]);
  await db.query(
    `DELETE FROM ai_models m WHERE m.provider_id = $1 AND NOT m.listed AND m.origin = 'sync' AND m.overrides = '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM ai_group_members g WHERE g.model_ref = m.id)
       AND NOT EXISTS (SELECT 1 FROM ai_role_bindings b WHERE b.model_ref = m.id)
       AND NOT EXISTS (SELECT 1 FROM embedding_spaces e WHERE e.model_ref = m.id)`,
    [providerId],
  );
  await db.query("UPDATE ai_providers SET models_synced_at = now() WHERE id = $1", [providerId]);
  return rows.length;
}

/** ASR accounts have no listing API: their registry's suggested models become (unlisted-origin) profiles. */
export async function seedAsrModels(db: Queryable, p: ProviderRecord): Promise<number> {
  const entry = getAsrEntry(p.kind);
  const ids = [...new Set([...(entry?.models ?? []), ...(typeof p.config.model === "string" && p.config.model ? [p.config.model] : [])])];
  if (!ids.length) return 0;
  await db.query(
    `INSERT INTO ai_models(provider_id, model_id, origin, listed, refreshed_at) SELECT $1, x, 'sync', true, now() FROM unnest($2::text[]) AS x
     ON CONFLICT (provider_id, model_id) DO UPDATE SET listed = true, refreshed_at = now()`,
    [p.id, ids],
  );
  await db.query("UPDATE ai_providers SET models_synced_at = now() WHERE id = $1", [p.id]);
  return ids.length;
}

/**
 * Reads the account's model list and stores the profiles. Throws the vendor error (callers decide), except for
 * accounts without a listing (static models / ASR), which are seeded from the registry.
 */
export async function syncModels(db: Db, p: ProviderRecord, opts: ClientFactoryOptions & { signal?: AbortSignal } = {}): Promise<{ count: number; models: ModelInfo[] }> {
  if (p.family === "asr") return { count: await seedAsrModels(db, p), models: [] };
  const entry = getProvider(p.kind);
  if (p.kind === "claude-cli" || entry?.capabilities.listModels === false) {
    const ids = entry?.quirks.staticModels ?? [];
    const models = ids.map((id) => ({ id }) as ModelInfo);
    return { count: await storeListing(db, p.id, models), models };
  }
  const models = await llmClient(db, p, opts).listModels({ signal: opts.signal ?? AbortSignal.timeout(30_000) });
  return { count: await storeListing(db, p.id, models), models };
}

/** Never throws; remembers the attempt so a vendor without a listing is not asked every minute. */
export async function trySyncModels(db: Db, p: ProviderRecord, opts: ClientFactoryOptions = {}): Promise<boolean> {
  if (!p.enabled) return false;
  try {
    await syncModels(db, p, opts);
    return true;
  } catch {
    await db.query("UPDATE ai_providers SET models_synced_at = now() WHERE id = $1", [p.id]).catch(() => undefined);
    return false;
  }
}

/** Syncs the given accounts whose listing was never read or is older than `MODELS_TTL_MS`. */
export async function syncStaleModels(db: Db, providers: ProviderRecord[], opts: ClientFactoryOptions = {}): Promise<number> {
  if (!providers.length) return 0;
  const r = await db.query<{ id: string }>(
    "SELECT id FROM ai_providers WHERE id = ANY($1::uuid[]) AND (models_synced_at IS NULL OR models_synced_at < now() - make_interval(secs => $2))",
    [providers.map((p) => p.id), MODELS_TTL_MS / 1000],
  );
  const stale = new Set(r.rows.map((row) => row.id));
  let n = 0;
  for (const p of providers) if (stale.has(p.id) && (await trySyncModels(db, p, opts))) n++;
  return n;
}

/**
 * Profile row for an account + model id, created (origin `manual`) when missing. `capability` (when the caller
 * knows how the model will be used, e.g. a member of an embedding group) becomes a manual override only when the
 * catalog/listing would say otherwise.
 */
export async function ensureModel(db: Queryable, p: ProviderRecord, modelId: string, capability?: ModelCapability): Promise<ModelRow> {
  const id = modelId.trim();
  let row = (await db.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM ai_models WHERE provider_id=$1 AND model_id=$2`, [p.id, id])).rows[0];
  if (!row) {
    row = (
      await db.query<ModelRow>(
        `INSERT INTO ai_models(provider_id, model_id, origin, listed) VALUES($1,$2,'manual',false)
         ON CONFLICT (provider_id, model_id) DO UPDATE SET updated_at = ai_models.updated_at RETURNING ${MODEL_COLUMNS}`,
        [p.id, id],
      )
    ).rows[0]!;
  }
  if (capability && p.family === "llm" && resolveProfile(p, row).fields.capability !== capability) {
    row = (await db.query<ModelRow>(`UPDATE ai_models SET overrides = overrides || jsonb_build_object('capability', $2::text), updated_at=now() WHERE id=$1 RETURNING ${MODEL_COLUMNS}`, [row.id, capability])).rows[0]!;
  }
  return row;
}

/** Records a measured fact (e.g. embedding dims from a test call) as provider data. */
export async function recordApiFact(db: Queryable, providerId: string, modelId: string, fields: ProfileFields) {
  const clean = cleanFields(fields);
  if (!Object.keys(clean).length) return;
  await db.query(
    `INSERT INTO ai_models(provider_id, model_id, origin, listed, api) VALUES($1,$2,'manual',false,$3)
     ON CONFLICT (provider_id, model_id) DO UPDATE SET api = ai_models.api || EXCLUDED.api, updated_at = now()`,
    [providerId, modelId, JSON.stringify(clean)],
  );
}

/** Applies a manual override patch (`null` clears a field back to provider/catalog). */
export function applyOverridePatch(current: ProfileFields, patch: Record<string, unknown>): ProfileFields {
  const next: Record<string, unknown> = { ...cleanFields(current) };
  const cleaned = cleanFields(patch);
  for (const k of PROFILE_FIELDS) {
    if (!(k in patch)) continue;
    if (patch[k] === null) delete next[k];
    else if ((cleaned as Record<string, unknown>)[k] !== undefined) next[k] = (cleaned as Record<string, unknown>)[k];
  }
  return next as ProfileFields;
}
