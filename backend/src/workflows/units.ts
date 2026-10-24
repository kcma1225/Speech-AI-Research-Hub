/**
 * Long outputs as units (docs/architecture.md "Workflows" → Long outputs): every long artifact (notes, topic research, lit
 * review, reading notes, LaTeX sections, paper drafts, decks) is planned as an outline whose units carry a purpose, key
 * points, source refs and a **length budget**; each unit is generated in its own call with the Brief, the outline and its
 * neighbours' summaries; a unit cut off by the output limit (or left with an open block) is continued — and, still cut,
 * regenerated shorter — ONLY that unit; integrators stitch the units deterministically (no model rewrites the document).
 */
import type { ChatResult } from "../ai/types.js";
import { unbalanced } from "./checks.js";
import type { LlmRequest } from "./llm.js";
import { getSteps } from "./store.js";
import type { WorkflowEnv } from "./env.js";
import type { StepRow } from "./types.js";

/** Length budget of a unit: characters (CJK text), English words, or slide bullets / words. */
export type UnitBudget = { chars?: number; words?: number; bullets?: number };
/** One unit of an outline (a section, a subsection, a page): what it is for and what it rests on. */
export type Unit = { key: string; title: string; purpose?: string; points?: string[]; sources?: string[]; budget?: UnitBudget };

/** The budget line a unit's prompt carries (the language decides chars vs. words). */
export function budgetLine(b: UnitBudget | undefined, lang?: "en" | "zh" | null): string {
  if (!b) return "";
  const parts: string[] = [];
  if (lang === "en" && (b.words || b.chars)) {
    const w = b.words ?? Math.round((b.chars ?? 0) / 5);
    parts.push(`about ${w} words (at most ${Math.round(w * 1.3)})`);
  } else if (b.chars) parts.push(`約 ${b.chars} 字（不要超過 ${Math.round(b.chars * 1.3)} 字）`);
  else if (b.words) parts.push(`約 ${b.words} 個英文字（不要超過 ${Math.round(b.words * 1.3)} 個）`);
  if (b.bullets) parts.push(`投影片上最多 ${b.bullets} 個條列`);
  return parts.length ? `長度預算（這一個單元）：${parts.join("；")}。寫完整、在預算內結束；不要為了湊字數重複內容。` : "";
}

/** Output tokens for a unit: its budget with room for reasoning, never below `floor`. */
export function unitTokens(b: UnitBudget | undefined, floor: number, cap = 16_000): number {
  const chars = b?.chars ?? (b?.words ? b.words * 6 : 0);
  return Math.min(cap, Math.max(floor, Math.round(chars * 2.5) + 3000));
}

