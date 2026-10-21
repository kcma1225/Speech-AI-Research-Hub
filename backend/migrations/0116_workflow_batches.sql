-- Workflows: batches (one run per paper for 「每一篇文獻都做成簡報」), a `queued` status for runs over the per-user
-- active limit (started automatically when a slot frees), and `needs_pdf` for a paper run that could not get a PDF.
-- See docs/architecture.md "Workflows".
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check CHECK (status IN
  ('queued','planning','awaiting_plan_approval','running','verifying','awaiting_input','needs_pdf','paused','done','partial','failed','cancelled'));
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS batch_index integer;
CREATE INDEX IF NOT EXISTS workflow_runs_batch ON workflow_runs (batch_id, batch_index) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_queued ON workflow_runs (user_id, created_at) WHERE status = 'queued';
