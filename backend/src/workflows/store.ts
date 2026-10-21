/**
 * Workflow rows, views and the event log (`workflow_events` + NOTIFY workflow_events '<runId>'). Used by the backend
 * routes and by the engine in the ai-worker.
 */
import type pg from "pg";
import type { Db, Queryable } from "../db.js";
import type { Artifact, RunRow, StepRow, StepSpec, Usage } from "./types.js";
import { getWorkflowPlaybook } from "./playbooks/registry.js";

export type WorkflowEventType = "workflow" | "step" | "activity" | "verdict" | "artifact" | "log";

export async function insertWorkflowEvent(db: Queryable, runId: string, type: WorkflowEventType, data: Record<string, unknown>): Promise<number> {
  const seq = (await db.query<{ seq: string }>(
    "WITH e AS (INSERT INTO workflow_events(run_id,type,data) VALUES($1,$2,$3) RETURNING seq) SELECT seq, pg_notify('workflow_events', $1::text) FROM e",
    [runId, type, JSON.stringify(data)],
  )).rows[0]!.seq;
  return Number(seq);
}

export async function workflowEventsAfter(db: Queryable, runId: string, after: number, limit = 500) {
  return (await db.query<{ seq: string; type: string; data: Record<string, unknown> }>("SELECT seq,type,data FROM workflow_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [runId, after, limit])).rows;
}

export async function lastWorkflowSeq(db: Queryable, runId: string) {
  return Number((await db.query<{ s: string | null }>("SELECT max(seq) AS s FROM workflow_events WHERE run_id=$1", [runId])).rows[0]?.s ?? 0);
}

export async function getRun(db: Queryable, id: string, forUpdate = false): Promise<RunRow | null> {
  return (await db.query<RunRow>(`SELECT * FROM workflow_runs WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
}

export async function getSteps(db: Queryable, runId: string): Promise<StepRow[]> {
  return (await db.query<StepRow>("SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position, created_at", [runId])).rows;
}

export async function insertSteps(db: Queryable, runId: string, specs: StepSpec[], startAt = 0) {
  let pos = startAt;
  for (const s of specs) {
    await db.query(
      `INSERT INTO workflow_steps(run_id,key,position,role,kind,title,instructions,depends_on,inputs,expected,verify,max_rounds,status,output,verdict,round,history,attempts,started_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CASE WHEN $13='passed' THEN now() END,CASE WHEN $13='passed' THEN now() END)`,
      [runId, s.key, pos++, s.role, s.kind ?? "task", s.title.slice(0, 200), s.instructions, s.depends_on ?? [], JSON.stringify(s.inputs ?? {}), s.expected ?? "", JSON.stringify(s.verify ?? { checks: [], judge: false }), s.max_rounds ?? null,
        s.done ? "passed" : "pending", s.done ? JSON.stringify(s.done.output) : null, s.done?.verdict ? JSON.stringify(s.done.verdict) : null, s.done?.round ?? 0, JSON.stringify(s.done?.history ?? []), s.done ? 1 : 0],
    );
  }
}

const studyCache = new Map<string, { id: string; slug: string; title: string }>();
async function studyOf(db: Queryable, id: string | null) {
  if (!id) return null;
  const hit = studyCache.get(id);
  if (hit) return hit;
  const s = (await db.query<{ id: string; slug: string; title: string }>("SELECT id,slug,title FROM studies WHERE id=$1", [id])).rows[0] ?? null;
  if (s) {
    if (studyCache.size > 200) studyCache.clear();
    studyCache.set(id, s);
  }
  return s;
}

export async function runView(db: Queryable, r: RunRow) {
  const pb = getWorkflowPlaybook(r.playbook);
  const job = r.job_id ? (await db.query<{ status: string; stage: string | null }>("SELECT status,stage FROM jobs WHERE id=$1", [r.job_id])).rows[0] ?? null : null;
  return {
    id: r.id,
    title: r.title,
    playbook: r.playbook,
    playbook_title: pb?.title ?? r.playbook,
    playbook_title_en: pb?.titleEn ?? r.playbook,
    status: r.status,
    request: r.request,
    objective: r.objective,
    criteria: r.criteria,
    plan: r.plan,
    inputs: r.inputs,
    study: await studyOf(db, r.study_id),
    conversation_id: r.conversation_id,
    tool_call_id: r.tool_call_id,
    autopilot: r.autopilot,
    tainted: r.tainted,
    taint_sources: r.taint_sources,
    budget: r.budget,
    usage: r.usage,
    artifacts: r.artifacts,
    guidance: r.guidance,
    report: r.report,
    stop_reason: r.stop_reason,
    error: r.error,
    question: r.question,
    job: job ? { status: job.status, stage: job.stage } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

export function stepView(s: StepRow, steps?: StepRow[]) {
  const parent = s.parent_id && steps ? steps.find((x) => x.id === s.parent_id)?.key ?? null : null;
  const text = s.output?.text ?? "";
  return {
    id: s.id,
    key: s.key,
    parent_key: parent,
    position: s.position,
    role: s.role,
    kind: s.kind,
    title: s.title,
    instructions: s.instructions,
    depends_on: s.depends_on,
    expected: s.expected,
    verify: s.verify,
    status: s.status,
    attempts: s.attempts,
    round: s.round,
    output: s.output ? { summary: s.output.summary, excerpt: text ? text.slice(0, 600) : undefined } : null,
    verdict: s.verdict,
    history: s.history,
    tokens: { in: s.tokens_in, out: s.tokens_out },
    ms: s.ms,
    error: s.error,
    started_at: s.started_at,
    finished_at: s.finished_at,
  };
}

export async function emitRun(db: Queryable, runId: string) {
  const r = await getRun(db, runId);
  if (r) await insertWorkflowEvent(db, runId, "workflow", { workflow: await runView(db, r) });
  return r;
}

export async function emitStep(db: Queryable, stepId: string) {
  const s = (await db.query<StepRow>("SELECT * FROM workflow_steps WHERE id=$1", [stepId])).rows[0];
  if (s) await insertWorkflowEvent(db, s.run_id, "step", { step: stepView(s) });
  return s ?? null;
}

/** Adds (or refreshes, same kind+id) an artifact on the run and emits the viewer-panel contract event. */
export async function addArtifact(db: Queryable, runId: string, a: Artifact) {
  const r = await getRun(db, runId);
  if (!r) return;
  const list = r.artifacts.filter((x) => !(x.kind === a.kind && x.id === a.id));
  list.push(a);
  await db.query("UPDATE workflow_runs SET artifacts=$2, updated_at=now() WHERE id=$1", [runId, JSON.stringify(list)]);
  await insertWorkflowEvent(db, runId, "artifact", { artifact: a });
}

export async function addUsage(db: Queryable, runId: string, delta: Partial<Usage>) {
  const keys = Object.entries(delta).filter(([, v]) => typeof v === "number" && v !== 0);
  if (!keys.length) return;
  const sets = keys.map(([k], i) => `'${k}', coalesce((usage->>'${k}')::bigint,0) + $${i + 2}`).join(", ");
  await db.query(`UPDATE workflow_runs SET usage = usage || jsonb_build_object(${sets}), updated_at=now() WHERE id=$1`, [runId, ...keys.map(([, v]) => v)]);
}

export async function markTainted(db: Queryable, runId: string, source: string | null) {
  await db.query(
    `UPDATE workflow_runs SET tainted=true, taint_sources=CASE WHEN $2::text IS NULL OR taint_sources ? $2 THEN taint_sources ELSE (taint_sources || to_jsonb($2::text)) END WHERE id=$1`,
    [runId, source ? source.slice(0, 120) : null],
  );
}

/** One LISTEN connection per pool for `workflow_events` (SSE handlers). */
class WorkflowEventHub {
  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;
  private readonly subs = new Map<string, Set<() => void>>();
  constructor(private readonly db: Db, private readonly log: { warn: (o: object, m: string) => void }) {}

  async subscribe(runId: string, cb: () => void): Promise<() => void> {
    await this.ensure();
    let set = this.subs.get(runId);
    if (!set) this.subs.set(runId, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (!set!.size) this.subs.delete(runId);
    };
  }

  private ensure(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.starting ??= (async () => {
      try {
        const client = await this.db.connect();
        client.on("notification", (msg) => {
          if (msg.channel !== "workflow_events" || !msg.payload) return;
          for (const cb of this.subs.get(msg.payload) ?? []) cb();
        });
        client.on("error", (err) => {
          this.log.warn({ err }, "workflow event listener error");
          this.client = null;
          client.release(true);
          for (const set of this.subs.values()) for (const cb of set) cb();
        });
        await client.query("LISTEN workflow_events");
        this.client = client;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query("UNLISTEN *").catch(() => undefined);
      c.release();
    }
  }
}

const hubs = new WeakMap<Db, WorkflowEventHub>();
export function workflowEventHub(db: Db, log: { warn: (o: object, m: string) => void }) {
  let h = hubs.get(db);
  if (!h) hubs.set(db, (h = new WorkflowEventHub(db, log)));
  return h;
}
export async function closeWorkflowEventHub(db: Db) {
  const h = hubs.get(db);
  if (h) {
    hubs.delete(db);
    await h.close();
  }
}
