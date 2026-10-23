/**
 * Verification ledger helpers (docs/architecture.md "Workflows" → Verification): the deterministic false-positive filter
 * (quote present, self-contradiction), the per-step issue ledger and the report lists. Pure functions; verify.ts calls
 * the verifier and engine.ts persists the ledger in `workflow_steps.inputs.ledger`.
 */
import { createHash } from "node:crypto";
import type { FinalLedger, Issue, Ledger, LedgerItem, RunRow, StepOutput, StepRow, Verdict } from "./types.js";

/** Fix rounds per unit (step / page / section): 2 by default, never more than 3 in one session (research: gains are front-loaded). */
export const DEFAULT_FIX_ROUNDS = 2;
export const HARD_FIX_ROUNDS = 3;
/** Kept for the report wording of older runs' ledgers. */
export const CONVERGENCE_ROUNDS = HARD_FIX_ROUNDS;

const QUOTE_NOISE = /[\s*_`#>|~"'「」『』“”‘’()（）[\]【】{}<>《》〈〉,，.。、:：;；!！?？\-–—…$\\]+/g;
export const normQuote = (s: string) => s.normalize("NFKC").toLowerCase().replace(QUOTE_NOISE, "");

/**
 * Whether a quote (from the verifier) occurs in the text: whitespace / punctuation / Markdown are ignored, 「…」 splits
 * it into parts that must all occur, and a long part may differ slightly (≥ 80 % of its 4-grams present).
 */
export function quoteIn(quote: string | undefined, text: string): boolean {
  if (!quote?.trim()) return false;
  const hay = normQuote(text);
  const parts = quote.split(/…|\.{3}|⋯/).map(normQuote).filter((p) => p.length >= 2);
  if (!parts.length) return false;
  return parts.every((p) => {
    if (hay.includes(p)) return true;
    if (p.length < 12) return false;
    const grams = Array.from({ length: p.length - 3 }, (_, i) => p.slice(i, i + 4));
    return grams.filter((g) => hay.includes(g)).length / grams.length >= 0.8;
  });
}

const REF_RE = /第\s*(\d+)\s*頁|\bp(?:age|\.)\s*(\d+)|(?:\bfig(?:ure|\.)?|圖)\s*(\d+)|(?:\btable|表)\s*(\d+)|§\s*([\d.]+)/gi;
function refsOf(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(REF_RE)) {
    const kind = m[1] || m[2] ? "page" : m[3] ? "fig" : m[4] ? "table" : "sec";
    out.push(`${kind}:${m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]}`);
  }
  return out;
}

/**
 * Self-contradictory issue text: 「會載入第 2 頁而非 Fig. 1 所在的第 2 頁」 (the wrong and the right side name the same
 * page), 「把『A』改為『A』」, or both sides of 而非 / instead of identical.
 */
export function selfContradictory(text: string): boolean {
  const swap = /[「『"“]([^」』"”]{1,80})[」』"”]\s*(?:改為|改成|換成|應為|應該是|應改為|→|->|to)\s*[「『"“]([^」』"”]{1,80})[」』"”]/.exec(text);
  if (swap && normQuote(swap[1]!) === normQuote(swap[2]!) && normQuote(swap[1]!)) return true;
  const m = /(而非|而不是|instead of|rather than)/i.exec(text);
  if (!m) return false;
  const left = text.slice(Math.max(0, m.index - 40), m.index);
  const right = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
  if (normQuote(left) && normQuote(left) === normQuote(right)) return true;
  // The wrong side's page reference is the very page the right side asks for.
  const l = refsOf(left).filter((r) => r.startsWith("page:"));
  const r = refsOf(right).filter((x) => x.startsWith("page:"));
  return l.length > 0 && l.every((x) => r.includes(x));
}

/** Why a verifier issue is invalid (dropped as 「驗收者判斷無效」), or null when it may stand. */
export function screenIssue(issue: Issue, text: string, sources: string): string | null {
  if (selfContradictory(issue.text)) return "問題描述自相矛盾";
  if (issue.quote?.trim()) {
    if (!quoteIn(issue.quote, text)) return "引用的原文不在產出中";
  } else if (issue.kind === "error" || issue.kind === "unclear") return "沒有引用產出中的原文";
  if (issue.source_quote?.trim() && sources.trim() && !quoteIn(issue.source_quote, sources)) return "引用的來源原文不在來源資料中";
  return null;
}

// ---------------------------------------------------------------- judged checklist problems

/**
 * One problem a judge reports for a checklist item it answers NO. Evidence comes first: `wrong` = something in the output
 * is wrong / unsupported (`output_quote` copied from the output; `source_quote` when it contradicts a source);
 * `missing` = required content is absent (`required_quote` copied from the task / checklist item / sources that asks for
 * it, `source_quote` = where the sources hold that content).
 */
export type Problem = { kind: "wrong" | "missing"; output_quote?: string; source_quote?: string; required_quote?: string; fix?: string; where?: string };
/** `fix` = evidence-backed and fixable; `note` = the sources do not hold it (「資料未提供」, a report note, never a fix); `invalid` = dropped. */
export type ScreenedProblem = Problem & { item: string; status: "fix" | "note" | "invalid"; reason?: string };

/**
 * Deterministic screen of a judged problem (no model call): quotes must exist where they claim to come from, a critique
 * of a sentence that the sources contain verbatim is not "unsupported", a missing item must be something the task asked
 * for, and missing content the sources do not hold is a 「資料未提供」 note.
 */
export function screenProblem(item: string, p: Problem, ctx: { output: string; sources: string; spec: string }): ScreenedProblem {
  const out = (status: ScreenedProblem["status"], reason?: string): ScreenedProblem => ({ ...p, item, status, ...(reason ? { reason } : {}) });
  if (p.fix && selfContradictory(p.fix)) return out("invalid", "問題描述自相矛盾");
  if (p.kind === "wrong") {
    if (!p.output_quote?.trim()) return out("invalid", "沒有引用產出中的原文");
    if (!quoteIn(p.output_quote, ctx.output)) return out("invalid", "引用的原文不在產出中");
    if (p.source_quote?.trim()) {
      if (!quoteIn(p.source_quote, ctx.sources)) return out("invalid", "引用的來源原文不在來源資料中");
    } else if (ctx.sources.trim() && normQuote(p.output_quote).length >= 6 && quoteIn(p.output_quote, ctx.sources)) return out("invalid", "被指為沒有依據的這段在來源中找得到");
    return out("fix");
  }
  // missing
  if (!p.required_quote?.trim() || !quoteIn(p.required_quote, `${ctx.spec}\n${ctx.sources}`)) return out("invalid", "要求的內容不在任務說明或驗收項目中");
  if (ctx.sources.trim() && !(p.source_quote?.trim() && quoteIn(p.source_quote, ctx.sources))) return out("note", "資料未提供");
  return out("fix");
}

/** Identity of a fixable problem across rounds (item + its quoted evidence). */
export const problemKey = (p: Pick<ScreenedProblem, "item" | "output_quote" | "required_quote">) => `j:${p.item}:${normQuote(p.output_quote || p.required_quote || "").slice(0, 40)}`;

// ---------------------------------------------------------------- convergence of a unit

/** Why a unit stopped: passed (`converged`), round cap, the same failures again, no score gain, only unfixable failures left, unchanged output. */
export type StopReason = "converged" | "cap" | "same_failure" | "no_improvement" | "unfixable" | "unchanged" | "blocked";
export type UnitRound = { round: number; score: number; total: number; failures: string[]; ms?: number };
/**
 * Convergence state of a step (`workflow_steps.inputs.conv`): the rounds of the current session (a session starts with a
 * fresh draft, a final repair or the user's 繼續改), the best-scoring version so far and why the unit stopped. `own` =
 * the next round is the unit's own fix round (same session).
 */
export type Convergence = {
  since: number; rounds: UnitRound[]; own?: boolean; stop?: StopReason;
  best?: { round: number; score: number; total: number; output: StepOutput; verdict?: Verdict; seed?: boolean };
};

export const loadConv = (v: unknown): Convergence | null => {
  const c = v as Convergence | null | undefined;
  return c && typeof c === "object" && Array.isArray(c.rounds) && typeof c.since === "number" ? c : null;
};

const ratio = (r: { score: number; total: number }) => (r.total > 0 ? r.score / r.total : 0);
export const sameFailures = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((x) => b.includes(x));

/**
 * After a failing round: stop (and why) or fix again. Same failures as the round before → `same_failure`; a score that
 * does not beat the best earlier version → `no_improvement`; `cap` fix rounds used in this session → `cap`.
 */
export function nextMove(conv: Convergence, current: UnitRound, cap: number): StopReason | null {
  const prev = conv.rounds.filter((r) => r.round < current.round).at(-1);
  if (prev && sameFailures(prev.failures, current.failures)) return "same_failure";
  // The first round of a session (a fresh draft, or a final repair seeded with the version before it) always gets its fix.
  const best = conv.best && conv.best.round !== current.round ? conv.best : null;
  if (prev && best && ratio(current) <= ratio(best)) return "no_improvement";
  if (current.round - conv.since >= Math.min(cap, HARD_FIX_ROUNDS)) return "cap";
  return null;
}

/** Records a round; the version is the new best when it scores at least as well as the best so far (ties: the newer one). */
export function recordRound(conv: Convergence, r: UnitRound, output: StepOutput, verdict: Verdict): Convergence {
  const rounds = [...conv.rounds.filter((x) => x.round !== r.round), r].slice(-6);
  const better = !conv.best || ratio(r) >= ratio(conv.best);
  return { ...conv, rounds, ...(better ? { best: { round: r.round, score: r.score, total: r.total, output, verdict } } : {}) };
}

export const STOP_LABEL: Record<StopReason, string> = {
  converged: "通過驗收", cap: "達到修正輪數上限", same_failure: "同樣的問題重複出現", no_improvement: "修正後沒有變好", unfixable: "剩下的問題無法修正（資料未提供或判定無效）", unchanged: "修正後內容沒有改變", blocked: "一直回報缺少資料",
};

export function loadLedger(v: unknown): Ledger {
  const l = v as Ledger | null | undefined;
  return l && typeof l === "object" && Array.isArray(l.items) ? { reviewed: !!l.reviewed, next: Number(l.next) || l.items.length + 1, items: l.items } : { reviewed: false, next: 1, items: [] };
}

/** A fresh output (not a fix of the previous one): the next judged round is a full review again; closed items stay for the report. */
export const resetLedger = (l: Ledger): Ledger => ({ reviewed: false, next: l.next, items: l.items.filter((i) => i.status === "fixed" || i.status === "invalid") });

export function addItem(l: Ledger, issue: Issue, round: number, status: LedgerItem["status"] = "open", note?: string, key?: string): LedgerItem {
  const item: LedgerItem = { ...issue, id: `i${l.next++}`, status, rounds: 0, opened: round, ...(status !== "open" ? { closed: round } : {}), ...(note ? { note } : {}), ...(key ? { key } : {}) };
  l.items.push(item);
  return item;
}

/** The fix request line for an open issue (the writer sees the id, the place, the problem and the quoted text). */
export const fixLine = (i: LedgerItem) => `[${i.id}] ${i.where ? `${i.where}：` : ""}${i.text}${i.quote ? `（原文：「${i.quote.slice(0, 160)}」）` : ""}`;

/** Section hashes of an artifact (Markdown headings / slides, LaTeX sections, else paragraphs): what changed between final rounds. */
export function sectionHashes(text: string): string[] {
  const parts = text.split(/\n(?=#{1,3} |\\(?:sub)*section\{)/);
  const list = parts.length > 1 ? parts : text.split(/\n\s*\n/);
  return list.map((p) => p.trim()).filter(Boolean).map((p) => createHash("sha1").update(normQuote(p)).digest("hex").slice(0, 12));
}

export function changedSections(text: string, previous: string[]): string[] {
  const parts = text.split(/\n(?=#{1,3} |\\(?:sub)*section\{)/);
  const list = (parts.length > 1 ? parts : text.split(/\n\s*\n/)).map((p) => p.trim()).filter(Boolean);
  const old = new Set(previous);
  return list.filter((p) => !old.has(createHash("sha1").update(normQuote(p)).digest("hex").slice(0, 12)));
}

export type LedgerReport = { fixed: string[]; unresolved: string[]; invalid: string[]; /** 「資料未提供」: what a judge asked for that the sources do not hold */ notes?: string[] };

/** 已修正 / 仍未解決 / 判定無效 across the steps' ledgers and the final-verification ledger. */
export function ledgerReport(run: Pick<RunRow, "criteria" | "state">, steps: Pick<StepRow, "title" | "inputs" | "kind">[]): LedgerReport {
  const out: LedgerReport & { notes: string[] } = { fixed: [], unresolved: [], invalid: [], notes: [] };
  const line = (title: string, i: Issue & { note?: string }) => `「${title}」${i.where ? `${i.where}：` : "："}${i.text.slice(0, 160)}`;
  for (const s of steps) {
    if (s.kind === "final") continue;
    for (const i of loadLedger(s.inputs?.ledger).items) {
      if (i.status === "fixed") out.fixed.push(line(s.title, i));
      else if (i.status === "unresolved" || i.status === "open") out.unresolved.push(line(s.title, i));
      else if (i.status === "invalid") out.invalid.push(`${line(s.title, i)}（${i.note ?? "驗收者判斷無效"}）`);
      else if (i.status === "note") out.notes.push(line(s.title, i));
    }
  }
  const fl = (run.state?.final_ledger ?? null) as FinalLedger | null;
  for (const c of run.criteria) {
    const f = fl?.items?.[c.id];
    if (!f) continue;
    if (f.fails > 0 && c.status === "pass") out.fixed.push(`最終驗收：${c.text.slice(0, 160)}`);
    if (f.invalid) out.invalid.push(`最終驗收：${c.text.slice(0, 120)}（${f.invalid}）`);
    if (f.note) out.notes.push(`最終驗收：${c.text.slice(0, 120)}（${f.note.slice(0, 160)}）`);
  }
  const notes = [...new Set(out.notes)].slice(0, 30);
  return { fixed: out.fixed.slice(0, 30), unresolved: out.unresolved.slice(0, 30), invalid: out.invalid.slice(0, 30), ...(notes.length ? { notes } : {}) };
}
