-- Autopilot = 完全自動 (docs/architecture.md "Agent" → Approval policy): deletions proposed under autopilot no longer
-- block the run. The call is recorded as `deferred` (its tool result tells the model it waits for the user), stays a
-- pending card outside the step, and runs only when the user approves it later (deny → nothing happens).
ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check
  CHECK (status IN ('pending_approval','deferred','approved','denied','running','done','failed','cancelled','expired'));
-- Marks a deferred deletion for its whole life (also after the user decided), so the step never waits for it.
ALTER TABLE tool_calls ADD COLUMN deferred boolean NOT NULL DEFAULT false;
CREATE INDEX tool_calls_deferred ON tool_calls (conversation_id) WHERE status = 'deferred';
