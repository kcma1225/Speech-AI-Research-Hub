/**
 * Attachments of a user message (docs/architecture.md "Agent → Attachments"): references to hub objects or files
 * uploaded into the conversation. The client sends refs; the server resolves titles, checks access and stores the
 * resolved list on `agent_messages.attachments`.
 */
import { z } from "zod";

export const ATTACHMENT_KINDS = ["upload", "note", "paper", "deck", "meeting", "latex_project", "latex_file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Max references per user message. */
export const MAX_ATTACHMENTS = 10;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "id 格式不正確。");

export const attachmentRef = z
  .object({
    kind: z.enum(ATTACHMENT_KINDS),
    id: uuid,
    /** latex_file: the project the file belongs to. */
    project_id: uuid.optional(),
    /** deck: a specific slide version (default: the active one). */
    version: uuid.optional(),
  })
  .refine((r) => r.kind !== "latex_file" || !!r.project_id, { message: "LaTeX 檔案需要 project_id。" });
export type AttachmentRef = z.infer<typeof attachmentRef>;

export const attachmentsInput = z
  .array(attachmentRef)
  .max(MAX_ATTACHMENTS, `每則訊息最多附加 ${MAX_ATTACHMENTS} 個項目。`);

/** What a message stores and the API returns (never content). */
export type StoredAttachment = {
  kind: AttachmentKind;
  id: string;
  project_id?: string;
  version?: string;
  version_label?: string;
  title: string;
  study: { id: string; slug: string; title: string } | null;
  url: string | null;
  /** upload only */
  mime?: string;
  upload_kind?: "document" | "image";
};

export const refOf = (a: StoredAttachment): AttachmentRef => ({
  kind: a.kind,
  id: a.id,
  ...(a.project_id ? { project_id: a.project_id } : {}),
  ...(a.version ? { version: a.version } : {}),
});

/** Dedupe by kind + id (+ version); keeps the first. */
export function dedupeRefs(refs: AttachmentRef[]): AttachmentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.kind}:${r.id}:${r.version ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
