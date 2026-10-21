-- CRUD gap fixes: admin-issued one-time password reset links (POST /users/:id/password-reset → /reset/<token>)
-- Only the sha256 of the token is stored; a link is single-use, expires, and a newer link revokes older unused ones.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets(user_id, created_at DESC);

-- Own slide reviews / replies can be edited (PATCH) and deleted (DELETE) by their author.
ALTER TABLE slide_reviews ADD COLUMN edited_at timestamptz;
ALTER TABLE slide_review_replies ADD COLUMN edited_at timestamptz;
