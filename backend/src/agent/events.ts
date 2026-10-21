/**
 * SSE replay log: every agent event is a row in `agent_events` (id = seq) plus `NOTIFY agent_events '<conversationId>'`.
 * SSE handlers subscribe through one shared LISTEN connection per process and read new rows after their last seq.
 * Token deltas are batched (≈100 ms) so a streaming answer writes a handful of rows per second.
 */
import type pg from "pg";
import type { Db, Queryable } from "../db.js";

export type AgentEventType =
  | "run" // {run}
  | "conversation" // {conversation}
  | "message" // {message}
  | "tool_call" // {toolCall}
  | "step_start" // {runId, step}
  | "step_discarded" // {runId} partial text of the current step was dropped (LLM outage)
  | "text" // {runId, text}
  | "reasoning" // {runId, text}
  | "tool_input" // {runId, index, name, title}
  | "branch"; // {messageId} the current branch changed (edit / regenerate / version switch): reload the conversation

export type AgentEventRow = { seq: string; type: AgentEventType; data: Record<string, unknown>; run_id: string | null; created_at: string };

export async function insertEvent(db: Queryable, conversationId: string, runId: string | null, type: AgentEventType, data: Record<string, unknown>): Promise<number> {
  // One statement (one commit): insert + notify.
  const seq = (await db.query<{ seq: string }>(
    "WITH e AS (INSERT INTO agent_events(conversation_id,run_id,type,data) VALUES($1,$2,$3,$4) RETURNING seq) SELECT seq, pg_notify('agent_events', $1::text) FROM e",
    [conversationId, runId, type, JSON.stringify(data)],
  )).rows[0]!.seq;
  return Number(seq);
}

export async function eventsAfter(db: Queryable, conversationId: string, after: number, limit = 500): Promise<AgentEventRow[]> {
  return (await db.query<AgentEventRow>("SELECT seq,type,data,run_id,created_at FROM agent_events WHERE conversation_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [conversationId, after, limit])).rows;
}

export async function lastSeq(db: Queryable, conversationId: string): Promise<number> {
  return Number((await db.query<{ s: string | null }>("SELECT max(seq) AS s FROM agent_events WHERE conversation_id=$1", [conversationId])).rows[0]?.s ?? 0);
}

/** Buffers text/reasoning deltas of one run; any other event flushes first so the order is kept. */
export class EventWriter {
  private buf: { type: "text" | "reasoning"; text: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Db, private readonly conversationId: string, private readonly runId: string, private readonly flushMs = 100) {}

  delta(type: "text" | "reasoning", text: string) {
    if (!text) return;
    if (this.buf && this.buf.type !== type) this.flush();
    if (!this.buf) this.buf = { type, text: "" };
    this.buf.text += text;
    if (this.buf.text.length > 2000) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  emit(type: AgentEventType, data: Record<string, unknown>) {
    this.flush();
    return this.enqueue(type, data);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const b = this.buf;
    this.buf = null;
    if (b) void this.enqueue(b.type, { runId: this.runId, text: b.text });
  }

  /** Resolves when every queued event is written. */
  async drain() {
    this.flush();
    await this.chain.catch(() => undefined);
  }

  private enqueue(type: AgentEventType, data: Record<string, unknown>) {
    const p = this.chain.then(() => insertEvent(this.db, this.conversationId, this.runId, type, data));
    this.chain = p.catch(() => undefined);
    return p;
  }
}

/** One LISTEN connection per pool, fanning `agent_events` notifications out to SSE handlers. */
class EventHub {
  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;
  private readonly subs = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(private readonly db: Db, private readonly log: { warn: (o: object, m: string) => void }) {}

  async subscribe(conversationId: string, cb: () => void): Promise<() => void> {
    await this.ensure();
    let set = this.subs.get(conversationId);
    if (!set) this.subs.set(conversationId, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (!set!.size) this.subs.delete(conversationId);
    };
  }

  private ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.starting ??= (async () => {
      try {
        const client = await this.db.connect();
        client.on("notification", (msg) => {
          if (msg.channel !== "agent_events" || !msg.payload) return;
          for (const cb of this.subs.get(msg.payload) ?? []) cb();
        });
        client.on("error", (err) => {
          this.log.warn({ err }, "agent event listener error");
          this.client = null;
          this.starting = null;
          client.release(true);
          // Wake subscribers so they re-read (and the next subscribe reconnects).
          for (const set of this.subs.values()) for (const cb of set) cb();
        });
        await client.query("LISTEN agent_events");
        this.client = client;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async close() {
    this.closed = true;
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query("UNLISTEN *").catch(() => undefined);
      c.release();
    }
  }
}

const hubs = new WeakMap<Db, EventHub>();
export function eventHub(db: Db, log: { warn: (o: object, m: string) => void }): EventHub {
  let h = hubs.get(db);
  if (!h) hubs.set(db, (h = new EventHub(db, log)));
  return h;
}
export async function closeEventHub(db: Db) {
  const h = hubs.get(db);
  if (h) {
    hubs.delete(db);
    await h.close();
  }
}
