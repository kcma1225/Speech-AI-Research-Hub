-- Draft Markdown images: uploaded on /studies/new before the study exists. study_id is NULL and the image belongs to
-- its uploader (created_by) only, stored under md-images/_drafts/<user_id>/. Creating the study claims the drafts its
-- summary references (moves the objects under md-images/<study_id>/ and sets study_id); unclaimed drafts older than a
-- day (or whose uploader was deleted) are swept on later draft uploads.
ALTER TABLE md_images ALTER COLUMN study_id DROP NOT NULL;
CREATE INDEX md_images_drafts_idx ON md_images(created_by, created_at) WHERE study_id IS NULL;
