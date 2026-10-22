/**
 * Goal layer (docs/architecture.md "Workflows" → Goals): what every playbook **produces** (artifact kind) and
 * **requires** (study data), the deterministic **readiness snapshot** of a study, the gaps between the two, and the
 * deliverable a request asks for. Pure except `readinessOf` (one round of SQL).
 */
import type { Queryable } from "../../db.js";
import { getWorkflowPlaybook, listWorkflowPlaybooks } from "../playbooks/registry.js";
import { TOPIC_RE } from "../playbooks/common.js";

/** The final thing the user gets. `paper` = a built-in LaTeX project with every section written and compiled. */
export const DELIVERABLE_KINDS = ["paper", "paper_section", "deck", "topic_note", "lit_review", "reading_note", "outline", "experiment_report", "meeting_agenda", "note"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_LABEL: Record<DeliverableKind, string> = {
  paper: "LaTeX 論文（內建 LaTeX 專案，各章節寫好並可編譯）",
  paper_section: "LaTeX 論文章節（既有專案）",
  deck: "簡報",
  topic_note: "主題調研筆記",
  lit_review: "文獻回顧筆記",
  reading_note: "閱讀筆記",
  outline: "論文大綱筆記",
  experiment_report: "實驗報告筆記",
  meeting_agenda: "會議議程筆記",
  note: "筆記",
};

/** What a playbook needs from the study before it can produce something useful (all optional; soft = a hint only). */
export type Requirements = {
  study?: boolean;
  /** Study papers in the library / with a PDF (full text). */
  papers?: number;
  papers_with_pdf?: number;
  /** A note of one of these kinds (research, reading, experiment…) or an outline note. */
  note_kinds?: string[];
  outline_note?: boolean;
  latex_project?: boolean;
  experiment_data?: boolean;
  /** A specific paper (paper_id) is needed. */
  paper?: boolean;
};
export type Capability = { produces: DeliverableKind; requires: Requirements; /** One line for the planner. */ summary: string };

/** Built-in playbooks (a playbook may also declare `capability` itself; that wins). */
const BUILTIN: Record<string, Capability> = {
  slides: { produces: "deck", requires: { study: true }, summary: "從 0 建一份簡報（論文報告需要一篇有 PDF 的文獻；進度報告用研究資料）" },
  latex_section: { produces: "paper_section", requires: { study: true, latex_project: true, papers: 1 }, summary: "在既有 LaTeX 專案新增／改寫一個章節（新檔或建議）" },
  lit_review: { produces: "lit_review", requires: { study: true, papers: 2 }, summary: "比較研究文獻庫已有的 ≥ 2 篇論文，寫文獻回顧筆記" },
  reading_note: { produces: "reading_note", requires: { study: true, paper: true, papers_with_pdf: 1 }, summary: "一篇文獻庫論文的深度閱讀筆記" },
  topic_research: { produces: "topic_note", requires: { study: true }, summary: "主題調研：線上找論文（只送關鍵字）、匯入 8–12 篇並精讀，寫做法分類與比較的研究筆記" },
  experiment_report: { produces: "experiment_report", requires: { study: true, experiment_data: true }, summary: "把實驗筆記／貼上的結果整理成實驗報告筆記（表格、圖表）" },
  meeting_prep: { produces: "meeting_agenda", requires: { study: true }, summary: "依研究進度與上次回饋擬會議議程筆記" },
  generic: { produces: "note", requires: { study: true }, summary: "一般任務：自由規劃步驟，成果是一份新筆記" },
};

export function capabilityOf(playbookId: string): Capability | null {
  const pb = getWorkflowPlaybook(playbookId);
  if (!pb) return null;
  return pb.capability ?? BUILTIN[playbookId] ?? { produces: "note", requires: { study: true }, summary: pb.description };
}

/** Playbooks that produce a deliverable kind (the planner's candidates for the last stage). */
export const producersOf = (kind: DeliverableKind) => listWorkflowPlaybooks().map((p) => p.id).filter((id) => capabilityOf(id)?.produces === kind);

/** The capability catalogue for the planner prompt (test playbooks without a capability are left out). */
export function catalogue(): { id: string; title: string; produces: DeliverableKind; requires: Requirements; summary: string }[] {
  return listWorkflowPlaybooks()
    .filter((p) => BUILTIN[p.id] || p.capability)
    .map((p) => ({ id: p.id, title: p.title, ...capabilityOf(p.id)! }));
}

// ---------------------------------------------------------------- readiness

export type Readiness = {
  study: { id: string; title: string } | null;
  papers: number;
  papers_with_pdf: number;
  /** Notes per kind (research / reading / experiment / meeting / custom). */
  notes: Record<string, number>;
  /** Notes whose title marks a paper outline (「論文大綱」 / outline). */
  outline_notes: { id: string; title: string }[];
  /** Newest research / reading notes (titles only). */
  recent_notes: { id: string; title: string; kind: string }[];
  latex_projects: { id: string; title: string; template: string | null }[];
  decks: number;
  experiment_notes: number;
};

export const OUTLINE_TITLE_RE = /大綱|outline/i;

export async function readinessOf(db: Queryable, studyId: string | null): Promise<Readiness> {
  const empty: Readiness = { study: null, papers: 0, papers_with_pdf: 0, notes: {}, outline_notes: [], recent_notes: [], latex_projects: [], decks: 0, experiment_notes: 0 };
  if (!studyId) return empty;
  const study = (await db.query<{ id: string; title: string }>("SELECT id, title FROM studies WHERE id=$1", [studyId])).rows[0];
  if (!study) return empty;
  const p = (await db.query<{ total: number; pdf: number }>(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE p.pdf_key IS NOT NULL)::int AS pdf FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1",
    [studyId],
  )).rows[0]!;
  const kinds = (await db.query<{ kind: string; n: number }>("SELECT kind, count(*)::int AS n FROM notes WHERE study_id=$1 GROUP BY kind", [studyId])).rows;
  const notes = (await db.query<{ id: string; title: string; kind: string }>("SELECT id, title, kind FROM notes WHERE study_id=$1 ORDER BY updated_at DESC LIMIT 40", [studyId])).rows;
  const projects = (await db.query<{ id: string; title: string; template: string | null }>("SELECT id, title, template FROM latex_projects WHERE study_id=$1 ORDER BY updated_at DESC LIMIT 10", [studyId])).rows;
  const decks = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM decks WHERE study_id=$1", [studyId])).rows[0]!.n;
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
  return {
    study,
    papers: p.total,
    papers_with_pdf: p.pdf,
    notes: byKind,
    outline_notes: notes.filter((n) => OUTLINE_TITLE_RE.test(n.title)).slice(0, 5).map(({ id, title }) => ({ id, title })),
    recent_notes: notes.filter((n) => n.kind === "research" || n.kind === "reading").slice(0, 8),
    latex_projects: projects,
    decks,
    experiment_notes: byKind.experiment ?? 0,
  };
}

