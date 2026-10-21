/**
 * Suggestions: proposed edits to a text target, reviewed hunk by hunk (docs/editor-collab.md).
 *
 *   const s = await createSuggestion(deps, { targetType: "note", targetId, proposedText, title: "AI 改寫", source: "ai", actorId: user.id });
 *   await decideSuggestion(deps, { suggestionId: s.id, hunkIds: "all", decision: "accept", actorId: user.id });
 *   await applySuggestionNow(deps, { ...createInput, source: "autopilot" });   // agent autopilot: create + accept all
 *
 * For Yjs targets the hunks are anchored with Y.RelativePosition, so they follow concurrent edits; accepting
 * applies the hunk inside a server-side Yjs transaction (every connected editor sees it) and is stale when the
 * anchored text no longer equals the hunk's `before`. Deciding needs the collab server (backend process).
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import * as Y from "yjs";
import { transaction, type Db, type Queryable } from "../../db.js";
import type { CollabServer } from "../../collab/server.js";
import { readStoredDoc } from "../../collab/server.js";
import { anchorRange, docText, resolveRange, TEXT_FIELD } from "../../collab/text.js";
import type { CurrentUser } from "../auth.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http.js";
import { computeHunks, locate, type RawHunk } from "./diff.js";
import { suggestionTarget, type ResolvedTarget, type SuggestionSource, type SuggestionTarget } from "./targets.js";

export type HunkStatus = "pending" | "accepted" | "rejected";
export type StoredHunk = RawHunk & {
  id: string;
  status: HunkStatus;
  /** Base64 Y.RelativePosition anchors (Yjs targets only). */
  start?: string;
  end?: string;
  decided_by?: string | null;
  decided_at?: string | null;
};
export type HunkView = StoredHunk & {
  /** `stale`: pending, but the anchored text changed (can only be rejected). */
  state: HunkStatus | "stale";
  /** Where the hunk is now (pending hunks that still apply); null otherwise. */
  current: { from: number; to: number } | null;
};
export type SuggestionStatus = "pending" | "applied" | "partial" | "rejected";
export type SuggestionView = {
  id: string;
  target_type: string;
  target_id: string;
  study_id: string | null;
  doc_name: string | null;
  title: string;
  source: SuggestionSource;
  base_version: number | null;
  status: SuggestionStatus;
  created_by: string | null;
  creator_name: string | null;
  created_by_conversation: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  url: string | null;
  hunks: HunkView[];
  /** Pending hunks that can still be accepted. */
  pending: number;
  stale: number;
};

export type SuggestionDeps = { db: Db; collab?: CollabServer | null };

export type CreateSuggestionInput = {
  targetType: string;
  targetId: string;
  /** Full proposed text (diffed against the current text), or explicit hunks against the current text. */
  proposedText?: string;
  hunks?: { from: number; to: number; after: string; before?: string }[];
  title?: string;
  source?: SuggestionSource;
  actorId: string | null;
  conversationId?: string | null;
  /** When given, the user must be allowed to edit the target (403 otherwise). */
  user?: CurrentUser;
};

type Row = Omit<SuggestionView, "hunks" | "pending" | "stale" | "url"> & { hunks: StoredHunk[] };

const MAX_HUNKS = 200;
const COLUMNS = `s.id,s.target_type,s.target_id,s.study_id,s.doc_name,s.title,s.source,s.base_version,s.status,s.created_by,
  u.name AS creator_name,s.created_by_conversation,s.created_at,s.updated_at,s.decided_at,s.hunks`;

function targetOf(type: string): SuggestionTarget {
  const target = suggestionTarget(type);
  if (!target) throw badRequest("不支援的建議對象。");
  return target;
}

async function resolveTarget(db: Queryable, type: string, id: string) {
  const target = targetOf(type);
  const resolved = await target.resolve(db, id);
  if (!resolved) throw notFound("找不到要修改的內容。");
  return { target, resolved };
}

