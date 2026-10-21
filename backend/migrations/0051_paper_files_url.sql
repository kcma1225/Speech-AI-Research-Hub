-- PDFs downloaded from a URL the user pasted (POST /library/papers/:id/pdf-from-url, /library/pdf-from-url).
ALTER TABLE paper_files DROP CONSTRAINT IF EXISTS paper_files_source_check;
ALTER TABLE paper_files ADD CONSTRAINT paper_files_source_check CHECK (source IN ('upload','open_access','import','url'));
-- PDF imports created from a URL keep where the file came from until confirm stores it on the paper.
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS source_url text;
