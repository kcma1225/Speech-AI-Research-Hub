-- Initial schema for v2 (fresh start; v1 data is exported separately, not migrated).

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member','professor')),
  auth_mode text NOT NULL DEFAULT 'either' CHECK (auth_mode IN ('either','two_factor')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';
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
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','professor')),
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

-- Background work executed by the worker service. See docs/architecture.md "Jobs".
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('media_transcode','slide_render')),
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

-- Research notes (研究筆記).
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content text NOT NULL DEFAULT '',
  event_date date NOT NULL,
  audio_key text,             -- S3 key of the transcoded m4a
  audio_name text,            -- original upload file name
  audio_bytes bigint,
  audio_duration_seconds double precision,
  transcript jsonb,           -- [{start,end,text}] parsed from SRT
  transcript_name text,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_event_date ON items (event_date DESC, created_at DESC);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_unique ON tags (lower(name));

CREATE TABLE item_tags (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX item_tags_tag ON item_tags(tag_id);

-- Slides.
CREATE TABLE slide_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE slide_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  entry_qmd text NOT NULL,
  entry_html text,             -- set by finalizer from job result
  source_name text NOT NULL,   -- uploaded zip file name
  source_key text NOT NULL,    -- S3 key of the uploaded zip
  output_prefix text NOT NULL, -- S3 prefix of rendered files, ends with '/'
  pdf_key text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','published','failed')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  error text,
  quarto_version text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  UNIQUE (project_id, id)
);
CREATE INDEX slide_versions_project ON slide_versions(project_id, version DESC);
ALTER TABLE slide_projects ADD CONSTRAINT slide_active_version_fk
  FOREIGN KEY (id, active_version_id) REFERENCES slide_versions(project_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE slide_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  url text,
  file_key text,
  file_name text,
  file_bytes bigint,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((url IS NOT NULL) <> (file_key IS NOT NULL))
);
CREATE UNIQUE INDEX slide_one_default_reference ON slide_references(project_id) WHERE is_default;

CREATE TABLE slide_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slide_reviews_project ON slide_reviews(project_id, created_at);

CREATE TABLE slide_review_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES slide_reviews(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slide_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slide_tags_name_unique ON slide_tags (lower(name));

CREATE TABLE slide_project_tags (
  project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES slide_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);
CREATE INDEX slide_project_tags_tag ON slide_project_tags(tag_id);

-- Notifications and Web Push.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('media','slide','system')),
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

-- The worker connects as a least-privilege role (created by postgres/init) that can only claim and update jobs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_worker') THEN
    GRANT SELECT, UPDATE ON jobs TO hub_worker;
  END IF;
END $$;
