import pg from "pg";
import type { Config } from "./config.js";

export type Db = pg.Pool;
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/**
 * Postgres text and jsonb cannot hold U+0000 (raw, or `\u0000` inside JSON): one such character in a parameter fails
 * the whole statement (production 研究內容講解: PDF text with NUL bytes made every `read_paper` result unstorable, the
 * assistant read it as a broken PDF and fetched it again). Every string parameter — and every object pg would send as
 * JSON — is cleaned here, so no extracted text (PDF, upload, web page, model output) can fail a write.
 */
export function pgSafe(v: unknown): unknown {
  if (typeof v === "string") return v.includes("\u0000") || v.includes("\\u0000") ? v.replace(/\u0000/g, "").replace(/(?<!\\)\\u0000/g, "") : v;
  if (v === null || v === undefined || typeof v !== "object" || v instanceof Date || Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return v;
  if (typeof (v as { toPostgres?: unknown }).toPostgres === "function") return v;
  if (Array.isArray(v)) return v.map(pgSafe);
  return pgSafe(JSON.stringify(v));
}

/** A pg client whose query parameters go through `pgSafe`. */
class SafeClient extends pg.Client {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(...args: any[]): any {
    const [q, values] = args;
    if (Array.isArray(values)) args[1] = values.map(pgSafe);
    else if (q && typeof q === "object" && typeof q.submit !== "function" && Array.isArray(q.values)) args[0] = { ...q, values: q.values.map(pgSafe) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (super.query as any)(...args);
  }
}

export function createPool(config: Config): Db {
  return new pg.Pool({
    Client: SafeClient,
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USER,
    password: config.POSTGRES_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function transaction<T>(pool: Db, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
