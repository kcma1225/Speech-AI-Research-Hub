import type { FastifyPluginAsync } from "fastify";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

const health: FastifyPluginAsync = async app => {
  /** Liveness: the process is serving requests. */
  app.get("/health", async () => ({ ok: true }));

  /** Readiness: dependencies reachable. Used by the compose healthcheck. */
  app.get("/health/ready", async (_request, reply) => {
    const checks = await Promise.allSettled([
      app.db.query("SELECT 1"),
      app.storage.client.send(new HeadBucketCommand({ Bucket: app.storage.bucket })),
    ]);
    const [db, storage] = checks.map(check => check.status === "fulfilled");
    const ok = Boolean(db && storage);
    return reply.code(ok ? 200 : 503).header("Cache-Control", "no-store").send({ ok, db, storage });
  });

  /** Public client config for the SPA. */
  app.get("/config", async () => ({
    pushPublicKey: app.config.VAPID_PUBLIC_KEY || null,
  }));
};

export default health;
