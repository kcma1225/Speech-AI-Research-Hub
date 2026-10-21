/**
 * ai-worker queue loop: same jobs-table contract as worker/ (claim with SKIP LOCKED, heartbeat, lease-guarded
 * updates, reaper), restricted to registered `ai_*` kinds, plus the `llm_unavailable` pause:
 * a job whose model role is unavailable goes back to the queue without consuming an attempt, after a backoff of
 * 2 min doubling to 30 min; its roles are paused (kinds using them are not claimed) until the backoff ends or the
 * platform reports the role healthy again. Only `llm_unavailable` auto-resumes; other errors retry/fail normally.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import type { Storage } from "../lib/storage.js";
import { AiError, isAiError } from "../ai/errors.js";
import type { AiPlatform } from "../ai/platform/platform.js";
import { isLlmUnavailable, isPlatformError } from "../ai/platform/errors.js";
import { isAiRole, type AiRole } from "../ai/platform/roles.js";
import { aiJobHandler, aiJobKinds, AiJobInputError, type AiJobHandler } from "./registry.js";

export const LLM_BACKOFF_BASE_MS = 2 * 60_000;
export const LLM_BACKOFF_MAX_MS = 30 * 60_000;
/** 2, 4, 8, 16, 30, 30 … minutes. */
export const llmBackoffMs = (waits: number) => Math.min(LLM_BACKOFF_BASE_MS * 2 ** Math.max(0, waits), LLM_BACKOFF_MAX_MS);
/** Infra retry backoff for other retryable errors: 30 s, 60 s, 120 s … capped at 15 min. */
export const retryBackoffSec = (attempts: number) => Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);

type Claimed = { id: string; kind: string; payload: unknown; attempts: number; max_attempts: number; created_by: string | null };
type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export type RunnerOptions = { concurrency?: number; pollMs?: number; heartbeatMs?: number; staleSeconds?: number; workerId?: string };

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);

export class AiJobRunner {
  readonly workerId: string;
  private running = new Map<string, { kind: string; abort: AbortController }>();
  private paused = new Map<AiRole, number>();
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private wake?: () => void;
  private loopDone?: Promise<void>;
  private unsubscribe?: () => void;
  private readonly concurrency: number;

  constructor(private readonly db: Db, private readonly storage: Storage, private readonly platform: AiPlatform, private readonly log: Log, private readonly opts: RunnerOptions = {}) {
    this.workerId = opts.workerId ?? `ai-worker-${hostname()}-${randomBytes(3).toString("hex")}`;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  // ---------------------------------------------------------------- pause bookkeeping

  pausedRoles(now = Date.now()): AiRole[] {
    for (const [r, until] of this.paused) if (until <= now) this.paused.delete(r);
    return [...this.paused.keys()];
  }

  pause(roles: AiRole[], untilMs: number) {
    for (const r of roles) this.paused.set(r, Math.max(this.paused.get(r) ?? 0, untilMs));
  }

  /** Role recovered: unpause and make its waiting jobs claimable now. */
  async resume(role: AiRole) {
    this.paused.delete(role);
    const kinds = aiJobKinds().filter((k) => aiJobHandler(k)!.roles.includes(role));
    if (kinds.length) await this.db.query("UPDATE jobs SET run_after=now() WHERE status='queued' AND stage='waiting_llm' AND kind = ANY($1)", [kinds]);
    this.log.info({ role }, "ai role recovered; resuming jobs");
    this.wake?.();
  }

  /** Kinds that may be claimed now (registered, not paused, below their own concurrency). */
  claimableKinds(): string[] {
    const paused = new Set(this.pausedRoles());
    const counts = new Map<string, number>();
    for (const r of this.running.values()) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return aiJobKinds().filter((k) => {
      const h = aiJobHandler(k)!;
      if (h.roles.some((r) => paused.has(r))) return false;
      return (counts.get(k) ?? 0) < (h.concurrency ?? this.concurrency);
    });
  }

  // ---------------------------------------------------------------- queue SQL

  async claim(): Promise<Claimed | null> {
    const kinds = this.claimableKinds();
    if (!kinds.length) return null;
    const r = await this.db.query<Claimed>(
      `UPDATE jobs SET status='running', attempts=attempts+1, locked_by=$1, heartbeat_at=now(),
              started_at=coalesce(started_at, now()), stage='starting', error=NULL
        WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=now() AND kind = ANY($2)
                     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, kind, payload, attempts, max_attempts, created_by`,
      [this.workerId, kinds],
    );
    return r.rows[0] ?? null;
  }

  private async heartbeat(jobId: string, stage?: string, progress?: number): Promise<{ cancelRequested: boolean } | null> {
    const r = await this.db.query<{ cancel_requested: boolean }>(
      `UPDATE jobs SET heartbeat_at=now(), stage=coalesce($2, stage), progress=GREATEST(progress, coalesce($3, progress))
        WHERE id=$1 AND locked_by=$4 AND status='running' RETURNING cancel_requested`,
      [jobId, stage ?? null, progress == null ? null : Math.max(0, Math.min(100, Math.round(progress))), this.workerId],
    );
    return r.rows[0] ? { cancelRequested: r.rows[0].cancel_requested } : null;
  }

  private async finish(sql: string, params: unknown[], jobId: string) {
    const r = await this.db.query(sql, params);
    if (r.rowCount) await this.db.query("SELECT pg_notify('jobs_finished', $1)", [jobId]);
  }

  private succeed = (id: string, result: object) =>
    this.finish(
      `UPDATE jobs SET status='succeeded', result=$3, stage='done', progress=100, finished_at=now(), heartbeat_at=now() WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [id, this.workerId, JSON.stringify(result)],
      id,
    );

  private failJob = (id: string, message: string) =>
    this.finish(`UPDATE jobs SET status='failed', error=$3, stage='failed', finished_at=now(), heartbeat_at=now() WHERE id=$1 AND locked_by=$2 AND status='running'`, [id, this.workerId, tail(message)], id);

  private cancelled = (id: string) =>
    this.finish(`UPDATE jobs SET status='cancelled', stage='cancelled', finished_at=now(), heartbeat_at=now() WHERE id=$1 AND locked_by=$2 AND status='running'`, [id, this.workerId], id);

  private async requeue(job: Claimed, opts: { delayMs: number; consumeAttempt: boolean; stage: string; error: string }) {
    await this.db.query(
      `UPDATE jobs SET status='queued', error=$3, stage=$4, locked_by=NULL, heartbeat_at=NULL,
              attempts = CASE WHEN $6 THEN attempts ELSE GREATEST(attempts-1, 0) END,
              run_after=now() + make_interval(secs => $5)
        WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [job.id, this.workerId, tail(opts.error), opts.stage, opts.delayMs / 1000, opts.consumeAttempt],
    );
    await this.db.query("SELECT pg_notify('jobs_new', $1)", [job.kind]);
  }

