/**
 * Platform-level errors (routing, configuration, embeddings, OAuth). Vendor failures stay `AiError`
 * (`../errors.ts`); both serialise to `{ error, code, hint }` in 繁中.
 */
import { AiError, isAiError, type AiErrorCode } from "../errors.js";
import { HttpError } from "../../lib/http.js";
import { ROLE_LABEL_ZH, type AiRole } from "./roles.js";

export type PlatformErrorCode =
  | "llm_unavailable"
  | "vision_unavailable"
  | "route_cycle"
  | "route_invalid"
  | "route_in_use"
  | "provider_invalid"
  | "provider_in_use"
  | "capability_mismatch"
  | "embedding_model_change_requires_switch"
  | "embedding_dims_unsupported"
  | "embedding_switch_in_progress"
  | "embedding_not_configured"
  | "secrets_key_missing"
  | "secrets_corrupt"
  | "oauth_unsupported"
  | "oauth_session_expired"
  | "oauth_failed"
  | "import_invalid"
  | "not_found";

const INFO: Record<PlatformErrorCode, { status: number; message_zh: string; hint_zh: string }> = {
  llm_unavailable: {
    status: 503,
    message_zh: "這個 AI 功能目前維護中。",
    hint_zh: "系統會自動重試；若持續發生，請管理員到「模型設定」檢查路由與供應商帳號的健康狀態。",
  },
  vision_unavailable: {
    status: 422,
    message_zh: "目前的模型不支援影像，無法檢查排版。",
    hint_zh: "請管理員到「模型設定」為這個功能選擇支援視覺的模型，或在路由成員把「視覺」設為「支援」。",
  },
  route_cycle: { status: 400, message_zh: "路由不能包含自己（形成循環）。", hint_zh: "請移除會繞回這條路由的子路由。" },
  route_invalid: { status: 400, message_zh: "路由設定不正確。", hint_zh: "請檢查每個成員的模型、權重與參數。" },
  route_in_use: { status: 409, message_zh: "這條路由仍在使用中。", hint_zh: "請先在「功能綁定」改選其他路由，或從其他路由中移除它，再刪除。" },
  provider_invalid: { status: 400, message_zh: "供應商帳號的欄位不正確。", hint_zh: "請依照欄位旁的說明修正後再儲存。" },
  provider_in_use: { status: 409, message_zh: "這個供應商帳號仍被路由使用。", hint_zh: "請先從所有路由移除它的模型，再刪除帳號；或改為停用。" },
  capability_mismatch: { status: 400, message_zh: "路由的能力和這個功能不相符。", hint_zh: "聊天功能請選聊天路由；語意搜尋請選 embedding 路由；語音請選 ASR 路由。" },
  embedding_model_change_requires_switch: {
    status: 409,
    message_zh: "這會換成不同的 embedding 模型，既有向量將無法比對。",
    hint_zh: "請使用「Embedding → 切換精靈」：系統會在新的向量空間重算所有內容，完成後再切換；期間搜尋照常運作。",
  },
  embedding_dims_unsupported: { status: 400, message_zh: "向量維度超過 4000，無法建立索引。", hint_zh: "請在路由成員參數設定 dimensions（例如 1024），或改用維度較小的模型。" },
  embedding_switch_in_progress: { status: 409, message_zh: "已經有一個 embedding 切換正在進行。", hint_zh: "請等它完成並切換，或先取消它。" },
  embedding_not_configured: { status: 409, message_zh: "尚未設定 embedding 路由。", hint_zh: "請先在「功能綁定」為語意搜尋選擇 embedding 路由。" },
  secrets_key_missing: {
    status: 500,
    message_zh: "伺服器沒有設定密鑰加密金鑰（PROVIDER_TOKEN_KEY）。",
    hint_zh: "請在 .env 設定 32 位元組 base64 的 PROVIDER_TOKEN_KEY（scripts/gen-env.sh 會產生），重新啟動後再試。",
  },
  secrets_corrupt: {
    status: 500,
    message_zh: "無法解密已儲存的密鑰。",
    hint_zh: "PROVIDER_TOKEN_KEY 可能被更換過；請重新輸入這個帳號的 API 金鑰或重新登入。",
  },
  oauth_unsupported: { status: 400, message_zh: "這個供應商帳號不支援這種登入方式。", hint_zh: "ChatGPT 用裝置代碼登入；Claude 用授權連結或 setup-token。" },
  oauth_session_expired: { status: 410, message_zh: "登入流程已逾時。", hint_zh: "請重新按「開始登入」。" },
  oauth_failed: { status: 400, message_zh: "訂閱帳號登入失敗。", hint_zh: "請確認代碼完整（Claude 為 code#state），或重新開始登入流程。" },
  import_invalid: { status: 400, message_zh: "設定檔格式不正確。", hint_zh: "請選擇由本系統「匯出設定」產生的 JSON 檔（format version 1）。" },
  not_found: { status: 404, message_zh: "找不到資料。", hint_zh: "資料可能已被刪除，請重新整理頁面。" },
};

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;
  readonly message_zh: string;
  readonly hint_zh: string;
  /** Structured, non-secret detail (validation issues, fingerprint scores, failed member codes). */
  readonly detail?: Record<string, unknown>;

  constructor(code: PlatformErrorCode, opts: { message_zh?: string; hint_zh?: string; detail?: Record<string, unknown>; cause?: unknown } = {}) {
    const info = INFO[code];
    super(code, { cause: opts.cause });
    this.name = "PlatformError";
    this.code = code;
    this.status = info.status;
    this.message_zh = opts.message_zh ?? info.message_zh;
    this.hint_zh = opts.hint_zh ?? info.hint_zh;
    this.detail = opts.detail;
  }

  toResponse() {
    return { error: this.message_zh, code: this.code, hint: this.hint_zh, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** Codes of the members that failed, in order (no vendor messages: they may echo content). */
export type FailedAttempt = { providerKind?: string; model?: string; code: AiErrorCode | "llm_unavailable" | "disabled" | "needs_reauth" | "no_vision" };

/** All members of a role's route failed (or the role has no route). The only code ai-worker auto-resumes on. */
export function llmUnavailable(role: AiRole | undefined, reason: "unconfigured" | "all_failed", attempts: FailedAttempt[] = []): PlatformError {
  const label = role ? ROLE_LABEL_ZH[role] : "AI";
  return new PlatformError("llm_unavailable", {
    message_zh: reason === "unconfigured" ? `「${label}」尚未設定模型，暫時無法使用。` : `「${label}」目前維護中：所有模型都無法使用。`,
    hint_zh:
      reason === "unconfigured"
        ? "請管理員到「模型設定 → 功能綁定」為這個功能選擇路由。背景工作會在設定完成後自動繼續。"
        : "系統會自動重試，背景工作會在服務恢復後繼續；管理員可到「模型設定 → 流量」查看失敗原因。",
    detail: { role, reason, attempts },
  });
}

/** An image request found no route member that accepts images (see vision.ts). */
export function visionUnavailable(role: AiRole): PlatformError {
  return new PlatformError("vision_unavailable", { detail: { role } });
}

export const isPlatformError = (e: unknown): e is PlatformError => e instanceof PlatformError;
export const isLlmUnavailable = (e: unknown) => isPlatformError(e) && e.code === "llm_unavailable";

/** Converts AI/platform errors into the HttpError the Fastify error handler renders. */
export function toHttpError(e: unknown): unknown {
  if (isPlatformError(e)) return new HttpError(e.status, e.message_zh, { code: e.code, hint: e.hint_zh });
  if (isAiError(e)) return new HttpError(aiStatus(e), e.message_zh, { code: e.code, hint: e.hint_zh });
  return e;
}

function aiStatus(e: AiError) {
  switch (e.code) {
    case "rate_limited":
      return 429;
    case "bad_request":
    case "context_too_long":
    case "content_filtered":
    case "unsupported":
      return 422;
    case "cancelled":
      return 499;
    default:
      return 502;
  }
}
