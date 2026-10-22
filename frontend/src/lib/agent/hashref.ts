/**
 * 「#」 references in the assistant composer: typing `#` opens a menu of kinds (簡報, 文獻, 筆記…; English keywords
 * too), `#簡報 週報` / `#slides weekly` searches items of that kind (`GET /api/agent/attach/lookup`), and picking one
 * adds a chip. Chips of attachable kinds are sent as attachment refs; a study or a task goes into the page context
 * (`studyId` / `taskId`). Pure helpers; the menu is `components/agent/attach/HashMenu.svelte`.
 */
import type { PageContext } from "./types.ts";

export type RefKind = "deck" | "paper" | "note" | "meeting" | "latex_project" | "study" | "task";

/** Menu order; `aliases` are matched case-insensitively (the first is the label, the first ASCII one the English keyword). */
export const REF_KINDS: readonly { kind: RefKind; aliases: readonly string[] }[] = [
  { kind: "deck", aliases: ["簡報", "投影片", "slides", "slide", "deck", "decks"] },
  { kind: "paper", aliases: ["文獻", "論文", "paper", "papers", "literature", "lit"] },
  { kind: "note", aliases: ["筆記", "note", "notes"] },
  { kind: "meeting", aliases: ["會議", "meeting", "meetings"] },
  { kind: "latex_project", aliases: ["LaTeX", "論文專案", "論文稿", "latex", "tex", "thesis", "manuscript"] },
  { kind: "study", aliases: ["研究", "study", "studies"] },
  { kind: "task", aliases: ["任務", "待辦", "task", "tasks", "todo"] },
];

/** Kinds that travel as attachment refs (the rest become page context). */
export const ATTACHABLE: ReadonlySet<RefKind> = new Set(["deck", "paper", "note", "meeting", "latex_project"]);

const MAX_TOKEN = 60;
const isCjk = (ch: string) => /[　-鿿豈-﫿＀-￯]/.test(ch);

/** The `#…` being typed: from the `#` up to the caret. `#` must start a word (not `C#`, `a#b` or `&#`). */
export type HashToken = { start: number; end: number; raw: string };
export function activeHash(text: string, caret: number): HashToken | null {
  if (caret < 1 || caret > text.length) return null;
  const from = Math.max(0, caret - MAX_TOKEN - 1);
  const at = text.lastIndexOf("#", caret - 1);
  if (at < from) return null;
  const raw = text.slice(at + 1, caret);
  if (/[\n#]/.test(raw) || /\s{2,}$/.test(raw) || /^\s/.test(raw)) return null;
  const before = at > 0 ? text[at - 1]! : "";
  if (before && /[A-Za-z0-9_&/#]/.test(before)) return null;
  return { start: at, end: caret, raw };
}

export type ParsedHash = { kind: RefKind | null; kindText: string; query: string };
/**
 * `簡報 週報` / `簡報週報` / `slides weekly` / `slides:weekly` → kind + query. An English keyword needs a word boundary
 * (`#paperless` is no kind); a CJK one may run straight into the query.
 */
export function parseHash(raw: string): ParsedHash {
  const lower = raw.toLowerCase();
  const all = REF_KINDS.flatMap((k) => k.aliases.map((a) => ({ kind: k.kind, alias: a }))).sort((a, b) => b.alias.length - a.alias.length);
  for (const { kind, alias } of all) {
    const a = alias.toLowerCase();
    if (!lower.startsWith(a)) continue;
    const next = raw.slice(a.length, a.length + 1);
    if (next && !/[\s:：]/.test(next) && !isCjk(alias[alias.length - 1]!)) continue;
    return { kind, kindText: raw.slice(0, a.length), query: raw.slice(a.length).replace(/^[\s:：]+/, "").trim() };
  }
  return { kind: null, kindText: raw, query: raw.trim() };
}

/** Kinds whose label or keywords start with (or, for longer input, contain) `text`; all kinds for an empty text. */
export function suggestKinds(text: string): RefKind[] {
  const q = text.trim().toLowerCase();
  if (!q) return REF_KINDS.map((k) => k.kind);
  return REF_KINDS.filter((k) => k.aliases.some((a) => a.toLowerCase().startsWith(q) || (q.length > 1 && a.toLowerCase().includes(q)))).map((k) => k.kind);
}

/** The keyword `#` + kind is rewritten to when a kind is chosen (zh label, or the English keyword). */
export function kindKeyword(kind: RefKind, locale: "zh-TW" | "en"): string {
  const k = REF_KINDS.find((x) => x.kind === kind)!;
  return locale === "en" ? (k.aliases.find((a) => /^[a-z]+$/.test(a)) ?? k.aliases[0]!) : k.aliases[0]!;
}

/** Replaces the token with `insert` (+ a space unless one follows); returns the new text and caret. */
export function replaceToken(text: string, token: HashToken, insert: string): { text: string; caret: number } {
  const after = text.slice(token.end);
  const sep = insert && !/^\s/.test(after) ? " " : "";
  const next = text.slice(0, token.start) + insert + sep + after;
  return { text: next, caret: token.start + insert.length + sep.length };
}

/** A chosen item → the text left in the message (`〈title〉`, the way the assistant names things). */
export const mentionText = (title: string) => `〈${title.replace(/[〈〉]/g, "")}〉`;

/** Study / task chips → page-context fields (the last study chip wins; a task brings its study unless one is chosen). */
export function contextWithRefs(ctx: PageContext | null, refs: { kind: RefKind; id: string; studyId?: string | null }[]): PageContext | null {
  const study = refs.findLast((r) => r.kind === "study");
  const task = refs.findLast((r) => r.kind === "task");
  if (!study && !task) return ctx;
  const out: PageContext = { ...(ctx ?? {}) };
  const studyId = study?.id ?? task?.studyId ?? null;
  if (studyId) {
    out.studyId = studyId;
    delete out.studySlug;
  }
  if (task) out.taskId = task.id;
  return out;
}
