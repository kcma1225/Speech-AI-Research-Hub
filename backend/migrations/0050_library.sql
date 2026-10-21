-- Library module (M4): lab-wide papers, per-study reading lists, files, import log. docs/architecture.md "Library".

-- One row per work, shared by the whole lab. `record` is the canonical PaperRecord (CSL-JSON semantics,
-- backend/src/lib/library/types.ts); the columns next to it are copies kept in sync by lib/library/store.ts for
-- filtering, dedupe and indexes.
CREATE TABLE papers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  type text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  -- normalizeTitle(title) (NFKC, case-folded, punctuation stripped): pg_trgm prefilter for dedupe and search.
  title_norm text NOT NULL,
  -- "family given; family given…" for search.
  authors_text text NOT NULL DEFAULT '',
  year integer CHECK (year BETWEEN 1000 AND 3000),
  venue text,
  doi text,
  doi_key text UNIQUE,          -- lower-case DOI (doiKey)
  arxiv_id text UNIQUE,         -- no version suffix
  s2_id text,
  openalex_id text,
  abstract text,
  -- Original BibTeX entry from a .bib import (round trip), when there is one.
  bibtex text,
  -- Open-access PDF location found online (not necessarily downloaded) and where it came from.
  oa_url text,
  oa_source text,
  -- Primary stored PDF (copy of paper_files.key of the newest file); NULL = no PDF.
  pdf_key text,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX papers_title_trgm ON papers USING gin (title_norm gin_trgm_ops);
CREATE INDEX papers_authors_trgm ON papers USING gin (lower(authors_text) gin_trgm_ops);
CREATE INDEX papers_year ON papers (year);
CREATE INDEX papers_venue ON papers (lower(venue));
CREATE UNIQUE INDEX papers_s2 ON papers (s2_id) WHERE s2_id IS NOT NULL;
CREATE UNIQUE INDEX papers_openalex ON papers (openalex_id) WHERE openalex_id IS NOT NULL;
CREATE INDEX papers_created ON papers (created_at DESC);

-- Stored files of a paper (PDF). Key: library/papers/<paperId>/<fileId>.pdf
CREATE TABLE paper_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'pdf' CHECK (kind IN ('pdf')),
  key text NOT NULL UNIQUE,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  sha256 text NOT NULL,
  source text NOT NULL CHECK (source IN ('upload','open_access','import')),
  source_url text,
  file_name text,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_files_paper ON paper_files (paper_id, created_at DESC);

-- A study's reading list. Everyone reads it; study editors (owner/member) change it.
CREATE TABLE study_papers (
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  -- Citation key used in this study's refs.bib. Pinned once set (never regenerated); unique per study, ignoring case.
  cite_key text NOT NULL CHECK (cite_key ~ '^[A-Za-z0-9_:.-]{1,100}$'),
  reading_status text NOT NULL DEFAULT 'unread' CHECK (reading_status IN ('unread','reading','read')),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 30),
  notes_md text NOT NULL DEFAULT '' CHECK (length(notes_md) <= 200000),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes_updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, paper_id)
);
CREATE UNIQUE INDEX study_papers_cite_key ON study_papers (study_id, lower(cite_key));
CREATE INDEX study_papers_paper ON study_papers (paper_id);

-- Import log: file / Zotero / PDF imports. Created as `preview` (parsed records + duplicate matches, nothing written),
-- then `done` after confirm (or `cancelled`). Previews older than a day are purged on the next import.
CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid REFERENCES studies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('file','zotero','pdf')),
  format text NOT NULL,
  file_name text,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','done','cancelled')),
  -- [{ index, record, citeKey, match: {level, reason, paperId}|null, inStudy }]
  items jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  -- PDF imports: the uploaded file, kept until confirm (library/imports/<batchId>/upload.pdf).
  file_key text,
  -- { added, linked, merged, skipped }
  counts jsonb NOT NULL DEFAULT '{}',
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
CREATE INDEX import_batches_study ON import_batches (study_id, created_at DESC);
CREATE INDEX import_batches_user ON import_batches (user_id, created_at DESC);

-- Per-user Zotero connection (Web API key encrypted with PROVIDER_TOKEN_KEY, AAD `<userId>:zotero`).
CREATE TABLE library_zotero_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key bytea NOT NULL,
  zotero_user_id bigint NOT NULL,
  username text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Paper reports (decks.kind = paper_report) point at a lab paper.
ALTER TABLE decks ADD CONSTRAINT decks_paper_fk FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE SET NULL;
CREATE INDEX decks_paper ON decks (paper_id) WHERE paper_id IS NOT NULL;
