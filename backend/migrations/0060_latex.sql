-- LaTeX editor (spec §3 LaTeX, §10, §13 #14 split-file convention). Module range 0060–0069.
-- A study has any number of projects (one per article/thesis). Text files are Yjs documents
-- `latex:<projectId>:<fileId>` (yjs_docs); `latex_files.content` is the materialized copy. Binary files and every
-- compile/version snapshot live in S3 as content-addressed blobs `latex/<projectId>/blobs/<sha256>`.

CREATE TABLE latex_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'paper' CHECK (kind IN ('paper','thesis','other')),
  -- Template id it was created from (`zh-thesis`, `ieee-conference`, `article-zh`, `article-en`, `import`, `blank`).
  template text NOT NULL DEFAULT 'blank' CHECK (template ~ '^[a-z][a-z0-9-]{0,39}$'),
  root_file text NOT NULL DEFAULT 'main.tex' CHECK (length(root_file) BETWEEN 1 AND 255),
  compiler text NOT NULL DEFAULT 'xelatex' CHECK (compiler IN ('xelatex','pdflatex','lualatex')),
  -- auto: the bib file (settings.bibFile, default refs.bib) is regenerated from the study library before each compile.
  bib_mode text NOT NULL DEFAULT 'auto' CHECK (bib_mode IN ('auto','manual')),
  -- {bibFile?: string, sectionCommand?: "chapter"|"section", haltOnError?: boolean}
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_compile_id uuid,
  last_pdf_compile_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX latex_projects_study ON latex_projects (study_id, updated_at DESC);

CREATE TABLE latex_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES latex_projects(id) ON DELETE CASCADE,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('text','binary')),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('main','section','bib','style','asset','other')),
  -- Cached \input order of sections in the root file (null = not listed); the root file itself is authoritative.
  position integer,
  -- text: materialized Yjs text; binary: null.
  content text,
  -- binary: S3 key of the bytes (content-addressed blob).
  s3_key text,
  bytes bigint NOT NULL DEFAULT 0,
  content_type text,
  -- sha256 of the current bytes (text: of the materialized UTF-8 text).
  sha256 text,
  -- sha256 of the last text snapshot uploaded as a blob (skip re-uploads when unchanged).
  blob_sha256 text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path),
  CHECK ((kind = 'text' AND s3_key IS NULL) OR (kind = 'binary' AND s3_key IS NOT NULL))
);
CREATE INDEX latex_files_project ON latex_files (project_id, position NULLS LAST, path);

CREATE TABLE latex_compiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES latex_projects(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  -- queued/running while the job runs; then the runner's result status, or failed (bad input / retries exhausted),
  -- cancelled (superseded by a newer request or cancelled by a user).
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','partial','failure','timeout','failed','cancelled')),
  compiler text NOT NULL CHECK (compiler IN ('xelatex','pdflatex','lualatex')),
  root_file text NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  manifest_key text NOT NULL,
  output_prefix text NOT NULL,
  -- LatexCompileResult (errors, warnings, counts) as returned by latex-runner.
  result jsonb,
  pdf_key text,
  synctex_key text,
  log_key text,
  blg_key text,
  pdf_bytes bigint,
  duration_ms integer,
  error text,
  -- path → file id at snapshot time, so diagnostics and SyncTeX map back to files after renames.
  file_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX latex_compiles_project ON latex_compiles (project_id, created_at DESC);
CREATE INDEX latex_compiles_job ON latex_compiles (job_id);

ALTER TABLE latex_projects
  ADD CONSTRAINT latex_projects_last_compile FOREIGN KEY (last_compile_id) REFERENCES latex_compiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT latex_projects_last_pdf FOREIGN KEY (last_pdf_compile_id) REFERENCES latex_compiles(id) ON DELETE SET NULL;

-- Named snapshots. The manifest (`latex/<p>/versions/<id>.json`) lists every file with its blob key.
CREATE TABLE latex_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES latex_projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','restore','backup','import')),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  manifest_key text NOT NULL,
  file_count integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX latex_versions_project ON latex_versions (project_id, created_at DESC);
