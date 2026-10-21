/**
 * Unified AI error. Every codec maps vendor failures (HTTP status, body codes, in-stream
 * error events, business codes) onto one of these codes.
 */

export type AiErrorCode =
  | "auth_failed"
  | "rate_limited"
  | "overloaded"
  | "context_too_long"
  | "content_filtered"
  | "bad_request"
  | "unavailable"
  | "timeout"
  | "quota_exhausted"
  | "model_not_found"
  | "unsupported"
  | "cancelled";

interface CodeInfo {
  retryable: boolean;
  message_zh: string;
  hint_zh: string;
}

export const AI_ERROR_CODES: Record<AiErrorCode, CodeInfo> = {
  auth_failed: {
    retryable: false,
    message_zh: "模型服務驗證失敗。",
    hint_zh: "請管理員到「模型設定」檢查 API 金鑰、權限或區域是否正確，並按「測試」確認。",
  },
  rate_limited: {
    retryable: true,
    message_zh: "模型服務請求太頻繁，暫時被限流。",
    hint_zh: "稍後會自動重試；若經常發生，請管理員調高廠商的速率上限或加入備援模型。",
  },
  overloaded: {
    retryable: true,
    message_zh: "模型服務目前忙碌中。",
    hint_zh: "這通常是暫時的，稍後會自動重試；也可以在路由中加入備援模型。",
  },
  context_too_long: {
    retryable: false,
    message_zh: "內容太長，超過模型可處理的長度。",
    hint_zh: "請縮短輸入或分段處理；管理員也可以改用上下文較長的模型（本機 Ollama 請調高 num_ctx）。",
  },
  content_filtered: {
    retryable: false,
    message_zh: "內容被模型服務的安全過濾機制擋下。",
    hint_zh: "請調整用詞後再試；若是誤判，管理員可以改用其他廠商的模型。",
  },
  bad_request: {
    retryable: false,
    message_zh: "模型服務拒絕了這個請求。",
    hint_zh: "請管理員檢查模型參數（例如溫度、最大輸出長度、推理設定）是否被這個模型支援。",
  },
  unavailable: {
    retryable: true,
    message_zh: "模型服務暫時無法使用。",
    hint_zh: "稍後會自動重試；若持續發生，請管理員檢查服務網址、網路或本機伺服器是否正常運作。",
  },
  timeout: {
    retryable: true,
    message_zh: "模型服務回應逾時。",
    hint_zh: "請稍後再試；本機模型第一次載入可能較慢，管理員可以調高逾時時間。",
  },
  quota_exhausted: {
    retryable: false,
    message_zh: "模型服務的額度或餘額已用完。",
    hint_zh: "請管理員到廠商後台儲值或提高用量上限，或改用其他模型。",
  },
  model_not_found: {
    retryable: false,
    message_zh: "找不到指定的模型。",
    hint_zh: "請管理員確認模型名稱（或 Azure 部署名稱、Bedrock 推論設定檔）是否正確，並重新取得模型清單。",
  },
  unsupported: {
    retryable: false,
    message_zh: "這個模型服務不支援此功能。",
    hint_zh: "請管理員為這個功能改選支援的模型（例如支援工具呼叫或向量嵌入的模型）。",
  },
  cancelled: {
    retryable: false,
    message_zh: "請求已取消。",
    hint_zh: "如需結果請重新送出。",
  },
};

export interface AiErrorInit {
  status?: number;
  vendorCode?: string;
  vendorMessage?: string;
  retryAfterMs?: number;
  providerId?: string;
  requestId?: string;
  /** true when the failure arrived inside an already-started (HTTP 200) stream. */
  midStream?: boolean;
  /** Override the default retryable flag (e.g. a 429 that is really a spend cap). */
  retryable?: boolean;
  cause?: unknown;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly message_zh: string;
  readonly hint_zh: string;
  readonly status?: number;
  readonly vendorCode?: string;
  /** Vendor's own message: log only, never shown to users verbatim. */
  readonly vendorMessage?: string;
  readonly retryAfterMs?: number;
  providerId?: string;
  readonly requestId?: string;
  midStream: boolean;

  constructor(code: AiErrorCode, init: AiErrorInit = {}) {
    const info = AI_ERROR_CODES[code];
    super(`${code}${init.vendorMessage ? `: ${truncate(init.vendorMessage, 300)}` : ""}`, { cause: init.cause });
    this.name = "AiError";
    this.code = code;
    this.retryable = init.retryable ?? info.retryable;
    this.message_zh = info.message_zh;
    this.hint_zh = info.hint_zh;
    this.status = init.status;
    this.vendorCode = init.vendorCode;
    this.vendorMessage = init.vendorMessage;
    this.retryAfterMs = init.retryAfterMs;
    this.providerId = init.providerId;
    this.requestId = init.requestId;
    this.midStream = init.midStream ?? false;
  }

  /** API response body shape (`{ error, code, hint }`). */
  toResponse(): { error: string; code: AiErrorCode; hint: string } {
    return { error: this.message_zh, code: this.code, hint: this.hint_zh };
  }

  /** Safe for logs / ai_call_log (no prompt content). */
  toLog(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      vendorCode: this.vendorCode,
      vendorMessage: this.vendorMessage ? truncate(this.vendorMessage, 500) : undefined,
      retryAfterMs: this.retryAfterMs,
      providerId: this.providerId,
      requestId: this.requestId,
      midStream: this.midStream,
    };
  }
}

export const isAiError = (e: unknown): e is AiError => e instanceof AiError;

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------- helpers

