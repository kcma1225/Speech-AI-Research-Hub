import { t } from "#lib/i18n.svelte.ts";
import type { Suggestion } from "#lib/components/suggest/types.ts";

/**
 * Client for document import (`/api/doc-import`, `/api/studies/:id/summary/import`) and Markdown image upload
 * (`/api/md-images`). Errors keep the backend's `code` and `hint` (e.g. 「偵測到：ZIP 壓縮檔」).
 */
export class ImportError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly hint?: string) {
    super(message);
  }
}

export type ImportedDocument = {
  filename: string;
  format: string;
  detected: { label: string; score: number };
  title: string | null;
  chars: number;
  truncated: boolean;
  pages?: number;
  warnings: string[];
};
export type ImportMode = "markdown" | "condense";
export type ImportPurpose = "study_summary" | "note";

/** Fallback when /doc-import/formats is unreachable (kept in sync with backend DOC_IMPORT_ACCEPT). */
export const DEFAULT_ACCEPT = ".pdf,.docx,.doc,.odt,.rtf,.txt,.md,.markdown,.html,.htm,.pptx,.ppt,.odp,.epub,.csv,.tsv,.xlsx,.ods";
export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

async function send<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    throw new ImportError(t("common.offline"), 0);
  }
  const text = await response.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* nginx error pages */
  }
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : response.status === 413 ? t("mdx.image.tooLarge") : t(response.status >= 500 ? "common.offline" : "common.error");
    throw new ImportError(message, response.status, typeof data?.code === "string" ? data.code : undefined, typeof data?.hint === "string" ? data.hint : undefined);
  }
  return data as T;
}

let formats: Promise<{ accept: string; maxBytes: number }> | null = null;
export function importFormats() {
  formats ??= fetch("/api/doc-import/formats", { credentials: "same-origin" })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
    .then((r: { accept: string; maxBytes: number }) => ({ accept: r.accept || DEFAULT_ACCEPT, maxBytes: r.maxBytes || MAX_IMPORT_BYTES }))
    .catch(() => {
      formats = null;
      return { accept: DEFAULT_ACCEPT, maxBytes: MAX_IMPORT_BYTES };
    });
  return formats;
}

/** Extracts (and optionally condenses with AI) without saving anything: prefill forms, insert into notes. */
export function importDocument(file: File, opts: { mode: ImportMode; purpose: ImportPurpose; studyId?: string }) {
  const form = new FormData();
  form.set("mode", opts.mode);
  form.set("purpose", opts.purpose);
  if (opts.studyId) form.set("study_id", opts.studyId);
  form.set("file", file);
  return send<{ markdown: string; document: ImportedDocument }>("/doc-import", form);
}

/** Existing study: the imported text becomes a `study_summary` suggestion. */
export function importIntoSummary(studyId: string, file: File, opts: { mode: ImportMode; placement: "append" | "replace" }) {
  const form = new FormData();
  form.set("mode", opts.mode);
  form.set("placement", opts.placement);
  form.set("file", file);
  return send<{ suggestion: Suggestion; document: ImportedDocument }>(`/studies/${studyId}/summary/import`, form);
}

/** Stores an image for a Markdown document (`scope` = `study:<id>` or `note:<id>`) and returns its URL. */
export async function uploadMdImage(scope: string, file: File): Promise<string> {
  const form = new FormData();
  form.set("scope", scope);
  form.set("file", file);
  const r = await send<{ image: { url: string } }>("/md-images", form);
  return r.image.url;
}