  /** Same recovery as worker/: stale running ai_* jobs are requeued, cancelled or failed. */
  async reap(staleSeconds = this.opts.staleSeconds ?? 60) {
    const r = await this.db.query<{ id: string; status: string; kind: string }>(
      `UPDATE jobs SET
          status = CASE WHEN cancel_requested THEN 'cancelled' WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          stage = CASE WHEN cancel_requested THEN 'cancelled' WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          error = CASE WHEN NOT cancel_requested AND attempts >= max_attempts THEN '處理程序中斷，已達重試上限。' ELSE error END,
          finished_at = CASE WHEN cancel_requested OR attempts >= max_attempts THEN now() ELSE NULL END,
          run_after = now(), locked_by = NULL, heartbeat_at = NULL
        WHERE status='running' AND kind LIKE 'ai\\_%' AND heartbeat_at < now() - make_interval(secs => $1)
        RETURNING id, status, kind`,
      [staleSeconds],
    );
    for (const row of r.rows) {
      if (row.status === "queued") await this.db.query("SELECT pg_notify('jobs_new', $1)", [row.kind]);
      else await this.db.query("SELECT pg_notify('jobs_finished', $1)", [row.id]);
    }
    return r.rows;
  }

  // ---------------------------------------------------------------- execution

  /** Runs one claimed job to completion (exposed for tests). */
  async execute(job: Claimed): Promise<"succeeded" | "failed" | "cancelled" | "waiting_llm" | "requeued"> {
    const handler = aiJobHandler(job.kind);
    if (!handler) {
      await this.failJob(job.id, `未知的工作類型：${job.kind}`);
      return "failed";
    }
    const abort = new AbortController();
    this.running.set(job.id, { kind: job.kind, abort });
    let cancelRequested = false;
    let leaseLost = false;
    const beat = setInterval(() => {
      void this.heartbeat(job.id)
        .then((h) => {
          if (!h) leaseLost = true;
          if (!h || h.cancelRequested) {
            cancelRequested = Boolean(h?.cancelRequested);
            abort.abort();
          }
        })
        .catch(() => undefined);
    }, this.opts.heartbeatMs ?? 10_000);
    const limit = setTimeout(() => abort.abort(), handler.timeoutMs ?? 2 * 3600_000);
    const state = (await this.db.query<{ checkpoint: unknown; llm_waits: number }>("SELECT checkpoint, llm_waits FROM ai_job_state WHERE job_id=$1", [job.id])).rows[0];
    try {
      const result = await handler.run({
        job: { id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts, maxAttempts: job.max_attempts, createdBy: job.created_by },
        db: this.db,
        storage: this.storage,
        ai: this.platform,
        log: this.log,
        signal: abort.signal,
        checkpoint: state?.checkpoint ?? null,
        progress: async (stage, percent) => {
          const h = await this.heartbeat(job.id, stage, percent);
          if (!h || h.cancelRequested) {
            cancelRequested = Boolean(h?.cancelRequested);
            leaseLost = !h;
            abort.abort();
          }
        },
        saveCheckpoint: async (value) => {
          await this.db.query(
            `INSERT INTO ai_job_state(job_id, checkpoint) VALUES($1,$2) ON CONFLICT (job_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint, updated_at=now()`,
            [job.id, JSON.stringify(value ?? null)],
          );
        },
      });
      if (cancelRequested) {
        await this.cancelled(job.id);
        return "cancelled";
      }
      if (leaseLost) return "requeued";
      await this.succeed(job.id, (result as object | undefined) ?? {});
      await this.db.query("UPDATE ai_job_state SET llm_waits=0, waiting_role=NULL WHERE job_id=$1", [job.id]);
      for (const r of handler.roles) this.paused.delete(r);
      return "succeeded";
    } catch (e) {
      if (cancelRequested) {
        await this.cancelled(job.id);
        return "cancelled";
      }
      if (leaseLost) return "requeued";
      if (this.stopping && abort.signal.aborted) {
        // Shutdown: hand back without consuming the attempt.
        await this.requeue(job, { delayMs: 0, consumeAttempt: false, stage: "queued", error: "ai-worker 重新啟動，稍後繼續。" });
        return "requeued";
      }
      return this.onError(job, handler, e, state?.llm_waits ?? 0);
    } finally {
      clearInterval(beat);
      clearTimeout(limit);
      this.running.delete(job.id);
    }
  }

