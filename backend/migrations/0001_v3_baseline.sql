-- v3 baseline (fresh start: v2 data, accounts included, is not migrated; the Owner is created by bootstrap).
-- docs/architecture.md is the contract. Module migration ranges: core 0001–0019, AI 0020–0029, notes 0030–0039,
-- slides 0040–0049, library 0050–0059, latex 0060–0069, agent 0070–0079, meetings 0080–0089, search 0090–0099.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── Identity ─────────────────────────────

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('student','professor')),
  -- System administration (models, templates, accounts). Independent of role.
  is_admin boolean NOT NULL DEFAULT false,
  -- The bootstrap account: exactly one, always an admin, cannot be demoted or disabled.
  is_owner boolean NOT NULL DEFAULT false,
  auth_mode text NOT NULL DEFAULT 'either' CHECK (auth_mode IN ('either','two_factor')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  locale text NOT NULL DEFAULT 'zh-TW' CHECK (locale IN ('zh-TW','en')),
  -- Validated by backend/src/lib/preferences.ts; missing keys mean the default.
  preferences jsonb NOT NULL DEFAULT '{}',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CHECK (NOT is_owner OR (is_admin AND disabled_at IS NULL))
);
CREATE UNIQUE INDEX users_one_owner ON users (is_owner) WHERE is_owner;
CREATE UNIQUE INDEX users_name_unique ON users (lower(name));

-- Hash of the OWNER_PASSWORD env value last applied, so a changed env value can be detected.
CREATE TABLE owner_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  password_hash text NOT NULL
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','professor')),
  is_admin boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz,                -- NULL = never expires
  max_uses integer DEFAULT 1 CHECK (max_uses IS NULL OR max_uses > 0), -- NULL = unlimited
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitation_uses (
  invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, user_id)
);

CREATE TABLE passkeys (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  device_name text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- ───────────────────────────── Jobs ─────────────────────────────

-- Background work. See docs/architecture.md "Jobs". `kind` is free-form (lower snake case) so each module can add
-- its own kinds without rewriting a shared CHECK; producers and consumers agree on kinds in architecture.md.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,47}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  payload jsonb NOT NULL,
  result jsonb,
  error text,
  stage text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false,
  locked_by text,
  heartbeat_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  finalized_at timestamptz
);
CREATE INDEX jobs_queue ON jobs (run_after, created_at) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs (heartbeat_at) WHERE status = 'running';
CREATE INDEX jobs_unfinalized ON jobs (finished_at) WHERE finalized_at IS NULL AND status IN ('succeeded','failed','cancelled');
CREATE INDEX jobs_creator ON jobs (created_by, created_at DESC);

-- ───────────────────────────── System ─────────────────────────────

-- Admin-managed settings (external API keys, OpenAlex mailto, …). Keys are namespaced `<module>.<name>`.
-- Secret values must be encrypted by the owning module before they are stored here.
CREATE TABLE system_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Stage templates copied into a new study's stages. Exactly one is the default.
CREATE TABLE stage_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- [{ "name": text (1–60), "description": text? }], 1–20 entries
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages) = 'array' AND jsonb_array_length(stages) BETWEEN 1 AND 20),
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stage_templates_one_default ON stage_templates (is_default) WHERE is_default;
INSERT INTO stage_templates(name, is_default, stages) VALUES ('預設階段', true, '[
  {"name":"題目發想","description":"確定研究問題與範圍"},
  {"name":"文獻探討","description":"整理相關研究與方法"},
  {"name":"實驗","description":"設計並執行實驗、分析結果"},
  {"name":"撰寫","description":"撰寫論文或報告"},
  {"name":"投稿/口試","description":"投稿、修訂或口試"}
]');

-- ───────────────────────────── Studies ─────────────────────────────