/** Parses Retry-After (seconds or HTTP date), retry-after-ms, and x-ratelimit-reset-* style hints. */
export function parseRetryAfter(headers?: Headers | null, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers.get("retry-after");
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.round(Number(ra) * 1000);
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  return undefined;
}

/** Google RetryInfo `retryDelay: "12s"` / "1.5s". */
export function parseGoogleRetryDelay(body: unknown): number | undefined {
  const details = (body as { error?: { details?: unknown[] } })?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const delay = (d as { retryDelay?: unknown })?.retryDelay;
    if (typeof delay === "string") {
      const m = /^([\d.]+)s$/.exec(delay);
      if (m) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

/** Best-effort extraction of a vendor message and code from any JSON/text error body. */
export function extractVendorError(body: unknown): { message?: string; code?: string; type?: string } {
  if (body == null) return {};
  if (typeof body === "string") return { message: body };
  const b = body as Record<string, unknown>;
  const e = b.error;
  if (typeof e === "string") return { message: e, type: str(b.error_type) ?? str(b.type) };
  if (e && typeof e === "object") {
    const eo = e as Record<string, unknown>;
    return {
      message: str(eo.message) ?? str(b.message),
      code: str(eo.code) ?? str(eo.status),
      type: str(eo.type) ?? str(eo.status),
    };
  }
  return {
    message: str(b.message) ?? str(b.Message) ?? str(b.detail) ?? (Array.isArray(b.detail) ? JSON.stringify(b.detail) : undefined),
    code: str(b.code),
    type: str(b.type) ?? str(b.__type),
  };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

const CONTEXT_RE =
  /context[_ ]length[_ ]exceeded|context_window|prompt is too long|too many tokens|maximum context|input is too long|reduce the length|exceeds the (model'?s )?(maximum|context)|token limit|context length|input token count.*exceeds|string_above_max_length|too long for the model/i;
const FILTER_RE = /content[_ ]filter|content_policy|responsibleaipolicyviolation|data_inspection_failed|safety|moderation|flagged|high risk|blocked by|sensitive/i;
const QUOTA_RE =
  /insufficient_quota|credit_balance|spend_limit|billing|insufficient balance|insufficient_balance|quota exceeded for|exceeded_current_quota|payment required|out of credits|balance is not enough/i;
const MODEL_RE =
  /model[_ ]not[_ ]found|no such model|model .*(does not exist|not found|is not available|not supported)|unknown model|deploymentnotfound|invalid model|model_not_available|not a valid model/i;

export interface ClassifyInput {
  status: number;
  body?: unknown;
  headers?: Headers | null;
  providerId?: string;
}

/**
 * Generic HTTP error classification (OpenAI-style bodies and common message patterns).
 * Codecs run their vendor-specific table first and fall back to this.
 */
export function classifyHttpError({ status, body, headers, providerId }: ClassifyInput): AiError {
  const v = extractVendorError(body);
  const text = `${v.code ?? ""} ${v.type ?? ""} ${v.message ?? ""}`;
  const retryAfterMs = parseRetryAfter(headers) ?? parseGoogleRetryDelay(body);
  const init: AiErrorInit = {
    status,
    vendorCode: v.code ?? v.type,
    vendorMessage: v.message,
    retryAfterMs,
    providerId,
    requestId: headers?.get("x-request-id") ?? headers?.get("request-id") ?? headers?.get("x-amzn-requestid") ?? undefined,
  };
  if (QUOTA_RE.test(text) || status === 402) return new AiError("quota_exhausted", init);
  if (status === 401 || status === 403) {
    if (FILTER_RE.test(text) && !/permission|forbidden|unauthori|api key|apikey|credential|token/i.test(v.message ?? "")) {
      return new AiError("content_filtered", init);
    }
    return new AiError("auth_failed", init);
  }
  if (status === 429) {
    if (/RESOURCE_EXHAUSTED/i.test(text) && /per day|daily|quota/i.test(v.message ?? "") && retryAfterMs === undefined) {
      return new AiError("quota_exhausted", init);
    }
    return new AiError("rate_limited", init);
  }
  if (status === 529 || status === 498 || status === 503) return new AiError("overloaded", init);
  if (status === 408 || status === 504) return new AiError("timeout", init);
  if (status >= 500) return new AiError("unavailable", init);
  if (status === 413) return new AiError(CONTEXT_RE.test(text) || !v.message ? "context_too_long" : "bad_request", init);
  if (CONTEXT_RE.test(text)) return new AiError("context_too_long", init);
  if (/content_filter|data_inspection_failed|responsibleaipolicyviolation/i.test(text)) return new AiError("content_filtered", init);
  if (status === 404 || MODEL_RE.test(text)) return new AiError("model_not_found", init);
  return new AiError("bad_request", init);
}

/** Map a thrown fetch/network/abort error. `timedOut` tells whether our own timer fired. */
export function fromThrown(e: unknown, opts: { timedOut?: boolean; cancelled?: boolean; providerId?: string; midStream?: boolean } = {}): AiError {
  if (e instanceof AiError) return e;
  if (opts.timedOut) return new AiError("timeout", { providerId: opts.providerId, midStream: opts.midStream, cause: e });
  if (opts.cancelled) return new AiError("cancelled", { providerId: opts.providerId, midStream: opts.midStream, cause: e });
  const msg = e instanceof Error ? `${e.message}${(e as { cause?: { code?: string } }).cause?.code ? ` (${(e as { cause: { code: string } }).cause.code})` : ""}` : String(e);
  return new AiError("unavailable", { vendorMessage: msg, providerId: opts.providerId, midStream: opts.midStream, cause: e });
}
