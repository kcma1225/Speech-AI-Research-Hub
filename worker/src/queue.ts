import pg from "pg";
import { STAGES, type ClaimedJob } from "./types.js";
import { backoffSeconds, tail } from "./errors.js";

/**
 * SQL for the job lifecycle in docs/architecture.md "Jobs". The worker role may only SELECT and
 * UPDATE `jobs`; every update is guarded by `locked_by` so a worker that lost its lease (reaped
 * after missing heartbeats) can never overwrite a newer attempt.
 */
export class Queue {
  constructor(private readonly pool: pg.Pool, readonly workerId: string) {}

  /**
   * Claims the oldest queued job whose kind is in `kinds` (other services own the other kinds). Quick previews
   * (`slide_preview`) are low priority: claimed only when no other claimable job is waiting.
   */
  async claim(kinds: readonly string[]): Promise<ClaimedJob | null> {
    const result = await this.pool.query<ClaimedJob>(
      `UPDATE jobs SET status='running', attempts=attempts+1, locked_by=$1, heartbeat_at=now(),
              started_at=coalesce(started_at, now()), stage='starting', error=NULL
        WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=now() AND kind = ANY($2::text[])
                     ORDER BY (kind = 'slide_preview'), created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, kind, payload, attempts, max_attempts`,
      [this.workerId, kinds],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Persists stage/progress and refreshes the lease. Returns `null` when the lease is lost,
   * otherwise whether cancellation was requested.
   */
  async heartbeat(jobId: string, stage: string, progress: number): Promise<{ cancelRequested: boolean } | null> {
    const result = await this.pool.query<{ cancel_requested: boolean }>(
      `UPDATE jobs SET heartbeat_at=now(), stage=$2, progress=GREATEST(progress, $3)
        WHERE id=$1 AND locked_by=$4 AND status='running' RETURNING cancel_requested`,
      [jobId, stage, Math.max(0, Math.min(100, Math.round(progress))), this.workerId],
    );
    const row = result.rows[0];
    return row ? { cancelRequested: row.cancel_requested } : null;
  }

  async succeed(jobId: string, result: object) {
    await this.finish(
      `UPDATE jobs SET status='succeeded', result=$3, stage=$4, progress=100, finished_at=now(), heartbeat_at=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [jobId, this.workerId, JSON.stringify(result), STAGES.done],
      jobId,
    );
  }

  async fail(jobId: string, message: string) {
    await this.finish(
      `UPDATE jobs SET status='failed', error=$3, stage=$4, finished_at=now(), heartbeat_at=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [jobId, this.workerId, tail(message), STAGES.failed],
      jobId,
    );
  }

  async cancelled(jobId: string) {
    await this.finish(
      `UPDATE jobs SET status='cancelled', stage=$3, finished_at=now(), heartbeat_at=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [jobId, this.workerId, STAGES.cancelled],
      jobId,
    );
  }

  /** Retryable failure: requeue with backoff, or fail for good once attempts are exhausted. */
  async retryOrFail(job: ClaimedJob, message: string): Promise<"requeued" | "failed"> {
    if (job.attempts >= job.max_attempts) {
      await this.fail(job.id, message);
      return "failed";
    }
    await this.pool.query(
      `UPDATE jobs SET status='queued', error=$3, stage=$4, locked_by=NULL, heartbeat_at=NULL,
              run_after=now() + make_interval(secs => $5)
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [job.id, this.workerId, tail(message), STAGES.queued, backoffSeconds(job.attempts)],
    );
    await this.pool.query("SELECT pg_notify('jobs_new', $1)", [job.kind]);
    return "requeued";
  }

  /** Shutdown: hand the job back without consuming an attempt. */
  async release(job: ClaimedJob) {
    await this.pool.query(
      `UPDATE jobs SET status='queued', attempts=GREATEST(attempts-1, 0), stage=$3, progress=0,
              locked_by=NULL, heartbeat_at=NULL, run_after=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [job.id, this.workerId, STAGES.queued],
    );
    await this.pool.query("SELECT pg_notify('jobs_new', $1)", [job.kind]);
  }

  /**
   * Recovers jobs whose worker stopped heartbeating (crash, OOM kill, network partition):
   * cancel if requested, requeue while attempts remain, otherwise fail.
   */
  async reap(staleSeconds = 60): Promise<{ id: string; status: string }[]> {
    const result = await this.pool.query<{ id: string; status: string; kind: string }>(
      `UPDATE jobs SET
          status = CASE WHEN cancel_requested THEN 'cancelled' WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          stage = CASE WHEN cancel_requested THEN $2 WHEN attempts < max_attempts THEN $3 ELSE $4 END,
          error = CASE WHEN NOT cancel_requested AND attempts >= max_attempts THEN '處理程序中斷，已達重試上限。' ELSE error END,
          finished_at = CASE WHEN cancel_requested OR attempts >= max_attempts THEN now() ELSE NULL END,
          run_after = now(), locked_by = NULL, heartbeat_at = NULL
        WHERE status='running' AND heartbeat_at < now() - make_interval(secs => $1)
        RETURNING id, status, kind`,
      [staleSeconds, STAGES.cancelled, STAGES.queued, STAGES.failed],
    );
    for (const row of result.rows) {
      if (row.status === "queued") await this.pool.query("SELECT pg_notify('jobs_new', $1)", [row.kind]);
      else await this.pool.query("SELECT pg_notify('jobs_finished', $1)", [row.id]);
    }
    return result.rows.map(({ id, status }) => ({ id, status }));
  }

  private async finish(sql: string, params: unknown[], jobId: string) {
    const result = await this.pool.query(sql, params);
    if (result.rowCount) await this.pool.query("SELECT pg_notify('jobs_finished', $1)", [jobId]);
  }
}
