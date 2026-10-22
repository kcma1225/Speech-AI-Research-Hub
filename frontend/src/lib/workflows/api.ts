import { api } from "#lib/api.ts";
import type { Playbook, Workflow, WorkflowDetail } from "./types.ts";

type W = { workflow: Workflow | null };
export type ApproveEdits = {
  objective?: string;
  criteria?: { id?: string; text: string }[];
  steps?: { key: string; title?: string; instructions?: string; skip?: boolean }[];
  outline?: { title: string; points: string[] }[];
  /** 「你的要求」: the whole edited list (types are detected again from reworded text). */
  requirements?: { id?: string; type?: string; text: string }[];
};

export const workflowsApi = {
  playbooks: () => api.get<{ playbooks: Playbook[] }>("/workflows/playbooks"),
  list: (q: { active?: boolean; study?: string; conversation?: string; batch?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.active) p.set("active", "1");
    if (q.study) p.set("study", q.study);
    if (q.conversation) p.set("conversation", q.conversation);
    if (q.batch) p.set("batch", q.batch);
    if (q.limit) p.set("limit", String(q.limit));
    const s = p.toString();
    return api.get<{ workflows: Workflow[] }>(`/workflows${s ? `?${s}` : ""}`);
  },
  get: (id: string) => api.get<WorkflowDetail>(`/workflows/${id}`),
  create: (body: { request: string; playbook?: string; conversation_id?: string; context?: unknown; inputs?: Record<string, unknown>; autopilot?: boolean }) =>
    api.post<{ workflow: Workflow; workflows: Workflow[]; batch_id: string | null; conversation_id: string | null }>("/workflows", body),
  approve: (id: string, edits: ApproveEdits) => api.post<W>(`/workflows/${id}/approve`, edits),
  revise: (id: string, feedback: string) => api.post<W>(`/workflows/${id}/revise`, { feedback }),
  pause: (id: string) => api.post<W>(`/workflows/${id}/pause`),
  resume: (id: string, more = false) => api.post<W>(`/workflows/${id}/resume`, more ? { more: true } : {}),
  cancel: (id: string) => api.post<W>(`/workflows/${id}/cancel`),
  guidance: (id: string, text: string) => api.post<W>(`/workflows/${id}/guidance`, { text }),
  answer: (id: string, cardId: string, answers: import("#lib/agent/types.ts").Answer[]) => api.post<W>(`/workflows/${id}/answer`, { card_id: cardId, answers }),
  patch: (id: string, body: { objective?: string; criteria?: { id?: string; text: string }[] }) => api.patch<W>(`/workflows/${id}`, body),
  publish: (id: string) => api.post<{ versionId: string; version: number; jobId: string }>(`/workflows/${id}/publish`),
  remove: (id: string) => api.del<{ ok: true }>(`/workflows/${id}`),
  /** 「從網址下載 PDF」 for a `needs_pdf` run: the library's PDF-from-URL endpoint, then the run re-plans. */
  pdfFromUrl: async (id: string, paperId: string, url: string) => {
    await api.post(`/library/papers/${paperId}/pdf-from-url`, { url });
    return api.post<W>(`/workflows/${id}/resume`, {});
  },
};
