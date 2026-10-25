/**
 * Where a new workflow works (docs/architecture.md "Workflows" → Context and batches):
 * - **Context inheritance**: the study / paper come from the explicit inputs, then the page context, then the
 *   conversation (its scoped study, its latest page context, the page context of its recent user messages), then a
 *   study named in the request (title / slug words of a study the user edits), then the user's only active study — so
 *   a run started from a chat that is clearly about one study never asks 「要把簡報放在哪個研究？」.
 * - **Batches**: a per-paper playbook (slides, reading note) whose user asked for 「每一篇文獻」 (route.ts decides)
 *   becomes one run per paper, linked by `batch_id` (+ `batch_index`); the per-user slot limit queues the rest.
 */
import type { Queryable } from "../db.js";
import type { CurrentUser } from "../lib/auth.js";

type Ctx = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Page context the conversation carries (its own context, then recent user messages' contexts), newest first. */
export async function conversationContext(db: Queryable, conversationId: string | null | undefined, userId: string): Promise<Ctx> {
  if (!conversationId) return {};
  const conv = (await db.query<{ context: Ctx | null; study_id: string | null }>("SELECT context, study_id FROM conversations WHERE id=$1 AND user_id=$2", [conversationId, userId])).rows[0];
  if (!conv) return {};
  const out: Ctx = { ...(conv.context ?? {}) };
  if (!out.studyId && !out.studySlug && conv.study_id) out.studyId = conv.study_id;
  if (!out.studyId && !out.studySlug || !out.paperId) {
    const recent = (await db.query<{ page_context: Ctx }>(
      "SELECT page_context FROM agent_messages WHERE conversation_id=$1 AND role='user' AND page_context IS NOT NULL AND hidden_by IS NULL ORDER BY seq DESC LIMIT 20",
      [conversationId],
    )).rows;
    for (const r of recent) {
      const c = r.page_context ?? {};
      if (!out.studyId && !out.studySlug && (str(c.studyId) || str(c.studySlug))) Object.assign(out, { studyId: str(c.studyId), studySlug: str(c.studySlug) });
      if (!out.paperId && str(c.paperId)) out.paperId = str(c.paperId);
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/**
 * The study a work object implies (docs/architecture.md "Context and batches"): a deck, a note, a LaTeX project or a paper
 * (when it is in exactly one study the user edits) belongs to one study, so a run on it never asks 「哪個研究？」
 * (production e6d552fc: start_workflow{deck_id} from a home-page chat asked which study, twice).
 */
export async function studyOfInputs(db: Queryable, userId: string, inputs: Record<string, unknown>): Promise<string | null> {
  const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const one = async (sql: string, id: string | null) => (id ? (await db.query<{ study_id: string | null }>(sql, [id]).catch(() => ({ rows: [] as { study_id: string | null }[] }))).rows[0]?.study_id ?? null : null);
  const noteId = Array.isArray(inputs.note_ids) ? uuid(inputs.note_ids[0]) : null;
  const found = (await one("SELECT study_id FROM decks WHERE id=$1", uuid(inputs.deck_id)))
    ?? (await one("SELECT study_id FROM notes WHERE id=$1", noteId))
    ?? (await one("SELECT study_id FROM latex_projects WHERE id=$1", uuid(inputs.project_id)));
  if (found) return found;
  const paperId = uuid(inputs.paper_id);
  if (!paperId) return null;
  const rows = (await db.query<{ study_id: string }>(
    "SELECT sp.study_id FROM study_papers sp JOIN study_members m ON m.study_id=sp.study_id AND m.user_id=$2 AND m.role IN ('owner','member') WHERE sp.paper_id=$1",
    [paperId, userId],
  ).catch(() => ({ rows: [] as { study_id: string }[] }))).rows;
  return rows.length === 1 ? rows[0]!.study_id : null;
}

/** The study of the conversation's most recent workflow / goal (「剛剛那個研究」): the work it has been doing. */
export async function conversationStudy(db: Queryable, conversationId: string | null | undefined, userId: string, excludeRun?: string | null): Promise<string | null> {
  if (!conversationId) return null;
  return (await db.query<{ study_id: string }>(
    `SELECT study_id FROM (
       SELECT study_id, created_at FROM workflow_runs WHERE conversation_id=$1 AND user_id=$2 AND study_id IS NOT NULL AND ($3::uuid IS NULL OR id<>$3)
       UNION ALL SELECT study_id, created_at FROM workflow_goals WHERE conversation_id=$1 AND user_id=$2 AND study_id IS NOT NULL
     ) t ORDER BY created_at DESC LIMIT 1`,
    [conversationId, userId, excludeRun ?? null],
  ).catch(() => ({ rows: [] as { study_id: string }[] }))).rows[0]?.study_id ?? null;
}

/** The newest artifact of a kind the conversation's workflows wrote (「剛剛那個簡報」「同一個簡報」「繼續」). */
export async function conversationArtifact(db: Queryable, conversationId: string | null | undefined, userId: string, kind: "deck" | "note" | "latex_project", excludeRun?: string | null): Promise<string | null> {
  if (!conversationId) return null;
  return (await db.query<{ id: string }>(
    `SELECT a->>'id' AS id FROM workflow_runs r, jsonb_array_elements(r.artifacts) WITH ORDINALITY x(a, n)
      WHERE r.conversation_id=$1 AND r.user_id=$2 AND a->>'kind'=$3 AND ($4::uuid IS NULL OR r.id<>$4)
      ORDER BY r.created_at DESC, x.n DESC LIMIT 1`,
    [conversationId, userId, kind, excludeRun ?? null],
  ).catch(() => ({ rows: [] as { id: string }[] }))).rows[0]?.id ?? null;
}

/** The words point at an existing one (「這個／那個／這份／剛剛那個／同一個／繼續」「this / that / the same deck」). */
export const POINTS_AT_RE = /這個|那個|這份|那份|這篇|那篇|剛剛|剛才|同一個|同個|上一個|上一份|前面那|之前那|原本的|繼續|\b(?:this|that|the same|the previous|my|our) (?:deck|presentation|slides?|note)\b|\bcontinue\b/i;

/** 「就剛剛的那個研究」「同一個」「上一個」「the same one」: the user points back at what the conversation was doing. */
export const REFER_BACK_RE = /剛剛|剛才|方才|同一個|同個|一樣的|上一個|上一份|前面那個|之前那個|原本那個|那個研究|這個研究|same (?:one|study|deck)|that (?:one|study)|the previous|the last one/i;

const STOP = new Set(["study", "the", "and", "for", "with", "our", "research", "研究", "this", "that"]);
/** Latin words (≥ 3 chars) and CJK bigrams of a text, lower-cased. */
export function textTokens(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const w of t.match(/[a-z0-9][a-z0-9+-]{2,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const run of t.match(/[一-鿿]{2,}/g) ?? []) for (let i = 0; i + 2 <= run.length; i++) { const bg = run.slice(i, i + 2); if (!STOP.has(bg)) out.add(bg); }
  return out;
}

/**
 * The study the request names: title/slug token overlap with the studies the user edits (an English word counts 2, a
 * CJK bigram 1; ≥ 4 points and a unique best), else the user's only active study.
 */
export async function studyFromText(db: Queryable, user: CurrentUser, request: string): Promise<string | null> {
  const rows = (await db.query<{ id: string; slug: string; title: string }>(
    `SELECT s.id, s.slug, s.title FROM studies s JOIN study_members m ON m.study_id=s.id AND m.user_id=$1 AND m.role IN ('owner','member')
      WHERE s.archived_at IS NULL AND s.status <> 'archived' ORDER BY s.activity_at DESC LIMIT 60`,
    [user.id],
  )).rows;
  if (!rows.length) return null;
  const req = textTokens(request);
  const scored = rows.map((s) => {
    const toks = new Set([...textTokens(s.title), ...textTokens(s.slug.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-/g, " "))]);
    const hit = [...toks].filter((x) => req.has(x)).reduce((n, x) => n + (/^[a-z0-9]/.test(x) ? 2 : 1), 0);
    return { id: s.id, hit };
  }).sort((a, b) => b.hit - a.hit);
  const best = scored[0]!;
  const second = scored[1];
  if (best.hit >= 4 && (!second || second.hit < best.hit)) return best.id;
  if (rows.length === 1) return rows[0]!.id;
  return null;
}

/** 「每一篇文獻」-style requests: one artifact per paper. */
export const EACH_PAPER_RE = /(每一?篇|各篇|逐篇|一篇一份|每一?份)[^。！？\n]{0,6}(文獻|論文|paper)|每一?個\s*(文獻|論文|paper)|(文獻|論文|papers?|篇)[^。！？\n]{0,6}(各做|分別做|各自做|各一份|逐篇|每篇)|\b(each|every) (paper|reference|article)s?\b(?![^.\n]{0,20}\b(title|year|name)\b)|\bone (deck|presentation|note) (per|for each) paper\b/i;
/** Playbooks whose run is about exactly one paper. */
export const PER_PAPER_PLAYBOOKS = new Set(["slides", "reading_note"]);
export const MAX_BATCH = 10;

export type BatchItem = { paper_id: string; title: string };

/**
 * The papers of a batch the router decided on (route.ts: one run per paper only when the user's OWN words ask for it —
 * 「每一篇各做一份」; several paper_ids from the assistant otherwise are the sources of ONE deck / note; production: 5
 * paper ids → 5 paper-report decks): explicit `paper_ids` (≥ 2), else the study's papers when no single `paper_id` is
 * given. Papers in the study's order (oldest first), ≤ MAX_BATCH; null = fewer than 2 (one run).
 */
export async function batchPapers(db: Queryable, input: { studyId: string | null; paperId?: string; paperIds?: string[] }): Promise<BatchItem[] | null> {
  const explicit = [...new Set(input.paperIds ?? [])];
  if (explicit.length >= 2) {
    const rows = (await db.query<{ id: string; title: string }>("SELECT id, title FROM papers WHERE id = ANY($1::uuid[])", [explicit])).rows;
    const list = explicit.map((id) => rows.find((r) => r.id === id)).filter((r): r is { id: string; title: string } => !!r).slice(0, MAX_BATCH);
    return list.length >= 2 ? list.map((r) => ({ paper_id: r.id, title: r.title })) : null;
  }
  if (input.paperId || !input.studyId) return null;
  const rows = (await db.query<{ id: string; title: string }>(
    "SELECT p.id, p.title FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY sp.created_at, p.title LIMIT $2",
    [input.studyId, MAX_BATCH],
  )).rows;
  return rows.length >= 2 ? rows.map((r) => ({ paper_id: r.id, title: r.title })) : null;
}

/** The request of one batch item: the user's words + which paper this run covers. */
export const batchRequest = (request: string, item: BatchItem, i: number, n: number) =>
  `${request.slice(0, 3700)}\n\n（批次 ${i + 1}/${n}：這個工作流程只處理〈${item.title.slice(0, 200)}〉這一篇。）`;

/**
 * Whether the assistant may act on this artifact (scenario matrix g22: with no deck open the assistant searched, picked an
 * unrelated deck and proposed deleting its page). Grounded = the conversation's own artifact (a page it was on, a workflow
 * of this conversation wrote or edited it, a create_* tool of this conversation made it) or the user's words name its
 * title exactly; otherwise the assistant must ask which one is meant. Calls outside a conversation are not checked.
 */
export async function artifactGrounded(db: Queryable, conversationId: string | null | undefined, userId: string, kind: "deck" | "note" | "latex_project", id: string): Promise<boolean> {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(id)) return true;
  const pageKey = kind === "deck" ? "deckId" : kind === "note" ? "noteId" : "projectId";
  const inputKey = kind === "deck" ? "deck_id" : kind === "note" ? "note_ids" : "project_id";
  const row = (await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM conversations c WHERE c.id=$1 AND c.context->>$3 = $2)
         OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversation_id=$1 AND m.role='user' AND m.page_context->>$3 = $2)
         OR EXISTS (SELECT 1 FROM workflow_runs r WHERE r.conversation_id=$1 AND r.user_id=$4 AND (r.artifacts @> jsonb_build_array(jsonb_build_object('id', $2::text)) OR r.inputs->>$5 = $2 OR r.inputs->$5 ? $2))
         OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversation_id=$1 AND m.role='tool' AND m.content::text LIKE '%' || $2 || '%' AND m.content::text LIKE '%tool=\\"create\\_%' ESCAPE '\\') AS ok`,
    [conversationId, id, pageKey, userId, inputKey],
  ).catch(() => ({ rows: [{ ok: true }] }))).rows[0];
  if (row?.ok) return true;
  const table = kind === "deck" ? "decks" : kind === "note" ? "notes" : "latex_projects";
  const title = (await db.query<{ title: string }>(`SELECT title FROM ${table} WHERE id=$1`, [id]).catch(() => ({ rows: [] as { title: string }[] }))).rows[0]?.title ?? "";
  const norm = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (norm(title).length < 6) return false;
  const said = (await db.query<{ text: string }>("SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' AND hidden_by IS NULL ORDER BY seq DESC LIMIT 6", [conversationId]).catch(() => ({ rows: [] as { text: string }[] }))).rows.map((r) => norm(r.text ?? "")).join("|");
  return said.includes(norm(title));
}
export const UNGROUNDED_TARGET = "這份成果不是這個對話裡的成果（不是使用者開著的頁面、不是這個對話的工作流程或工具建立的），使用者也沒有說出它的標題：不要對用搜尋或列表挑出來的成果動手。先用 ask_user 問使用者要改哪一份（列出候選的標題），或請使用者打開那份成果再說一次。";