  private async onError(job: Claimed, handler: AiJobHandler, e: unknown, waits: number) {
    if (isLlmUnavailable(e)) {
      const delayMs = llmBackoffMs(waits);
      const detailRole = (e as { detail?: { role?: unknown } }).detail?.role;
      const roles = isAiRole(detailRole) ? [detailRole] : handler.roles;
      this.pause(roles, Date.now() + delayMs);
      await this.db.query(
        `INSERT INTO ai_job_state(job_id, llm_waits, waiting_role) VALUES($1, 1, $2)
         ON CONFLICT (job_id) DO UPDATE SET llm_waits = ai_job_state.llm_waits + 1, waiting_role = EXCLUDED.waiting_role, updated_at=now()`,
        [job.id, roles[0] ?? null],
      );
      await this.requeue(job, { delayMs, consumeAttempt: false, stage: "waiting_llm", error: (e as { message_zh: string }).message_zh });
      this.log.warn({ jobId: job.id, kind: job.kind, roles, delayMs }, "llm unavailable; job paused");
      return "waiting_llm" as const;
    }
    const message = e instanceof AiJobInputError ? e.message : isPlatformError(e) ? e.message_zh : isAiError(e) ? `${e.message_zh}${e.hint_zh ? ` ${e.hint_zh}` : ""}` : "處理時發生錯誤，稍後會重試。";
    const retryable = e instanceof AiJobInputError ? false : isAiError(e) ? e.retryable : !isPlatformError(e);
    if (!(e instanceof AiJobInputError)) this.log.error({ err: isAiError(e) ? (e as AiError).toLog() : e, jobId: job.id, kind: job.kind }, "ai job failed");
    if (retryable && job.attempts < job.max_attempts) {
      await this.requeue(job, { delayMs: retryBackoffSec(job.attempts) * 1000, consumeAttempt: true, stage: "queued", error: message });
      return "requeued" as const;
    }
    await this.failJob(job.id, message);
    return "failed" as const;
  }

  // ---------------------------------------------------------------- loop

  async start() {
    const listener = await this.db.connect();
    listener.on("notification", () => this.wake?.());
    listener.on("error", (err) => this.log.warn({ err }, "ai-worker listener error"));
    await listener.query("LISTEN jobs_new");
    // Resume on every transition to healthy, not only for roles paused by this process: after a restart the
    // pause map is empty while jobs from before still wait (`waiting_llm`, run_after up to 30 min away).
    const healthy = new Set<string>();
    this.unsubscribe = this.platform.onStatus((s) => {
      for (const [role, st] of Object.entries(s.roles) as [AiRole, { state: string }][]) {
        const ok = st.state === "ok" || st.state === "degraded";
        if (ok && (!healthy.has(role) || this.paused.has(role))) void this.resume(role).catch((err) => this.log.warn({ err, role }, "resume failed"));
        if (ok) healthy.add(role);
        else healthy.delete(role);
      }
    });
    this.timers.push(setInterval(() => void this.reap().catch((err) => this.log.warn({ err }, "reap failed")), 30_000));
    this.timers.push(setInterval(() => this.wake?.(), this.opts.pollMs ?? 2000));
    this.loopDone = this.loop().finally(async () => {
      await listener.query("UNLISTEN *").catch(() => undefined);
      listener.release();
    });
  }

  private async loop() {
    while (!this.stopping) {
      if (this.running.size < this.concurrency) {
        let job: Claimed | null = null;
        try {
          job = await this.claim();
        } catch (err) {
          this.log.warn({ err }, "claim failed");
        }
        if (job) {
          void this.execute(job).catch((err) => this.log.error({ err, jobId: job!.id }, "ai job crashed"));
          continue;
        }
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, this.opts.pollMs ?? 2000).unref?.();
      });
    }
  }

  async stop() {
    this.stopping = true;
    this.wake?.();
    this.unsubscribe?.();
    for (const t of this.timers) clearInterval(t);
    for (const r of this.running.values()) r.abort.abort();
    const deadline = Date.now() + 25_000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await this.loopDone;
  }
}
