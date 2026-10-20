import type { TagRef } from "#lib/types.ts";

export type VersionStatus = "queued" | "rendering" | "review" | "published" | "failed";
export type SourceType = "quarto" | "pdf" | "pptx";
export type UploadLimits = { zipBytes: number; deckBytes?: number; deckTypes?: string[]; referenceBytes: number };

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
  sourceType: SourceType;
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
  /** Null for renders without a page manifest (older renders, failed quarto capture) and review versions in by-slug. */
  pageCount: number | null;
  pagesUrl: string | null;
};

/** One page of a version's manifest (1-based `index`; `h`/`v` are Reveal indices of quarto decks). */
export type SlidePage = { index: number; h?: number; v?: number; title?: string; thumb: string; full?: string; notes?: { text: string; html?: string } };
/** GET …/pages: image URLs must always be taken from here (they may carry `?r=` and `?key=`). */
export type PageManifest = { version: 1; versionId: string; sourceType: SourceType; width: number; height: number; pageCount: number; pages: SlidePage[] };

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
export type SlideReview = {
  id: string;
  body: string;
  created_at: string;
  author: string;
  author_id: string;
  /** Page of `versionId` the review is about; null for general reviews. */
  page: number | null;
  versionId: string | null;
  replies: SlideReply[];
};

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
