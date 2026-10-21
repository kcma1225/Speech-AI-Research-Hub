import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { JobFinalizer } from "./jobs/queue.js";
import { migrate } from "./migrate.js";
import { Storage } from "./lib/storage.js";

const config = loadConfig();
const db = createPool(config);
const storage = new Storage(config.S3_BUCKET, config);
const app = await buildApp({ config, db, storage });

await migrate(db, app.log);
await bootstrapAdmin(db, config);
await storage.ensureBucket();

const finalizer = new JobFinalizer(db, app.log);
await finalizer.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  try {
    await app.close();
    await finalizer.stop();
    await db.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.PORT });
