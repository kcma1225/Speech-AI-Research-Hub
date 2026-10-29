-- 「先確認先備知識」 end-of-paper quiz and tutoring history (docs/architecture.md "Agent" → Prerequisite check).
-- Quizzes live in the session (answer keys never leave the server: the card gets the items without them).
ALTER TABLE paper_concept_sessions ADD COLUMN quizzes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quizzes) = 'array');

-- Every write of a session, tagged with the newest message of the conversation at that time (NULL while the user turn
-- that caused it is being inserted). Editing a message or switching versions restores each session to its newest
-- state whose message is on the current branch, so tutoring follows the branch like the messages do.
CREATE TABLE paper_concept_history (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  message_id uuid REFERENCES agent_messages(id) ON DELETE CASCADE,
  concepts jsonb NOT NULL,
  answered boolean NOT NULL,
  checks_off boolean NOT NULL,
  quizzes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_concept_history_conv ON paper_concept_history(conversation_id, paper_id, id DESC);

-- Remembering concepts (設定 → 記憶 → 懂的概念) has its own switch, on by default; off = nothing read or written.
ALTER TABLE agent_settings ADD COLUMN concept_memory boolean NOT NULL DEFAULT true;

-- Sessions started before this migration: their current state is the first history entry, on the conversation's newest
-- message of the current branch (so an edit after the upgrade does not drop them).
INSERT INTO paper_concept_history(conversation_id,paper_id,message_id,concepts,answered,checks_off,quizzes)
SELECT s.conversation_id, s.paper_id,
       (SELECT m.id FROM agent_messages m WHERE m.conversation_id=s.conversation_id AND m.hidden_by IS NULL ORDER BY m.seq DESC LIMIT 1),
       s.concepts, s.answered, s.checks_off, s.quizzes
  FROM paper_concept_sessions s;
