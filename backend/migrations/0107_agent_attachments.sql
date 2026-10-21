-- Assistant attachments (docs/architecture.md "Agent → Attachments"): references a user message carries
-- (notes, papers, decks, meetings, LaTeX projects/files, uploaded files) and the files uploaded into a conversation.

-- [{kind, id, project_id?, version?, version_label?, title, study?: {id,slug,title}, url, mime?}] resolved at send time.
ALTER TABLE agent_messages ADD COLUMN attachments jsonb;

CREATE TABLE agent_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('document','image')),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  -- document: doc-import format (pdf, docx, …); image: png | jpeg | webp
  format text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  -- agent/<conversationId>/uploads/<id>.<ext> (removed with the conversation's agent/ prefix)
  object_key text NOT NULL,
  -- Extracted Markdown of a document (doc-import pipeline, ≤ 200 000 chars); NULL for images.
  text_md text,
  chars integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  pages integer,
  detected jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_uploads_conversation ON agent_uploads (conversation_id, created_at);
