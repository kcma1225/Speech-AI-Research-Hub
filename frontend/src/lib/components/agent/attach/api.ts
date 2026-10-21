import { api, ApiError } from "#lib/api.ts";
import { t } from "#lib/i18n.svelte.ts";
import type { Attachment, AttachmentRef, LatexFile, PickerCategory, PickerItem, PickerStudy, UploadView } from "./types.ts";

/** Picker + upload calls (`/api/agent/attach/*`, `/api/agent/conversations/:id/uploads`). */
export type Formats = { accept: string; maxBytes: number; maxImageBytes: number; maxPerMessage: number };
let formats: Promise<Formats> | null = null;
export const attachFormats = () => (formats ??= api.get<Formats>("/agent/attach/formats").catch((e) => ((formats = null), Promise.reject(e))));

const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();

export const listStudies = (q = "") => api.get<{ studies: PickerStudy[] }>(`/agent/attach/studies?${qs({ q: q.trim() || undefined })}`);
export const listItems = (study: string, kind: PickerCategory, q = "") =>
  api.get<{ study: { id: string; slug: string; title: string }; items: PickerItem[] }>(`/agent/attach/items?${qs({ study, kind, q: q.trim() || undefined })}`);
export const latexFiles = (projectId: string) => api.get<{ project: { id: string; title: string }; files: LatexFile[] }>(`/agent/attach/latex/${projectId}/files`);
export const resolveRefs = (attachments: AttachmentRef[], conversationId: string | null = null) =>
  api.post<{ attachments: Attachment[] }>("/agent/attach/resolve", { attachments, ...(conversationId ? { conversation_id: conversationId } : {}) });
/** Upload with real progress (XHR: fetch has no upload progress) and cancel via `signal` (rejects with an AbortError). */
export function uploadFile(conversationId: string, file: File, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) {
  const body = new FormData();
  body.append("file", file, file.name);
  return new Promise<{ attachment: UploadView }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/agent/conversations/${conversationId}/uploads`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, t("common.offline")));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      let data: { error?: unknown } | null = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as { attachment: UploadView });
      else reject(new ApiError(xhr.status, typeof data?.error === "string" ? data.error : t(xhr.status === 429 ? "common.rateLimited" : "attach.uploadFailed")));
    };
    if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** Clipboard images arrive as "image.png" (or nameless): give them a readable, unique name. */
export function namePasted(file: File, at = new Date()): File {
  if (file.name && file.name !== "image.png" && /\.[a-z0-9]+$/i.test(file.name)) return file;
  const ext = EXT_BY_MIME[file.type] ?? (file.type.split("/")[1] || "bin");
  const stamp = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}-${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}${String(at.getSeconds()).padStart(2, "0")}`;
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

/** Client-side check against `/agent/attach/formats` (the server re-checks): null when OK, else a message key + params. */
export function checkFile(file: File, f: Formats): { key: "attach.badType" | "attach.tooLarge"; size?: string } | null {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const allowed = f.accept.split(",").map((s) => s.trim().toLowerCase());
  if (!ext || !allowed.includes(ext)) return { key: "attach.badType" };
  const image = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
  const max = image ? f.maxImageBytes : f.maxBytes;
  if (file.size > max) return { key: "attach.tooLarge", size: `${Math.round(max / 1024 / 1024)} MB` };
  return null;
}
export const removeUpload = (id: string) => api.del<{ ok: true }>(`/agent/uploads/${id}`);
