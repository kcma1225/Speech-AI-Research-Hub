/**
 * Call log (`ai_call_log`): one row per member attempt, never any prompt/response content. Rows are buffered and
 * inserted in batches so logging never slows a call; `flush()` is awaited on shutdown and in tests.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Db, Queryable } from "../../db.js";
import type { AttemptFailure } from "../router/index.js";
import type { ModelLeaf } from "../router/tree.js";
import type { Usage } from "../types.js";
import type { AiRole } from "./roles.js";

export type CallCapability = "chat" | "embedding" | "asr" | "asr_live";

export type CallLogRow = {
  call_id: string;
  final: boolean;
  role: AiRole | null;
  capability: CallCapability;
  route_id: string | null;
  provider_id: string | null;
  provider_kind: string | null;
  model: string | null;
  stream: boolean;
  probe: boolean;
  started_at: Date;
  latency_ms: number;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  ok: boolean;
  error_code: string | null;
  retries: number;
  fallback_index: number;
  job_id: string | null;
  user_id: string | null;
};

export type CallContext = { userId?: string | null; jobId?: string | null };

const COLS: (keyof CallLogRow)[] = [
  "call_id", "final", "role", "capability", "route_id", "provider_id", "provider_kind", "model", "stream", "probe", "started_at",
  "latency_ms", "ttft_ms", "tokens_in", "tokens_out", "ok", "error_code", "retries", "fallback_index", "job_id", "user_id",
];

export class CallLogger {
  private buffer: CallLogRow[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  /** Called after rows are written (health recompute). */
  onWritten?: (rows: CallLogRow[]) => void;

  constructor(private readonly db: Db, private readonly log?: Pick<FastifyBaseLogger, "warn">, private readonly delayMs = 1500) {}

  add(rows: CallLogRow[]) {
    if (!rows.length) return;
    this.buffer.push(...rows);
    if (this.buffer.length >= 50) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.delayMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.flushing) await this.flushing;
    const rows = this.buffer.splice(0);
    if (!rows.length) return;
    this.flushing = insertRows(this.db, rows)
      .then(() => this.onWritten?.(rows))
      .catch((err) => this.log?.warn({ err }, "ai_call_log insert failed"))
      .finally(() => (this.flushing = undefined));
    await this.flushing;
  }
}

async function insertRows(db: Queryable, rows: CallLogRow[]) {
  const values: unknown[] = [];
  const tuples = rows.map((row, i) => {
    for (const c of COLS) values.push(row[c]);
    return `(${COLS.map((_, j) => `$${i * COLS.length + j + 1}`).join(",")})`;
  });
  await db.query(`INSERT INTO ai_call_log(${COLS.join(",")}) VALUES ${tuples.join(",")}`, values);
}

/** Collects the rows of one logical call (failed members + the final outcome). */
export class CallRecorder {
  readonly callId = randomUUID();
  private rows: CallLogRow[] = [];
  constructor(
    private readonly logger: CallLogger | undefined,
    private readonly base: { role: AiRole | null; capability: CallCapability; stream: boolean; probe?: boolean; ctx?: CallContext },
  ) {}

  private row(leaf: ModelLeaf | null, o: Partial<CallLogRow> & Pick<CallLogRow, "ok" | "started_at">): CallLogRow {
    return {
      call_id: this.callId,
      final: false,
      role: this.base.role,
      capability: this.base.capability,
      route_id: leaf?.routeId ?? null,
      provider_id: leaf?.provider.id ?? null,
      provider_kind: leaf?.provider.kind ?? null,
      model: leaf?.model ?? null,
      stream: this.base.stream,
      probe: this.base.probe ?? false,
      latency_ms: 0,
      ttft_ms: null,
      tokens_in: null,
      tokens_out: null,
      error_code: null,
      retries: 0,
      fallback_index: 0,
      job_id: this.base.ctx?.jobId ?? null,
      user_id: this.base.ctx?.userId ?? null,
      ...o,
    };
  }

  failures(list: AttemptFailure[]) {
    for (const f of list) {
      this.rows.push(
        this.row(f.leaf, {
          ok: false,
          started_at: f.startedAt,
          latency_ms: Math.max(0, Math.round(f.latencyMs)),
          error_code: f.skipped ?? f.error?.code ?? "unavailable",
          retries: f.retries,
          fallback_index: f.fallbackIndex,
        }),
      );
    }
  }

  /** Final row. `leaf` null when the role has no route. */
  finish(leaf: ModelLeaf | null, o: { ok: boolean; startedAt: Date; errorCode?: string; retries?: number; fallbackIndex?: number; ttftMs?: number; usage?: Usage }) {
    this.rows.push(
      this.row(leaf, {
        final: true,
        ok: o.ok,
        started_at: o.startedAt,
        latency_ms: Math.max(0, Date.now() - o.startedAt.getTime()),
        ttft_ms: o.ttftMs ?? null,
        tokens_in: o.usage?.inputTokens ?? null,
        tokens_out: o.usage?.outputTokens ?? null,
        error_code: o.errorCode ?? null,
        retries: o.retries ?? 0,
        fallback_index: o.fallbackIndex ?? 0,
      }),
    );
    this.logger?.add(this.rows.splice(0));
  }

