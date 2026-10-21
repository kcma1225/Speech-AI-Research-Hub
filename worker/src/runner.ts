import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { JobAbortedError, JobInputError } from "./errors.js";
import type { Handler } from "./handlers/context.js";
import { cleanupMedia, mediaTranscode } from "./handlers/media-transcode.js";
import { cleanupSlides, slideRender } from "./handlers/slide-render.js";
import { cleanupPreview, slidePreview } from "./handlers/slide-preview.js";
import { Queue } from "./queue.js";
import type { Storage } from "./storage.js";
import type { ClaimedJob, JobKind } from "./types.js";

const HANDLERS: Record<JobKind, Handler> = { media_transcode: mediaTranscode, slide_render: slideRender, slide_preview: slidePreview };

export type RunnerTimings = { pollMs: number; heartbeatMs: number; reapMs: number; staleSeconds: number; shutdownGraceMs: number };
const DEFAULT_TIMINGS: RunnerTimings = { pollMs: 2000, heartbeatMs: 5000, reapMs: 30_000, staleSeconds: 60, shutdownGraceMs: 20_000 };

type Active = { job: ClaimedJob; controller: AbortController; done: Promise<void> };

/**
 * Claims and runs jobs with `WORKER_CONCURRENCY` slots. Woken by NOTIFY jobs_new, with polling as a
 * fallback (and for `run_after` backoff). Exposes `healthy()` for the health endpoint.
 */
