/**
 * Scenario oracles: what a case's planning must produce given how it was set up (matrix.ts `expect`) — checked on the
 * same stored bundle as the invariants, deterministic. Reported in the failure table next to the invariants
 * (ids `scenario.*`).
 */
import { questionsAsked, requirementsOf, routeOf, STUDY_Q_RE, type Finding, type RunBundle } from "../../../src/workflows/invariants.js";
import { EDIT_INTENTS, type Scenario } from "./matrix.js";

const FAMILY: Record<string, string> = { deck: "deck", note: "note", lit_review: "note", reading_note: "note", latex: "latex" };
const f = (b: RunBundle, invariant: string, severity: Finding["severity"], message: string, evidence: Record<string, unknown>): Finding => ({ invariant, severity, run_id: b.run.id, conversation_id: b.run.conversation_id ?? null, message, evidence });

/** Effective language per deck part from the requirements (a part-specific requirement beats a whole-artifact one). */
export function effectiveLanguages(b: RunBundle): { slides: string | null; notes: string | null } {
  const reqs = requirementsOf(b.run).filter((q) => q.type === "language");
  const pick = (part: "slides" | "notes") => {
    const own = reqs.find((q) => q.params?.part === part);
    const all = reqs.find((q) => !q.params?.part);
    const v = (own ?? all)?.params?.language;
    return v ? String(v).toLowerCase().replace("zh-tw", "zh") : null;
  };
  return { slides: pick("slides"), notes: pick("notes") };
}

export function scenarioFindings(s: Scenario, b: RunBundle, ctx: { studyId: string; deckId: string | null; status: string; routed?: boolean }): Finding[] {
  const out: Finding[] = [];
  const run = b.run;
  const rt = routeOf(run);
  // Planned = the plan card (or later), or (depth route) the Brief + requirements + route stored and the playbook planning.
  const planned = ["awaiting_plan_approval", "running", "verifying", "done", "partial"].includes(ctx.status) || !!ctx.routed;
  // The run must reach a plan or a legitimate question; a failure / no route is a finding.
  if (["failed"].includes(ctx.status)) out.push(f(b, "scenario.reached_plan", "critical", `規劃失敗：${(run as { error?: { error?: string } }).error?.error ?? run.stop_reason ?? "?"}`, { status: ctx.status }));
  // Deliverable kind.
  const kind = run.brief?.deliverable?.kind;
  if (kind && FAMILY[kind] !== s.expect.kind) out.push(f(b, "scenario.kind", "critical", `要 ${s.expect.kind}，Brief 是 ${kind}`, { expected: s.expect.kind, brief: kind, route: rt?.kind ?? null }));
  // The deck to edit: resolved and routed as an edit.
  if (s.expect.editDeck) {
    const got = run.inputs?.deck_id as string | undefined;
    if (ctx.deckId && got !== ctx.deckId) out.push(f(b, "scenario.deck_resolved", "critical", got ? `改錯簡報（${got.slice(0, 8)}，應為 ${ctx.deckId.slice(0, 8)}）` : "要修改的簡報沒有被找到（inputs 沒有 deck_id）", { expected: ctx.deckId, got: got ?? null, entry: s.entry, history: s.history, anaphora: s.anaphora }));
    else if (rt && rt.deck !== "edit") out.push(f(b, "scenario.edit_route", "critical", `修改既有簡報，路由卻是 ${rt.deck ?? rt.playbook}`, { route: rt }));
    if (s.expect.editKind && rt?.edit && rt.edit !== s.expect.editKind) out.push(f(b, "scenario.edit_kind", "high", `修改種類應為 ${s.expect.editKind}，路由是 ${rt.edit}`, { expected: s.expect.editKind, route: rt }));
  }
  // A request for a NEW artifact made on a deck page (or after an earlier deck) is not an edit of that deck.
  if (!EDIT_INTENTS.has(s.intent) && s.expect.kind === "deck" && (rt?.deck === "edit" || rt?.edit)) out.push(f(b, "scenario.new_not_edit", "critical", `要的是新簡報，路由卻是修改既有簡報（${rt.edit ?? "edit"}）`, { route: rt, deck_id: run.inputs?.deck_id ?? null, entry: s.entry }));
  // The study: derivable → set, never asked.
  if (s.expect.studyDerivable) {
    const asked = questionsAsked(b).filter((q) => STUDY_Q_RE.test(q.text));
    if (asked.length) out.push(f(b, "scenario.study_resolved", "critical", "研究推得出來，卻問了「放在哪個研究」", { questions: asked.map((q) => q.text.slice(0, 120)), entry: s.entry, history: s.history }));
    else if (planned && run.study_id !== ctx.studyId) out.push(f(b, "scenario.study_resolved", "critical", `研究應為固定資料的研究，得到 ${run.study_id ?? "（沒有）"}`, { expected: ctx.studyId, got: run.study_id ?? null }));
  }
  // Per-part language as stated (checked once requirements exist: the plan card or later).
  const p = s.expect.parts;
  if ((planned || requirementsOf(run).length) && (p.all || p.slides || p.notes)) {
    const eff = effectiveLanguages(b);
    const want = { slides: p.slides ?? p.all ?? null, notes: p.notes ?? p.all ?? null };
    const wrong = (["slides", "notes"] as const).filter((k) => want[k] && s.expect.kind === "deck" ? eff[k] !== want[k] : false);
    if (s.expect.kind !== "deck" && p.all && eff.slides !== p.all) wrong.push("slides");
    if (wrong.length) out.push(f(b, "scenario.part_language", "critical", `語言要求不符：${wrong.map((k) => `${k === "slides" ? "投影片／內文" : "講稿"} 要 ${want[k] ?? p.all}，要求是 ${eff[k] ?? "未設定"}`).join("；")}`, { expected: want, effective: eff, requirements: requirementsOf(run).filter((q) => q.type === "language") }));
  }
  return out;
}
