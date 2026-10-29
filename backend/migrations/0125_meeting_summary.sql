-- Imported meeting summaries (docs/architecture.md "Meetings" → Imported summary): a Markdown summary written on another
-- platform, pasted or read from a .md file. The analysis uses it as the main source and every action item in it becomes
-- a proposed task in the per-study drafts.
ALTER TABLE meetings
  ADD COLUMN summary_md text NOT NULL DEFAULT '' CHECK (length(summary_md) <= 100000),
  ADD COLUMN summary_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN summary_at timestamptz;
