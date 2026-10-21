/**
 * Per-user slots for working runs (docs/architecture.md "Workflows" → Queue). At most `MAX_ACTIVE_PER_USER` runs of one
 * user are `planning` / `running` / `verifying` at a time; a run created over the limit (or behind runs already
 * waiting) gets status `queued` (「排隊中」) with a parked `ai_workflow` job (`run_after = infinity`, shown in the jobs
 * tray), and `promoteQueued` starts the oldest queued runs as slots free — called by the ai-worker when a workflow job
 * stops (the run waits for the user or ended), on cancel and by the backend sweep. Slot checks take a per-user advisory
 * lock, so concurrent creates / promotions never exceed the limit.
 */
import { transaction, type Db, type Queryable } from "../db.js";
import { enqueueWorkflow } from "./jobs.js";
import { emitRun, insertWorkflowEvent } from "./store.js";

export const MAX_ACTIVE_PER_USER = 3;
export const WORKING_SQL = "('planning','running','verifying')";

/** Serialises slot decisions of one user (inside the caller's transaction). */
export async function lockUserSlots(client: Queryable, userId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('workflow_slots:' || $1::text))", [userId]);
}

export async function slotUsage(client: Queryable, userId: string) {
  const r = (await client.query<{ working: number; queued: number }>(
    `SELECT count(*) FILTER (WHERE status IN ${WORKING_SQL})::int AS working, count(*) FILTER (WHERE status='queued')::int AS queued
       FROM workflow_runs WHERE user_id=$1`,
    [userId],
  )).rows[0]!;
  return r;
}

/** Starts the owner's oldest queued runs while slots are free. Returns the promoted run ids. */
export async function promoteQueued(db: Db, userId: string): Promise<string[]> {
  const promoted = await transaction(db, async (client) => {
    await lockUserSlots(client, userId);
    const { working, queued } = await slotUsage(client, userId);
    const free = MAX_ACTIVE_PER_USER - working;
    if (free <= 0 || !queued) return [];
    const rows = (await client.query<{ id: string; title: string }>(
      "SELECT id, title FROM workflow_runs WHERE user_id=$1 AND status='queued' ORDER BY created_at, batch_index NULLS FIRST LIMIT $2 FOR UPDATE",
      [userId, free],
    )).rows;
    for (const r of rows) {
      await client.query("UPDATE workflow_runs SET status='planning', updated_at=now() WHERE id=$1", [r.id]);
      await enqueueWorkflow(client, r.id, userId, r.title);
    }
    return rows.map((r) => r.id);
  });
  for (const id of promoted) {
    await insertWorkflowEvent(db, id, "log", { level: "info", text: "輪到這個工作流程了，開始規劃。" });
    await emitRun(db, id);
  }
  return promoted;
}

/** Sweep: every user with queued runs (a promotion missed by a crash). */
export async function promoteAllQueued(db: Db) {
  const users = (await db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM workflow_runs WHERE status='queued' LIMIT 50")).rows;
  let n = 0;
  for (const u of users) n += (await promoteQueued(db, u.user_id).catch(() => [])).length;
  return n;
}