/** A deterministic one-paragraph summary of a written unit (headings + its first sentence), for its neighbours. */
export function unitSummary(text: string, max = 240): string {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const heads = lines.filter((l) => /^#{2,4}\s/.test(l)).map((l) => l.replace(/^#+\s*/, "")).slice(0, 4);
  const first = lines.find((l) => !/^(#|```|:::|\||<!--|!\[|\{)/.test(l)) ?? "";
  const sentence = (/^(.{12,}?(?:[。！？]|[.!?](?=\s|$)))/.exec(first)?.[1] ?? first).replace(/^[-*]\s*/, "");
  const out = [heads.length ? `（${heads.join("／")}）` : "", sentence].filter(Boolean).join(" ");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * The neighbours of unit `i`: the previous and next unit's title + purpose / points, and their text summary once written
 * (so a unit continues the line of the one before it without rewriting it).
 */
export function neighbourBlock(units: Pick<Unit, "title" | "purpose" | "points">[], i: number, written: (string | undefined)[] = []): string {
  const line = (j: number, label: string) => {
    const u = units[j];
    if (!u) return "";
    const done = written[j]?.trim();
    const what = done ? `已寫：${unitSummary(done)}` : [u.purpose, ...(u.points ?? []).slice(0, 3)].filter(Boolean).join("；");
    return `- ${label}「${u.title}」${what ? `：${what}` : ""}`;
  };
  const lines = [line(i - 1, "上一個單元"), line(i + 1, "下一個單元")].filter(Boolean);
  return lines.length ? `相鄰單元（銜接它們，但不要寫它們的內容）：\n${lines.join("\n")}` : "";
}

/** The run's units (`state.units`, written at planning) and the unit of a step. */
export const unitsOf = (env: Pick<WorkflowEnv, "state">) => env.state<Unit[]>("units") ?? [];

/** The unit prompt pieces of a step: its budget line and its neighbours (with their text when already written). */
export async function unitContext(env: WorkflowEnv, step: Pick<StepRow, "key" | "inputs">, lang?: "en" | "zh" | null): Promise<{ budget: string; neighbours: string; unit: Unit | null }> {
  const units = unitsOf(env);
  const i = units.findIndex((u) => u.key === step.key);
  const unit = i >= 0 ? units[i]! : null;
  const budget = budgetLine(unit?.budget ?? (step.inputs?.budget as UnitBudget | undefined), lang);
  if (i < 0) return { budget, neighbours: "", unit };
  const steps = await getSteps(env.db, env.run.id);
  const written = units.map((u) => steps.find((s) => s.key === u.key)?.output?.text);
  return { budget, neighbours: neighbourBlock(units, i, written), unit };
}

// ---------------------------------------------------------------- one unit, continued only when cut

const tailOf = (t: string, n = 160) => t.slice(-n).replace(/\s+/g, " ").trim();

export const CONTINUE_PROMPT = (tail: string) =>
  `你上一個回覆在這裡被輸出上限截斷：「…${tail}」。請從中斷的地方直接接著寫完這一個單元：不要重複已經寫過的內容、不要前言、不要重新開始；未關閉的區塊（\`\`\`、:::、\\end{…}）要關上；寫完就停。`;
export const SHORTER_PROMPT =
  "上一次的輸出太長，在寫完前就被截斷了。請重寫這一個單元的精簡版：長度大約減半，只保留最重要的內容，但結構要完整（標題、表格、講稿、區塊都要關上），確定在上限內寫完。";

/**
 * Joins a continuation to the cut text: drops a repeated overlap (the model often restates the last words), and when the
 * model started over (its reply begins like the cut text) keeps the restart if it is the longer, complete version.
 */
export function joinContinuation(cut: string, more: string): string {
  const fenced = /^```(?:markdown|md|latex|tex)\s*\n([\s\S]*?)\n```\s*$/.exec(more.trim());
  let b = fenced ? fenced[1]! : more;
  const head = cut.trimStart().slice(0, 60);
  if (head.length >= 20 && b.trimStart().startsWith(head)) return b.trim().length >= cut.trim().length ? b : cut;
  for (let k = Math.min(400, cut.length, b.length); k >= 4; k--) {
    if (cut.endsWith(b.slice(0, k))) {
      b = b.slice(k);
      break;
    }
  }
  // Mid-line cut: the continuation goes on the same line; a cut at a line end keeps the continuation's own line break.
  return `${cut}${b}`;
}

export type UnitResult = { text: string; stopReason: ChatResult["stopReason"]; continued: number; regenerated: boolean; truncated: boolean };

/** Whether a unit's reply is cut: the output limit was hit, or a structure was left open (`complete` overrides the latter). */
export function isCut(res: { stopReason?: ChatResult["stopReason"]; text: string }, complete?: (t: string) => boolean): boolean {
  if (res.stopReason === "max_tokens") return true;
  if (!res.text.trim()) return false;
  return complete ? !complete(res.text) : unbalanced(res.text).length > 0;
}

/**
 * Generates ONE unit. Cut (output limit / an open block): up to `continuations` continuation calls with the text so far
 * (joined deterministically); still cut → one regeneration of the unit with half the length. Nothing outside this unit is
 * touched; the step's checks then judge the result (and a fix round, if any, again redoes only this unit).
 */
export async function generateUnit(env: WorkflowEnv, req: LlmRequest, stepId: string | undefined, opts: { complete?: (t: string) => boolean; continuations?: number; clean?: (t: string) => string } = {}): Promise<UnitResult> {
  const clean = opts.clean ?? ((t: string) => t);
  const first = await env.call(req, stepId);
  let text = clean(first.text);
  let stop = first.stopReason;
  let continued = 0;
  const cut = () => isCut({ stopReason: stop, text }, opts.complete);
  while (cut() && text.trim() && continued < (opts.continuations ?? 1)) {
    continued++;
    await env.note(`有一段在輸出上限被截斷，只接續寫完這一段（第 ${continued} 次），其他段落不動。`);
    const more = await env.call({ ...req, purpose: `${req.purpose}:continue`, messages: [...req.messages, { role: "assistant", content: text }, { role: "user", content: CONTINUE_PROMPT(tailOf(text)) }] }, stepId);
    text = joinContinuation(text, clean(more.text));
    stop = more.stopReason;
  }
  if (!cut()) return { text, stopReason: stop, continued, regenerated: false, truncated: false };
  // Still cut: the unit is too long for one reply → a shorter version of this unit only.
  const again = await env.call({ ...req, purpose: `${req.purpose}:shorter`, messages: [...req.messages, ...(text.trim() ? [{ role: "assistant" as const, content: text.slice(0, 6000) }] : []), { role: "user", content: SHORTER_PROMPT }] }, stepId);
  const short = clean(again.text);
  if (short.trim() && !isCut({ stopReason: again.stopReason, text: short }, opts.complete)) return { text: short, stopReason: again.stopReason, continued, regenerated: true, truncated: false };
  return { text: short.trim().length > text.trim().length * 0.5 ? short : text, stopReason: again.stopReason, continued, regenerated: true, truncated: true };
}

// ---------------------------------------------------------------- deterministic stitching

const normHead = (h: string) => h.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A whole-reply code fence (```markdown … ```) removed; a leading `# ` document title dropped (the stitcher adds one). */
export function cleanUnit(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fenced) t = fenced[1]!.trim();
  return t.replace(/^#\s+[^\n]*\n+/, "").trim();
}

/**
 * Stitches units in outline order (no model): each unit cleaned, a `## ` section a later unit repeats (a unit writing its
 * neighbour's part) dropped from the later unit, an unclosed code fence closed, blank lines normalised.
 */
export function stitch(parts: string[], opts: { title?: string } = {}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    let t = cleanUnit(raw);
    if (!t) continue;
    const sections = t.split(/^(?=## )/m);
    const kept = sections.filter((s) => {
      const h = /^## (.+)$/m.exec(s.split("\n")[0] ?? "")?.[1];
      if (!h || !s.startsWith("## ")) return true;
      const k = normHead(h);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    t = kept.join("").trim();
    if (((t.match(/^\s*```/gm) ?? []).length) % 2) t = `${t}\n\`\`\``;
    if (t) out.push(t);
  }
  const body = out.join("\n\n").replace(/\n{3,}/g, "\n\n");
  return `${opts.title ? `# ${opts.title}\n\n` : ""}${body}\n`;
}
