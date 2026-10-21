/**
 * Vision (image input) support per route member and per role.
 *
 * A member supports images when its `vision` param says so (`yes` / `no`, set by the admin), else when detection
 * does: the vendor's model listing (`ModelInfo.hints.vision`, stored in `ai_model_hints`), else a model-name
 * heuristic, else the registry entry (vendors whose current models all take images). Unknown means no.
 *
 * Requests that carry image blocks are only sent to members that support images: the router skips the others
 * (skip code `no_vision`, not logged). When no member with vision is left the call fails with `vision_unavailable`
 * (never `llm_unavailable`, so the role is not marked down and ai-worker does not wait). Images are never silently
 * stripped: a layout review without the screenshots would be invented.
 */
import type { Db, Queryable } from "../../db.js";
import { getProvider } from "../providers/index.js";
import type { ChatMessage, ModelInfo } from "../types.js";
import { llmClient, type ClientFactoryOptions } from "./clients.js";
import type { ParamField } from "./params.js";
import type { ProviderRecord } from "./store.js";

export type VisionSource = "override" | "model_list" | "name" | "vendor" | "unknown";
export type MemberVision = { vision: boolean; detected: boolean; source: VisionSource; overridden: boolean };
/** `<providerId>\0<model>` → hints.vision */
export type HintMap = Map<string, boolean>;

export const VISION_PARAM: ParamField = {
  key: "vision",
  type: "select",
  label: { zh: "視覺（影像輸入）", en: "Vision (image input)" },
  options: ["yes", "no"],
  option_labels: { yes: { zh: "支援", en: "Supported" }, no: { zh: "不支援", en: "Not supported" } },
  default_label: { zh: "自動偵測", en: "Auto-detect" },
  scope: "platform",
  help_zh: "能不能看圖片（簡報與論文的「AI 檢查排版」需要）。自動偵測依供應商的模型清單與模型名稱；偵測錯誤時可手動指定。",
};

/** Hints older than this are re-read from the vendor by the probe leader. */
export const HINTS_TTL_MS = 6 * 3_600_000;

// Model families that take images (used only when the vendor's listing says nothing).
const VISION_NAME =
  /(vision|(^|[-_/.])vl([-_/.:]|$)|vl-|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|(^|\/)(o3(?!-mini)|o4-mini)(-|$)|claude-(3|sonnet|opus|haiku)|claude-[a-z]+-[34]|gemini|gemma-?3|llava|pixtral|llama-?4|llama-?3\.2-.*vision|qvq|glm-\d(\.\d)?v|minicpm-v|internvl|grok-4|grok-.*vision|kimi-.*vl|moondream|phi-.*(vision|multimodal)|mistral-(small|medium)-3)/i;
// Vendors whose chat models (current generations) all accept images.
const VISION_VENDOR_CODECS = new Set(["anthropic-messages", "gemini"]);

export const hintKey = (providerId: string, model: string) => `${providerId}\u0000${model}`;

export function detectVision(provider: Pick<ProviderRecord, "id" | "kind">, model: string, hints: HintMap): { detected: boolean; source: VisionSource } {
  if (provider.kind === "claude-cli") return { detected: false, source: "vendor" }; // text-only adapter
  const entry = getProvider(provider.kind);
  if (entry && !entry.capabilities.vision) return { detected: false, source: "vendor" };
  const hint = hints.get(hintKey(provider.id, model));
  if (hint !== undefined) return { detected: hint, source: "model_list" };
  if (VISION_NAME.test(model)) return { detected: true, source: "name" };
  if (entry && VISION_VENDOR_CODECS.has(entry.codec)) return { detected: true, source: "vendor" };
  return { detected: false, source: "unknown" };
}

export function memberVision(provider: Pick<ProviderRecord, "id" | "kind">, model: string, params: Record<string, unknown>, hints: HintMap): MemberVision {
  const d = detectVision(provider, model, hints);
  if (params.vision === "yes" || params.vision === "no") return { vision: params.vision === "yes", detected: d.detected, source: "override", overridden: true };
  return { vision: d.detected, detected: d.detected, source: d.source, overridden: false };
}

/** Does the request carry images (user content or tool results)? */
export function hasImages(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "tool") continue;
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image") return true;
      if (b.type === "tool_result" && typeof b.content !== "string" && b.content.some((c) => c.type === "image")) return true;
    }
  }
  return false;
}

export async function loadHints(db: Queryable): Promise<HintMap> {
  const r = await db.query<{ provider_id: string; model: string; vision: boolean }>(
    "SELECT provider_id, model, (hints->>'vision')::boolean AS vision FROM ai_model_hints WHERE jsonb_typeof(hints->'vision') = 'boolean'",
  );
  return new Map(r.rows.map((row) => [hintKey(row.provider_id, row.model), row.vision]));
}

/** Replaces an account's stored hints with a fresh model listing. */
export async function storeModelHints(db: Queryable, providerId: string, models: ModelInfo[]) {
  const rows = models
    .filter((m) => m.hints && Object.keys(m.hints).length)
    .slice(0, 5000)
    .map((m) => ({ model: m.id.slice(0, 300), hints: m.hints }));
  await db.query("DELETE FROM ai_model_hints WHERE provider_id = $1", [providerId]);
  if (rows.length) {
    await db.query(
      `INSERT INTO ai_model_hints(provider_id, model, hints)
       SELECT $1, x.model, x.hints FROM jsonb_to_recordset($2::jsonb) AS x(model text, hints jsonb)
       ON CONFLICT (provider_id, model) DO UPDATE SET hints = EXCLUDED.hints, updated_at = now()`,
      [providerId, JSON.stringify(rows)],
    );
  }
  await db.query("UPDATE ai_providers SET model_hints_at = now() WHERE id = $1", [providerId]);
}

/** Lists the account's models and stores their hints. Never throws (returns false on failure). */
export async function refreshModelHints(db: Db, p: ProviderRecord, opts: ClientFactoryOptions = {}): Promise<boolean> {
  if (p.family !== "llm" || !p.enabled || p.kind === "claude-cli") return false;
  if (getProvider(p.kind)?.capabilities.listModels === false) return false;
  try {
    const models = await llmClient(db, p, opts).listModels({ signal: AbortSignal.timeout(20_000) });
    await storeModelHints(db, p.id, models);
    return true;
  } catch {
    // Remember the attempt so a vendor without a listing is not asked every minute.
    await db.query("UPDATE ai_providers SET model_hints_at = now() WHERE id = $1", [p.id]).catch(() => undefined);
    return false;
  }
}

/** Refreshes hints of the given accounts that were never read or are older than `HINTS_TTL_MS`. */
export async function refreshStaleHints(db: Db, providers: ProviderRecord[], opts: ClientFactoryOptions = {}): Promise<number> {
  if (!providers.length) return 0;
  const r = await db.query<{ id: string }>(
    "SELECT id FROM ai_providers WHERE id = ANY($1::uuid[]) AND (model_hints_at IS NULL OR model_hints_at < now() - make_interval(secs => $2))",
    [providers.map((p) => p.id), HINTS_TTL_MS / 1000],
  );
  const stale = new Set(r.rows.map((row) => row.id));
  let n = 0;
  for (const p of providers) if (stale.has(p.id) && (await refreshModelHints(db, p, opts))) n++;
  return n;
}
