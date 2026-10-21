/**
 * Single point where ASR code builds unified AI errors (`AiError` from ../errors.js).
 * `asrReason` carries the ASR-specific hint the orchestrator acts on (re-chunk smaller etc.).
 */
import { AiError, type AiErrorCode } from "../errors.js";

export type AsrReason = "too_large" | "too_long" | "unsupported_format" | "job_failed" | "network";

export type AsrErrOpts = {
  status?: number;
  vendorCode?: string;
  retryAfterMs?: number;
  reason?: AsrReason;
  retryable?: boolean;
  cause?: unknown;
};

export type AsrError = AiError & { asrReason?: AsrReason };

/** `detail` goes to `vendorMessage` (logs only; users see message_zh/hint_zh). */
export function asrErr(code: AiErrorCode, detail: string, opts: AsrErrOpts = {}): AsrError {
  const err: AsrError = new AiError(code, {
    vendorMessage: detail,
    status: opts.status,
    vendorCode: opts.vendorCode,
    retryAfterMs: opts.retryAfterMs,
    retryable: opts.retryable ?? (opts.reason === "job_failed" ? true : undefined),
    cause: opts.cause,
  });
  if (opts.reason) err.asrReason = opts.reason;
  return err;
}

export const asrReasonOf = (e: unknown): AsrReason | undefined => (e as { asrReason?: AsrReason } | null)?.asrReason;

export { AiError };
export type { AiErrorCode };
