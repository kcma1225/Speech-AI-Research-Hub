-- Embedding identity and vector spaces (docs/architecture.md "AI platform → Embeddings").
-- One space per embedding model identity. Changing the model builds a new space (re-embedding everything), then
-- flips `embedding_identity.active_space_id`; search never stops and no column dimension is ever altered.

CREATE TABLE embedding_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  route_id uuid REFERENCES ai_routes(id) ON DELETE SET NULL,
  provider_kind text NOT NULL,
  model text NOT NULL,
  dims integer NOT NULL CHECK (dims BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','active','retired','failed')),
  items_total integer NOT NULL DEFAULT 0,
  items_done integer NOT NULL DEFAULT 0,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz
);

-- Identity fingerprint: vectors of a fixed probe set embedded by the space's model. A candidate model/deployment
-- is "the same identity" when its vectors of the same probes have cosine ≥ 0.95 with these (see ai/embedding).
CREATE TABLE embedding_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  probe_version integer NOT NULL,
  dims integer NOT NULL,
  vectors jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, probe_version)
);

-- Singleton: the space semantic search reads from (NULL = keyword-only search).
CREATE TABLE embedding_identity (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_space_id uuid REFERENCES embedding_spaces(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO embedding_identity(id) VALUES (true);

-- Vectors. `vec` has no fixed dimension; each space gets a partial HNSW index on `(vec::halfvec(<dims>))`
-- created by ai/embedding/spaces.ts, so queries must filter `space_id = $1` and cast both sides to that dimension.
CREATE TABLE embeddings (
  space_id uuid NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  owner_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content_hash text NOT NULL,
  vec halfvec NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, owner_type, owner_id, chunk_index)
);
CREATE INDEX embeddings_owner ON embeddings(owner_type, owner_id);
