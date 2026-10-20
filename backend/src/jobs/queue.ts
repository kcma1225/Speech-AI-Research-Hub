import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Db, Queryable } from "../db.js";

export type JobKind = "media_transcode" | "slide_render";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Payload/result contracts shared with the worker. Keep in sync with worker/src/types.ts. */
export type MediaTranscodePayload = { itemId: string; sourceKey: string; outputKey: string; fileName: string };
/** `peaks`: optional waveform, up to 1000 values in [0,1] (3 decimals). */
export type MediaTranscodeResult = { outputKey: string; bytes: number; durationSeconds: number | null; peaks?: number[] };
/** Kind of uploaded deck: a Quarto ZIP, a PDF, or a PowerPoint file converted with LibreOffice. */
export type SlideSourceType = "quarto" | "pdf" | "pptx";
/**
 * `sourceType` absent means `quarto` (jobs queued before PDF/PPTX support). `sourceKey` is
 * `slides/<p>/<v>/source.zip|pdf|pptx`; `entry` is the QMD path for quarto and "" otherwise.
 * `outputPrefix` is `slides/<p>/<v>/output/` or, for a re-index, `slides/<p>/<v>/output-<suffix>/`.
 */
export type SlideRenderPayload = {
  projectId: string;
  versionId: string;
  sourceKey: string;
  entry: string;
  outputPrefix: string;
  sourceType?: SlideSourceType;
};
/**
 * `entryHtml`: entry HTML relative to `outputPrefix` (quarto), null for pdf/pptx (no HTML deck).
 * `pdfKey`: full key of the downloadable PDF (`<outputPrefix>slides.pdf`; for pdf decks the uploaded `sourceKey`).
 * `quartoVersion`: null for pdf/pptx. `sharedPrefix`: where `offline-assets/` of this render is stored
 * (content-addressed, shared across versions); null for pdf/pptx.
 * `thumbnailKey`: full key of the 960 px wide deck thumbnail of the first slide
 * (`<outputPrefix>_hub/thumbnail.png` for quarto, `_hub/thumbnail.webp` for pdf/pptx); omitted when it failed.
 * `pageCount` / `manifestKey`: number of pages and full key of `<outputPrefix>_hub/pages.json`
 * (see PageManifest); omitted when page capture failed (quarto only — pdf/pptx fail the job instead).
 * `converter`: LibreOffice version used for pptx.
 */
export type SlideRenderResult = {
  entryHtml: string | null;
  pdfKey: string;
  quartoVersion: string | null;
  fileCount: number;
  sharedPrefix: string | null;
  thumbnailKey?: string;
  pageCount?: number;
  manifestKey?: string;
  converter?: string;
};

/** Speaker notes of one page: plain text (paragraphs separated by blank lines) and, for quarto, minimal HTML. */
export type PageNotes = { text: string; html?: string };
/** One page in `pages.json`. `thumb`/`full` are keys relative to the version's output prefix. */
export type PageEntry = { index: number; h?: number; v?: number; title?: string; thumb: string; full?: string; notes?: PageNotes };
/** `<outputPrefix>_hub/pages.json`. `width`/`height`: the deck's slide size in its own units (use the ratio). */
export type PageManifest = { version: 1; sourceType: SlideSourceType; width: number; height: number; pages: PageEntry[] };

export type JobRow = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: unknown;
  result: unknown;
  error: string | null;
  stage: string;
  progress: number;
  attempts: number;
  cancel_requested: boolean;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/** Inserts a queued job and wakes workers. Use the caller's transaction client so the job commits with its domain row. */
