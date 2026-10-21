/**
 * ai-worker job registry. Modules register handlers for job kinds prefixed `ai_` and import their registration
 * file from `handlers.ts` (one line each). Producers enqueue with `enqueueJob(client, "ai_…", payload, userId)`
 * from `src/jobs/queue.ts` as usual; finalizers (backend `registerFinalizer`) stay optional because ai-worker
 * handlers may write domain tables themselves.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import type { Storage } from "../lib/storage.js";
import type { AiPlatform } from "../ai/platform/platform.js";
import type { AiRole } from "../ai/platform/roles.js";

export type AiJobInfo<P> = { id: string; kind: string; payload: P; attempts: number; maxAttempts: number; createdBy: string | null };

export type AiJobContext<P = unknown> = {
  job: AiJobInfo<P>;
  db: Db;
  storage: Storage;
  ai: AiPlatform;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Aborted when the job is cancelled, the lease is lost, or the worker shuts down. Pass it to every `ai.*` call. */
  signal: AbortSignal;
  /** Persists stage (short English id, shown in the jobs widget) and 0–100 progress; also refreshes the lease. */
  progress(stage: string, percent: number): Promise<void>;
  /** Checkpoint saved by an earlier attempt of this job (null on the first run). */
  checkpoint: unknown;
  /** Durable resume state (e.g. ASR vendor job ids from `ai.transcribe`'s onCheckpoint). */
  saveCheckpoint(value: unknown): Promise<void>;
};

export type AiJobHandler<P = unknown> = {
  /** Roles the handler calls; while one of them is paused (llm_unavailable) the kind is not claimed. */
  roles: AiRole[];
  /** Max jobs of this kind running at once in one worker (default: the worker's concurrency). */
  concurrency?: number;
  /** Hard limit per attempt (default 2 h). */
  timeoutMs?: number;
  /** Return value becomes `jobs.result`. Throw `AiJobInputError` for bad input (no retry), `llmUnavailable` (via ai.*) to wait for the model. */
  run(ctx: AiJobContext<P>): Promise<object | void>;
};

/** Non-retryable failure with a 繁中 message for the user (bad input, missing domain row…). */
export class AiJobInputError extends Error {}

const handlers = new Map<string, AiJobHandler<any>>();

export function registerAiJob<P>(kind: string, handler: AiJobHandler<P>) {
  if (!/^ai_[a-z0-9_]{1,44}$/.test(kind)) throw new Error(`ai-worker job kinds must match ai_[a-z0-9_]+ (got ${kind})`);
  handlers.set(kind, handler as AiJobHandler<any>);
}

export const aiJobHandler = (kind: string) => handlers.get(kind);
export const aiJobKinds = () => [...handlers.keys()];
