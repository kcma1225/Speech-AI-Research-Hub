/** Job plumbing for workflows: kind, payload, enqueue (one active job per run). */
import type { Queryable } from "../db.js";
import { enqueueJob } from "../jobs/queue.js";

export const WORKFLOW_JOB = "ai_workflow";
export type WorkflowJobPayload = { workflowId: string; /** jobs-tray label */ fileName?: string };

/**
 * Enqueues `ai_workflow` for the run unless one is already queued/running. Inside the caller's transaction. A run in
 * status `queued` (over the per-user limit, queue.ts) gets a **parked** job (`run_after = infinity`, stage `queued`):
 * it shows in the jobs tray as 「排隊中」 and starts when `promoteQueued` moves the run to `planning`.
 */
export async function enqueueWorkflow(client: Queryable, runId: string, userId: string, title: string): Promise<string> {
  const cur = (await client.query<{ job_id: string | null; status: string | null; run_status: string }>(
    "SELECT r.job_id, j.status, r.status AS run_status FROM workflow_runs r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.id=$1 FOR UPDATE OF r",
    [runId],
  )).rows[0];
  const park = cur?.run_status === "queued";
  if (cur?.job_id && park && cur.status === "queued") return cur.job_id;
  if (cur?.job_id && (cur.status === "queued" || cur.status === "running")) {
    // A running job re-reads the run between steps; make a queued one start now.
    await client.query("UPDATE jobs SET run_after=now() WHERE id=$1 AND status='queued'", [cur.job_id]);
    return cur.job_id;
  }
  const payload: WorkflowJobPayload = { workflowId: runId, fileName: `Agent：${title || "工作流程"}`.slice(0, 120) };
  const jobId = await enqueueJob(client, WORKFLOW_JOB, payload, userId, 3);
  if (park) await client.query("UPDATE jobs SET run_after='infinity', stage='queued' WHERE id=$1", [jobId]);
  await client.query("UPDATE workflow_runs SET job_id=$2, updated_at=now() WHERE id=$1", [runId, jobId]);
  return jobId;
}
