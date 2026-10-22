-- Workflow goals: one user objective with a fixed final deliverable (a LaTeX paper, a deck, a note…) planned as a
-- roadmap of stages, each stage = one workflow run of a playbook. See docs/architecture.md "Workflows" → Goals.
CREATE TABLE workflow_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_id uuid REFERENCES studies(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 160),
  request text NOT NULL CHECK (length(request) BETWEEN 1 AND 4000),
  objective text NOT NULL DEFAULT '',
  -- {kind, label, direct, note?, language?, template?}
  deliverable jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planning' CHECK (status IN
    ('planning','awaiting_approval','running','awaiting_input','done','partial','failed','cancelled')),
  -- [{id, playbook, title, why, request, inputs, uses[], status, run_id?, artifacts[], summary?, issues[], added_by}]
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  current integer NOT NULL DEFAULT 0,
  autopilot boolean NOT NULL DEFAULT false,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness jsonb,
  -- {template?: id, replans: n, rounds: {<playbook>: n}}
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{at, kind, text}] newest last (≤ 60 kept)
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  question text,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX workflow_goals_user ON workflow_goals (user_id, created_at DESC);
CREATE INDEX workflow_goals_conversation ON workflow_goals (conversation_id);

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES workflow_goals(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS goal_stage text;
CREATE INDEX IF NOT EXISTS workflow_runs_goal ON workflow_runs (goal_id) WHERE goal_id IS NOT NULL;
