-- AI platform (docs/architecture.md "AI platform"): provider accounts → routes → role bindings,
-- call log (never prompt/response content), health status, subscription OAuth logins, ai-worker job state.

-- Provider accounts. `family` picks the registry: `llm` (backend/src/ai/providers, chat + embeddings) or
-- `asr` (backend/src/ai/asr). `kind` is the registry id. Secrets (API keys, service-account JSON…) and OAuth
-- tokens are AES-256-GCM ciphertext (key PROVIDER_TOKEN_KEY, AAD = provider id + purpose); API responses only
-- ever show which secret keys are set.
CREATE TABLE ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL CHECK (family IN ('llm','asr')),
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  category text NOT NULL CHECK (category IN ('external','local','subscription')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_url text,
  auth_type text NOT NULL CHECK (auth_type IN ('api_key','oauth','none','service_account','aws','azure')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secret_keys text[] NOT NULL DEFAULT '{}',
  oauth_tokens bytea,
  -- Non-secret OAuth facts for the UI: {status: none|connected|needs_reauth, email?, planType?, expiresAt?, connectedAt?}
  oauth_meta jsonb NOT NULL DEFAULT '{"status":"none"}',
  enabled boolean NOT NULL DEFAULT true,
  -- Last probe: {ok, latencyMs, detail_zh, code?, modelCount?}
  last_probe jsonb,
  last_probe_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, name)
);

-- Routes: a named strategy over members. `capability` decides which members fit (chat/embedding → llm providers,
-- asr → asr providers) and which roles may bind it.
CREATE TABLE ai_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  capability text NOT NULL CHECK (capability IN ('chat','embedding','asr')),
  strategy text NOT NULL CHECK (strategy IN ('single','fallback','round_robin','load_balance')),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A member is either provider + model or a child route (nesting; cycles are rejected by the API).
-- `params` holds per-use settings validated against the registry entry's whitelist (timeout_ms, max_retries,
-- temperature, vendor passthrough keys, ASR language/diarization…).
CREATE TABLE ai_route_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES ai_routes(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  provider_id uuid REFERENCES ai_providers(id) ON DELETE RESTRICT,
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  child_route_id uuid REFERENCES ai_routes(id) ON DELETE RESTRICT,
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
  params jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  CHECK ((provider_id IS NOT NULL AND model IS NOT NULL AND child_route_id IS NULL)
      OR (provider_id IS NULL AND model IS NULL AND child_route_id IS NOT NULL)),
  CHECK (child_route_id IS NULL OR child_route_id <> route_id),
  UNIQUE (route_id, position)
);
CREATE INDEX ai_route_members_provider ON ai_route_members(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX ai_route_members_child ON ai_route_members(child_route_id) WHERE child_route_id IS NOT NULL;

-- Role bindings (功能綁定). Code asks for a role, never a model.
CREATE TABLE ai_role_routes (
  role text PRIMARY KEY CHECK (role IN ('assistant','writing','slides','analysis','fast','embedding','asr','asr_live')),
  route_id uuid NOT NULL REFERENCES ai_routes(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per member attempt (after its own retries). Rows of one logical call share `call_id`; `final` marks the
-- row that ended it. Never stores prompts, responses, audio or embeddings input.
CREATE TABLE ai_call_log (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL,
  final boolean NOT NULL,
  role text,
  capability text NOT NULL CHECK (capability IN ('chat','embedding','asr','asr_live')),
  route_id uuid,
  provider_id uuid,
  provider_kind text,
  model text,
  stream boolean NOT NULL DEFAULT false,
  probe boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  latency_ms integer NOT NULL DEFAULT 0,
  ttft_ms integer,
  tokens_in integer,
  tokens_out integer,
  ok boolean NOT NULL,
  error_code text,
  retries integer NOT NULL DEFAULT 0,
  fallback_index integer NOT NULL DEFAULT 0,
  job_id uuid,
  user_id uuid
);
CREATE INDEX ai_call_log_time ON ai_call_log(started_at DESC);
CREATE INDEX ai_call_log_role ON ai_call_log(role, started_at DESC);
CREATE INDEX ai_call_log_provider ON ai_call_log(provider_id, model, started_at DESC);

-- Derived health per role (written by whichever process recomputes; NOTIFY ai_status on change).
CREATE TABLE ai_role_status (
  role text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('ok','degraded','unavailable','unconfigured')),
  message_zh text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',
  changed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pending subscription logins (ChatGPT device code, Claude copy-code PKCE). `state` is encrypted (AAD = session id).
CREATE TABLE ai_oauth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  flow text NOT NULL CHECK (flow IN ('chatgpt_device','claude_pkce')),
  state bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','expired','failed')),
  created_by uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ai_oauth_sessions_expires ON ai_oauth_sessions(expires_at);

-- ai-worker per-job state: resumable checkpoint (e.g. ASR vendor job ids) and the llm_unavailable backoff step.
CREATE TABLE ai_job_state (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  checkpoint jsonb,
  llm_waits integer NOT NULL DEFAULT 0,
  waiting_role text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