export class Runner {
  private readonly queue: Queue;
  private readonly active = new Map<string, Active>();
  private listener?: pg.Client;
  private stopping = false;
  private wake?: () => void;
  private loop?: Promise<void>;
  private reaper?: NodeJS.Timeout;
  private lastTick = Date.now();
  private listening = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly listenerConfig: pg.ClientConfig,
    private readonly storage: Storage,
    private readonly config: Config,
    private readonly log: Logger,
    workerId: string,
    private readonly timings: RunnerTimings = DEFAULT_TIMINGS,
  ) {
    this.queue = new Queue(pool, workerId);
  }

  async start() {
    await mkdir(this.config.WORK_DIR, { recursive: true });
    await this.connectListener();
    this.reaper = setInterval(() => void this.reap(), this.timings.reapMs);
    void this.reap();
    this.loop = this.run();
  }

  healthy() {
    return !this.stopping && this.listening && Date.now() - this.lastTick < Math.max(30_000, this.timings.pollMs * 5);
  }

  /** Stops claiming, waits for running jobs up to the grace period, then hands the rest back. */
  async stop() {
    this.stopping = true;
    this.wake?.();
    if (this.reaper) clearInterval(this.reaper);
    const running = [...this.active.values()];
    const graceful = Promise.all(running.map(item => item.done));
    const timedOut = await Promise.race([
      graceful.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), this.timings.shutdownGraceMs).unref()),
    ]);
    if (timedOut) {
      for (const item of this.active.values()) item.controller.abort("shutdown");
      await Promise.all([...this.active.values()].map(item => item.done));
    }
    await this.loop;
    this.listening = false;
    await this.listener?.end().catch(() => {});
  }

  /** Retries until LISTEN is back (e.g. while the database restarts); polling keeps claiming jobs meanwhile. */
  private reconnectListener(delayMs = 2000) {
    setTimeout(() => {
      if (this.stopping) return;
      this.connectListener().catch(err => {
        this.log.error({ err }, "LISTEN reconnect failed; retrying");
        this.reconnectListener(Math.min(delayMs * 2, 30_000));
      });
    }, delayMs).unref();
  }

  private async connectListener() {
    const client = new pg.Client(this.listenerConfig);
    client.on("notification", () => this.wake?.());
    client.on("error", error => {
      this.listening = false;
      this.log.warn({ err: error }, "LISTEN connection lost; reconnecting");
      void client.end().catch(() => {});
      if (!this.stopping) this.reconnectListener();
    });
    await client.connect();
    await client.query("LISTEN jobs_new");
    this.listener = client;
    this.listening = true;
  }

  private async run() {
    while (!this.stopping) {
      this.lastTick = Date.now();
      let claimed = false;
      if (this.active.size < this.config.WORKER_CONCURRENCY) {
        try {
          const job = await this.queue.claim(Object.keys(HANDLERS));
          if (job) {
            claimed = true;
            this.startJob(job);
          }
        } catch (error) {
          this.log.error({ err: error }, "claim failed");
        }
      }
      // Claim again immediately while there is work and free capacity; otherwise sleep until notified.
      if (claimed && this.active.size < this.config.WORKER_CONCURRENCY) continue;
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, this.timings.pollMs);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.wake = done;
      });
      this.wake = undefined;
    }
  }

  private startJob(job: ClaimedJob) {
    const controller = new AbortController();
    const done = this.execute(job, controller).finally(() => {
      this.active.delete(job.id);
      this.wake?.();
    });
    this.active.set(job.id, { job, controller, done });
  }

  private async execute(job: ClaimedJob, controller: AbortController) {
    const log = this.log.child({ jobId: job.id, kind: job.kind, attempt: job.attempts });
    const workDir = path.join(this.config.WORK_DIR, job.id);
    let stage = "starting";
    let percent = 0;
    let beating: Promise<void> = Promise.resolve();
    const beat = () => {
      beating = beating.then(async () => {
        try {
          const state = await this.queue.heartbeat(job.id, stage, percent);
          if (!state) controller.abort("lease_lost");
          else if (state.cancelRequested) controller.abort("cancelled");
        } catch (error) {
          log.warn({ err: error }, "heartbeat failed");
        }
      });
    };
    const heartbeat = setInterval(beat, this.timings.heartbeatMs);
    const started = Date.now();
    log.info("job started");
    try {
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const handler = HANDLERS[job.kind];
      if (!handler) throw new JobInputError(`未知的工作類型：${job.kind}`);
      const result = await handler(job.payload, {
        jobId: job.id,
        config: this.config,
        storage: this.storage,
        log,
        signal: controller.signal,
        workDir,
        progress: (nextStage, nextPercent) => {
          const changed = nextStage !== stage;
          stage = nextStage;
          if (nextPercent !== undefined) percent = nextPercent;
          if (changed) beat();
        },
      });
      clearInterval(heartbeat);
      await beating;
      if (controller.signal.aborted) throw new JobAbortedError(controller.signal.reason);
      await this.queue.succeed(job.id, result);
      log.info({ ms: Date.now() - started }, "job succeeded");
    } catch (error) {
      clearInterval(heartbeat);
      await beating;
      await this.handleError(job, error, controller, log);
    } finally {
      clearInterval(heartbeat);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async handleError(job: ClaimedJob, error: unknown, controller: AbortController, log: Logger) {
    const reason = controller.signal.aborted ? (controller.signal.reason as string) : null;
    try {
      if (reason === "lease_lost") {
        log.warn("lease lost; abandoning job");
        return;
      }
      if (reason === "shutdown") {
        await this.cleanup(job);
        await this.queue.release(job);
        log.info("job handed back for shutdown");
        return;
      }
      if (reason === "cancelled") {
        await this.cleanup(job);
        await this.queue.cancelled(job.id);
        log.info("job cancelled");
        return;
      }
      await this.cleanup(job);
      if (error instanceof JobInputError) {
        await this.queue.fail(job.id, error.message);
        log.info({ error: error.message.slice(0, 500) }, "job failed (input)");
        return;
      }
      const outcome = await this.queue.retryOrFail(job, "暫時性錯誤，稍後重試：" + ((error as Error)?.message ?? String(error)));
      log.warn({ err: error, outcome }, "job failed (infrastructure)");
    } catch (recordError) {
      // The reaper will requeue the job once its heartbeat goes stale.
      log.error({ err: recordError }, "could not record job outcome");
    }
  }

  private async cleanup(job: ClaimedJob) {
    try {
      if (job.kind === "slide_render") await cleanupSlides(job.payload, prefix => this.storage.deletePrefix(prefix));
      if (job.kind === "slide_preview") await cleanupPreview(job.payload, prefix => this.storage.deletePrefix(prefix));
      if (job.kind === "media_transcode") await cleanupMedia(job.payload, key => this.storage.delete(key));
    } catch (error) {
      this.log.warn({ err: error, jobId: job.id }, "cleanup of partial output failed");
    }
  }

  private async reap() {
    try {
      const reaped = await this.queue.reap(this.timings.staleSeconds);
      if (reaped.length) this.log.warn({ reaped }, "recovered stale jobs");
    } catch (error) {
      this.log.error({ err: error }, "reaper failed");
    }
  }
}
