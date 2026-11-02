/**
 * Locating the text an edit replaces, for every edit tool (deck / LaTeX / note). Harness survey: Aider matches a
 * SEARCH block with flexible whitespace and, on a miss, answers with the closest real lines ("did you mean"); SWE-agent
 * shows the file window again. A bare 「找不到」 left the model guessing (production 64876e38: six failed edits in a row
 * with text from its own pending suggestion, text the user had already replaced, and text it never wrote to the file).
 *
 *   1. an exact, unique match;
 *   2. the same text up to whitespace / line breaks (unique) → the file's own text is used;
 *   3. several matches → the deck pages / lines where it occurs (decks: `page` picks one);
 *   4. no match → why (its text is a pending suggestion of this conversation that was not accepted yet, or an applied
 *      one replaced it) and the closest passage the file has now, so the next attempt can use the real text.
 */
import type { Queryable } from "../../db.js";
import { badRequest, conflict } from "../http.js";
import { deckPageOfOffset } from "./view.js";

export type EditSpec = { before: string; after: string; page?: number };
export type LocatedHunk = { from: number; to: number; before: string; after: string };
/** Suggestions of the same target that explain a miss (newest first). */
export type SuggestionTrail = { title: string; status: string; mine: boolean; hunks: { before: string; after: string; state?: string }[] };
export type LocateOpts = {
  /** "deck": occurrences are named by player page and `page` scopes the match. */
  kind: "deck" | "latex" | "note";
  /** The read tool to name in errors, e.g. "get_deck". */
  reread: string;
  trail?: SuggestionTrail[];
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** Matches of `needle` ignoring whitespace differences: [from, to) ranges in `text`. */
export function looseMatches(text: string, needle: string): [number, number][] {
  const words = needle.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(esc.join("\\s+"), "g");
  const out: [number, number][] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

const bigrams = (s: string) => {
  const t = s.toLowerCase().replace(/\s+/g, " ");
  const out = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
  return out;
};
function dice(a: Map<string, number>, b: Map<string, number>, na: number, nb: number) {
  if (!na || !nb) return 0;
  let both = 0;
  for (const [k, n] of a) both += Math.min(n, b.get(k) ?? 0);
  return (2 * both) / (na + nb);
}

/** The passage of `text` most like `needle` (same number of lines, ±2 lines of context) with its 1-based first line. */
export function closestPassage(text: string, needle: string): { line: number; offset: number; text: string; score: number } | null {
  const lines = text.split("\n");
  const span = Math.max(1, Math.min(needle.split("\n").length, 40));
  const want = bigrams(needle);
  const nw = [...want.values()].reduce((x, y) => x + y, 0);
  let best = { at: -1, score: 0 };
  for (let i = 0; i + span <= Math.max(lines.length, span); i++) {
    const win = lines.slice(i, i + span).join("\n");
    const got = bigrams(win);
    const score = dice(want, got, nw, [...got.values()].reduce((x, y) => x + y, 0));
    if (score > best.score) best = { at: i, score };
  }
  if (best.at < 0 || best.score < 0.25) return null;
  const from = Math.max(0, best.at - 2);
  // `offset`: where the matching window itself starts (its page), not the context above it.
  const offset = lines.slice(0, best.at).reduce((n, l) => n + l.length + 1, 0);
  return { line: from + 1, offset, text: lines.slice(from, Math.min(lines.length, best.at + span + 2)).join("\n"), score: best.score };
}

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** Why `before` is not in the file, from this target's suggestion trail. */
function missReason(before: string, trail: SuggestionTrail[]): string | null {
  const key = oneLine(before);
  if (key.length < 8) return null;
  const has = (s: string) => oneLine(s).includes(key) || (key.length > 40 && oneLine(s).includes(key.slice(0, 40)));
  for (const s of trail) {
    if (s.status === "pending" || s.status === "partial") {
      if (s.hunks.some((h) => h.state !== "accepted" && has(h.after)))
        return `這段是${s.mine ? "你" : ""}還沒被接受的建議〈${s.title}〉裡的新文字；使用者還沒接受，檔案裡現在不是這樣。before 必須用檔案目前的原文`;
    }
    if (s.status === "applied" || s.status === "partial") {
      if (s.hunks.some((h) => h.state !== "rejected" && has(h.before) && !has(h.after)))
        return `這段原文已經被使用者接受的建議〈${s.title}〉改掉了，檔案裡現在是改過的版本`;
    }
  }
  return null;
}

/**
 * Locates every edit in `text` (throws an actionable HttpError otherwise). Edits must not overlap each other.
 */
export function locateEdits(text: string, edits: EditSpec[], opts: LocateOpts): LocatedHunk[] {
  const hunks = edits.map((e) => locateOne(text, e, opts));
  const sorted = [...hunks].sort((x, y) => x.from - y.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from < sorted[i - 1]!.to) throw badRequest(`有兩個 edits 改到同一段文字（第 ${lineOf(text, sorted[i]!.from)} 行附近）：合併成一個 edit 再提一次。`);
  }
  return hunks;
}

function locateOne(text: string, e: EditSpec, opts: LocateOpts): LocatedHunk {
  const deck = opts.kind === "deck";
  // The page of the line `at` is on (a passage starting at a `## ` heading belongs to that heading's page).
  const pageAt = (at: number) => deckPageOfOffset(text, text.indexOf("\n", at) >= 0 ? text.indexOf("\n", at) : text.length);
  const where = (at: number) => (deck ? `第 ${pageAt(at)} 頁` : `第 ${lineOf(text, at)} 行`);
  const inPage = (at: number) => !deck || !e.page || pageAt(at) === e.page;
  const hunk = (from: number, to: number): LocatedHunk => ({ from, to, before: text.slice(from, to), after: e.after });

  let ranges: [number, number][] = occurrences(text, e.before).map((at) => [at, at + e.before.length]);
  if (!ranges.length) ranges = looseMatches(text, e.before);
  const scoped = ranges.filter(([at]) => inPage(at));
  if (scoped.length === 1) return hunk(...scoped[0]!);
  if (scoped.length > 1 || (ranges.length > 1 && !scoped.length && !e.page)) {
    const list = [...new Set((scoped.length ? scoped : ranges).map(([at]) => where(at)))].join("、");
    throw badRequest(`這段文字出現 ${(scoped.length || ranges.length)} 次（${list}）：「${clip(oneLine(e.before), 40)}」。${deck ? "加上 page 指定要改哪一頁，或" : ""}把 before 擴大到包含那一處獨有的前後文字。`);
  }
  if (ranges.length && e.page) {
    throw conflict(`第 ${e.page} 頁沒有這段文字（它在${[...new Set(ranges.map(([at]) => where(at)))].join("、")}）：「${clip(oneLine(e.before), 40)}」。確認頁碼或改用那一頁的原文。`);
  }
  const parts = [`檔案中找不到這段文字：「${clip(oneLine(e.before), 50)}」。`];
  const reason = missReason(e.before, opts.trail ?? []);
  if (reason) parts.push(`${reason}。`);
  const near = closestPassage(text, e.before);
  if (near) parts.push(`檔案目前最接近的是${deck ? `${where(near.offset)}（` : "（"}第 ${near.line} 行起）：\n<<<\n${clip(near.text, 1500)}\n>>>\n用這段的原文（逐字）當 before 再提一次。`);
  else parts.push(`請先用 ${opts.reread} 讀取目前內容，before 要逐字取自檔案。`);
  throw conflict(parts.join(""));
}

/** The suggestion trail of a target (this conversation's own marked `mine`), newest first, for miss explanations. */
export async function suggestionTrail(db: Queryable, targetType: string, targetId: string, conversationId: string | null): Promise<SuggestionTrail[]> {
  const rows = (await db.query<{ title: string; status: string; hunks: unknown; created_by_conversation: string | null }>(
    "SELECT title, status, hunks, created_by_conversation FROM suggestions WHERE target_type=$1 AND target_id=$2 ORDER BY created_at DESC LIMIT 20",
    [targetType, targetId],
  )).rows;
  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    mine: !!conversationId && r.created_by_conversation === conversationId,
    hunks: (Array.isArray(r.hunks) ? r.hunks : []).map((h: { before?: unknown; after?: unknown; state?: unknown }) => ({ before: String(h.before ?? ""), after: String(h.after ?? ""), state: typeof h.state === "string" ? h.state : undefined })),
  }));
}
