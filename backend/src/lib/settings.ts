import type { Queryable } from "../db.js";

/**
 * `system_settings` access for modules (keys `<module>.<name>`, e.g. `library.openalex_mailto`). Values are JSON.
 * Secrets must be encrypted by the caller before `setSetting` and never returned to clients unmasked.
 */
export async function getSetting<T = unknown>(db: Queryable, key: string): Promise<T | null> {
  const row = (await db.query<{ value: T }>("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0];
  return row ? row.value : null;
}

export async function setSetting(db: Queryable, key: string, value: unknown, userId: string | null) {
  await db.query(
    `INSERT INTO system_settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,
    [key, JSON.stringify(value), userId],
  );
}

export async function deleteSetting(db: Queryable, key: string) {
  await db.query("DELETE FROM system_settings WHERE key=$1", [key]);
}