CREATE TABLE studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lower-case ASCII words joined by '-'; never UUID-shaped (routes accept an id or a slug).
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80
                                   AND slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  summary_md text NOT NULL DEFAULT '' CHECK (length(summary_md) <= 100000),
  summary_format text NOT NULL DEFAULT 'prose' CHECK (summary_format IN ('prose','bullets')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','archived')),
  current_stage_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Last change to anything in the study (bumped by recordActivity); list ordering.
  activity_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX studies_activity ON studies (activity_at DESC);
CREATE INDEX studies_title_trgm ON studies USING gin (title gin_trgm_ops);

CREATE TABLE study_members (
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- owner: creator (transferable), edits and manages members; member: edits; advisor: professor account, reads + comments.
  role text NOT NULL CHECK (role IN ('owner','member','advisor')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, user_id)
);
CREATE UNIQUE INDEX study_members_one_owner ON study_members (study_id) WHERE role = 'owner';
CREATE INDEX study_members_user ON study_members (user_id);

CREATE TABLE study_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (study_id, id)
);
ALTER TABLE studies ADD CONSTRAINT studies_current_stage_fk
  FOREIGN KEY (id, current_stage_id) REFERENCES study_stages(study_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES study_stages(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  due_on date,
  done_at timestamptz,
  done_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestones_study ON milestones (study_id, due_on NULLS LAST);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND title = btrim(title)),
  detail_md text NOT NULL DEFAULT '' CHECK (length(detail_md) <= 20000),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  -- Where the task came from: typed by hand, a confirmed meeting draft, or an AI tool call.
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','meeting','ai')),
  -- Free-form pointer into the source (e.g. `meeting:<id>`, `tool_call:<id>`).
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_study ON tasks (study_id, status, due_on NULLS LAST);
CREATE INDEX tasks_assignee_open ON tasks (assignee_id, due_on NULLS LAST) WHERE status = 'open';

-- Timeline of a study (dashboard "recent activity"). Any module may append through lib/studies/activity.ts.
CREATE TABLE study_activity (
  id bigserial PRIMARY KEY,
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- lower snake case, namespaced by module when not core: study_created, task_done, milestone_done, stage_changed,
  -- deck_published, member_added, …
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,47}$'),
  target_type text,
  target_id text,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  -- SPA path to open, e.g. /studies/<slug>?tab=tasks
  url text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_activity_study ON study_activity (study_id, created_at DESC);
CREATE INDEX study_activity_created ON study_activity (created_at DESC);

-- ───────────────────────────── Slides (decks) ─────────────────────────────

CREATE TABLE decks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'progress' CHECK (kind IN ('progress','paper_report')),
  -- Paper being reported on (kind paper_report). The FK to papers is added by the library module.
  paper_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80),
  public_view boolean NOT NULL DEFAULT false,
  share_key text NOT NULL UNIQUE,
  active_version_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decks_study ON decks (study_id, updated_at DESC);

CREATE TABLE slide_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  -- Source of a version: Quarto ZIP, a PDF, or a PPTX converted by the worker.
  source_type text NOT NULL DEFAULT 'quarto' CHECK (source_type IN ('quarto','pdf','pptx')),
  entry_qmd text NOT NULL,
  entry_html text,             -- set by finalizer from job result
  source_name text NOT NULL,   -- uploaded file name
  source_key text NOT NULL,    -- S3 key of the uploaded file
  output_prefix text NOT NULL, -- S3 prefix of rendered files, ends with '/'
  pdf_key text,
  -- `review`: rendered (PPTX conversion) and waiting for the uploader to confirm before it can become active.
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','review','published','failed')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  error text,
  quarto_version text,
  -- offline-assets/ shared per worker asset set under slides/_shared/<hash>/; NULL = in the version's own output.
  shared_prefix text CHECK (shared_prefix ~ '^slides/_shared/[0-9a-f]{32}/$'),
  -- Full S3 key of the first-slide thumbnail; NULL when the render produced none.
  thumbnail_key text,
  -- Page manifest (`<output_prefix>_hub/pages.json`) and its page count; NULL when page capture failed.
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 1000),
  manifest_key text,
  published_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deck_id, version),
  UNIQUE (deck_id, id)
);
CREATE INDEX slide_versions_deck ON slide_versions(deck_id, version DESC);
ALTER TABLE decks ADD CONSTRAINT deck_active_version_fk
  FOREIGN KEY (id, active_version_id) REFERENCES slide_versions(deck_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE slide_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  url text,
  file_key text,
  file_name text,
  file_bytes bigint,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((url IS NOT NULL) <> (file_key IS NOT NULL))
);
CREATE UNIQUE INDEX slide_one_default_reference ON slide_references(deck_id) WHERE is_default;

-- Per-page reviews: `page` (1-based) refers to the pages of `version_id`. A deleted version keeps the review.
CREATE TABLE slide_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  page integer CHECK (page IS NULL OR page BETWEEN 1 AND 1000),
  version_id uuid REFERENCES slide_versions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slide_reviews_deck ON slide_reviews(deck_id, created_at);
CREATE INDEX slide_reviews_version ON slide_reviews(version_id) WHERE version_id IS NOT NULL;

CREATE TABLE slide_review_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES slide_reviews(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Notifications, audit ─────────────────────────────

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- media, slide, system, study, task, … (modules add their own; lower snake case)
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '/',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created ON notifications(user_id, created_at DESC);

CREATE TABLE push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log(created_at DESC);

-- ───────────────────────────── OIDC provider (kept for MCP authorization) ─────────────────────────────

-- ID-token signing key, created on first use. Exactly one key is active; inactive keys stay published until removed.
CREATE TABLE oidc_signing_keys (
  kid text PRIMARY KEY,
  alg text NOT NULL CHECK (alg IN ('ES256')),
  private_key_pem text NOT NULL,
  public_jwk jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oidc_signing_keys_one_active ON oidc_signing_keys(active) WHERE active;

-- One-time authorization codes (sha256 of the code), ~60 s TTL; consumed with DELETE … RETURNING.
CREATE TABLE oidc_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  nonce text,
  code_challenge text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_codes_expires ON oidc_codes(expires_at);

-- Opaque access tokens for /api/oidc/userinfo (sha256 of the token), short-lived.
CREATE TABLE oidc_access_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_access_tokens_expires ON oidc_access_tokens(expires_at);

-- The worker connects as a least-privilege role (created by postgres/init) that can only claim and update jobs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_worker') THEN
    GRANT SELECT, UPDATE ON jobs TO hub_worker;
  END IF;
END $$;