export async function enqueueJob(client: Queryable, kind: "media_transcode", payload: MediaTranscodePayload, createdBy: string, maxAttempts?: number): Promise<string>;
export async function enqueueJob(client: Queryable, kind: "slide_render", payload: SlideRenderPayload, createdBy: string, maxAttempts?: number): Promise<string>;
export async function enqueueJob(client: Queryable, kind: JobKind, payload: object, createdBy: string, maxAttempts = 3): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO jobs(kind,payload,created_by,max_attempts) VALUES($1,$2,$3,$4) RETURNING id",
    [kind, JSON.stringify(payload), createdBy, maxAttempts],
  );
  await client.query("SELECT pg_notify('jobs_new', $1)", [kind]);
  return result.rows[0]!.id;
}

/**
 * Requests cancellation. A queued job is cancelled immediately; a running job is flagged and the
 * worker stops it at its next heartbeat. Returns false when the job is already finished.
 */
export async function cancelJob(client: Queryable, jobId: string): Promise<boolean> {
  const queued = await client.query(
    "UPDATE jobs SET status='cancelled',stage='cancelled',finished_at=now() WHERE id=$1 AND status='queued'",
    [jobId],
  );
  if (queued.rowCount) {
    await client.query("SELECT pg_notify('jobs_finished', $1)", [jobId]);
    return true;
  }
  const running = await client.query("UPDATE jobs SET cancel_requested=true WHERE id=$1 AND status='running'", [jobId]);
  return Boolean(running.rowCount);
}

export type FinalizeContext = { client: pg.PoolClient; log: FastifyBaseLogger };
/** Runs inside the finalize transaction. Return a callback for side effects that must happen after commit (push, S3 deletes). */
export type Finalizer = (job: JobRow, context: FinalizeContext) => Promise<void | (() => Promise<void>)>;

const finalizers = new Map<JobKind, Finalizer>();

/** Register domain handling for finished jobs of `kind` (succeeded, failed or cancelled). */
export function registerFinalizer(kind: JobKind, finalizer: Finalizer) {
  finalizers.set(kind, finalizer);
}

/**
 * Applies finished jobs to domain tables exactly once. Safe with several backend replicas
 * (row locks with SKIP LOCKED). Woken by NOTIFY jobs_finished, with a polling fallback.
 */
export class JobFinalizer {
  private timer?: NodeJS.Timeout;
  private listener?: pg.PoolClient;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(private readonly db: Db, private readonly log: FastifyBaseLogger, private readonly intervalMs = 3000) {}

  async start() {
    this.listener = await this.db.connect();
    this.listener.on("notification", () => this.kick());
    this.listener.on("error", error => this.log.warn({ err: error }, "finalizer listener error"));
    await this.listener.query("LISTEN jobs_finished");
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.listener) {
      await this.listener.query("UNLISTEN *").catch(() => {});
      this.listener.release();
    }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 50));
  }

  kick() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.drain()
      .catch(error => this.log.error({ err: error }, "job finalizer failed"))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Processes finished jobs until none remain. Exposed for tests. */
  async drain() {
    while (!this.stopped && (await this.finalizeOne())) {}
  }

  private async finalizeOne(): Promise<boolean> {
    const client = await this.db.connect();
    let after: void | (() => Promise<void>) = undefined;
    try {
      await client.query("BEGIN");
      const job = (await client.query<JobRow>(
        `SELECT * FROM jobs WHERE finalized_at IS NULL AND status IN ('succeeded','failed','cancelled')
          ORDER BY finished_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )).rows[0];
      if (!job) {
        await client.query("COMMIT");
        return false;
      }
      const finalizer = finalizers.get(job.kind);
      await client.query("SAVEPOINT finalize");
      try {
        if (finalizer) after = await finalizer(job, { client, log: this.log });
      } catch (error) {
        // Do not block the queue on one bad job: undo its domain changes but keep the row lock and mark it finalized.
        this.log.error({ err: error, jobId: job.id }, "finalizer threw; marking job finalized");
        await client.query("ROLLBACK TO SAVEPOINT finalize");
        after = undefined;
      }
      await client.query("UPDATE jobs SET finalized_at=now() WHERE id=$1", [job.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (after) await after().catch(error => this.log.warn({ err: error }, "finalizer post-commit step failed"));
    return true;
  }
}
