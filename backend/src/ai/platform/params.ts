/**
 * Route-member params: per-use settings validated against a whitelist built from the registry entry
 * (vendor passthrough `ParamSpec`s) plus platform-level knobs (timeout, retries, sampling, dimensions, ASR options).
 */
import { ASR_MEMBER_PARAMS, getAsrEntry } from "../asr/index.js";
import type { ReasoningEffort } from "../types.js";
import { getProvider, type Bilingual, type ParamSpec } from "../providers/index.js";
import type { RouteCapability } from "./roles.js";
import { VISION_PARAM } from "./vision.js";

export type ParamField = {
  key: string;
  type: "number" | "integer" | "string" | "boolean" | "json" | "select";
  label: Bilingual;
  help_zh?: string;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
  /** Display labels of `select` options (else the option value is shown). */
  option_labels?: Record<string, Bilingual>;
  /** Label of the empty choice ("use the default"), when it means more than "default". */
  default_label?: Bilingual;
  /** `platform`: interpreted by the router; `vendor`: passed through to the request body. */
  scope: "platform" | "vendor";
};

const L = (zh: string, en: string): Bilingual => ({ zh, en });
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const RETRIES: ParamField = {
  key: "max_retries",
  type: "integer",
  label: L("重試次數", "Retries"),
  min: 0,
  max: 5,
  default: 1,
  scope: "platform",
  help_zh: "同一個成員遇到限流、忙碌或暫時無法連線時，先重試幾次再換下一個成員。",
};
const TIMEOUT: ParamField = {
  key: "timeout_ms",
  type: "integer",
  label: L("逾時（毫秒）", "Timeout (ms)"),
  min: 1000,
  max: 3_600_000,
  scope: "platform",
  help_zh: "覆蓋帳號的逾時設定；串流時是等待第一個位元組與兩段之間的最長時間。",
};

export const CHAT_PLATFORM_PARAMS: ParamField[] = [
  TIMEOUT,
  RETRIES,
  { key: "temperature", type: "number", label: L("溫度", "Temperature"), min: 0, max: 2, scope: "platform", help_zh: "推理模型通常不接受，留空即可。" },
  { key: "top_p", type: "number", label: L("Top-P", "Top-P"), min: 0, max: 1, scope: "platform" },
  { key: "max_tokens", type: "integer", label: L("最大輸出 tokens", "Max output tokens"), min: 1, max: 1_000_000, scope: "platform", help_zh: "上限；呼叫端要求更少時以呼叫端為準。" },
  { key: "reasoning_effort", type: "select", label: L("推理強度", "Reasoning effort"), options: EFFORTS, scope: "platform" },
  VISION_PARAM,
];

export const EMBED_PLATFORM_PARAMS: ParamField[] = [
  TIMEOUT,
  RETRIES,
  { key: "dimensions", type: "integer", label: L("向量維度", "Dimensions"), min: 1, max: 4000, scope: "platform", help_zh: "支援 Matryoshka 的模型可以縮短向量（索引上限 4000 維）。更改後需要用切換精靈重算。" },
];

function fromParamSpec(p: ParamSpec): ParamField {
  return { key: p.key, type: p.type, label: p.label, help_zh: p.help_zh, default: p.default, options: p.options, min: p.min, max: p.max, scope: "vendor" };
}

function asrFields(): ParamField[] {
  return [
    ...ASR_MEMBER_PARAMS.filter((f) => f.key !== "model").map(
      (f): ParamField => ({
        key: f.key,
        type: f.type === "text" || f.type === "url" || f.type === "secret" ? "string" : f.type === "number" ? (f.key.endsWith("_ms") || f.key.endsWith("_sec") ? "integer" : "number") : f.type,
        label: f.label,
        help_zh: f.help_zh,
        default: f.default,
        options: f.options?.map((o) => o.value),
        multiline: f.multiline,
        scope: "platform",
      }),
    ),
    RETRIES,
  ];
}

/** Param whitelist for a member of a route with `capability` using provider `kind`. */
export function memberParamFields(capability: RouteCapability, kind: string): ParamField[] {
  if (capability === "asr") return getAsrEntry(kind) ? asrFields() : [];
  const entry = getProvider(kind);
  const vendor = (entry?.params ?? []).map(fromParamSpec);
  const platform = capability === "chat" ? CHAT_PLATFORM_PARAMS : EMBED_PLATFORM_PARAMS;
  const taken = new Set(platform.map((f) => f.key));
  return [...platform, ...vendor.filter((f) => !taken.has(f.key))];
}

export type ParamIssue = { key: string; message_zh: string };

/** Validates and normalises member params; unknown keys are issues (not silently dropped) so admins notice typos. */
export function validateMemberParams(capability: RouteCapability, kind: string, params: Record<string, unknown>): { params: Record<string, unknown>; issues: ParamIssue[] } {
  const fields = new Map(memberParamFields(capability, kind).map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  const issues: ParamIssue[] = [];
  for (const [key, raw] of Object.entries(params ?? {})) {
    if (raw === null || raw === undefined || raw === "") continue;
    const f = fields.get(key);
    if (!f) {
      issues.push({ key, message_zh: `這個模型不支援參數「${key}」。` });
      continue;
    }
    const name = f.label.zh;
    switch (f.type) {
      case "number":
      case "integer": {
        const n = typeof raw === "string" ? Number(raw) : raw;
        if (typeof n !== "number" || !Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) {
          issues.push({ key, message_zh: `「${name}」必須是${f.type === "integer" ? "整數" : "數字"}。` });
          break;
        }
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          issues.push({ key, message_zh: `「${name}」必須介於 ${f.min ?? "-∞"} 到 ${f.max ?? "∞"}。` });
          break;
        }
        out[key] = n;
        break;
      }
      case "boolean":
        if (typeof raw !== "boolean") issues.push({ key, message_zh: `「${name}」必須是開或關。` });
        else out[key] = raw;
        break;
      case "select":
        if (typeof raw !== "string" || (f.options && !f.options.includes(raw))) issues.push({ key, message_zh: `「${name}」的選項不正確。` });
        else out[key] = raw;
        break;
      case "json":
        if (typeof raw !== "object") issues.push({ key, message_zh: `「${name}」必須是 JSON。` });
        else out[key] = raw;
        break;
      default:
        if (typeof raw !== "string" || raw.length > 4000) issues.push({ key, message_zh: `「${name}」格式不正確。` });
        else out[key] = raw;
    }
  }
  return { params: out, issues };
}

/** Splits validated chat params into typed request knobs and vendor passthrough. */
export function splitChatParams(capability: RouteCapability, kind: string, params: Record<string, unknown>) {
  const vendorKeys = new Set(memberParamFields(capability, kind).filter((f) => f.scope === "vendor").map((f) => f.key));
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (vendorKeys.has(k)) passthrough[k] = v;
  const num = (k: string) => (typeof params[k] === "number" ? (params[k] as number) : undefined);
  return {
    timeoutMs: num("timeout_ms"),
    maxRetries: num("max_retries"),
    temperature: num("temperature"),
    topP: num("top_p"),
    maxTokens: num("max_tokens"),
    dimensions: num("dimensions"),
    reasoningEffort: typeof params.reasoning_effort === "string" ? (params.reasoning_effort as ReasoningEffort) : undefined,
    passthrough,
  };
}
