import type { TagRef } from "#lib/types.ts";

export type VersionStatus = "queued" | "rendering" | "published" | "failed";
export type UploadLimits = { zipBytes: number; referenceBytes: number };

/** Row of GET /slides. */
export type SlideSummary = {
  id: string;
  title: string;
  slug: string;
  public_view: boolean;
  created_at: string;
  updated_at: string;
  active_version_id: string | null;
  active_version: number | null;
  latest_version_id: string | null;
  latest_version: number | null;
  latest_status: VersionStatus | null;
  tags: TagRef[];
  reference_count: number;
  review_count?: number;
  author_name?: string | null;
  published_at?: string | null;
  thumbnailUrl: string | null;
};

export type SlideVersion = {
  id: string;
  version: number;
  status: VersionStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  source_name: string;
  entry_qmd: string;
  quarto_version: string | null;
  created_at: string;
  uploader_name?: string | null;
  published_at?: string | null;
  is_active: boolean;
  viewUrl: string | null;
  pdfUrl: string | null;
  hasThumbnail: boolean;
};

export type SlideReference = {
  id: string;
  title: string;
  url: string | null;
  file_name: string | null;
  file_bytes: number | null;
  is_default: boolean;
  created_at: string;
  kind: "file" | "url";
  href: string;
};

export type SlideReply = { id: string; review_id: string; body: string; created_at: string; author: string; author_id: string };
export type SlideReview = { id: string; body: string; created_at: string; author: string; author_id: string; replies: SlideReply[] };

/** GET /slides/:id and GET /slides/by-slug/:slug. */
export type SlideDetail = {
  project: {
    id: string;
    title: string;
    slug: string;
    public_view: boolean;
    active_version_id: string | null;
    created_by: string;
    creator_name?: string | null;
    created_at: string;
    updated_at: string;
    share_key: string | null;
    shareUrl: string | null;
    playerUrl: string;
  };
  activeVersion: SlideVersion | null;
  thumbnailUrl: string | null;
  viewUrl: string | null;
  pdfUrl: string | null;
  versions: SlideVersion[];
  references: SlideReference[];
  reviews: SlideReview[];
  tags: TagRef[];
  permissions: { manage: boolean; review: boolean; reply: boolean };
  limits?: UploadLimits;
};

export type SlideStatus = { id: string; version: number; status: VersionStatus; error: string | null; stage: string | null; progress: number };
