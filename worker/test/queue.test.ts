import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";

/**
 * Runs against a real database with the v2 schema applied and the hub_worker role:
 *   TEST_ADMIN_DB_URL=postgres://postgres:pw@127.0.0.1:55434/research_hub
 *   TEST_WORKER_DB_URL=postgres://hub_worker:workerpw@127.0.0.1:55434/research_hub
 * Uses the jobs table destructively; never point it at a real database.
 */
const enabled = Boolean(process.env.TEST_ADMIN_DB_URL && process.env.TEST_WORKER_DB_URL);

describe.skipIf(!enabled)("Queue (postgres)", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  beforeAll(() => {
    admin = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DB_URL });
    worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DB_URL });
  });
  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });
  beforeEach(async () => {
    await admin.query("DELETE FROM jobs");
  });

  const insert = async (extra = "") =>
    (await admin.query<{ id: string }>(`INSERT INTO jobs(kind,payload${extra ? "," + extra.split("=")[0] : ""}) VALUES('media_transcode','{}'${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`)).rows[0]!.id;
  const row = async (id: string) => (await admin.query("SELECT * FROM jobs WHERE id=$1", [id])).rows[0];

  it("claims oldest queued job once, skipping locked and future jobs", async () => {
    const first = await insert();
    await insert("run_after=now() + interval '1 hour'");
    const a = new Queue(worker, "a");
    const b = new Queue(worker, "b");
    const [x, y] = await Promise.all([a.claim(), b.claim()]);
    const claimed = [x, y].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(first);
    expect(claimed[0]!.attempts).toBe(1);
    expect((await row(first)).status).toBe("running");
  });

  it("heartbeat reports cancel and lost lease; only the lock holder can finish", async () => {
    const id = await insert();
    const q = new Queue(worker, "a");
    await q.claim();
    expect(await q.heartbeat(id, "音訊轉碼", 40)).toEqual({ cancelRequested: false });
    await admin.query("UPDATE jobs SET cancel_requested=true WHERE id=$1", [id]);
    expect(await q.heartbeat(id, "音訊轉碼", 30)).toEqual({ cancelRequested: true });
    expect((await row(id)).progress).toBe(40); // never goes backwards
    expect(await new Queue(worker, "other").heartbeat(id, "x", 1)).toBeNull();
    await new Queue(worker, "other").succeed(id, {});
    expect((await row(id)).status).toBe("running");
    await q.cancelled(id);
    expect((await row(id)).status).toBe("cancelled");
  });

  it("succeed stores result and notifies jobs_finished", async () => {
    const id = await insert();
    const listener = new pg.Client({ connectionString: process.env.TEST_ADMIN_DB_URL });
    await listener.connect();
    await listener.query("LISTEN jobs_finished");
    const notified = new Promise<string>(resolve => listener.on("notification", message => resolve(message.payload ?? "")));
    const q = new Queue(worker, "a");
    await q.claim();
    await q.succeed(id, { ok: 1 });
    expect(await notified).toBe(id);
    await listener.end();
    const done = await row(id);
    expect(done).toMatchObject({ status: "succeeded", result: { ok: 1 }, progress: 100 });
    expect(done.finished_at).not.toBeNull();
  });

  it("retryOrFail requeues with backoff, then fails when attempts are exhausted", async () => {
    const id = await insert("max_attempts=2");
    const q = new Queue(worker, "a");
    const job = (await q.claim())!;
    expect(await q.retryOrFail(job, "s3 down")).toBe("requeued");
    let current = await row(id);
    expect(current.status).toBe("queued");
    expect(current.locked_by).toBeNull();
    expect(new Date(current.run_after).getTime()).toBeGreaterThan(Date.now() + 10_000);
    await admin.query("UPDATE jobs SET run_after=now() WHERE id=$1", [id]);
    const again = (await q.claim())!;
    expect(again.attempts).toBe(2);
    expect(await q.retryOrFail(again, "s3 down")).toBe("failed");
    current = await row(id);
    expect(current.status).toBe("failed");
    expect(current.error).toContain("s3 down");
  });

  it("release hands a job back without consuming an attempt", async () => {
    const id = await insert();
    const q = new Queue(worker, "a");
    const job = (await q.claim())!;
    await q.release(job);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, locked_by: null });
  });

  it("reaper requeues, cancels or fails stale running jobs", async () => {
    const stale = "now() - interval '5 minutes'";
    const requeue = await insert();
    const cancel = await insert();
    const exhausted = await insert("max_attempts=1");
    const fresh = await insert();
    await admin.query(`UPDATE jobs SET status='running', attempts=1, locked_by='dead', heartbeat_at=${stale} WHERE id = ANY($1)`, [[requeue, cancel, exhausted]]);
    await admin.query("UPDATE jobs SET cancel_requested=true WHERE id=$1", [cancel]);
    await admin.query("UPDATE jobs SET status='running', attempts=1, locked_by='alive', heartbeat_at=now() WHERE id=$1", [fresh]);
    const reaped = await new Queue(worker, "a").reap(60);
    expect(Object.fromEntries(reaped.map(r => [r.id, r.status]))).toEqual({ [requeue]: "queued", [cancel]: "cancelled", [exhausted]: "failed" });
    expect((await row(fresh)).status).toBe("running");
    expect((await row(exhausted)).finished_at).not.toBeNull();
  });
});
