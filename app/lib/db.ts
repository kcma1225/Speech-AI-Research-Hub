import { Pool, type PoolClient } from "pg";

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

let pool: Pool | undefined;

export function db() {
  pool ??= new Pool({
    host: process.env.DATABASE_HOST ?? "db",
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME ?? "research_hub",
    user: process.env.DATABASE_USER ?? "research_hub",
    password: process.env.POSTGRES_PASSWORD,
    max: 10,
  });
  return Promise.resolve(pool);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
