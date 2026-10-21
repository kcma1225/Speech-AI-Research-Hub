import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db.js";
import { backfillPersonNames } from "./lib/users/person-name.js";
import { backfillUsernames } from "./lib/users/username.js";

/** Data steps that need application code; each runs right after its migration file, in the same transaction. */
const DATA_STEPS: Record<string, (client: Pick<Db, "query">) => Promise<void>> = {
  "0103_usernames.sql": backfillUsernames,
  "0112_person_names.sql": backfillPersonNames,
};

const MIGRATION_LOCK = 473921;
export const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Applies `migrations/NNNN_name.sql` files in order, each in its own transaction.
 * Applied files are recorded by name; editing an applied file has no effect, so always add a new one.
 */
export async function migrate(pool: Db, log: Pick<FastifyBaseLogger, "info">, dir = migrationsDir) {
  const files = (await readdir(dir)).filter(name => /^\d{4}_[\w-]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(row => row.name));
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(path.join(dir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await DATA_STEPS[name]?.(client);
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
        log.info({ migration: name }, "applied migration");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
