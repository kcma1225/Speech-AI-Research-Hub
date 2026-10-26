/**
 * Read-only loader for the invariant auditor and the scenario matrix: turns `workflow_runs` (+ events, steps, the
 * conversation's messages, input-artifact studies, the owner's studies, the study library) into `RunBundle`s for
 * src/workflows/invariants.ts. Every query runs on a connection opened with `default_transaction_read_only=on` inside a
 * `BEGIN READ ONLY` transaction, so nothing here can write — also when pointed at production.
 */
import pg from "pg";
import type { ConversationBundle, LibraryPaper, RunBundle, StoredEvent, StoredMessage, StoredRun, StoredStep } from "../../src/workflows/invariants.js";

export type ReadOnlyDb = { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void>; label: string };

/** Opens a read-only connection (the URL's password is never printed: `label` is host/db only). */
export async function openReadOnly(url: string): Promise<ReadOnlyDb> {
  const u = new URL(url);
  const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on -c statement_timeout=120000", application_name: "hub-invariant-audit" });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  return {
    label: `${u.hostname}:${u.port || 5432}${u.pathname}`,
    async query<T>(sql: string, params: unknown[] = []) {
      if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("read-only loader: only SELECT / WITH statements");
      return (await client.query(sql, params)).rows as T[];
    },
    async close() {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    },
  };
}

export type Window = { since?: string; until?: string; runIds?: string[]; conversationIds?: string[]; limit?: number; user?: string };

const RUN_COLS = "r.id, r.user_id, r.status, r.playbook, r.title, r.request, r.objective, r.study_id, r.conversation_id, r.inputs, r.context, r.state, r.plan, r.criteria, r.report, r.brief, r.guidance, r.artifacts, r.autopilot, r.stop_reason, r.question, r.goal_id, r.created_at, r.updated_at, r.started_at, r.finished_at";
type Row = StoredRun & { user_id: string };
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
const fixTimes = <T extends Record<string, unknown>>(r: T, keys: string[]): T => {
  for (const k of keys) if (r[k] != null) (r as Record<string, unknown>)[k] = iso(r[k]);
  return r;
};

