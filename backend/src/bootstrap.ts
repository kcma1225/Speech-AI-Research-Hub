import argon2 from "argon2";
import type { Config } from "./config.js";
import { transaction, type Db } from "./db.js";
import { USERNAME_RE, uniqueUsername, usernameSlug } from "./lib/users/username.js";

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);

/**
 * Creates the initial admin (初始管理員; `role='admin'`, `is_owner`) on first boot from ADMIN_NAME / ADMIN_PASSWORD
 * (legacy OWNER_* accepted, see config.ts). When ADMIN_PASSWORD changes between boots, resets that account's password and
 * revokes its sessions; a password changed in Settings survives restarts as long as the env value stays the same.
 * ADMIN_NAME becomes the username (slugged if needed); the names are 系統 / 管理員 (系統管理員) and English "Admin". Both are only used on creation
 * (the real name can be changed later in Settings, the username in user management).
 */
export async function bootstrapAdmin(pool: Db, config: Config) {
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(473922)");
    const initial = (await client.query<{ id: string }>("SELECT id FROM users WHERE is_owner FOR UPDATE")).rows[0];
    const applied = (await client.query<{ password_hash: string }>("SELECT password_hash FROM owner_config WHERE singleton FOR UPDATE")).rows[0];
    const envChanged = !applied || !(await verifyPassword(applied.password_hash, config.ADMIN_PASSWORD));
    if (!initial) {
      const wanted = config.ADMIN_NAME.toLowerCase();
      const taken = new Set((await client.query<{ u: string }>("SELECT lower(username) AS u FROM users")).rows.map(r => r.u));
      const username = USERNAME_RE.test(wanted) && !taken.has(wanted) ? wanted : uniqueUsername(usernameSlug(config.ADMIN_NAME) || "admin", taken, 1);
      await client.query(
        `INSERT INTO users(username,real_name,zh_family,zh_given,en_family,names_confirmed_at,password_hash,role,is_admin,is_owner)
         VALUES($1,'系統管理員','系統','管理員','Admin',now(),$2,'admin',true,true)`,
        [username, await hashPassword(config.ADMIN_PASSWORD)],
      );
    } else if (envChanged) {
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hashPassword(config.ADMIN_PASSWORD), initial.id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [initial.id]);
      await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,'admin_password_rebound','user',$2)", [initial.id, initial.id]);
    }
    if (envChanged) {
      await client.query(
        "INSERT INTO owner_config(singleton,password_hash) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash",
        [await hashPassword(config.ADMIN_PASSWORD)],
      );
    }
  });
}
