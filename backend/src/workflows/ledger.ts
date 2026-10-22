/**
 * Verification ledger helpers (docs/architecture.md "Workflows" → Verification): the deterministic false-positive filter
 * (quote present, self-contradiction), the per-step issue ledger and the report lists. Pure functions; verify.ts calls
 * the verifier and engine.ts persists the ledger in `workflow_steps.inputs.ledger`.
 */
import { createHash } from "node:crypto";
import type { FinalLedger, Issue, Ledger, LedgerItem, RunRow, StepRow } from "./types.js";

/** An issue that survives this many fix rounds is no longer fixed: medium/low → report item, high → the step fails. */
export const CONVERGENCE_ROUNDS = 3;

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

export function loadLedger(v: unknown): Ledger {
  const l = v as Ledger | null | undefined;
  return l && typeof l === "object" && Array.isArray(l.items) ? { reviewed: !!l.reviewed, next: Number(l.next) || l.items.length + 1, items: l.items } : { reviewed: false, next: 1, items: [] };
}

/** A fresh output (not a fix of the previous one): the next judged round is a full review again; closed items stay for the report. */
export const resetLedger = (l: Ledger): Ledger => ({ reviewed: false, next: l.next, items: l.items.filter((i) => i.status === "fixed" || i.status === "invalid") });

export function addItem(l: Ledger, issue: Issue, round: number, status: LedgerItem["status"] = "open", note?: string): LedgerItem {
  const item: LedgerItem = { ...issue, id: `i${l.next++}`, status, rounds: 0, opened: round, ...(status !== "open" ? { closed: round } : {}), ...(note ? { note } : {}) };
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

export type LedgerReport = { fixed: string[]; unresolved: string[]; invalid: string[] };

/** 已修正 / 仍未解決 / 判定無效 across the steps' ledgers and the final-verification ledger. */
export function ledgerReport(run: Pick<RunRow, "criteria" | "state">, steps: Pick<StepRow, "title" | "inputs" | "kind">[]): LedgerReport {
  const out: LedgerReport = { fixed: [], unresolved: [], invalid: [] };
  const line = (title: string, i: Issue & { note?: string }) => `「${title}」${i.where ? `${i.where}：` : "："}${i.text.slice(0, 160)}`;
  for (const s of steps) {
    if (s.kind === "final") continue;
    for (const i of loadLedger(s.inputs?.ledger).items) {
      if (i.status === "fixed") out.fixed.push(line(s.title, i));
      else if (i.status === "unresolved" || i.status === "open") out.unresolved.push(line(s.title, i));
      else if (i.status === "invalid") out.invalid.push(`${line(s.title, i)}（${i.note ?? "驗收者判斷無效"}）`);
    }
  }
  const fl = (run.state?.final_ledger ?? null) as FinalLedger | null;
  for (const c of run.criteria) {
    const f = fl?.items?.[c.id];
    if (!f) continue;
    if (f.fails > 0 && c.status === "pass") out.fixed.push(`最終驗收：${c.text.slice(0, 160)}`);
    if (f.invalid) out.invalid.push(`最終驗收：${c.text.slice(0, 120)}（${f.invalid}）`);
  }
  return { fixed: out.fixed.slice(0, 30), unresolved: out.unresolved.slice(0, 30), invalid: out.invalid.slice(0, 30) };
}
