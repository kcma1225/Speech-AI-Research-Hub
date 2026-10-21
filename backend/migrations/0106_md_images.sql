-- Images inserted into Markdown documents (notes, study summary) by upload / paste / drop. Stored in S3 under
-- md-images/<study_id>/<id>.<ext>, served by GET /api/md-images/:id. note_id is informational (the note that was
-- being edited); deleting the study deletes the rows (cascade) and the cleanup hook removes the objects.
CREATE TABLE md_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  object_key text NOT NULL UNIQUE,
  mime text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL,
  original_name text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX md_images_study_idx ON md_images(study_id);
