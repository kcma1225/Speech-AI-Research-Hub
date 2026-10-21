/**
 * Model profile fields. A profile is per model (account + model id), never per provider account.
 * Effective value of each field = manual override > provider listing (`provider_api`) > built-in catalog.
 */

export type ModelCapability = "chat" | "embedding" | "asr";

export type ProfileFields = {
  display_name?: string;
  capability?: ModelCapability;
  /** Max input context (tokens). */
  context_window?: number;
  /** Max output tokens per request. */
  max_output_tokens?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  json_schema?: boolean;
  /** Default vector size of an embedding model. */
  embedding_dims?: number;
  /** USD per 1M input tokens. */
  input_price?: number;
  /** USD per 1M output tokens. */
  output_price?: number;
};

export type ProfileField = keyof ProfileFields;
export type FieldSource = "manual" | "provider_api" | "catalog";

export const PROFILE_FIELDS: ProfileField[] = [
  "display_name",
  "capability",
  "context_window",
  "max_output_tokens",
  "vision",
  "tools",
  "reasoning",
  "json_schema",
  "embedding_dims",
  "input_price",
  "output_price",
];

export const FIELD_TYPES: Record<ProfileField, "string" | "capability" | "integer" | "boolean" | "number"> = {
  display_name: "string",
  capability: "capability",
  context_window: "integer",
  max_output_tokens: "integer",
  vision: "boolean",
  tools: "boolean",
  reasoning: "boolean",
  json_schema: "boolean",
  embedding_dims: "integer",
  input_price: "number",
  output_price: "number",
};

/** One catalog entry: a family of model ids (regex on the normalised id) with default fields. */
export type CatalogEntry = {
  /** Stable id for tests and the UI ("openai.gpt-4o"). */
  id: string;
  match: RegExp;
  fields: Omit<ProfileFields, "display_name" | "input_price" | "output_price">;
};

/** Keeps only valid values of known fields (drops unknown keys, NaN, wrong types). */
export function cleanFields(input: unknown): ProfileFields {
  const out: ProfileFields = {};
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  for (const k of PROFILE_FIELDS) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    switch (FIELD_TYPES[k]) {
      case "string":
        if (typeof v === "string" && v.trim()) (out as Record<string, unknown>)[k] = v.trim().slice(0, 200);
        break;
      case "capability":
        if (v === "chat" || v === "embedding" || v === "asr") out.capability = v;
        break;
      case "integer": {
        const n = typeof v === "string" ? Number(v) : v;
        if (typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e9) (out as Record<string, unknown>)[k] = Math.round(n);
        break;
      }
      case "number": {
        const n = typeof v === "string" ? Number(v) : v;
        if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 1e6) (out as Record<string, unknown>)[k] = n;
        break;
      }
      case "boolean":
        if (typeof v === "boolean") (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
