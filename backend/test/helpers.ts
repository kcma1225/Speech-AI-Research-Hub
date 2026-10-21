import { randomBytes } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { bootstrapAdmin, hashPassword } from "../src/bootstrap.js";
import { loadConfig, type Config } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { JobFinalizer } from "../src/jobs/queue.js";
import { migrate } from "../src/migrate.js";
import { Storage } from "../src/lib/storage.js";
import type { Role } from "../src/lib/auth.js";

/**
 * Integration tests need a real Postgres (and RustFS for file routes):
 *   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres
 *   TEST_S3_ENDPOINT=http://127.0.0.1:59002 TEST_S3_ACCESS_KEY=... TEST_S3_SECRET_KEY=...
 * Each call creates its own database and bucket, so test files can run in parallel.
 */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);
export const hasTestS3 = Boolean(process.env.TEST_S3_ENDPOINT);

export const ORIGIN = "http://hub.test";
export const OWNER_PASSWORD = "owner-password-123";

export type TestRole = Role;

export type TestContext = {
  app: FastifyInstance;
  db: Db;
  storage: Storage;
  config: Config;
  finalizer: JobFinalizer;
  /** Creates a user with `role` (`admin` = a system-only admin account) and returns its session cookie header value. */
  login(role: TestRole, name?: string): Promise<{ id: string; cookie: string }>;
  /** Cookie for the bootstrapped initial admin (system-only: no research workspace). */
  ownerCookie(): Promise<{ id: string; cookie: string }>;
  close(): Promise<void>;
};

/** `env` adds or overrides config variables (e.g. the OIDC client). */
export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const name = `t_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(process.env.TEST_DATABASE_URL!);

  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    APP_ORIGIN: ORIGIN,
    DATABASE_HOST: url.hostname,
    DATABASE_PORT: url.port || "5432",
    DATABASE_NAME: name,
    DATABASE_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    ADMIN_PASSWORD: OWNER_PASSWORD,
    ADMIN_NAME: "Owner",
    AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:1",
    S3_BUCKET: `b-${name.replace(/_/g, "-")}`,
    S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY ?? "test",
    S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY ?? "test",
    ...env,
  });
  const db = createPool(config);
  const storage = new Storage(config.S3_BUCKET, config);
  const app = await buildApp({ config, db, storage }, { logger: { level: "warn" } });
  await migrate(db, app.log);
  await bootstrapAdmin(db, config);
  if (hasTestS3) await storage.ensureBucket();
  await app.ready();
  const finalizer = new JobFinalizer(db, app.log, 60_000);

  async function sessionFor(userId: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { userId, password: OWNER_PASSWORD } });
    const cookie = response.cookies.find(c => c.name === "hub_session");
    if (!cookie) throw new Error(`login failed for ${userId}: ${response.statusCode} ${response.body}`);
    return `hub_session=${cookie.value}`;
  }

  return {
    app, db, storage, config, finalizer,
    async login(role, userName) {
      const hash = await hashPassword(OWNER_PASSWORD);
      const id = (await db.query<{ id: string }>(
        "INSERT INTO users(name,password_hash,role,is_admin) VALUES($1,$2,$3,$4) RETURNING id",
        [userName ?? `${role}-${randomBytes(3).toString("hex")}`, hash, role, role === "admin"],
      )).rows[0]!.id;
      return { id, cookie: await sessionFor(id) };
    },
    async ownerCookie() {
      const id = (await db.query<{ id: string }>("SELECT id FROM users WHERE is_owner")).rows[0]!.id;
      return { id, cookie: await sessionFor(id) };
    },
    async close() {
      await app.close();
      await db.end();
      const cleanup = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
      if (hasTestS3) await storage.deletePrefix("").catch(() => {});
    },
  };
}
