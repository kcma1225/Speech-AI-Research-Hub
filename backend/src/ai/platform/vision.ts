/**
 * Vision (image input) support per model and per role.
 *
 * A model supports images when its profile says so (models.ts: manual override > the vendor's model listing >
 * the built-in catalog), else when the model-name heuristic does, else when the registry entry does (vendors
 * whose current chat models all take images). Unknown means no.
 *
 * Requests that carry image blocks are only sent to members whose model supports images: the router skips the
 * others (skip code `no_vision`, not logged). When no member with vision is left the call fails with
 * `vision_unavailable` (never `llm_unavailable`, so the role is not marked down and ai-worker does not wait).
 * Images are never silently stripped: a layout review without the screenshots would be invented.
 */
import { getProvider } from "../providers/index.js";
import type { ChatMessage } from "../types.js";
import type { ResolvedProfile } from "./models.js";
import type { ProviderRecord } from "./store.js";

/** `override` = manual profile field, `model_list` = provider listing, `catalog` = built-in catalog. */
export type VisionSource = "override" | "model_list" | "catalog" | "name" | "vendor" | "unknown";
export type MemberVision = { vision: boolean; detected: boolean; source: VisionSource; overridden: boolean };

// Model families that take images (used only when neither the profile nor the vendor's listing says anything).
const VISION_NAME =
  /(vision|(^|[-_/.])vl([-_/.:]|$)|vl-|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|(^|\/)(o3(?!-mini)|o4-mini)(-|$)|claude-(3|sonnet|opus|haiku)|claude-[a-z]+-[34]|gemini|gemma-?3|llava|pixtral|llama-?4|llama-?3\.2-.*vision|qvq|glm-\d(\.\d)?v|minicpm-v|internvl|grok-4|grok-.*vision|kimi-.*vl|moondream|phi-.*(vision|multimodal)|mistral-(small|medium)-3)/i;
// Vendors whose chat models (current generations) all accept images.
const VISION_VENDOR_CODECS = new Set(["anthropic-messages", "gemini"]);

/**
 * Vision of a model: manual / listing / catalog profile value first, then the name heuristic, then the vendor.
 * `profile` may be null for a model id that has no profile yet.
 */
export function modelVision(provider: Pick<ProviderRecord, "kind">, model: string, profile: Pick<ResolvedProfile, "fields" | "sources"> | null | undefined): MemberVision {
  if (provider.kind === "claude-cli") return { vision: false, detected: false, source: "vendor", overridden: false }; // text-only adapter
  const entry = getProvider(provider.kind);
  if (entry && !entry.capabilities.vision) return { vision: false, detected: false, source: "vendor", overridden: false };
  const v = profile?.fields.vision;
  const src = profile?.sources.vision;
  if (v !== undefined && src === "manual") return { vision: v, detected: v, source: "override", overridden: true };
  if (v !== undefined && src === "provider_api") return { vision: v, detected: v, source: "model_list", overridden: false };
  if (v !== undefined && src === "catalog" && v) return { vision: true, detected: true, source: "catalog", overridden: false };
  if (VISION_NAME.test(model)) return { vision: true, detected: true, source: "name", overridden: false };
  if (v === false && src === "catalog") return { vision: false, detected: false, source: "catalog", overridden: false };
  if (entry && VISION_VENDOR_CODECS.has(entry.codec)) return { vision: true, detected: true, source: "vendor", overridden: false };
  return { vision: false, detected: false, source: "unknown", overridden: false };
}

/** Back-compat shape for the admin badge: `{ detected, source }`. */
export function detectVision(provider: Pick<ProviderRecord, "kind">, model: string, profile: Pick<ResolvedProfile, "fields" | "sources"> | null | undefined) {
  const v = modelVision(provider, model, profile);
  return { detected: v.vision, source: v.source };
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

