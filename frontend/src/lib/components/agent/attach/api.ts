import { api } from "#lib/api.ts";
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
export function uploadFile(conversationId: string, file: File) {
  const body = new FormData();
  body.append("file", file, file.name);
  return api.post<{ attachment: UploadView }>(`/agent/conversations/${conversationId}/uploads`, body);
}
export const removeUpload = (id: string) => api.del<{ ok: true }>(`/agent/uploads/${id}`);
