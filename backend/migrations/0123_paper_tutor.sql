-- 「先確認先備知識」 paper tutoring (docs/architecture.md "Agent" → Prerequisite check).
-- Per conversation opt-in: when on, the assistant extracts the concepts a paper builds on, asks the user which they know
-- (an `ask_user` card with a `concept_check` question) and teaches the gaps in a code-decided order.
ALTER TABLE conversations ADD COLUMN prereq_check boolean NOT NULL DEFAULT false;

-- Tutoring state of one paper in one conversation: the extracted concepts (prerequisites in topological order, paper-
-- defined terms and symbols), what the user answered on the card, what was taught / verified. Written only by the
-- tutoring tools and the card answer (src/agent/tutor.ts).
CREATE TABLE paper_concept_sessions (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  -- SessionConcept[] (tutor.ts); prerequisites first, in teaching order.
  concepts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(concepts) = 'array'),
  -- The concept_check card was answered (or skipped) at least once.
  answered boolean NOT NULL DEFAULT false,
  -- No more explain-back checks: the user chose 「全部都懂，直接講」, skipped the card or skipped a check.
  checks_off boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, paper_id)
);

-- What the user knows, across papers and conversations (設定 → 記憶 → 懂的概念; private to the user).
-- source self_report = the user said so (card / teaching), checked = passed a one-sentence explain-back (never re-asked).
CREATE TABLE user_concepts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_key text NOT NULL CHECK (length(concept_key) BETWEEN 1 AND 60),
  term_zh text NOT NULL DEFAULT '' CHECK (length(term_zh) <= 80),
  term_en text NOT NULL DEFAULT '' CHECK (length(term_en) <= 120),
  level text NOT NULL CHECK (level IN ('known','heard','unknown')),
  source text NOT NULL CHECK (source IN ('self_report','checked')),
  paper_id uuid REFERENCES papers(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, concept_key)
);