/** Text of a Yjs document (live copy when the server has it open) via `read`. */
async function withDoc<T>(deps: SuggestionDeps, name: string, read: (doc: Y.Doc) => T): Promise<T> {
  const result = deps.collab ? await deps.collab.readDoc(name, read) : await readStoredDoc(deps.db, name, read);
  if (result === null) {
    // No state yet (never opened): an empty document, as the namespace would create it.
    const doc = new Y.Doc();
    try {
      return read(doc);
    } finally {
      doc.destroy();
    }
  }
  return result;
}

function normaliseHunks(text: string, input: CreateSuggestionInput): RawHunk[] {
  if (input.proposedText !== undefined) {
    if (input.proposedText.length > 500_000) throw badRequest("建議內容太長。");
    return computeHunks(text, input.proposedText);
  }
  const hunks = (input.hunks ?? []).map((h) => {
    if (!Number.isInteger(h.from) || !Number.isInteger(h.to) || h.from < 0 || h.to < h.from || h.to > text.length) throw badRequest("建議的位置超出內容範圍。");
    const before = text.slice(h.from, h.to);
    if (h.before !== undefined && h.before !== before) throw conflict("內容已經變更，請重新選取後再試。");
    return { from: h.from, to: h.to, before, after: h.after };
  });
  hunks.sort((a, b) => a.from - b.from);
  for (let i = 1; i < hunks.length; i++) if (hunks[i]!.from < hunks[i - 1]!.to) throw badRequest("建議的段落重疊。");
  return hunks.filter((h) => h.before !== h.after);
}

