-- The composer's queued message (docs/architecture.md → Agent → Queued message): a message the user sent while the
-- assistant was still replying. At most one per conversation; sent by the server when the run ends (or held when the
-- run stopped on a card that needs the user's decision). NULL = nothing queued.
ALTER TABLE conversations ADD COLUMN queued jsonb;
CREATE INDEX conversations_queued_idx ON conversations (updated_at) WHERE queued IS NOT NULL;
