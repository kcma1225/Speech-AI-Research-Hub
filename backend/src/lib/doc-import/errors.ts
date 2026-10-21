import { HttpError } from "../http.js";

export type DocImportErrorCode =
  | "unsupported_format"
  | "too_large"
  | "content_mismatch"
  | "not_document"
  | "legacy_format"
  | "encrypted"
  | "corrupt"
  | "empty";

/** A document-import failure: HTTP status, 繁中 message, `extra.code` (machine-readable) and an optional `extra.hint`. */
export class DocImportError extends HttpError {
  readonly code: DocImportErrorCode;
  constructor(status: number, code: DocImportErrorCode, message: string, hint?: string) {
    super(status, message, hint ? { code, hint } : { code });
    this.name = "DocImportError";
    this.code = code;
  }
}

export const corrupt = (what = "檔案") => new DocImportError(422, "corrupt", `${what}損毀或無法解析。`);
export const encrypted = () =>
  new DocImportError(422, "encrypted", "檔案有密碼保護或已加密，無法匯入。", "請先移除密碼或另存一份未加密的檔案。");
