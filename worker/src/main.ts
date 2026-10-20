import { createServer } from "node:http";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import { Runner } from "./runner.js";
import { Storage } from "./storage.js";

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker" } });
const workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

const connection: pg.ClientConfig = {
  host: config.DATABASE_HOST,
  port: config.DATABASE_PORT,
  database: config.DATABASE_NAME,
  user: config.WORKER_DB_USER,
  password: config.WORKER_DB_PASSWORD,
  application_name: "hub-worker",
  connectionTimeoutMillis: 5000,
};
const pool = new pg.Pool({ ...connection, max: config.WORKER_CONCURRENCY + 3, idleTimeoutMillis: 30_000 });
pool.on("error", error => log.warn({ err: error }, "idle database connection error"));
const runner = new Runner(pool, connection, new Storage(config), config, log, workerId);

// Health endpoint for the container healthcheck (loopback only; the worker publishes nothing).
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

// Database may still be starting; retry instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await runner.start();
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    log.warn({ err: error, attempt }, "worker start failed; retrying");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
log.info({ workerId, concurrency: config.WORKER_CONCURRENCY }, "worker started");
