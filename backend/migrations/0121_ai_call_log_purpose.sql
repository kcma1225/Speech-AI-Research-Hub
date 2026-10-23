-- What a model call was for (docs/architecture.md "Workflows" → Observability): `purpose` (write_slides, verify,
-- verify_final, visual_qa, research…; set by every workflow call, null for chat/embedding/ASR calls that do not pass one),
-- the workflow run, the step key and the step's fix round. Lets call cost be split by phase (draft / verify / fix /
-- vision) and by step without guessing from the role.
ALTER TABLE ai_call_log ADD COLUMN purpose text;
ALTER TABLE ai_call_log ADD COLUMN workflow_id uuid;
ALTER TABLE ai_call_log ADD COLUMN step_key text;
ALTER TABLE ai_call_log ADD COLUMN round integer;
CREATE INDEX ai_call_log_workflow ON ai_call_log(workflow_id, started_at) WHERE workflow_id IS NOT NULL;
