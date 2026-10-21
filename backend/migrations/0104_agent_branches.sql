-- Agent: editable user messages with alternate branches (‹ 1/2 ›) and structured `ask_user` answers.
--
-- Every user message belongs to a version group: `version_of` is the group's first message (NULL on the first one).
-- `hidden_by` IS NULL means the message is on the current branch. Editing (or regenerating from) user message M hides
-- every current-branch message from M on with `hidden_by = M.id` and appends the new version; switching back to a
-- version V hides the current tail from the active version A (`hidden_by = A.id`) and un-hides `hidden_by = V.id`.
-- So the current branch is always "messages WHERE hidden_by IS NULL ORDER BY seq".
ALTER TABLE agent_messages
  ADD COLUMN version_of uuid REFERENCES agent_messages(id) ON DELETE CASCADE,
  ADD COLUMN hidden_by uuid,
  -- `ask_user` answers sent as this user turn: {toolCallId, answers:[{id, value, other?, skipped?}]}.
  ADD COLUMN answers jsonb;
CREATE INDEX agent_messages_visible ON agent_messages (conversation_id, seq) WHERE hidden_by IS NULL;
CREATE INDEX agent_messages_versions ON agent_messages (version_of) WHERE version_of IS NOT NULL;
