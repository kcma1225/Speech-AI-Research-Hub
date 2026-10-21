-- 研究成熟度: how far the student's thinking is when the study is created (set by the AI interview, editable on the
-- overview). Later AI features (progress summaries, slide drafts) read it so an exploratory study is not treated as a
-- finished plan. NULL = not set.
ALTER TABLE studies ADD COLUMN maturity text
  CHECK (maturity IN ('exploring','problem_defined','method_first','continuation','assigned','well_defined'));
