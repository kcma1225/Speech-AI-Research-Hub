-- Agent runtime (M3): conversations, transcript, runs, tool calls with persisted approvals, grants, memories,
-- SSE replay log and personal MCP tokens. See docs/architecture.md "Agent".

-- Per-user assistant preferences (memory off and autopilot off by default).
CREATE TABLE agent_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  memory_enabled boolean NOT NULL DEFAULT false,
  autopilot_default boolean NOT NULL DEFAULT false,
  -- The one-time autopilot explainer was confirmed.
  autopilot_explained boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  title_source text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','user')),
  -- `interview`: the study-creation interview on /studies/new (not listed on /assistant).
  mode text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','interview')),
  -- Latest page context sent with a message ({path, studyId, studySlug, noteId, deckId, meetingId, page}); a hint only.
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Study of the latest page context: study-scoped memories are injected only for this study.
  study_id uuid REFERENCES studies(id) ON DELETE SET NULL,
  autopilot boolean NOT NULL DEFAULT false,
  memory_enabled boolean NOT NULL DEFAULT false,
  -- Context compaction: model-only summary of every message with seq <= summary_until.
  summary text,
  summary_until bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user ON conversations (user_id, mode, updated_at DESC);

-- Model transcript (source of truth). `content` is the unified ChatMessage content (text / tool_use / tool_result
-- blocks); `text` is what the UI shows for user and assistant messages.
CREATE TABLE agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL UNIQUE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','notice','compaction')),
  content jsonb NOT NULL DEFAULT '[]'::jsonb,
  text text NOT NULL DEFAULT '',
  reasoning text NOT NULL DEFAULT '',
  provider_state jsonb,
  page_context jsonb,
  -- complete | cancelled (stopped while streaming; text kept, marked 已中止)
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled')),
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_conv ON agent_messages (conversation_id, seq);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','awaiting_approval','awaiting_llm','done','cancelled','failed')),
  step integer NOT NULL DEFAULT 0,
  max_steps integer NOT NULL DEFAULT 25,
  -- Autopilot at start (informational; the policy reads conversations.autopilot at each decision).
  autopilot boolean NOT NULL DEFAULT false,
  tainted boolean NOT NULL DEFAULT false,
  taint_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  autopilot_writes integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  -- Wall clock spent executing (excludes time waiting for approval or for the LLM).
  active_ms integer NOT NULL DEFAULT 0,
  -- Why a run ended early: limit_steps | limit_time | limit_tokens | repeat | cancelled.
  stop_reason text,
  error jsonb,
  llm_waits integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX agent_runs_conv ON agent_runs (conversation_id, started_at DESC);
CREATE INDEX agent_runs_active ON agent_runs (status) WHERE status IN ('running','awaiting_llm');

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The assistant message that requested the call.
  message_id uuid NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  step integer NOT NULL,
  position integer NOT NULL,
  provider_call_id text NOT NULL,
  tool text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  edited_args jsonb,
  risk text NOT NULL CHECK (risk IN ('read','write','destructive')),
  status text NOT NULL CHECK (status IN ('pending_approval','approved','denied','running','done','failed','cancelled','expired')),
  approved_via text CHECK (approved_via IN ('user','conversation_grant','autopilot')),
  -- Why approval was needed: write | destructive | memory | tainted | outbound | autopilot_limit.
  approval_reason text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  deny_reason text,
  summary text NOT NULL DEFAULT '',
  -- {studyId, studySlug, label, url} of the object the call touches (authz, grant scope, card chip).
  target jsonb,
  -- Structured result for the UI (links, created ids, suggestion) and the text the model saw.
  result jsonb,
  result_text text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (message_id, position)
);
CREATE INDEX tool_calls_conv ON tool_calls (conversation_id, created_at);
CREATE INDEX tool_calls_pending ON tool_calls (conversation_id) WHERE status = 'pending_approval';

-- 「本對話都允許」: per tool and target study ('*' when the tool has no study).
CREATE TABLE conversation_grants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool text NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tool, scope)
);

-- Short atomic memories; only used when the user enabled memory. Never visible to other users.
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global','study')),
  study_id uuid REFERENCES studies(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 300),
  source text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','user')),
  -- Kept when the conversation is deleted (the UI then shows 「對話已刪除」).
  source_conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'study') = (study_id IS NOT NULL))
);
CREATE INDEX memories_user ON memories (user_id, updated_at DESC);

CREATE TABLE memory_uses (
  message_id uuid NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, memory_id)
);

-- SSE replay log (event id = seq). Pruned a day after the run ended.
CREATE TABLE agent_events (
  seq bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_conv ON agent_events (conversation_id, seq);

-- Personal access tokens for the MCP endpoint (`Authorization: Bearer hubmcp_…`), stored as sha256.
CREATE TABLE mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  -- First characters of the token, shown in the list.
  prefix text NOT NULL,
  -- read: read tools only; suggest: read tools + suggestion-producing writes.
  scopes text[] NOT NULL DEFAULT ARRAY['read']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX mcp_tokens_user ON mcp_tokens (user_id, created_at DESC);
