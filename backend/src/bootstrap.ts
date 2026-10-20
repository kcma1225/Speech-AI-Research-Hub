import argon2 from "argon2";
import type { Config } from "./config.js";
import { transaction, type Db } from "./db.js";

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);

/**
 * Creates the Owner on first boot. When OWNER_PASSWORD changes between boots, resets the
 * Owner password and revokes Owner sessions; a password changed in Profile survives restarts
 * as long as the env value stays the same.
 */
export async function bootstrapOwner(pool: Db, config: Config) {
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(473922)");
    const owner = (await client.query<{ id: string }>("SELECT id FROM users WHERE role='owner' FOR UPDATE")).rows[0];
    const applied = (await client.query<{ password_hash: string }>("SELECT password_hash FROM owner_config WHERE singleton FOR UPDATE")).rows[0];
    const envChanged = !applied || !(await verifyPassword(applied.password_hash, config.OWNER_PASSWORD));
    if (!owner) {
      await client.query("INSERT INTO users(name,password_hash,role) VALUES($1,$2,'owner')", [config.OWNER_NAME, await hashPassword(config.OWNER_PASSWORD)]);
    } else if (envChanged) {
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hashPassword(config.OWNER_PASSWORD), owner.id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [owner.id]);
      await client.query("INSERT INTO audit_log(actor_id,action,target_type,target_id) VALUES($1,'owner_password_rebound','user',$2)", [owner.id, owner.id]);
    }
    if (envChanged) {
      await client.query(
        "INSERT INTO owner_config(singleton,password_hash) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash",
        [await hashPassword(config.OWNER_PASSWORD)],
      );
    }
  });
}
