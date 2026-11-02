/**
 * A deck that stops compiling after an AI suggestion goes back to the AI (production 61666f10: the user accepted the
 * assistant's cover edit, the preview failed with `duplicated mapping key`, and nothing told the assistant).
 *
 * - `renderDiagnosis`: the newest failed preview of a deck, its error (ANSI codes stripped), the structural problems of
 *   the current entry file (source-lint.ts) and the suggestions applied since the last preview that compiled — the
 *   `get_deck_render_error` tool and the follow-up turn read it.
 * - `renderFailureFollowUp` (slide_preview finalizer, after commit): when the failing revision follows an AI suggestion
 *   from a conversation, a notice goes into that conversation and an automatic `fix_render` turn asks the assistant to
 *   find the cause and suggest a fix — once per failing revision, ≤ 2 automatic turns per deck and conversation in
 *   6 hours, never while a workflow is writing the deck (its own render-fix loop handles that).
 */
import type { FastifyInstance } from "fastify";
import type { Queryable } from "../../db.js";
import { insertEvent } from "../../agent/events.js";
import { messageView, type MessageRow } from "../../agent/views.js";
import { CURRENT_USER_COLUMNS, toCurrentUser } from "../auth.js";
import { sourceProblems } from "./source-lint.js";

/** Quarto / Chrome logs carry ANSI colours (`[91mERROR`): plain text for people and models. */
export const plainLog = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[(?:\d{1,3};?)+m/g, "");

export type RenderDiagnosis = {
  deck: { id: string; title: string; study_slug: string };
  status: "failed" | "ready" | "queued" | "none";
  revision: number | null;
  error: string | null;
  /** Structural problems of the current entry file (YAML, unclosed blocks): the usual cause, located by line. */
  problems: string[];
  /** Applied since the last preview that compiled (newest first). */
  changes: { suggestion_id: string; title: string; by: "ai" | "user"; conversation_id: string | null; decided_at: string }[];
};

/** The deck's newest preview and, when it failed, what probably broke it. */
export async function renderDiagnosis(db: Queryable, deckId: string): Promise<RenderDiagnosis | null> {
  const deck = (await db.query<{ id: string; title: string; slug: string; entry: string | null }>(
    `SELECT d.id, d.title, s.slug, t.entry FROM decks d JOIN studies s ON s.id=d.study_id LEFT JOIN deck_source_trees t ON t.deck_id=d.id WHERE d.id=$1`,
    [deckId],
  )).rows[0];
  if (!deck) return null;
  const last = (await db.query<{ status: string; revision: number; error: string | null; created_at: string }>(
    "SELECT status, revision, error, created_at FROM deck_previews WHERE deck_id=$1 AND status IN ('failed','ready','queued') ORDER BY created_at DESC LIMIT 1",
    [deckId],
  )).rows[0];
  const ready = (await db.query<{ created_at: string }>("SELECT max(created_at) AS created_at FROM deck_previews WHERE deck_id=$1 AND status='ready'", [deckId])).rows[0]?.created_at ?? null;
  const entry = deck.entry ? (await db.query<{ path: string; content: string | null }>("SELECT path, content FROM deck_sources WHERE deck_id=$1 AND path=$2", [deckId, deck.entry])).rows[0] : undefined;
  const changes = last?.status === "failed"
    ? (await db.query<{ id: string; title: string; source: string; created_by_conversation: string | null; decided_at: string }>(
      `SELECT s.id, s.title, s.source, s.created_by_conversation, s.decided_at FROM suggestions s JOIN deck_sources f ON f.id::text=s.target_id
        WHERE s.target_type='deck_source' AND f.deck_id=$1 AND s.status IN ('applied','partial') AND s.decided_at IS NOT NULL
          AND s.decided_at >= coalesce($2::timestamptz, now() - interval '1 day') AND s.decided_at <= $3::timestamptz + interval '10 seconds'
        ORDER BY s.decided_at DESC LIMIT 6`,
      [deckId, ready, last.created_at],
    )).rows
    : [];
  return {
    deck: { id: deck.id, title: deck.title, study_slug: deck.slug },
    status: (last?.status as RenderDiagnosis["status"] | undefined) ?? "none",
    revision: last?.revision ?? null,
    error: last?.status === "failed" ? plainLog(last.error ?? "").slice(-3000) : null,
    problems: last?.status === "failed" && entry?.content != null ? sourceProblems(entry.path, entry.content).map((p) => `${entry.path}：${p}`) : [],
    changes: changes.map((c) => ({ suggestion_id: c.id, title: c.title, by: c.source === "ai" || c.source === "autopilot" ? "ai" : "user", conversation_id: c.created_by_conversation, decided_at: c.decided_at })),
  };
}

