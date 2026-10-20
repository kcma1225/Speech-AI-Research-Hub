import argon2 from "argon2";
import { db } from "./db";

let initialized: Promise<void> | undefined;

export function ensureSchema() {
  initialized ??= initialize().catch(error => { initialized = undefined; throw error; });
  return initialized;
}

async function initialize() {
  const pool = await db();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner','admin','member')),
      auth_mode text NOT NULL DEFAULT 'either' CHECK (auth_mode IN ('either','two_factor')),
      theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
      disabled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users (role) WHERE role = 'owner';
    CREATE TABLE IF NOT EXISTS owner_config (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      password_hash text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      user_agent text,
      ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      created_by uuid NOT NULL REFERENCES users(id),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      used_by uuid REFERENCES users(id),
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      content text NOT NULL DEFAULT '',
      event_date date NOT NULL,
      file_name text,
      storage_name text,
      mime_type text,
      created_by uuid NOT NULL REFERENCES users(id),
      updated_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id uuid PRIMARY KEY,
      item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      file_name text NOT NULL,
      status text NOT NULL CHECK (status IN ('processing','completed','failed','cancelled')),
      stage text NOT NULL,
      progress integer NOT NULL DEFAULT 0,
      duration_seconds double precision,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS media_jobs_user_created ON media_jobs(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS slide_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
      slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      public_view boolean NOT NULL DEFAULT false,
      share_key text NOT NULL UNIQUE,
      active_version_id uuid,
      created_by uuid NOT NULL REFERENCES users(id),
      updated_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS slide_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      entry_qmd text NOT NULL,
      entry_html text NOT NULL,
      source_name text NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','published','failed')),
      error text,
      quarto_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(project_id,version), UNIQUE(project_id,id)
    );
    CREATE INDEX IF NOT EXISTS slide_versions_project ON slide_versions(project_id,version DESC);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='slide_active_version_fk') THEN
        ALTER TABLE slide_projects ADD CONSTRAINT slide_active_version_fk FOREIGN KEY(id,active_version_id) REFERENCES slide_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS slide_references (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
      title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
      url text,
      file_name text,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((url IS NOT NULL) <> (file_name IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS slide_one_default_reference ON slide_references(project_id) WHERE is_default;
    CREATE TABLE IF NOT EXISTS slide_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
      author_id uuid NOT NULL REFERENCES users(id),
      body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS slide_review_replies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id uuid NOT NULL REFERENCES slide_reviews(id) ON DELETE CASCADE,
      author_id uuid NOT NULL REFERENCES users(id),
      body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS slide_tags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS slide_tags_name_unique ON slide_tags (lower(name));
    CREATE TABLE IF NOT EXISTS slide_project_tags (
      project_id uuid NOT NULL REFERENCES slide_projects(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES slide_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS slide_project_tags_tag ON slide_project_tags(tag_id);
    CREATE TABLE IF NOT EXISTS passkeys (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key bytea NOT NULL,
      counter bigint NOT NULL DEFAULT 0,
      transports text[],
      device_name text NOT NULL DEFAULT 'Passkey',
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    );
    ALTER TABLE items ADD COLUMN IF NOT EXISTS transcript jsonb;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS transcript_name text;
    CREATE TABLE IF NOT EXISTS tags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tags_name_unique ON tags (lower(name));
    CREATE TABLE IF NOT EXISTS item_tags (
      item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag_id);
    DROP TABLE IF EXISTS chat_messages;
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('media','system')),
      title text NOT NULL,
      body text NOT NULL DEFAULT '',
      url text NOT NULL DEFAULT '/',
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    DELETE FROM notifications WHERE kind='chat';
    ALTER TABLE notifications ALTER COLUMN url SET DEFAULT '/';
    UPDATE notifications SET url='/' WHERE url='/notifications';
    CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','admin','member','professor'));
    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
    ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IN ('admin','member','professor'));
    ALTER TABLE invitations ALTER COLUMN expires_at DROP NOT NULL;
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS max_uses integer DEFAULT 1 CHECK (max_uses IS NULL OR max_uses > 0);
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
    UPDATE invitations SET use_count=1 WHERE used_at IS NOT NULL AND max_uses=1 AND use_count=0;
    CREATE TABLE IF NOT EXISTS invitation_uses (
      invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (invitation_id, user_id)
    );
    DELETE FROM notifications WHERE kind NOT IN ('media','system');
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('media','system'));
    CREATE TABLE IF NOT EXISTS audit_log (
      id bigserial PRIMARY KEY,
      actor_id uuid REFERENCES users(id),
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const password = process.env.OWNER_PASSWORD;
  if (!password) throw new Error("OWNER_PASSWORD must not be empty");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(473921)");
    const owner = await client.query<{id:string;password_hash:string}>("SELECT id,password_hash FROM users WHERE role = 'owner' LIMIT 1 FOR UPDATE");
    const config = await client.query<{password_hash:string}>("SELECT password_hash FROM owner_config WHERE singleton=true FOR UPDATE");
    if (!owner.rowCount) {
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      await client.query("INSERT INTO users (name, password_hash, role) VALUES ($1,$2,'owner')", [process.env.OWNER_NAME ?? "Owner", hash]);
    } else if (config.rowCount && !await argon2.verify(config.rows[0].password_hash,password)) {
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash,owner.rows[0].id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [owner.rows[0].id]);
      await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,'owner_password_rebound','user',$1)", [owner.rows[0].id]);
    } else if (!config.rowCount && !await argon2.verify(owner.rows[0].password_hash,password)) {
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash,owner.rows[0].id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [owner.rows[0].id]);
    }
    if (!config.rowCount || !await argon2.verify(config.rows[0].password_hash,password)) {
      await client.query("INSERT INTO owner_config(singleton,password_hash) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash",[await argon2.hash(password,{type:argon2.argon2id})]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
