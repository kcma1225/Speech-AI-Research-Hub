-- The Brief (docs/architecture.md "Workflows" → Brief): the one fixed statement of what a run / goal must deliver —
-- deliverable kind (hard), the user's own words (verbatim), the assistant's paraphrase (never a source of
-- requirements), the typed requirements with their quotes, what the user left unspecified, and the acceptance checklist.
-- `brief.version` only grows: 0 = the seed written at creation, ≥ 1 = built at planning; every later version comes from
-- the user (guidance, plan-card edits, a clarifying answer, an approved deliverable change). Earlier versions are kept
-- in `brief_versions` (newest last, ≤ 10).
ALTER TABLE workflow_runs ADD COLUMN brief jsonb;
ALTER TABLE workflow_runs ADD COLUMN brief_versions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workflow_goals ADD COLUMN brief jsonb;

-- Immutability: a version never changes after it was written (only its empty checklist may be filled in once), and the
-- version number never goes back. Agents have no path that bumps the version; brief.ts does it for user actions only.
CREATE FUNCTION workflow_brief_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.brief IS NULL OR NEW.brief IS NOT DISTINCT FROM OLD.brief THEN
    RETURN NEW;
  END IF;
  IF NEW.brief IS NULL OR coalesce((NEW.brief->>'version')::int, 0) < coalesce((OLD.brief->>'version')::int, 0) THEN
    RAISE EXCEPTION 'workflow brief version cannot go back' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.brief->>'version')::int = (OLD.brief->>'version')::int AND (
       NEW.brief->'deliverable' IS DISTINCT FROM OLD.brief->'deliverable'
    OR NEW.brief->'user_words' IS DISTINCT FROM OLD.brief->'user_words'
    OR NEW.brief->'paraphrase' IS DISTINCT FROM OLD.brief->'paraphrase'
    OR NEW.brief->'requirements' IS DISTINCT FROM OLD.brief->'requirements'
    OR NEW.brief->'unspecified' IS DISTINCT FROM OLD.brief->'unspecified'
    OR (jsonb_array_length(coalesce(OLD.brief->'checklist', '[]'::jsonb)) > 0 AND NEW.brief->'checklist' IS DISTINCT FROM OLD.brief->'checklist')) THEN
    RAISE EXCEPTION 'workflow brief version % is immutable', OLD.brief->>'version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_runs_brief_guard BEFORE UPDATE OF brief ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_brief_guard();
CREATE TRIGGER workflow_goals_brief_guard BEFORE UPDATE OF brief ON workflow_goals FOR EACH ROW EXECUTE FUNCTION workflow_brief_guard();
