import { createServer } from "node:http";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import { Runner } from "./runner.js";
import { checkSandbox } from "./self-check.js";
import { Storage } from "./storage.js";

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: "latex-runner" } });
const workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

// Refuse to start without isolation instead of silently compiling unsandboxed.
const sandbox = await checkSandbox(config);
if (!sandbox.ok) {
  log.fatal({ detail: sandbox.detail }, "bubblewrap sandbox unavailable; run with security_opt seccomp=latex-runner/seccomp.json (or LATEX_SANDBOX=none for local development only)");
  process.exit(1);
}
if (config.LATEX_SANDBOX === "none") log.warn("LATEX_SANDBOX=none: compiles are NOT isolated (development only)");

const connection: pg.ClientConfig = {
  host: config.DATABASE_HOST,
  port: config.DATABASE_PORT,
  database: config.DATABASE_NAME,
  user: config.WORKER_DB_USER,
  password: config.WORKER_DB_PASSWORD,
  application_name: "hub-latex-runner",
  connectionTimeoutMillis: 5000,
};
const pool = new pg.Pool({ ...connection, max: config.LATEX_CONCURRENCY + 3, idleTimeoutMillis: 30_000 });
pool.on("error", error => log.warn({ err: error }, "idle database connection error"));
const runner = new Runner(pool, connection, new Storage(config), config, log, workerId);

const health = createServer((request, response) => {
  const ok = request.url === "/health" && runner.healthy();
  response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
});
health.listen(config.HEALTH_PORT, "127.0.0.1");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  try {
    await runner.stop();
    health.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

for (let attempt = 1; ; attempt++) {
  try {
    await runner.start();
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    log.warn({ err: error, attempt }, "runner start failed; retrying");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
log.info({ workerId, concurrency: config.LATEX_CONCURRENCY, sandbox: config.LATEX_SANDBOX }, "latex-runner started");
