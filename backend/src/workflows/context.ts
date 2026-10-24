/**
 * Where a new workflow works (docs/architecture.md "Workflows" → Context and batches):
 * - **Context inheritance**: the study / paper come from the explicit inputs, then the page context, then the
 *   conversation (its scoped study, its latest page context, the page context of its recent user messages), then a
 *   study named in the request (title / slug words of a study the user edits), then the user's only active study — so
 *   a run started from a chat that is clearly about one study never asks 「要把簡報放在哪個研究？」.
 * - **Batches**: a per-paper playbook (slides, reading note) asked for 「每一篇文獻」 (or given several `paper_ids`)
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
 * The papers a batch covers, or null for a single run: explicit `paper_ids` (≥ 2), or the study's papers when the
 * request asks for each of them (no single `paper_id` given). Papers in the study's order (oldest first), ≤ MAX_BATCH.
 */
export async function batchPapers(db: Queryable, input: { playbook: string; request: string; studyId: string | null; paperId?: string; paperIds?: string[]; userText?: string }): Promise<BatchItem[] | null> {
  if (!PER_PAPER_PLAYBOOKS.has(input.playbook)) return null;
  // One artifact per paper only when the user's OWN words ask for it (「每一篇各做一份」); several paper_ids from the
  // assistant otherwise are the sources of ONE deck / note (production: 5 paper ids → 5 paper-report decks).
  const asked = EACH_PAPER_RE.test(input.userText ?? input.request);
  if (!asked) return null;
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
