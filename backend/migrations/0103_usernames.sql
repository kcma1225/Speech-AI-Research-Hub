-- Accounts get two names: `username` (login id, unique case-insensitively, stored lower-case) and `real_name` (真實姓名,
-- shown everywhere a person appears). The old `name` (login id and display name at once) becomes `real_name`; `name`
-- stays as a generated read-only copy of `real_name` so every existing `u.name` read keeps showing the real name.
-- Usernames are derived from the old name (pinyin for Han characters, ASCII slug, numeric suffix on collision, user<N>
-- when nothing is left) by the data step `backfillUsernames` (src/lib/users/username.ts), which migrate() runs right
-- after this file in the same transaction and which then makes `username` NOT NULL.

DROP INDEX IF EXISTS users_name_unique;
ALTER TABLE users RENAME COLUMN name TO real_name;
ALTER TABLE users ADD COLUMN name text GENERATED ALWAYS AS (real_name) STORED;
ALTER TABLE users ADD COLUMN username text;
ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
CREATE UNIQUE INDEX users_username_unique ON users (lower(username));

-- The initial admin's old name was its login id; its display name becomes 系統管理員 and the id moves to `username`.
UPDATE users SET username = lower(real_name)
 WHERE is_owner AND lower(real_name) ~ '^[a-z0-9][a-z0-9._-]{2,31}$';
UPDATE users SET real_name = '系統管理員' WHERE is_owner AND username IS NOT NULL;
