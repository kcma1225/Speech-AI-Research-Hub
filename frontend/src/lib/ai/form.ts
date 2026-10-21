import { i18n, t } from "#lib/i18n.svelte.ts";
import type { Bilingual, FormField, ParamField } from "./admin.ts";

export const L = (b: Bilingual | null | undefined) => (b ? (i18n.locale === "en" ? b.en : b.zh) : "");

export type RawValues = Record<string, string | boolean>;

/** Raw (input) values for a provider form from a stored config. */
export function rawFromConfig(fields: FormField[], config: Record<string, unknown>): RawValues {
  const out: RawValues = {};
  for (const f of fields) {
    if (f.type === "secret") {
      out[f.key] = "";
      continue;
    }
    const v = config[f.key] ?? f.default;
    if (f.type === "boolean") out[f.key] = Boolean(v);
    else if (f.type === "json") out[f.key] = v === undefined || v === null ? "" : JSON.stringify(v, null, 2);
    else out[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

export const visible = (f: { showIf?: { key: string; equals: unknown[] } }, raw: RawValues) => !f.showIf || f.showIf.equals.includes(raw[f.showIf.key]);

/** Converts raw values into `{config, secrets}`; returns per-field errors for invalid JSON/numbers. */
export function toPayload(fields: FormField[], raw: RawValues, cleared: Set<string>) {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!visible(f, raw)) continue;
    const v = raw[f.key];
    if (f.type === "secret") {
      if (typeof v === "string" && v.trim()) secrets[f.key] = v.trim();
      else if (cleared.has(f.key)) secrets[f.key] = null;
      continue;
    }
    if (f.type === "boolean") {
      config[f.key] = Boolean(v);
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (f.type === "number") {
      const n = Number(s);
      if (!Number.isFinite(n)) errors[f.key] = t("aiAdmin.sheet.jsonInvalid", { field: L(f.label) });
      else config[f.key] = n;
    } else if (f.type === "json") {
      try {
        const parsed = JSON.parse(s);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        config[f.key] = parsed;
      } catch {
        errors[f.key] = t("aiAdmin.sheet.jsonInvalid", { field: L(f.label) });
      }
    } else config[f.key] = s;
  }
  return { config, secrets, errors };
}

/** Raw param values ↔ stored member params. */
export function rawFromParams(fields: ParamField[], params: Record<string, unknown>): RawValues {
  const out: RawValues = {};
  for (const f of fields) {
    const v = params[f.key];
    if (f.type === "boolean") out[f.key] = v === undefined ? "" : v ? "true" : "false";
    else if (f.type === "json") out[f.key] = v === undefined ? "" : JSON.stringify(v);
    else out[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

export function paramsFromRaw(fields: ParamField[], raw: RawValues): { params: Record<string, unknown>; errors: Record<string, string> } {
  const params: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === "") continue;
    const s = String(v).trim();
    if (!s) continue;
    switch (f.type) {
      case "number":
      case "integer": {
        const n = Number(s);
        if (!Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) errors[f.key] = L(f.label);
        else params[f.key] = n;
        break;
      }
      case "boolean":
        params[f.key] = s === "true";
        break;
      case "json":
        try {
          params[f.key] = JSON.parse(s);
        } catch {
          errors[f.key] = L(f.label);
        }
        break;
      default:
        params[f.key] = s;
    }
  }
  return { params, errors };
}