/** One line per readiness fact, for the planner prompt and the goal card. */
export function readinessLines(r: Readiness): string[] {
  if (!r.study) return ["還沒有決定研究（第一個階段會問要放在哪個研究）"];
  const notes = Object.entries(r.notes).map(([k, n]) => `${k} ${n}`).join("、") || "沒有";
  return [
    `研究〈${r.study.title}〉`,
    `文獻庫 ${r.papers} 篇（有全文 PDF ${r.papers_with_pdf} 篇）`,
    `筆記：${notes}${r.outline_notes.length ? `；大綱筆記 ${r.outline_notes.map((n) => `〈${n.title}〉`).join("、")}` : ""}`,
    `LaTeX 專案 ${r.latex_projects.length} 個${r.latex_projects.length ? `（${r.latex_projects.map((p) => `〈${p.title}〉`).join("、")}）` : ""}、簡報 ${r.decks} 份`,
  ];
}

/** Unmet requirements of a capability against the snapshot (繁中, for the roadmap's 「為什麼」 and the planner). */
export function gapsOf(req: Requirements, r: Readiness, inputs: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  if (req.study && !r.study) out.push("還沒有研究");
  if (req.papers && r.papers < req.papers) out.push(`文獻庫只有 ${r.papers} 篇（需要 ≥ ${req.papers}）`);
  if (req.papers_with_pdf && r.papers_with_pdf < req.papers_with_pdf) out.push(`有全文的論文只有 ${r.papers_with_pdf} 篇（需要 ≥ ${req.papers_with_pdf}）`);
  if (req.latex_project && !r.latex_projects.length && !inputs.project_id) out.push("還沒有 LaTeX 專案");
  if (req.outline_note && !r.outline_notes.length && !(inputs.note_ids as unknown[] | undefined)?.length) out.push("還沒有論文大綱筆記");
  if (req.experiment_data && !r.experiment_notes) out.push("還沒有實驗筆記");
  if (req.note_kinds?.length && !req.note_kinds.some((k) => (r.notes[k] ?? 0) > 0)) out.push(`還沒有 ${req.note_kinds.join("／")} 筆記`);
  if (req.paper && !inputs.paper_id && !r.papers_with_pdf) out.push("沒有指定的論文");
  return out;
}

