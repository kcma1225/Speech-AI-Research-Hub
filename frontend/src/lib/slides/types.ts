import type { StudyRef } from "#lib/types.ts";

export type DeckKind = "progress" | "paper_report";

export type VersionStatus = "queued" | "rendering" | "review" | "published" | "failed";
export type SourceType = "quarto" | "pdf" | "pptx";
export type UploadLimits = { zipBytes: number; deckBytes?: number; deckTypes?: string[]; referenceBytes: number };

/** Row of GET /slides. */
export type SlideSummary = {
  id: string;
  title: string;
  slug: string;
  kind: DeckKind;
  study_id: string;
  study: StudyRef;
  public_view: boolean;
  created_at: string;
  updated_at: string;
  active_version_id: string | null;
  active_version: number | null;
  latest_version_id: string | null;
  latest_version: number | null;
  latest_status: VersionStatus | null;
  reference_count: number;
  review_count?: number;
  /** The deck has an in-app Quarto source tree. */
  has_source?: boolean;
  paper_id?: string | null;
  metadata?: DeckMetadata;
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
    kind: DeckKind;
    paper_id: string | null;
    metadata?: DeckMetadata;
    /** In-app source revision and the revision last published (signed-in viewers; null without a tree). */
    source?: { revision: number; published_revision: number | null } | null;
    study_id: string | null;
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
  /** The deck's study; null for anonymous viewers. */
  study: StudyRef | null;
  permissions: { manage: boolean; review: boolean; reply: boolean };
  limits?: UploadLimits;
};

export type SlideStatus = { id: string; version: number; status: VersionStatus; error: string | null; stage: string | null; progress: number };

/** `decks.metadata`: `paper` is a paper report's paper when it is not linked to the library. */
export type DeckMetadata = { paper?: { title: string; url?: string; abstract?: string } };

export type DeckTemplate = "progress" | "paper_report" | "blank";

/** One file of an in-app Quarto source tree (GET /slides/:id/source). Text files carry `content`. */
export type SourceFile = {
  id: string;
  path: string;
  kind: "text" | "binary";
  bytes: number;
  content_type: string | null;
  version: number;
  updated_by: string | null;
  updated_by_name?: string | null;
  updated_at: string;
  content?: string;
};

export type PreviewStatus = "queued" | "rendering" | "ready" | "failed" | "cancelled";
export type PreviewInfo = {
  latest: { id: string; revision: number; status: PreviewStatus; error: string | null; stage: string | null; progress: number; created_at: string } | null;
  ready: { id: string; revision: number; finished_at: string | null; viewUrl: string } | null;
};

export type SourceTree = { entry: string; origin: string; revision: number; published_revision: number | null; updated_at: string; updated_by_name: string | null };
export type SourceResponse = {
  source: SourceTree | null;
  files: SourceFile[];
  preview: PreviewInfo;
  permissions: { edit: boolean };
  limits: { files: number; textBytes: number; binaryBytes: number; totalBytes: number };
  templates: DeckTemplate[];
};

/** GET /slides/:id/ai/generate (`stage`: context | generating | writing | validating | fixing | waiting_llm | done | failed …). */
export type AiDraftJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;
  error: string | null;
  result: { revision: number; previewId: string | null; valid: boolean | null; fixed: boolean; pages: number } | null;
  created_at: string;
  finished_at: string | null;
};
