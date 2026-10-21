/**
 * Group execution: walk the strategy order, retry a member on transient errors, fall back to the next member on
 * pre-stream failures, recurse into child groups. Content errors (bad request, filtered, too long) and
 * cancellation are thrown to the caller as-is: another model would not fix them.
 */
import { AiError, fromThrown, type AiErrorCode } from "../errors.js";
import type { FailedAttempt } from "../platform/errors.js";
import { orderMembers, type Rng } from "./strategy.js";
import type { ModelLeaf, RouteNode } from "./tree.js";

const FALLBACK_CODES = new Set<AiErrorCode>([
  "rate_limited",
  "overloaded",
  "unavailable",
  "timeout",
  "auth_failed",
  "quota_exhausted",
  "model_not_found",
  "unsupported",
]);
const RETRY_CODES = new Set<AiErrorCode>(["rate_limited", "overloaded", "unavailable"]);

export const shouldFallback = (e: AiError) => !e.midStream && FALLBACK_CODES.has(e.code);

export type AttemptInfo = { fallbackIndex: number; retry: number };

/** One member's outcome after its own retries (success is reported by the caller once the stream ends). */
export type AttemptFailure = {
  leaf: ModelLeaf;
  startedAt: Date;
  latencyMs: number;
  error: AiError | null;
  /** Why the member was skipped without a request ("disabled", "needs_reauth"). */
  skipped?: FailedAttempt["code"];
  retries: number;
  fallbackIndex: number;
};

export type RunSuccess<T> = { value: T; leaf: ModelLeaf; fallbackIndex: number; retries: number; startedAt: Date; failures: AttemptFailure[] };

export class RouteExhausted extends Error {
  constructor(readonly failures: AttemptFailure[]) {
    super("all route members failed");
  }
  attempts(): FailedAttempt[] {
    return this.failures.map((f) => ({ providerKind: f.leaf.provider.kind, model: f.leaf.model, code: f.skipped ?? f.error?.code ?? "unavailable" }));
  }
}

export type RunHooks = {
  signal?: AbortSignal;
  rng?: Rng;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Return a skip code to pass over a member without calling it (disabled account, dead OAuth login). */
  skip?: (leaf: ModelLeaf) => FailedAttempt["code"] | null;
  /** Default retries per member when its params do not set `max_retries`. */
  defaultRetries?: number;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AiError("cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new AiError("cancelled"))), { once: true });
  });

export async function runRoute<T>(node: RouteNode, attempt: (leaf: ModelLeaf, info: AttemptInfo) => Promise<T>, hooks: RunHooks = {}, depth = { index: 0 }): Promise<RunSuccess<T>> {
  const failures: AttemptFailure[] = [];
  for (const member of orderMembers(node, hooks.rng)) {
    if (member.node.type === "group") {
      try {
        const r = await runRoute(member.node, attempt, hooks, depth);
        return { ...r, failures: [...failures, ...r.failures] };
      } catch (e) {
        if (e instanceof RouteExhausted) {
          failures.push(...e.failures);
          continue;
        }
        throw e;
      }
    }
    const leaf = member.node;
    const fallbackIndex = depth.index++;
    const startedAt = new Date();
    const skipped = hooks.skip?.(leaf);
    if (skipped) {
      failures.push({ leaf, startedAt, latencyMs: 0, error: null, skipped, retries: 0, fallbackIndex });
      continue;
    }
    const maxRetries = typeof leaf.params.max_retries === "number" ? leaf.params.max_retries : (hooks.defaultRetries ?? 1);
    let retry = 0;
    for (;;) {
      if (hooks.signal?.aborted) throw new AiError("cancelled");
      try {
        const value = await attempt(leaf, { fallbackIndex, retry });
        return { value, leaf, fallbackIndex, retries: retry, startedAt, failures };
      } catch (raw) {
        const err = fromThrown(raw, { providerId: leaf.provider.id });
        if (err.code === "cancelled" || hooks.signal?.aborted) throw err.code === "cancelled" ? err : new AiError("cancelled");
        if (RETRY_CODES.has(err.code) && retry < maxRetries && !err.midStream) {
          const wait = Math.min(err.retryAfterMs ?? 400 * 2 ** retry, 8000);
          retry++;
          await (hooks.sleep ?? defaultSleep)(wait, hooks.signal);
          continue;
        }
        if (!shouldFallback(err)) {
          (err as AiError & { routeFailures?: AttemptFailure[] }).routeFailures = [
            ...failures,
            { leaf, startedAt, latencyMs: Date.now() - startedAt.getTime(), error: err, retries: retry, fallbackIndex },
          ];
          throw err;
        }
        failures.push({ leaf, startedAt, latencyMs: Date.now() - startedAt.getTime(), error: err, retries: retry, fallbackIndex });
        break;
      }
    }
  }
  throw new RouteExhausted(failures);
}
