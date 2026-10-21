-- Workflows: orchestrator → sub-agent runs for task-oriented creation (decks, sections, reviews, notes).
-- See docs/architecture.md "Workflows". Runs execute in the ai-worker (job kind `ai_workflow`); every step is a
-- checkpoint, so a restarted job resumes from these rows.

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_id uuid REFERENCES studies(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  playbook text NOT NULL CHECK (playbook ~ '^[a-z][a-z0-9_]{1,47}$'),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 160),
  request text NOT NULL CHECK (length(request) BETWEEN 1 AND 4000),
  objective text NOT NULL DEFAULT '',
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan jsonb,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Playbook working state (research brief, outline, assembled draft…); never sent to the browser in full.
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planning' CHECK (status IN
    ('planning','awaiting_plan_approval','running','verifying','awaiting_input','paused','done','partial','failed','cancelled')),
  question text,
  autopilot boolean NOT NULL DEFAULT false,
  tainted boolean NOT NULL DEFAULT false,
  taint_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{"steps":0,"calls":0,"tokens_in":0,"tokens_out":0,"active_ms":0,"fix_rounds":0}'::jsonb,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  guidance jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb,
  stop_reason text,
  error jsonb,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  pause_requested boolean NOT NULL DEFAULT false,
  final_rounds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX workflow_runs_user ON workflow_runs (user_id, created_at DESC);
CREATE INDEX workflow_runs_study ON workflow_runs (study_id, created_at DESC);
CREATE INDEX workflow_runs_conversation ON workflow_runs (conversation_id);

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES workflow_steps(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9_-]{1,40}$'),
  position integer NOT NULL DEFAULT 0,
  role text NOT NULL CHECK (role IN ('planner','researcher','writer','designer','coder','verifier','integrator')),
  kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task','integrate','final')),
  title text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  depends_on text[] NOT NULL DEFAULT '{}',
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected text NOT NULL DEFAULT '',
  verify jsonb NOT NULL DEFAULT '{"checks":[],"judge":false}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','verifying','passed','failed','skipped','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  round integer NOT NULL DEFAULT 0,
  max_rounds integer,
  output jsonb,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  ms integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, key)
);
CREATE INDEX workflow_steps_run ON workflow_steps (run_id, position);

CREATE TABLE workflow_events (
  seq bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_run ON workflow_events (run_id, seq);
