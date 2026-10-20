-- Slide pages (thumbnail strip, speaker view), PDF/PPTX decks, per-page reviews.
-- docs/architecture.md "Slides" / "Slide pages".

-- Source of a version: Quarto ZIP (as before), a PDF, or a PPTX converted by the worker.
ALTER TABLE slide_versions ADD COLUMN source_type text NOT NULL DEFAULT 'quarto' CHECK (source_type IN ('quarto','pdf','pptx'));

-- `review`: rendered (PPTX conversion) and waiting for the uploader to confirm before it can become active.
ALTER TABLE slide_versions DROP CONSTRAINT slide_versions_status_check;
ALTER TABLE slide_versions ADD CONSTRAINT slide_versions_status_check CHECK (status IN ('queued','rendering','review','published','failed'));

-- Page manifest written by the worker (`<output_prefix>_hub/pages.json`) and its page count; NULL for versions
-- rendered before pages existed (or when the quarto page capture failed).
ALTER TABLE slide_versions ADD COLUMN page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 1000);
ALTER TABLE slide_versions ADD COLUMN manifest_key text;

-- When the version was published (finalizer, or the publish route for `review` versions). A re-index replaces
-- the version's job, so the job's finished_at no longer tells the publish time.
ALTER TABLE slide_versions ADD COLUMN published_at timestamptz;
UPDATE slide_versions v SET published_at = COALESCE((SELECT j.finished_at FROM jobs j WHERE j.id = v.job_id), v.created_at)
 WHERE v.status = 'published';

-- Per-page reviews: `page` (1-based) refers to the pages of `version_id`. A deleted version keeps the review
-- (version_id becomes NULL, page stays as written).
ALTER TABLE slide_reviews ADD COLUMN page integer CHECK (page IS NULL OR page BETWEEN 1 AND 1000);
ALTER TABLE slide_reviews ADD COLUMN version_id uuid REFERENCES slide_versions(id) ON DELETE SET NULL;
CREATE INDEX slide_reviews_version ON slide_reviews(version_id) WHERE version_id IS NOT NULL;
