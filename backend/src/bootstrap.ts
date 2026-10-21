import argon2 from "argon2";
import type { Config } from "./config.js";
import { transaction, type Db } from "./db.js";

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);

/**
 * Creates the initial admin (初始管理員; `role='admin'`, `is_owner`) on first boot from ADMIN_NAME / ADMIN_PASSWORD
 * (legacy OWNER_* accepted, see config.ts). When ADMIN_PASSWORD changes between boots, resets that account's password and
 * revokes its sessions; a password changed in Settings survives restarts as long as the env value stays the same.
 * The name is only used on creation (renaming later happens in Settings).
 */
export async function bootstrapAdmin(pool: Db, config: Config) {
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(473922)");
    const initial = (await client.query<{ id: string }>("SELECT id FROM users WHERE is_owner FOR UPDATE")).rows[0];
    const applied = (await client.query<{ password_hash: string }>("SELECT password_hash FROM owner_config WHERE singleton FOR UPDATE")).rows[0];
    const envChanged = !applied || !(await verifyPassword(applied.password_hash, config.ADMIN_PASSWORD));
    if (!initial) {
      await client.query("INSERT INTO users(name,password_hash,role,is_admin,is_owner) VALUES($1,$2,'admin',true,true)", [config.ADMIN_NAME, await hashPassword(config.ADMIN_PASSWORD)]);
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
