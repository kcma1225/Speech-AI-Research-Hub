-- Slides module (v3 M5): in-app Quarto sources, quick previews, deck metadata.
-- docs/architecture.md "Slides" is the contract.

-- Free-form deck metadata. `paper` = {title, url?} for paper reports whose paper is not (yet) in the library
-- (decks.paper_id stays the link once the library module adds its FK).
ALTER TABLE decks ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object');

-- One Quarto source tree per deck (edited in the platform; "發布" packs it into a ZIP version).
CREATE TABLE deck_source_trees (
  deck_id uuid PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
  -- Entry .qmd (posix path inside the tree).
  entry text NOT NULL DEFAULT 'index.qmd' CHECK (length(entry) BETWEEN 1 AND 200),
  -- Template the tree started from: progress | paper_report | blank | ai | version (imported from a version ZIP).
  origin text NOT NULL DEFAULT 'blank' CHECK (origin ~ '^[a-z_]{1,32}$'),
  -- Bumped on every change to any file; previews and publishes record the revision they were built from.
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- Revision of the last publish (null = never published).
  published_revision integer,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Files of a source tree: text in `content`, binaries (images, fonts…) in S3 `slides/<deckId>/source/<id>`.
-- `id` is the suggestion target (`suggestions.target_type = 'deck_source'`), `version` its base version.
CREATE TABLE deck_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES deck_source_trees(deck_id) ON DELETE CASCADE,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('text','binary')),
  content text,
  s3_key text,
  bytes integer NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  content_type text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deck_id, path),
  CHECK ((kind = 'text') = (content IS NOT NULL) AND (kind = 'binary') = (s3_key IS NOT NULL))
);

-- Quick preview renders (`slide_preview` jobs: HTML only). Only the newest ready one per deck is kept.
CREATE TABLE deck_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed','cancelled')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  entry_html text,
  output_prefix text NOT NULL,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX deck_previews_deck ON deck_previews (deck_id, created_at DESC);
