/**
 * ai-worker entrypoint (same image as the backend, command `node dist/ai-worker/main.js`). Claims `ai_*` jobs,
 * runs the AI platform runtime (status notifications; probes when it holds the probe lock) and has internet
 * egress plus ffmpeg for ASR chunking. Env: the backend's env plus AI_WORKER_CONCURRENCY (default 2).
 */
import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { Storage } from "../lib/storage.js";
import { initAiPlatform } from "../ai/platform/index.js";
import { AiJobRunner } from "./runner.js";
import { aiJobKinds } from "./registry.js";
import { createLogger } from "./log.js";
import "./handlers.js";

const log = createLogger(undefined, { service: "ai-worker" });
const config = loadConfig();
const db = createPool(config);
const storage = new Storage(config.S3_BUCKET, config);
const platform = initAiPlatform(db, log as unknown as FastifyBaseLogger);
await platform.start();

const runner = new AiJobRunner(db, storage, platform, log, { concurrency: Number(process.env.AI_WORKER_CONCURRENCY ?? 2) || 2 });
await runner.start();
log.info({ kinds: aiJobKinds(), workerId: runner.workerId }, "ai-worker started");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "ai-worker shutting down");
  const force = setTimeout(() => process.exit(1), 40_000);
  force.unref();
  try {
    await runner.stop();
    await platform.stop();
    await db.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