  /** All members failed (or no route): one extra final row without a member carries the outcome. */
  exhausted(errorCode = "llm_unavailable", routeId: string | null = null) {
    this.rows.push(this.row(null, { final: true, ok: false, started_at: new Date(), error_code: errorCode, route_id: routeId }));
    this.logger?.add(this.rows.splice(0));
  }
}

// ---------------------------------------------------------------- queries (admin)

export type CallFilters = {
  role?: string;
  providerId?: string;
  model?: string;
  ok?: boolean;
  errorCode?: string;
  from?: Date;
  to?: Date;
  finalOnly?: boolean;
  includeProbes?: boolean;
  before?: number;
  limit?: number;
};

export async function listCalls(db: Queryable, f: CallFilters) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (f.role) add("l.role = ?", f.role);
  if (f.providerId) add("l.provider_id = ?", f.providerId);
  if (f.model) add("l.model = ?", f.model);
  if (f.ok !== undefined) add("l.ok = ?", f.ok);
  if (f.errorCode) add("l.error_code = ?", f.errorCode);
  if (f.from) add("l.started_at >= ?", f.from);
  if (f.to) add("l.started_at < ?", f.to);
  if (f.before) add("l.id < ?", f.before);
  if (f.finalOnly) where.push("l.final");
  if (!f.includeProbes) where.push("NOT l.probe");
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = (
    await db.query(
      `SELECT l.id::text AS id, l.call_id, l.final, l.role, l.capability, l.route_id, r.name AS route_name, l.provider_id, p.name AS provider_name,
              l.provider_kind, l.model, l.stream, l.probe, l.started_at, l.latency_ms, l.ttft_ms, l.tokens_in, l.tokens_out, l.ok, l.error_code,
              l.retries, l.fallback_index, l.job_id, l.user_id, u.name AS user_name
         FROM ai_call_log l
         LEFT JOIN ai_routes r ON r.id = l.route_id
         LEFT JOIN ai_providers p ON p.id = l.provider_id
         LEFT JOIN users u ON u.id = l.user_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY l.id DESC LIMIT ${limit + 1}`,
      args,
    )
  ).rows as Array<Record<string, unknown> & { id: string }>;
  const more = rows.length > limit;
  const calls = rows.slice(0, limit);
  return { calls, next: more ? Number(calls[calls.length - 1]!.id) : null };
}

export const STAT_WINDOWS = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days", "30d": "30 days" } as const;
export type StatWindow = keyof typeof STAT_WINDOWS;

/** Per-role (logical calls) and per-provider/model (attempts) stats: count, success rate, p50/p95, tokens, errors. */
export async function callStats(db: Queryable, window: StatWindow) {
  const since = `now() - interval '${STAT_WINDOWS[window]}'`;
  const agg = `count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p95_ms,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE ok AND ttft_ms IS NOT NULL) AS ttft_p50_ms,
      coalesce(sum(tokens_in),0)::bigint AS tokens_in, coalesce(sum(tokens_out),0)::bigint AS tokens_out,
      sum(retries)::int AS retries`;
  const [roles, members, errors, series] = await Promise.all([
    db.query(`SELECT role, ${agg}, count(*) FILTER (WHERE ok AND fallback_index > 0)::int AS fallbacks
                FROM ai_call_log WHERE final AND NOT probe AND started_at >= ${since} GROUP BY role ORDER BY role`),
    db.query(`SELECT l.provider_id, p.name AS provider_name, l.provider_kind, l.model, ${agg.replaceAll("latency_ms", "l.latency_ms")}
                FROM ai_call_log l LEFT JOIN ai_providers p ON p.id = l.provider_id
               WHERE l.provider_id IS NOT NULL AND NOT l.probe AND l.started_at >= ${since}
               GROUP BY l.provider_id, p.name, l.provider_kind, l.model ORDER BY calls DESC LIMIT 100`),
    db.query(`SELECT error_code, count(*)::int AS count FROM ai_call_log
               WHERE NOT ok AND NOT probe AND started_at >= ${since} GROUP BY error_code ORDER BY count DESC`),
    db.query(`SELECT date_bin('${window === "1h" ? "5 minutes" : window === "24h" ? "1 hour" : "1 day"}', started_at, '2000-01-01') AS bucket,
                     count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok
                FROM ai_call_log WHERE final AND NOT probe AND started_at >= ${since} GROUP BY bucket ORDER BY bucket`),
  ]);
  const round = (r: Record<string, unknown>) => ({
    ...r,
    p50_ms: r.p50_ms == null ? null : Math.round(Number(r.p50_ms)),
    p95_ms: r.p95_ms == null ? null : Math.round(Number(r.p95_ms)),
    ttft_p50_ms: r.ttft_p50_ms == null ? null : Math.round(Number(r.ttft_p50_ms)),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
    success_rate: Number(r.calls) ? Number(r.ok) / Number(r.calls) : null,
  });
  return { window, roles: roles.rows.map(round), members: members.rows.map(round), errors: errors.rows, series: series.rows };
}

/** Retention: keep 90 days. */
export async function pruneCallLog(db: Queryable, days = 90) {
  await db.query("DELETE FROM ai_call_log WHERE started_at < now() - make_interval(days => $1)", [days]);
}