/** The turn an automatic follow-up posts in the user's name: marked 〔自動〕 so it never reads as something they typed. */
export const FIX_RENDER_TEXT = "〔自動〕簡報編譯失敗了，請找出原因並提出修正。";

const AUTO_LIMIT = 2;

/** Slide-preview finalizer, after commit: a failure that follows an AI suggestion goes back to its conversation. */
export async function renderFailureFollowUp(app: FastifyInstance, deckId: string, previewId: string): Promise<void> {
  const db = app.db;
  const p = (await db.query<{ revision: number; created_at: string; error: string | null }>("SELECT revision, created_at, error FROM deck_previews WHERE id=$1 AND status='failed'", [previewId])).rows[0];
  if (!p) return;
  // A newer preview already compiled / is on its way, or a workflow is writing the deck (it fixes its own render errors).
  // (A queued duplicate of the same revision — accepting a suggestion and the editor both ask for one — does not count:
  // it fails the same way and the revision is posted once.)
  const newer = (await db.query("SELECT 1 FROM deck_previews WHERE deck_id=$1 AND created_at > $2 AND (status='ready' OR (status='queued' AND revision > $3)) LIMIT 1", [deckId, p.created_at, p.revision])).rowCount;
  if (newer) return;
  const writing = (await db.query(
    "SELECT 1 FROM workflow_runs WHERE status NOT IN ('done','partial','failed','cancelled') AND artifacts @> jsonb_build_array(jsonb_build_object('kind','deck','id',$1::text)) LIMIT 1",
    [deckId],
  )).rowCount;
  if (writing) return;
  const diag = await renderDiagnosis(db, deckId);
  const cause = diag?.changes.find((c) => c.by === "ai" && c.conversation_id);
  if (!diag || !cause?.conversation_id) return;
  const conv = (await db.query<{ id: string; user_id: string }>("SELECT id, user_id FROM conversations WHERE id=$1", [cause.conversation_id])).rows[0];
  if (!conv) return;
  const earlier = (await db.query<{ revision: number }>(
    `SELECT (b->>'revision')::int AS revision FROM agent_messages m, jsonb_array_elements(m.content) b
      WHERE m.conversation_id=$1 AND m.role='notice' AND b->>'kind'='deck_render_failed' AND b->>'deckId'=$2 AND m.created_at > now() - interval '6 hours'`,
    [conv.id, deckId],
  )).rows;
  if (earlier.some((e) => e.revision === p.revision)) return;
  const auto = earlier.length < AUTO_LIMIT;
  const first = (diag.problems[0] ?? plainLog(p.error ?? "").split("\n").find((l) => /error|錯誤/i.test(l)) ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const text = auto
    ? `接受 AI 的建議「${cause.title}」後，簡報〈${diag.deck.title}〉編譯失敗${first ? `（${first}）` : ""}。已請助理找出原因並提出修正。`
    : `簡報〈${diag.deck.title}〉又編譯失敗了${first ? `（${first}）` : ""}。助理已經自動修過 ${AUTO_LIMIT} 次，這次不再自動處理；可以在預覽的錯誤訊息旁按「請 AI 找出問題」。`;
  const m = (await db.query<MessageRow>(
    "INSERT INTO agent_messages(conversation_id,role,content,text) VALUES($1,'notice',$2,$3) RETURNING *",
    [conv.id, JSON.stringify([{ type: "notice", kind: "deck_render_failed", deckId, previewId, revision: p.revision, suggestionId: cause.suggestion_id, auto, model: true }]), text],
  )).rows[0]!;
  await insertEvent(db, conv.id, null, "message", { message: messageView(m) });
  if (!auto) return;
  const row = (await db.query(`SELECT ${CURRENT_USER_COLUMNS} FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL`, [conv.user_id])).rows[0];
  if (!row) return;
  const { agentFor } = await import("../../agent/runtime.js");
  await agentFor(app).postMessage(toCurrentUser(row), conv.id, { text: FIX_RENDER_TEXT, intent: "fix_render", context: { path: `/studies/${diag.deck.study_slug}/decks/${deckId}/edit`, deckId, studySlug: diag.deck.study_slug } });
}