/** Creates a suggestion against the current text of the target. 400 when it changes nothing. */
export async function createSuggestion(deps: SuggestionDeps, input: CreateSuggestionInput): Promise<SuggestionView> {
  const { target, resolved } = await resolveTarget(deps.db, input.targetType, input.targetId);
  if (input.user && !(await target.canEdit(deps.db, input.user, resolved))) throw forbidden("只有研究成員可以修改。");
  let hunks: StoredHunk[];
  if (resolved.docName) {
    hunks = await withDoc(deps, resolved.docName, (doc) => {
      const ytext = doc.getText(TEXT_FIELD);
      return normaliseHunks(ytext.toString(), input).map((h) => ({ ...h, id: randomUUID(), status: "pending" as const, ...anchorRange(ytext, h.from, h.to) }));
    });
  } else {
    if (!target.readText) throw badRequest("不支援的建議對象。");
    const text = await target.readText(deps.db, input.targetId);
    hunks = normaliseHunks(text, input).map((h) => ({ ...h, id: randomUUID(), status: "pending" as const }));
  }
  if (!hunks.length) throw badRequest("建議內容與目前內容相同。");
  if (hunks.length > MAX_HUNKS) throw badRequest(`建議的修改太多處（上限 ${MAX_HUNKS}）。`);
  const id = (
    await deps.db.query<{ id: string }>(
      `INSERT INTO suggestions(target_type,target_id,study_id,doc_name,title,source,base_version,hunks,created_by,created_by_conversation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.targetType, input.targetId, resolved.studyId, resolved.docName, (input.title ?? "").slice(0, 200), input.source ?? "user",
        resolved.version ?? null, JSON.stringify(hunks), input.actorId, input.conversationId ?? null,
      ],
    )
  ).rows[0]!.id;
  if (resolved.docName) deps.collab?.broadcast(resolved.docName, { type: "suggestions", id });
  return (await getSuggestion(deps, id))!;
}

async function loadRows(db: Queryable, where: string, params: unknown[], lock = false): Promise<Row[]> {
  return (await db.query<Row>(`SELECT ${COLUMNS} FROM suggestions s LEFT JOIN users u ON u.id=s.created_by WHERE ${where} ORDER BY s.created_at DESC${lock ? " FOR UPDATE OF s" : ""}`, params)).rows;
}

/** Adds live hunk states (current position / stale) to rows of one target. */
async function viewRows(deps: SuggestionDeps, rows: Row[], resolved: ResolvedTarget | null, targetType: string, targetId: string): Promise<SuggestionView[]> {
  if (!rows.length) return [];
  const decorate = (row: Row, place: (h: StoredHunk) => { from: number; to: number } | null): SuggestionView => {
    const hunks = row.hunks.map((h): HunkView => {
      if (h.status !== "pending") return { ...h, state: h.status, current: null };
      const current = place(h);
      return { ...h, state: current ? "pending" : "stale", current };
    });
    return {
      ...row,
      url: resolved?.url ?? null,
      hunks,
      pending: hunks.filter((h) => h.state === "pending").length,
      stale: hunks.filter((h) => h.state === "stale").length,
    };
  };
  if (!resolved) return rows.map((row) => decorate(row, () => null));
  if (resolved.docName) {
    return withDoc(deps, resolved.docName, (doc) => {
      const text = docText(doc);
      return rows.map((row) => decorate(row, (h) => placeAnchored(doc, text, h)));
    });
  }
  const target = targetOf(targetType);
  const text = target.readText ? await target.readText(deps.db, targetId) : "";
  return rows.map((row) => decorate(row, (h) => locate(text, h)));
}

/** Current range of a pending anchored hunk when it still applies. */
function placeAnchored(doc: Y.Doc, text: string, h: StoredHunk): { from: number; to: number } | null {
  if (!h.start || !h.end) return locate(text, h);
  const range = resolveRange(doc, { start: h.start, end: h.end });
  if (!range) return null;
  if (!h.before) return range.from >= range.to ? { from: range.to, to: range.to } : null;
  if (range.to < range.from) return null;
  return text.slice(range.from, range.to) === h.before ? range : null;
}

export async function getSuggestion(deps: SuggestionDeps, id: string): Promise<SuggestionView | null> {
  const row = (await loadRows(deps.db, "s.id=$1", [id]))[0];
  if (!row) return null;
  const target = suggestionTarget(row.target_type);
  const resolved = target ? await target.resolve(deps.db, row.target_id) : null;
  return (await viewRows(deps, [row], resolved, row.target_type, row.target_id))[0]!;
}

/** Suggestions of a target, newest first (`status` filters; default pending only). */
export async function listSuggestions(deps: SuggestionDeps, targetType: string, targetId: string, status: SuggestionStatus | "all" = "pending"): Promise<SuggestionView[]> {
  const { resolved } = await resolveTarget(deps.db, targetType, targetId);
  const rows = await loadRows(deps.db, `s.target_type=$1 AND s.target_id=$2${status === "all" ? "" : " AND s.status=$3"}`, status === "all" ? [targetType, targetId] : [targetType, targetId, status]);
  return viewRows(deps, rows, resolved, targetType, targetId);
}

/** May `user` review suggestions of this target? */
export async function canReview(deps: SuggestionDeps, user: CurrentUser, targetType: string, targetId: string) {
  const { target, resolved } = await resolveTarget(deps.db, targetType, targetId);
  return target.canEdit(deps.db, user, resolved);
}

const overall = (hunks: StoredHunk[]): SuggestionStatus => {
  if (hunks.some((h) => h.status === "pending")) return "pending";
  const accepted = hunks.filter((h) => h.status === "accepted").length;
  return accepted === hunks.length ? "applied" : accepted ? "partial" : "rejected";
};

export type DecideInput = {
  suggestionId: string;
  /** Hunks to decide; "all" = every pending hunk (stale ones are skipped when accepting). */
  hunkIds: string[] | "all";
  decision: "accept" | "reject";
  actorId: string | null;
  /** When given, must be allowed to edit the target. */
  user?: CurrentUser;
  /** Version tag for accepted changes (default: the suggestion's source). */
  source?: SuggestionSource;
};

/**
 * Accepts or rejects hunks. Accepting applies them to the live document (Yjs) or text; a single stale hunk → 409.
 * Returns the updated suggestion plus how many hunks were applied and skipped (stale, with "all").
 */
export async function decideSuggestion(deps: SuggestionDeps, input: DecideInput): Promise<{ suggestion: SuggestionView; applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  let docName: string | null = null;
  await transaction(deps.db, async (client) => {
    const row = (await loadRows(client, "s.id=$1", [input.suggestionId], true))[0];
    if (!row) throw notFound("建議不存在。");
    const { target, resolved } = await resolveTarget(client, row.target_type, row.target_id);
    if (input.user && !(await target.canEdit(client, input.user, resolved))) throw forbidden("只有研究成員可以處理建議。");
    docName = resolved.docName;
    const chosen = row.hunks.filter((h) => h.status === "pending" && (input.hunkIds === "all" || input.hunkIds.includes(h.id)));
    if (input.hunkIds !== "all" && chosen.length !== input.hunkIds.length) throw conflict("這段建議已經處理過了。");
    const now = new Date().toISOString();
    const mark = (h: StoredHunk, status: HunkStatus) => Object.assign(h, { status, decided_by: input.actorId, decided_at: now });

    if (input.decision === "reject") {
      for (const h of chosen) mark(h, "rejected");
    } else {
      const single = input.hunkIds !== "all";
      let text: string;
      if (resolved.docName) {
        if (!deps.collab) throw new HttpError(503, "協作服務尚未啟動，請稍後再試。");
        text = await deps.collab.edit(resolved.docName, input.actorId, (doc, ytext) => {
          for (const h of chosen) {
            const place = placeAnchored(doc, ytext.toString(), h);
            if (!place) {
              skipped++;
              continue;
            }
            if (place.to > place.from) ytext.delete(place.from, place.to - place.from);
            if (h.after) ytext.insert(place.from, h.after);
            mark(h, "accepted");
            applied++;
          }
          return ytext.toString();
        });
      } else {
        if (!target.readText || !target.writeText) throw badRequest("不支援的建議對象。");
        text = await target.readText(client, row.target_id);
        // Apply from the end so earlier offsets stay valid; later pending hunks are shifted afterwards.
        const placed = chosen.map((h) => ({ h, at: locate(text, h) })).sort((a, b) => (b.at?.from ?? 0) - (a.at?.from ?? 0));
        for (const { h, at } of placed) {
          if (!at) {
            skipped++;
            continue;
          }
          text = text.slice(0, at.from) + h.after + text.slice(at.to);
          const delta = h.after.length - (at.to - at.from);
          for (const other of row.hunks) if (other !== h && other.status === "pending" && other.from >= at.to) Object.assign(other, { from: other.from + delta, to: other.to + delta });
          mark(h, "accepted");
          applied++;
        }
        if (applied) await target.writeText(client, row.target_id, text, input.actorId);
      }
      if (single && skipped) throw conflict("這段內容已被修改，無法套用建議。");
      if (applied && target.afterApply) {
        const source = input.source ?? row.source;
        await target.afterApply(client, row.target_id, { text, accepted: applied, source, actorId: input.actorId, suggestion: { id: row.id, title: row.title, source: row.source } });
      }
    }
    const status = overall(row.hunks);
    await client.query("UPDATE suggestions SET hunks=$2, status=$3, updated_at=now(), decided_at=CASE WHEN $3='pending' THEN NULL ELSE now() END WHERE id=$1", [
      row.id, JSON.stringify(row.hunks), status,
    ]);
  });
  if (docName) deps.collab?.broadcast(docName, { type: "suggestions", id: input.suggestionId });
  return { suggestion: (await getSuggestion(deps, input.suggestionId))!, applied, skipped };
}

/**
 * Autopilot: creates the suggestion and accepts every hunk at once (versions are tagged `autopilot`, so the change
 * can be restored from history). Backend only (needs the collab server for Yjs targets).
 */
export async function applySuggestionNow(deps: SuggestionDeps, input: CreateSuggestionInput) {
  const created = await createSuggestion(deps, { ...input, source: input.source ?? "autopilot" });
  return decideSuggestion(deps, { suggestionId: created.id, hunkIds: "all", decision: "accept", actorId: input.actorId, user: input.user, source: input.source ?? "autopilot" });
}

/** Removes every suggestion of a target (call when the target is deleted). */
export async function deleteSuggestionsOf(client: Queryable | pg.PoolClient, targetType: string, targetId: string) {
  await client.query("DELETE FROM suggestions WHERE target_type=$1 AND target_id=$2", [targetType, targetId]);
}
