/** Assistant attachments (docs/architecture.md "Agent → Attachments"). */
export type AttachmentKind = "upload" | "note" | "paper" | "deck" | "meeting" | "latex_project" | "latex_file";
export type PickerCategory = "note" | "paper" | "deck" | "meeting" | "latex_project";

export const MAX_ATTACHMENTS = 10;

/** What the server stores on a user message (and returns from resolve / upload). */
export type Attachment = {
  kind: AttachmentKind;
  id: string;
  project_id?: string;
  version?: string;
  version_label?: string;
  title: string;
  study: { id: string; slug: string; title: string } | null;
  url: string | null;
  mime?: string;
  upload_kind?: "document" | "image";
};

export type AttachmentRef = { kind: AttachmentKind; id: string; project_id?: string; version?: string };

export const refOf = (a: Attachment): AttachmentRef => ({
  kind: a.kind,
  id: a.id,
  ...(a.project_id ? { project_id: a.project_id } : {}),
  ...(a.version ? { version: a.version } : {}),
});
export const keyOf = (a: { kind: string; id: string }) => `${a.kind}:${a.id}`;

export type UploadView = {
  id: string;
  kind: "upload";
  title: string;
  upload_kind: "document" | "image";
  format: string;
  mime: string;
  bytes: number;
  chars: number;
  truncated: boolean;
  pages: number | null;
  warnings: string[];
  url: string;
};

export type PickerStudy = { id: string; slug: string; title: string; status: string; activity_at: string; mine: boolean; my_role: string | null; owner: string | null };

export type DeckVersion = { id: string; version: number; status: string; page_count: number | null; created_at: string };
export type PickerItem = {
  id: string;
  title: string;
  date: string | null;
  // note
  note_kind?: string;
  author?: string | null;
  // paper
  year?: number | null;
  venue?: string | null;
  authors?: string;
  has_pdf?: boolean;
  cite_key?: string;
  // deck
  deck_kind?: string;
  active_version_id?: string | null;
  versions?: DeckVersion[];
  // meeting
  status?: string;
  // latex
  latex_kind?: string;
  text_files?: number;
};

export type LatexFile = { id: string; path: string; role: string; position: number | null; bytes: number; updated_at: string; heading: string | null };
