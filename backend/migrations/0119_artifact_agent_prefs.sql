-- Standing preferences of an artifact for the Agent (docs/architecture.md "Workflows" → Requirements): the confirmed
-- requirements that are properties of the artifact (language, audience, tone), written by the workflow that edited it
-- and inherited by later edits unless a new request overrides them. {requirements: [{type, text, params?}], run_id, updated_at}
ALTER TABLE decks ADD COLUMN agent_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notes ADD COLUMN agent_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE latex_projects ADD COLUMN agent_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