/** The runs of the window, newest first. */
export async function loadRuns(db: ReadOnlyDb, w: Window): Promise<Row[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (w.runIds?.length) {
    params.push(w.runIds);
    where.push(`r.id = ANY($${params.length}::uuid[])`);
  }
  if (w.conversationIds?.length) {
    params.push(w.conversationIds);
    where.push(`r.conversation_id = ANY($${params.length}::uuid[])`);
  }
  if (w.since) {
    params.push(w.since);
    where.push(`r.created_at >= $${params.length}::timestamptz`);
  }
  if (w.until) {
    params.push(w.until);
    where.push(`r.created_at < $${params.length}::timestamptz`);
  }
  if (w.user) {
    params.push(w.user);
    where.push(`r.user_id = (SELECT id FROM users WHERE username = $${params.length})`);
  }
  params.push(w.limit ?? 500);
  const rows = await db.query<Row>(`SELECT ${RUN_COLS} FROM workflow_runs r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  return rows.map((r) => fixTimes(r as unknown as Record<string, unknown>, ["created_at", "updated_at", "started_at", "finished_at"]) as unknown as Row);
}

/** Builds the bundles of the given runs (batched queries; large JSON trimmed in SQL). */
export async function loadBundles(db: ReadOnlyDb, runs: Row[]): Promise<{ bundles: RunBundle[]; conversations: ConversationBundle[] }> {
  const ids = runs.map((r) => r.id);
  const convIds = [...new Set(runs.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const now = iso((await db.query<{ now: Date }>("SELECT now() AS now"))[0]!.now);

  const events = ids.length
    ? await db.query<StoredEvent & { run_id: string }>(
        `SELECT run_id, seq, type, created_at,
                CASE WHEN type = 'workflow' THEN jsonb_build_object('workflow', jsonb_build_object(
                       'status', data->'workflow'->'status', 'question', data->'workflow'->'question',
                       'criteria', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c->'id', 'status', c->'status', 'reason', c->'reason'))
                                             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'workflow'->'criteria') = 'array' THEN data->'workflow'->'criteria' ELSE '[]'::jsonb END) c), '[]'::jsonb)))
                     ELSE jsonb_build_object('level', data->'level', 'text', data->'text') END AS data
           FROM workflow_events WHERE run_id = ANY($1::uuid[]) AND type IN ('workflow', 'log') ORDER BY seq`,
        [ids],
      )
    : [];
  const steps = ids.length
    ? await db.query<StoredStep & { run_id: string }>(
        `SELECT run_id, key, kind, role, status, round, title, inputs->'conv' AS conv,
                nullif(array_to_string(ARRAY(SELECT m[1] FROM regexp_matches(coalesce(output->>'text', ''), '([^\\n]{0,160}(?:venue|會議|期刊|年份|\\myear\\M)[^\\n]{0,160})', 'gi') m LIMIT 20), E'\\n'), '') AS output_text
           FROM workflow_steps WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, position`,
        [ids],
      )
    : [];
  const convs = convIds.length ? await db.query<{ id: string; study_id: string | null; context: Record<string, unknown> | null }>("SELECT id, study_id, context FROM conversations WHERE id = ANY($1::uuid[])", [convIds]) : [];
  const messages = convIds.length
    ? await db.query<StoredMessage & { conversation_id: string }>(
        `SELECT conversation_id, seq, role, left(text, 4000) AS text, page_context, created_at, attachments,
                CASE WHEN role = 'tool' THEN (SELECT jsonb_agg(jsonb_build_object('type', 'tool_result', 'tool_use_id', b->>'tool_use_id', 'content', left(b->>'content', 600)))
                                              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(content) = 'array' THEN content ELSE '[]'::jsonb END) b)
                     ELSE content END AS content
           FROM agent_messages WHERE conversation_id = ANY($1::uuid[]) AND hidden_by IS NULL AND role IN ('user', 'assistant', 'tool', 'notice') ORDER BY seq`,
        [convIds],
      )
    : [];
  const siblings = convIds.length ? await db.query<Row>(`SELECT r.id, r.status, r.study_id, r.conversation_id, r.created_at, r.inputs, r.artifacts FROM workflow_runs r WHERE r.conversation_id = ANY($1::uuid[])`, [convIds]) : [];

  // Input artifacts → their study.
  const deckIds = new Set<string>();
  const noteIds = new Set<string>();
  const projectIds = new Set<string>();
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  for (const r of runs) {
    const i = r.inputs ?? {};
    if (uuid(i.deck_id)) deckIds.add(i.deck_id);
    if (uuid(i.note_id)) noteIds.add(i.note_id);
    if (Array.isArray(i.note_ids)) for (const n of i.note_ids) if (uuid(n)) noteIds.add(n);
    if (uuid(i.project_id)) projectIds.add(i.project_id);
  }
  const artifactStudies: Record<string, string | null> = {};
  for (const [table, set] of [["decks", deckIds], ["notes", noteIds], ["latex_projects", projectIds]] as const) {
    if (!set.size) continue;
    for (const row of await db.query<{ id: string; study_id: string | null }>(`SELECT id, study_id FROM ${table} WHERE id = ANY($1::uuid[])`, [[...set]])) artifactStudies[row.id] = row.study_id;
  }
  const users = [...new Set(runs.map((r) => r.user_id))];
  const studies = users.length ? await db.query<{ user_id: string; id: string; title: string }>("SELECT sm.user_id, s.id, s.title FROM study_members sm JOIN studies s ON s.id = sm.study_id WHERE sm.user_id = ANY($1::uuid[])", [users]) : [];
  const studyIds = [...new Set(runs.map((r) => r.study_id).filter((x): x is string => !!x))];
  const library = studyIds.length
    ? await db.query<LibraryPaper & { study_id: string }>("SELECT sp.study_id, p.title, p.year, p.venue, sp.cite_key, p.arxiv_id, (p.pdf_key IS NOT NULL) AS has_pdf FROM study_papers sp JOIN papers p ON p.id = sp.paper_id WHERE sp.study_id = ANY($1::uuid[])", [studyIds])
    : [];

  const by = <T, K extends keyof T>(xs: T[], k: K) => {
    const m = new Map<unknown, T[]>();
    for (const x of xs) {
      const key = x[k];
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(x);
    }
    return m;
  };
  const evBy = by(events.map((e) => fixTimes(e as unknown as Record<string, unknown>, ["created_at"]) as unknown as StoredEvent & { run_id: string }), "run_id");
  const stBy = by(steps, "run_id");
  const msgBy = by(messages.map((m) => fixTimes(m as unknown as Record<string, unknown>, ["created_at"]) as unknown as StoredMessage & { conversation_id: string }), "conversation_id");
  const sibBy = by(siblings.map((s) => fixTimes(s as unknown as Record<string, unknown>, ["created_at"]) as unknown as Row), "conversation_id");
  const studyBy = by(studies, "user_id");
  const libBy = by(library, "study_id");
  const convMap = new Map(convs.map((c) => [c.id, c]));

  const bundles: RunBundle[] = runs.map((run) => ({
    run,
    events: evBy.get(run.id) ?? [],
    steps: stBy.get(run.id) ?? [],
    conversation: run.conversation_id ? (convMap.get(run.conversation_id) ?? null) : null,
    messages: run.conversation_id ? (msgBy.get(run.conversation_id) ?? []) : undefined,
    siblings: run.conversation_id ? (sibBy.get(run.conversation_id) ?? []).filter((s) => s.id !== run.id) : [],
    artifactStudies,
    studies: (studyBy.get(run.user_id) ?? []).map((s) => ({ id: s.id, title: s.title })),
    library: run.study_id ? (libBy.get(run.study_id) ?? []) : [],
    now,
  }));
  const conversations: ConversationBundle[] = convIds.map((id) => ({ conversation: convMap.get(id) ?? { id }, messages: msgBy.get(id) ?? [], runs: sibBy.get(id) ?? [] }));
  return { bundles, conversations };
}
