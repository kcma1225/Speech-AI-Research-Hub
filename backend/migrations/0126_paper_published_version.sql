-- Papers imported from arXiv before the published-version lookup existed keep 「arXiv」 as their venue even when the
-- paper appeared at a conference / in a journal (production 61666f10: an Interspeech 2024 paper). One metadata-only
-- ai_library_import job looks up their published versions (lib/library/published.ts; only the papers' own identifiers
-- and titles leave the hub).
INSERT INTO jobs (kind, payload, created_by, max_attempts)
SELECT 'ai_library_import',
       jsonb_build_object('batchId', NULL, 'paperIds', jsonb_agg(id ORDER BY created_at), 'userId', NULL, 'metadataOnly', true),
       NULL, 3
  FROM papers
 WHERE (venue IS NULL OR venue ~* 'arxiv|preprint|corr')
   AND (arxiv_id IS NOT NULL OR doi IS NOT NULL)
HAVING count(*) > 0;
