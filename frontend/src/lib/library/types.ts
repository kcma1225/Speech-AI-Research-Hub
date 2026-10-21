// Library API shapes (backend routes/papers.ts, library-study.ts, library-imports.ts; docs/architecture.md "Library").

export type PaperAuthor = { family?: string; given?: string; literal?: string; particle?: string; suffix?: string };

export const PAPER_TYPES = [
  "article-journal", "paper-conference", "article", "book", "chapter", "thesis", "report", "webpage", "dataset", "software", "patent", "manuscript", "speech", "document",
] as const;
export type PaperType = (typeof PAPER_TYPES)[number];

/** PaperRecord (CSL-JSON semantics, camelCase). */
export type PaperRecord = {
  type: PaperType;
  title: string;
  authors: PaperAuthor[];
  editors?: PaperAuthor[];
  year?: number;
  month?: number;
  day?: number;
  containerTitle?: string;
  venue?: string;
  collectionTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publisherPlace?: string;
  edition?: string;
  isbn?: string;
  issn?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  abstract?: string;
  keywords?: string[];
  language?: string;
  note?: string;
  ids?: Record<string, string>;
  oaPdfUrl?: string;
  citeKey?: string;
};

export type PaperSummary = {
  id: string;
  type: PaperType;
  title: string;
  authors: PaperAuthor[];
  year: number | null;
  venue: string | null;
  container_title: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  has_pdf: boolean;
  oa_url: string | null;
  created_at: string;
  updated_at: string;
};

export type LabPaper = PaperSummary & { studies: { id: string; slug: string; title: string }[] };

export type PaperDetail = PaperSummary & {
  record: PaperRecord;
  abstract: string | null;
  bibtex_original: string | null;
  oa_source: string | null;
  added_by: { id: string; name: string } | null;
  files: { id: string; bytes: number; source: "upload" | "open_access" | "import"; file_name: string | null; created_at: string; added_by: string | null }[];
  studies: { id: string; slug: string; title: string; cite_key: string; reading_status: ReadingStatus; can_edit: boolean }[];
  citations: { apa: string; ieee: string; bibtex: string };
  permissions: { edit: boolean; delete: boolean };
};

export type ReadingStatus = "unread" | "reading" | "read";

export type StudyPaper = {
  paper: PaperSummary;
  cite_key: string;
  reading_status: ReadingStatus;
  tags: string[];
  notes_md: string;
  added_by: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  notes_updated_at: string | null;
  notes_updated_by: string | null;
};

export type MatchLevel = "same" | "likely" | "possible";

export type ImportItem = {
  index: number;
  record: PaperRecord;
  citeKey: string;
  match: { level: MatchLevel; reason?: string; score: number; paper: PaperSummary } | null;
  inStudy: boolean;
  duplicateOf: number | null;
  action: "add" | "link" | "skip";
};

export type ImportBatch = {
  id: string;
  study_id: string | null;
  source: "file" | "zotero" | "pdf";
  format: string;
  file_name: string | null;
  status: "preview" | "done" | "cancelled";
  items: ImportItem[];
  warnings: { index: number; key?: string; message: string }[];
  counts: { added?: number; linked?: number; skipped?: number; total?: number };
  summary: { total: number; new: number; same: number; likely: number; possible: number; inStudy: number; inFile: number };
  job_id: string | null;
  created_at: string;
};

export type ConfirmResult = { added: number; linked: number; skipped: number; papers: { index: number; paperId: string; citeKey: string; created: boolean }[] };

export type SearchSource = "openalex" | "s2" | "arxiv" | "crossref" | "isca";
export type SearchHit = { record: PaperRecord; sources: SearchSource[]; existing: { paperId: string; level: MatchLevel; inStudy: boolean } | null };
export type SearchResponse = { hits: SearchHit[]; errors: { source: SearchSource; status: number; message: string }[]; skipped: { source: SearchSource; reason: string }[] };

export type DuplicateResponse = { error: string; code: "duplicate"; record: PaperRecord; duplicates: { level: MatchLevel; reason?: string; paper: PaperSummary }[] };

export type LibrarySettingsView = {
  contact_email: string | null;
  unpaywall_email: string | null;
  grobid_url: string | null;
  openalex_api_key: { set: boolean; last4: string | null };
  s2_api_key: { set: boolean; last4: string | null };
  zotero_api_key: { set: boolean; last4: string | null };
  zotero_library: { type: "user" | "group"; id: string; name?: string } | null;
};