// ---------------------------------------------------------------- deliverable of a request

/** A deck about a paper (「論文報告」「這篇論文做成簡報」) is a deck, never a paper. */
const DECK_RE = /簡報|投影片|slides?\b|deck|\bppt\b|論文報告|報告用的/i;
/** Writing a whole paper: 「寫一篇 paper」「可以開論文了」「給我一個 latex 論文」「論文初稿」「write a paper」. */
const PAPER_RE = /(?:寫|撰寫|起草)[^。！？\n]{0,40}(?:論文|paper)|(?:產出|生成|給我|開|做|完成)[^。！？\n]{0,12}(?:論文|paper|latex)|latex\s*(?:的)?\s*論文|論文(?:初稿|草稿|全文)|一篇[^。！？\n]{0,6}(?:paper|論文)|write (?:a|the|my) (?:full )?paper|paper draft|full paper/i;
const SECTION_RE = /章節|這一節|一節|\bsection\b|introduction|related work 章|方法章|實驗章|緒論|結論章/i;
const LIT_RE = /文獻回顧|文獻探討|literature review|related work(?! 章)/i;
const READING_RE = /閱讀筆記|精讀筆記|reading note/i;
const OUTLINE_RE = /(?:論文)?大綱|outline/i;
const EXP_RE = /實驗報告|實驗結果(?:整理|報告)/;
const MEETING_RE = /會議準備|會議議程|meeting prep|agenda/i;

/** A paper the user wants written — not one that exists (「這篇論文的摘要」「給我那篇論文」). */
function wantsPaper(t: string) {
  const m = PAPER_RE.exec(t);
  if (m && !/這篇|那篇|該篇|此篇|這幾篇|幾篇|一些|相關(?:的)?(?:論文|paper)|推薦/.test(m[0])) return true;
  return /latex/i.test(t) && /論文|paper/i.test(t) && !/這篇|那篇/.test(t);
}

/** The deliverable a request names (deterministic; null = none recognised → the playbook's own product). */
export function deliverableOf(request: string): DeliverableKind | null {
  const t = request.replace(/\s+/g, " ");
  if (DECK_RE.test(t)) return "deck";
  if (READING_RE.test(t)) return "reading_note";
  if (wantsPaper(t)) return SECTION_RE.test(t) && !/整篇|全文|一篇|從零|從 0/.test(t) ? "paper_section" : "paper";
  if (LIT_RE.test(t)) return "lit_review";
  if (EXP_RE.test(t)) return "experiment_report";
  if (MEETING_RE.test(t)) return "meeting_agenda";
  if (OUTLINE_RE.test(t) && /論文|paper/i.test(t)) return "outline";
  if (TOPIC_RE.test(t)) return "topic_note";
  return null;
}

/** Language of a paper deliverable: English when asked for / the request is English, else Traditional Chinese. */
export function languageOf(request: string): "zh" | "en" {
  if (/英文|English|in english|IEEE|ICASSP|Interspeech/i.test(request)) return "en";
  if (/中文|繁體|Chinese/i.test(request)) return "zh";
  const cjk = (request.match(/[㐀-鿿]/g) ?? []).length;
  return cjk >= 4 ? "zh" : "en";
}

/** LaTeX template for a paper: a thesis (碩士論文 / 學位論文) → zh-thesis; other Chinese papers → article-zh; English → ieee-conference. */
export function templateFor(request: string, lang: "zh" | "en"): "zh-thesis" | "article-zh" | "ieee-conference" {
  if (lang === "en") return "ieee-conference";
  return /碩士論文|學位論文|畢業論文|thesis/i.test(request) ? "zh-thesis" : "article-zh";
}
