/**
 * Writing a whole paper (docs/architecture.md "Workflows" → Goals; the last stages of a 「從零寫一篇論文」 goal):
 * - `paper_outline` 論文大綱 — a new note in a fixed Markdown format (題目, 主要貢獻, 章節規劃 with each section's points
 *   and `[@key]` citations) from the research notes handed over by earlier stages and the study library.
 * - `paper_draft` 撰寫 LaTeX 論文 — reads that outline note (or plans an outline itself), writers draft every section in
 *   parallel plus the abstract, then `assemble` creates a **new LaTeX project** from a template (zh → article-zh /
 *   zh-thesis, en → ieee-conference) with one file per section and refs.bib from the study library, compiles it (a
 *   verification compile, no history row) and fixes compile errors in bounded rounds. Only the run's own new project is
 *   ever written (effect `new`); a file someone edited in the meantime is left alone.
 *   Section scope is enforced by code (lib/latex/section-scope.ts): a writer sees the whole outline and the library as
 *   `key：title`; its reply loses everything that belongs to main.tex (which code generates) and any block of another
 *   planned section; unknown \cite keys get one repair (library key or claim removed) and are then dropped by code;
 *   `assemble` rewrites only the later section of a repeated paragraph / sub-heading pair, and a compile error repairs
 *   only the file it names.
 */
import { initialState } from "../../collab/text.js";
import { transaction, type Queryable } from "../../db.js";
import { exportStudyBibtex } from "../../lib/library/study-export.js";
import { addInput, listInputs, removeInput } from "../../lib/latex/inputs.js";
import { dropRepeatedParagraphs, dropUnknownCites, headingBlocks, keepOwnSection, scopeIssues, sectionOverlap, stripPreamble, unknownCites, type HeadingCommand, type Overlap } from "../../lib/latex/section-scope.js";
import { generateTemplate, templateInfo, type LatexTemplateId } from "../../lib/latex/templates.js";
import { requestCompile } from "../../lib/latex-projects/service.js";
import { findFileByPath, findProject, insertTextFile, latexDocName, latexUrl, liveText, roleOf, sha256Hex } from "../../lib/latex-projects/store.js";
import { recordActivity } from "../../lib/studies/activity.js";
import { CHECKS, unbalanced } from "../checks.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps, markTainted } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import type { CheckSpec, Criterion, OutlineItem, StepOutput, StepRow, StepSpec } from "../types.js";
import { clipText, planningStep, systemFor, taskPrompt } from "./common.js";
import { commitNote, finalSpec, studyOrQuestion } from "./documents.js";
import { verificationCompile } from "./latex.js";
import { registerWorkflowPlaybook, type ApprovalEdits, type PlanResult, type WorkflowPlaybook } from "./registry.js";
import { targetLanguage } from "../requirements.js";
import { languageOf, OUTLINE_TITLE_RE, templateFor, type Capability } from "../goals/capabilities.js";
import { generateUnit, unitContext, unitTokens, type Unit } from "../units.js";

type Fix = { previous: StepOutput; issues: string[] } | null;
export type PaperSection = { title: string; points: string[]; cites: string[] };
export type PaperOutline = { title: string; contributions: string[]; sections: PaperSection[] };

// ---------------------------------------------------------------- outline note format

export const OUTLINE_HEADINGS = ["論文題目", "主要貢獻", "章節規劃"];

/** Parses an outline note (`## 論文題目` / `## 主要貢獻` / `## 章節規劃` with `### n. 節名` + bullets, `[@key]` / 「引用：」). */
export function parseOutline(md: string): PaperOutline | null {
  const lines = md.replace(/\r/g, "").split("\n");
  let part = "";
  let title = (/^#\s+(?:論文大綱[:：]\s*)?(.+)$/m.exec(md)?.[1] ?? "").trim();
  const contributions: string[] = [];
  const sections: PaperSection[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      part = h2[1]!.trim();
      continue;
    }
    if (/論文題目|題目|title/i.test(part) && line && !line.startsWith("#") && !/^#\s/.test(line)) {
      if (!sections.length && line.replace(/^[-*]\s*/, "").length > 2) title = line.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim();
      part = "_title_done";
      continue;
    }
    if (/貢獻|contribution/i.test(part)) {
      const b = /^[-*]\s+(.+)$/.exec(line);
      if (b) contributions.push(b[1]!.trim());
      continue;
    }
    if (/章節|section|結構/i.test(part)) {
      const h3 = /^###\s+(?:第?\s*[\d一二三四五六七八九十]+\s*[.、章節:：)]?\s*)?(.+)$/.exec(line);
      if (h3) {
        sections.push({ title: h3[1]!.replace(/\*\*/g, "").trim(), points: [], cites: [] });
        continue;
      }
      const cur = sections.at(-1);
      const b = /^[-*]\s+(.+)$/.exec(line);
      if (cur && b) {
        const text = b[1]!.trim();
        const keys = [...text.matchAll(/\[@([^\]\s;,]+)\]|@([A-Za-z][\w:.-]*\d{2,4}[\w:.-]*)/g)].map((m) => m[1] ?? m[2]!);
        const citeLine = /^(?:引用|cite[sd]?|references?)\s*[:：]\s*(.+)$/i.exec(text);
        if (citeLine) for (const k of citeLine[1]!.split(/[,，、\s]+/)) { const key = k.replace(/^\[?@?|\]$/g, "").trim(); if (key) keys.push(key); }
        for (const k of keys) if (!cur.cites.includes(k)) cur.cites.push(k);
        if (!citeLine) cur.points.push(text.replace(/^重點[:：]\s*/, ""));
      }
    }
  }
  // The abstract is its own step and the bibliography comes from the library: neither is a section.
  const clean = sections.filter((s) => s.title && !/^參考文獻|^references$|^(?:摘要|abstract)$/i.test(s.title.trim())).slice(0, 12);
  return clean.length >= 2 ? { title: clipText(title || "論文", 160), contributions: contributions.slice(0, 8), sections: clean } : null;
}

/** ≥ `min` sections planned under 章節規劃 (outline notes). */
const OUTLINE_CHECKS: typeof CHECKS = {
  outline_sections(text, { params }) {
    const min = Number(params.min ?? 4);
    const o = parseOutline(text);
    const n = o?.sections.length ?? 0;
    if (n < min) return { ok: false, detail: `「## 章節規劃」下只有 ${n} 個「### 」小節，至少需要 ${min} 個（每節一個「### 節名」加條列重點與「引用：」）。` };
    const noPoints = o!.sections.filter((s) => !s.points.length).map((s) => s.title);
    return noPoints.length ? { ok: false, detail: `這些章節沒有條列重點：${noPoints.join("、")}。` } : { ok: true, detail: `${n} 個章節，每節都有重點` };
  },
  /** Every planned section heading appears in the assembled paper (`data.sections` = the approved titles). */
  paper_sections(text, { data }) {
    const want = ((data as { sections?: string[] } | null)?.sections ?? []).filter(Boolean);
    if (!want.length) return { ok: true, detail: "（沒有章節清單）" };
    return CHECKS.sections_present!(text, { params: { sections: want }, data });
  },
  /** A section file holds only its own section (lib/latex/section-scope.ts): params `index`, `titles`, `command`. */
  latex_section_scope(text, { params }) {
    const titles = Array.isArray(params.titles) ? (params.titles as string[]) : [];
    const issues = scopeIssues(text, { index: Number(params.index ?? 0), titles, command: params.command === "chapter" ? "chapter" : "section" });
    return issues.length ? { ok: false, detail: issues.join("；") } : { ok: true, detail: "只有本節的內容" };
  },
  /** No section of the assembled paper repeats another's paragraphs or sub-headings (`params.command` = top-level heading). */
  latex_no_overlap(text, { params }) {
    const found = paperOverlap(text, params.command === "chapter" ? "chapter" : "section");
    return found.issues.length ? { ok: false, detail: `各節之間有重複的內容：${found.issues.slice(0, 6).join("；")}。後面的節要刪掉重複的部分，只寫自己的重點。` } : { ok: true, detail: `${found.titles.length} 節沒有重複的段落或小節` };
  },
};
Object.assign(CHECKS, OUTLINE_CHECKS);

/**
 * The paper as the final verification reads it: top-level headings (\chapter / \section) → `## `, lower ones → `### `
 * (the Markdown heading checks and per-section requirements apply; `paperOverlap` maps them back).
 */
export const paperHeadings = (tex: string, command: HeadingCommand = "section") => tex
  .replace(new RegExp(`^[ \\t]*\\\\${command}\\*?\\{([^}]*)\\}.*$`, "gm"), "## $1")
  .replace(/^[ \t]*\\(?:sub)*section\*?\{([^}]*)\}.*$/gm, "### $1");

/** Overlaps between the top-level sections of an assembled paper (the abstract before the first heading is not a section). */
export function paperOverlap(text: string, command: HeadingCommand): { titles: string[]; overlaps: Overlap[]; issues: string[] } {
  // The final text has Markdown headings (paperHeadings): back to LaTeX for the section boundaries.
  const tex = new RegExp(`\\\\${command}\\*?\\{`).test(text) ? text : text.replace(/^## (.+)$/gm, `\\${command}{$1}`).replace(/^### (.+)$/gm, `\\${command === "chapter" ? "section" : "subsection"}{$1}`);
  const blocks = headingBlocks(tex, command);
  const overlaps = sectionOverlap(blocks.map((b) => tex.slice(b.start, b.end)));
  const titles = blocks.map((b) => b.title);
  const issues = overlaps.map((o) => `「${titles[o.later]}」${o.kind === "heading" ? "重複了小節標題" : "重複了段落"}「${o.sample}」（已在「${titles[o.earlier]}」）`);
  return { titles, overlaps, issues };
}

// ---------------------------------------------------------------- shared sources

type Source = { brief: string; keys: string[]; papers: { key: string; title: string; year: number | null; abstract: string }[]; noteIds: string[] };

async function studyKeys(db: Queryable, studyId: string) {
  return (await db.query<{ cite_key: string; title: string; year: number | null; abstract: string | null }>(
    "SELECT sp.cite_key, p.title, p.year, p.abstract FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY p.year DESC NULLS LAST LIMIT 60",
    [studyId],
  )).rows.map((r) => ({ key: r.cite_key, title: r.title, year: r.year, abstract: clipText((r.abstract ?? "").replace(/\s+/g, " "), 500) }));
}

/** Notes handed over (inputs.note_ids) else the study's newest research / reading notes; plus the library with cite keys. */
async function gatherSources(env: WorkflowEnv, studyId: string, opts: { exclude?: string[]; max?: number } = {}): Promise<Source> {
  const ids = (Array.isArray(env.run.inputs.note_ids) ? (env.run.inputs.note_ids as string[]) : []).filter((id) => !opts.exclude?.includes(id));
  const notes = ids.length
    ? (await env.db.query<{ id: string; title: string; content_md: string; created_by: string | null }>("SELECT id, title, content_md, created_by FROM notes WHERE id = ANY($1::uuid[]) AND study_id=$2", [ids, studyId])).rows
    : (await env.db.query<{ id: string; title: string; content_md: string; created_by: string | null }>("SELECT id, title, content_md, created_by FROM notes WHERE study_id=$1 AND kind IN ('research','reading') ORDER BY updated_at DESC LIMIT 3", [studyId])).rows.filter((n) => !opts.exclude?.includes(n.id));
  const papers = await studyKeys(env.db, studyId);
  const max = opts.max ?? 24_000;
  const share = notes.length ? Math.floor(max / notes.length) : 0;
  const brief = [
    ...notes.map((n) => `### 筆記〈${n.title}〉\n${n.content_md.slice(0, share)}`),
    papers.length ? `### 研究文獻庫（cite key：標題，年份；摘要）\n${papers.map((p) => `- ${p.key}：${p.title}${p.year ? `（${p.year}）` : ""}${p.abstract ? `；${p.abstract}` : ""}`).join("\n")}` : "### 研究文獻庫是空的",
  ].join("\n\n");
  // Notes and papers the owner did not write are third-party content (taint, as when the assistant reads them).
  if (notes.some((n) => n.created_by !== env.user.id) || papers.length) await markTainted(env.db, env.run.id, notes.length ? `筆記〈${clipText(notes[0]!.title, 40)}〉` : "研究文獻庫");
  await env.refresh();
  return { brief, keys: papers.map((p) => p.key), papers, noteIds: notes.map((n) => n.id) };
}

const STUDY_ONLY: Capability["requires"] = { study: true };

// ---------------------------------------------------------------- 論文大綱 (paper_outline)

const paperOutline: WorkflowPlaybook = {
  id: "paper_outline",
  title: "論文大綱",
  titleEn: "Paper outline",
  description: "依調研筆記與研究文獻庫擬論文大綱：題目、主要貢獻、章節規劃（每節重點與要引用的文獻），寫成新筆記",
  descriptionEn: "Draft a paper outline from research notes and the study library: title, contributions, section plan with citations; a new note",
  capability: { produces: "outline", requires: { ...STUDY_ONLY, papers: 3 }, summary: "論文大綱筆記：題目、主要貢獻、章節規劃與每節要引用的 cite key（寫整篇論文前的依據）" },
  autoApprovable: true,
  detect: (req) => (/(?:論文|paper).{0,6}大綱|大綱.{0,6}(?:論文|paper)|paper outline/i.test(req) ? 0.8 : 0),
  async plan(env): Promise<PlanResult> {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question };
    const src = await gatherSources(env, access.study.id);
    if (!src.keys.length && !src.noteIds.length) return { kind: "question", question: `〈${access.study.title}〉的文獻庫與筆記都是空的，沒有資料可以擬大綱。請先加入論文或做一次主題調研，再按「繼續」。` };
    const lang = targetLanguage(env.requirements()) ?? (env.run.inputs.language as "zh" | "en" | undefined) ?? languageOf(env.run.request);
    await env.setState({ brief: src.brief.slice(0, 30_000), keys: src.keys, language: lang, note_title: `論文大綱：${clipText(env.run.request.replace(/^為論文「|」.*$/gs, ""), 60)}` });
    const minCites = Math.min(3, src.keys.length);
    const verify = { checks: [{ id: "sections_present", params: { sections: OUTLINE_HEADINGS } }, { id: "outline_sections", params: { min: 4 } }, ...(src.keys.length ? [{ id: "citations", params: { keys: src.keys, min: minCites } }] : []), { id: "no_placeholder" }, { id: "not_truncated" }], judge: true };
    const research: StepSpec = { key: "research", role: "researcher", title: "讀調研筆記與文獻庫", instructions: "整理交接的筆記與研究文獻庫（含 cite key）。", expected: "資料摘要", verify: { checks: [], judge: false }, done: { output: { summary: `${src.noteIds.length} 份筆記、${src.keys.length} 篇文獻`, text: src.brief.slice(0, 20_000) } } };
    return {
      kind: "plan", title: env.state<string>("note_title"), studyId: access.study.id,
      objective: `為「${clipText(env.run.request, 160)}」擬一份論文大綱（題目、主要貢獻、≥ 4 個章節的重點與要引用的文獻），寫成新筆記，作為撰寫整篇論文的依據。`,
      criteria: [
        { id: "structure", kind: "check", text: "包含論文題目、主要貢獻、章節規劃三段", check: { id: "sections_present", params: { sections: OUTLINE_HEADINGS } } },
        { id: "sections", kind: "check", text: "章節規劃至少 4 節，每節有重點", check: { id: "outline_sections", params: { min: 4 } } },
        ...(src.keys.length ? [{ id: "cites", kind: "check" as const, text: "引用都對應到研究文獻庫的 cite key", check: { id: "citations", params: { keys: src.keys, min: minCites } } }] : []),
        { id: "grounded", kind: "judge", text: "題目、貢獻與各節重點都有資料依據（調研筆記、文獻），沒有捏造結果或實驗數字" },
      ],
      plan: { summary: `依 ${src.noteIds.length} 份筆記與 ${src.keys.length} 篇文獻擬大綱，驗收後寫成新筆記。`, writes: [{ kind: "note", label: `新筆記「${env.state<string>("note_title")}」`, effect: "new" }] },
      steps: [
        research,
        { key: "outline", role: "writer", title: "擬論文大綱", instructions: "依資料擬題目、主要貢獻與章節規劃。", depends_on: ["research"], expected: "固定格式的大綱 Markdown", verify },
        { key: "assemble", role: "integrator", kind: "integrate", title: "整理成筆記", instructions: "整理成一份筆記。", depends_on: ["outline"], expected: "大綱筆記", verify: { checks: [{ id: "sections_present", params: { sections: OUTLINE_HEADINGS } }], judge: false } },
        finalSpec(),
      ],
    };
  },
  async execute(env, step, fix) {
    if (step.key === "research") return step.output ?? { summary: "", text: env.state<string>("brief") ?? "" };
    if (step.key === "assemble") {
      const out = (await getSteps(env.db, env.run.id)).find((s) => s.key === "outline")?.output?.text ?? "";
      const body = out.replace(/^```(?:markdown|md)?\n|\n```$/g, "").trim();
      const doc = /^#\s/.test(body) ? body : `# ${env.state<string>("note_title") ?? "論文大綱"}\n\n${body}`;
      await env.setState({ doc: `${doc}\n` });
      return { summary: `大綱 ${doc.length} 字`, text: doc };
    }
    const en = env.state<string>("language") === "en";
    const user = taskPrompt(env, step, {
      context: { sources: (env.state<string>("brief") ?? "").slice(0, 24_000), cite_keys: (env.state<string[]>("keys") ?? []).join(", ") },
      format: [
        "Markdown，固定格式（標題文字照抄）：",
        "# 論文大綱：<題目>", "## 論文題目", "<一行題目>", "## 主要貢獻", "- <貢獻，2–4 條>", "## 章節規劃",
        "### 1. <節名>", "- <這一節要寫的重點，2–5 條>", "- 引用：[@key1], [@key2]", "### 2. <節名> …（共 4–8 節，例如緒論、相關研究、方法／資料、分析或討論、結論）",
        "## 參考文獻", "- [@key] 標題",
        `引用只能用 cite_keys 裡的 key。每節都要有重點與引用（真的沒有相關文獻的節可以省略引用）。${en ? "節名與題目用英文（論文是英文的）；重點可用繁體中文。" : "全部用繁體中文。"}不要寫實驗數字或結果，除非資料裡有。`,
      ].join("\n"),
    }, fix);
    const res = await env.call({ purpose: "paper_outline", role: "writer", aiRole: "writing", messages: [{ role: "system", content: systemFor("writer", "你在為一篇學術論文擬大綱。") }, { role: "user", content: user }], maxTokens: 6000 }, step.id);
    return { summary: `${res.text.length} 字`, text: res.text.replace(/^```(?:markdown|md)?\n|\n```$/g, "").trim() };
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(_env, failing) {
    return [{ key: "outline", issues: failing.map((c) => `${c.text}：${c.reason ?? "未達成"}`) }];
  },
  commit: (env, outcome) => commitNote(env, outcome, "research"),
};

// ---------------------------------------------------------------- 撰寫 LaTeX 論文 (paper_draft)

type DraftState = { sections: PaperSection[]; title: string; language: "zh" | "en"; template: LatexTemplateId; keys: string[]; command: HeadingCommand; library?: { key: string; title: string }[] };
/** A repair of one section file (compile fix, de-duplication), valid only while the section text it started from is unchanged. */
type FileFix = { from: string; text: string };
type Written = { project_id: string; paths: string[]; abstract_path: string; sha: Record<string, string>; compile?: { status: string; errors: string[] } };

const ASCII_SLUG = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
export const sectionFile = (i: number, title: string) => `sections/s${String(i + 1).padStart(2, "0")}${ASCII_SLUG(title) ? `-${ASCII_SLUG(title)}` : ""}.tex`;

const stripFence = (t: string) => t.replace(/^```(?:latex|tex)?\s*\n/, "").replace(/\n```\s*$/, "").trim();

/** Ensures the section text starts with its heading command (`\section{…}` / `\chapter{…}`) and a label. */
export function withHeading(tex: string, title: string, i: number, command: "chapter" | "section") {
  const body = stripFence(tex).replace(/\\documentclass[\s\S]*?\\begin\{document\}/, "").replace(/\\end\{document\}/, "").trim();
  const re = new RegExp(`^\\\\${command}\\*?\\{`);
  if (re.test(body)) return `${body}\n`;
  // A lower / other heading first (\section in a thesis) → replace it; none → add one.
  const stripped = body.replace(/^\\(?:chapter|section)\*?\{[^}]*\}(?:\\label\{[^}]*\})?\s*/, "");
  return `\\${command}{${title.replace(/[\\{}$&#^_%~]/g, "")}}\\label{${command === "chapter" ? "chap" : "sec"}:s${i + 1}}\n\n${stripped}\n`;
}

/**
 * A writer's section reply made into a section file, deterministically: fence and everything that belongs to main.tex
 * stripped (preamble, document, title block, abstract, own bibliography, \input), blocks headed by another planned section
 * dropped (extra top-level headings demoted), its heading ensured, and — with `keys` — \cite keys outside the study
 * library removed. `notes` say what was changed (shown in the run's activity).
 */
export function sanitizeSection(tex: string, opts: { index: number; titles: string[]; command: HeadingCommand; keys?: readonly string[] }): { text: string; notes: string[] } {
  const notes: string[] = [];
  const stripped = stripPreamble(stripFence(tex));
  if (stripped.removed.length) notes.push(`移除了屬於主檔的內容（${stripped.removed.join("、")}）`);
  const own = keepOwnSection(stripped.text, opts);
  if (own.dropped.length) notes.push(`刪掉了屬於其他節的內容（${own.dropped.map((t) => `「${clipText(t, 20)}」`).join("、")}）`);
  if (own.demoted.length) notes.push(`多出的標題改成小節（${own.demoted.map((t) => `「${clipText(t, 20)}」`).join("、")}）`);
  let text = own.text.trim() ? withHeading(own.text, opts.titles[opts.index] ?? "", opts.index, opts.command) : "";
  if (opts.keys && text) {
    const c = dropUnknownCites(text, opts.keys);
    if (c.dropped.length) notes.push(`移除了不在研究文獻庫的引用鍵（${c.dropped.join("、")}）`);
    text = c.text;
  }
  return { text, notes };
}

function abstractTex(template: LatexTemplateId, text: string, keywords: string[]) {
  const kw = keywords.join(template === "ieee-conference" || template === "article-en" ? ", " : "、");
  if (template === "zh-thesis") return `\\chapter*{摘要}\n\\addcontentsline{toc}{chapter}{摘要}\n\n${text}\n\n${kw ? `\\noindent\\textbf{關鍵字：}${kw}\n` : ""}`;
  if (template === "ieee-conference") return `\\begin{abstract}\n${text}\n\\end{abstract}\n\n${kw ? `\\begin{IEEEkeywords}\n${kw}\n\\end{IEEEkeywords}\n` : ""}`;
  return `\\begin{abstract}\n${text}\n${kw ? `\n\\noindent\\textbf{${template === "article-en" ? "Keywords:" : "關鍵字："}} ${kw}\n` : ""}\\end{abstract}\n`;
}

/** The template's main.tex with its sample section inputs replaced by the paper's (abstract file kept / added first). */
export function paperMain(template: LatexTemplateId, title: string, author: string, paths: string[], abstractPath: string) {
  const built = generateTemplate(template, { title, author });
  let main = built.files.find((f) => f.path === built.rootFile)!.content;
  const samples = built.sections.filter((p) => p !== abstractPath);
  const anchor = samples.find((p) => !/abstract/.test(p)) ?? samples[0]!;
  const mine = built.sections.includes(abstractPath) ? paths : [abstractPath, ...paths];
  let after = anchor;
  for (const p of mine) {
    main = addInput(main, p, { after });
    after = p;
  }
  for (const p of samples) main = removeInput(main, p);
  return main;
}

const BIB_HEADER = (n: number) => `% 此檔由研究文獻庫自動產生（${n} 筆），每次編譯前更新；手動修改會被覆蓋。\n% 要自行編輯，請在專案設定把參考文獻改為「手動」。\n\n`;

/** Writes one of the run's own files: new → inserted; unchanged since the run wrote it → replaced; edited by someone → left alone (false). */
async function writeOwn(client: Queryable, projectId: string, path: string, text: string, actorId: string, sha: Record<string, string>, role: "main" | "section" | "bib"): Promise<boolean> {
  const file = await findFileByPath(client, projectId, path);
  if (!file) {
    await insertTextFile(client, { projectId, path, content: text, role, actorId });
    sha[path] = sha256Hex(text);
    return true;
  }
  const current = await liveText(client, null, file);
  if (current === text) return true;
  if (sha[path] && sha256Hex(current) !== sha[path]) return false;
  const state = Buffer.from(initialState(text));
  await client.query("UPDATE yjs_docs SET state=$2, size=$3 WHERE name=$1", [latexDocName(projectId, file.id), state, state.length]);
  await client.query("UPDATE latex_files SET content=$2, bytes=$3, sha256=$4, updated_by=$5, updated_at=now() WHERE id=$1", [file.id, text, Buffer.byteLength(text), sha256Hex(text), actorId]);
  sha[path] = sha256Hex(text);
  return true;
}

async function draftPlan(env: WorkflowEnv): Promise<PlanResult> {
  const access = await studyOrQuestion(env);
  if ("question" in access) return { kind: "question", question: access.question };
  const studyId = access.study.id;
  // The outline: a handed-over note in the outline format (or the study's newest outline note).
  const ids = Array.isArray(env.run.inputs.note_ids) ? (env.run.inputs.note_ids as string[]) : [];
  const candidates = (await env.db.query<{ id: string; title: string; content_md: string; updated_at: string }>(
    `SELECT id, title, content_md, updated_at FROM notes WHERE study_id=$1 AND (id = ANY($2::uuid[]) OR ($3 AND title ~* '大綱|outline')) ORDER BY (id = ANY($2::uuid[])) DESC, updated_at DESC LIMIT 6`,
    [studyId, ids, !ids.length],
  )).rows;
  const outlineNote = candidates.map((n) => ({ n, o: parseOutline(n.content_md) })).find((x) => x.o && (OUTLINE_TITLE_RE.test(x.n.title) || /##\s*章節規劃/.test(x.n.content_md))) ?? null;
  const src = await gatherSources(env, studyId, { exclude: outlineNote ? [outlineNote.n.id] : [] });
  const lang = targetLanguage(env.requirements()) ?? (env.run.inputs.language as "zh" | "en" | undefined) ?? languageOf(env.run.request);
  const template = ((env.run.inputs.template as LatexTemplateId | undefined) && ["zh-thesis", "ieee-conference", "article-zh", "article-en"].includes(env.run.inputs.template as string) ? env.run.inputs.template : templateFor(env.run.request, lang)) as LatexTemplateId;
  let outline = outlineNote?.o ?? null;
  const research: StepSpec = { key: "research", role: "researcher", title: "讀大綱、調研筆記與文獻庫", instructions: "整理論文大綱、交接的筆記與研究文獻庫（含 cite key）。", expected: "撰寫依據", verify: { checks: [], judge: false }, done: { output: { summary: `${outlineNote ? `大綱〈${outlineNote.n.title}〉、` : ""}${src.noteIds.length} 份筆記、${src.keys.length} 篇文獻`, text: src.brief.slice(0, 20_000) } } };
  const pre: StepSpec[] = [research];
  if (!outline) {
    // No outline note: plan the sections now (shown and editable on the plan card).
    const o = await planningStep(env, { key: "outline", role: "planner", title: "規劃論文章節", instructions: "規劃題目與 4–8 個章節。", depends_on: ["research"], expected: "章節大綱", verify: { checks: [{ id: "outline_sections", params: { min: 4 } }], judge: false } }, async (fix) => {
      const res = await env.call({ purpose: "paper_outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: [`要寫的論文：${env.run.request}`, env.guidanceText(), dataBlock("sources", src.brief.slice(0, 20_000)), fix ? `上一版的問題：${fix.issues.join("；")}` : "", "輸出 Markdown：# 論文大綱：<題目> / ## 論文題目 / <題目> / ## 主要貢獻 / - … / ## 章節規劃 / ### 1. <節名> / - <重點> / - 引用：[@key] …（4–8 節，引用只用資料中的 cite key）。"].filter(Boolean).join("\n\n") }], maxTokens: 4000 });
      return { summary: `${res.text.length} 字`, text: res.text };
    }, 1);
    outline = parseOutline(o.output.text ?? "");
    pre.push(o.spec);
  }
  if (!outline) throw new WorkflowInputError("無法規劃論文章節，請先擬一份論文大綱筆記（## 章節規劃 下每節一個 ### 標題）。");
  const command = templateInfo(template).sectionCommand;
  const keySet = new Set(src.keys);
  const sections = outline.sections.slice(0, 10).map((s) => ({ ...s, cites: s.cites.filter((k) => keySet.has(k)) }));
  const st: DraftState = { sections, title: outline.title, language: lang, template, keys: src.keys, command, library: src.papers.map((p) => ({ key: p.key, title: clipText(p.title, 120) })) };
  await env.setState({ draft: st, brief: src.brief.slice(0, 30_000), outline_note: outlineNote ? { id: outlineNote.n.id, title: outlineNote.n.title } : null, units: paperUnits(st) });
  const info = templateInfo(template);
  return {
    kind: "plan",
    title: clipText(`論文：${outline.title}`, 120),
    studyId,
    objective: `依${outlineNote ? `大綱〈${outlineNote.n.title}〉` : "規劃的大綱"}寫完整的 LaTeX 論文「${outline.title}」：新的 LaTeX 專案（${info.name_zh}），${sections.length} 節＋摘要，引用研究文獻庫，編譯通過。`,
    criteria: draftCriteria(src.keys, command),
    plan: {
      summary: `建立新的 LaTeX 專案（${info.name_zh}，${lang === "en" ? "英文" : "繁體中文"}），${sections.length} 節由撰寫者平行撰寫（每節只引用研究文獻庫的 cite key），再寫摘要；整合後編譯，有錯誤時修正（最多 3 輪）。`,
      outline: sections.map((s, i) => ({ n: i + 1, title: s.title, points: [...s.points.slice(0, 6), ...(s.cites.length ? [`引用：${s.cites.join(", ")}`] : [])] })),
      writes: [{ kind: "latex_project", label: `新 LaTeX 專案〈${clipText(outline.title, 60)}〉（${info.name_zh}，每節一個檔案）`, effect: "new" }],
    },
    steps: [...pre, ...draftSteps(st, pre.at(-1)!.key)],
  };
}

/** Short sections (introduction, conclusion) get a smaller budget than the body sections. */
const SHORT_SECTION_RE = /intro|conclu|summary|緒論|前言|引言|結論|總結|結語/i;
/** The paper's units (`state.units`): one per section, with its points and length budget (words in English, chars otherwise). */
export function paperUnits(st: Pick<DraftState, "sections" | "language">): Unit[] {
  return st.sections.map((s, i) => {
    const short = SHORT_SECTION_RE.test(s.title);
    return { key: `sec_${i + 1}`, title: s.title, points: s.points, sources: s.cites, budget: st.language === "en" ? { words: short ? 450 : 800 } : { chars: short ? 1200 : 2400 } };
  });
}

const draftCriteria = (keys: string[], command: HeadingCommand): Omit<Criterion, "status">[] => [
  { id: "compile", kind: "check", text: "LaTeX 專案編譯成功（沒有錯誤）", check: { id: "compile_ok" } },
  { id: "structure", kind: "check", text: "大綱的每一節都寫出來了", check: { id: "paper_sections" } },
  { id: "distinct", kind: "check", text: "各節只寫自己的內容，彼此沒有重複的段落或小節", check: { id: "latex_no_overlap", params: { command } } },
  ...(keys.length ? [{ id: "cites", kind: "check" as const, text: "所有 \\cite 都對應到研究文獻庫的 cite key", check: { id: "citations", params: { keys, min: 1 } } }] : []),
  { id: "complete", kind: "check", text: "沒有佔位文字或被截斷的內容", check: { id: "no_placeholder" } },
  { id: "grounded", kind: "judge", text: "論述來自調研筆記與文獻，引用對應正確的論點，沒有捏造實驗結果或數字" },
];

function sectionChecks(st: DraftState, s: PaperSection, i: number): CheckSpec[] {
  return [
    { id: "citations", params: { keys: st.keys, min: s.cites.length && st.keys.length ? 1 : 0 } },
    { id: "not_truncated" }, { id: "no_placeholder" }, { id: "min_length", params: { chars: 500 } },
    { id: "sections_present", params: { sections: [s.title] } },
    { id: "latex_section_scope", params: { index: i, titles: st.sections.map((x) => x.title), command: st.command } },
  ];
}

function draftSteps(st: DraftState, dep: string): StepSpec[] {
  const secs: StepSpec[] = st.sections.map((s, i) => ({
    key: `sec_${i + 1}`, role: "writer", title: `撰寫「${clipText(s.title, 40)}」`,
    instructions: `寫 \\${st.command}{${s.title}} 的 LaTeX 內文。重點：${s.points.join("；") || "依大綱與資料"}${s.cites.length ? `。引用：${s.cites.join(", ")}` : ""}。`,
    depends_on: [dep], inputs: { index: i }, expected: `一個 \\${st.command} 的 LaTeX 內文`, verify: { checks: sectionChecks(st, s, i), judge: true },
  }));
  return [
    ...secs,
    { key: "abstract", role: "writer", title: "撰寫摘要與關鍵字", instructions: "依各節內容寫摘要（150–250 字／words）與 3–5 個關鍵字。", depends_on: secs.map((s) => s.key), expected: "摘要＋關鍵字", verify: { checks: [{ id: "min_length", params: { chars: 120 } }, { id: "no_placeholder" }], judge: false } },
    { key: "assemble", role: "integrator", kind: "integrate", title: "建立 LaTeX 專案並編譯", instructions: "建立 LaTeX 專案（每節一個檔案、參考文獻來自研究文獻庫）並編譯；有錯誤時依錯誤修正。", depends_on: ["abstract", ...secs.map((s) => s.key)], expected: "可以編譯的論文", max_rounds: 3, verify: { checks: [{ id: "compile_ok" }, ...(st.keys.length ? [{ id: "citations", params: { keys: st.keys, min: 0 } }] : []), { id: "not_truncated" }], judge: false } },
    finalSpec(),
  ];
}

const scopeOf = (st: DraftState, i: number) => ({ index: i, titles: st.sections.map((s) => s.title), command: st.command });

async function sectionTexts(env: WorkflowEnv) {
  const st = env.state<DraftState>("draft")!;
  const steps = await getSteps(env.db, env.run.id);
  return st.sections.map((_, i) => {
    const out = steps.find((x) => x.key === `sec_${i + 1}`)?.output?.text ?? "";
    return out.trim() ? sanitizeSection(out, { ...scopeOf(st, i), keys: st.keys }).text : "";
  });
}

/** The study library as the writer sees it: one `key：title` per line (the only keys \cite may use). */
const libraryList = (st: DraftState) => (st.library?.length ? st.library.map((p) => `- ${p.key}：${p.title}`) : st.keys.map((k) => `- ${k}`)).join("\n");

async function writeSection(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const st = env.state<DraftState>("draft")!;
  const i = Number(step.inputs.index ?? 0);
  const s = st.sections[i]!;
  const en = st.language === "en";
  const sub = st.command === "chapter" ? "section" : "subsection";
  // One section = one unit: its budget and its neighbours (their text once written), generated alone (units.ts).
  const u = await unitContext(env, step, st.language);
  const user = taskPrompt(env, step, {
    context: {
      // The whole outline with every section's scope, so this writer knows what the others cover.
      paper: `題目：${st.title}\n章節大綱（每節只寫自己的重點）：\n${st.sections.map((x, j) => `${j + 1}. ${x.title}${j === i ? "（← 你寫這一節）" : "（其他節負責，不要寫）"}${x.points.length ? `：${x.points.slice(0, 5).join("；")}` : ""}`).join("\n")}`,
      sources: (env.state<string>("brief") ?? "").slice(0, 16_000),
      library: st.keys.length ? `可以引用的文獻（\\cite 只能用這些 key，不要自己編 key）：\n${libraryList(st)}` : "（文獻庫是空的：不要用 \\cite）",
    },
    format: [
      `只輸出這一節的 LaTeX：第一行 \\${st.command}{${s.title}}，接著 3–6 段內文（必要時 \\${sub}、itemize、table）。這個檔案會被主檔 \\input，主檔已經有前言、題目、摘要與參考文獻。`,
      `範圍：只寫「${s.title}」的重點。不要 \\documentclass、\\usepackage、\\begin{document}、\\title、\\maketitle、abstract、thebibliography、\\input；不要寫其他節的標題或內容；${SHORT_SECTION_RE.test(s.title) ? "" : "不要寫自己的摘要、緒論或結論，也不要重新介紹整篇論文（「本文…」「In this paper we…」）；"}不要 Markdown、不要 \`\`\`。`,
      `引用用 \\cite{key}，key 只能是 library 列出的（沒有適合的文獻就不要引用，不要編造）。特殊字元要跳脫（\\%、\\&、\\_、\\#）。${en ? "用英文（English）撰寫，不要出現中文字。" : "用繁體中文撰寫。"}資料沒有的實驗數字不要寫。`,
      u.budget, u.neighbours,
    ].filter(Boolean).join("\n"),
  }, fix);
  const system = systemFor("writer", `你在寫一篇學術論文其中一節的 LaTeX 內文。${en ? "This paper is written in English: write English only (the 繁體中文 rule does not apply to the paper text)." : ""}`);
  const res = await generateUnit(env, { purpose: "paper_section", role: "writer", aiRole: "writing", messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: unitTokens(u.unit?.budget, 7000) }, step.id, { clean: stripFence });
  // Scope first (deterministic), then citations: unknown keys → one repair that swaps in a library key or drops the claim;
  // whatever is still unknown is removed by code. A key is never invented.
  let out = sanitizeSection(res.text, scopeOf(st, i));
  const unknown = unknownCites(out.text, st.keys);
  let citeFixed = false;
  if (unknown.length) {
    await env.activity(step.key, "writer", `修正不在文獻庫的引用：${unknown.slice(0, 5).join("、")}`);
    const r = await env.call({ purpose: "paper_cite_fix", role: "writer", aiRole: "writing", messages: [
      { role: "system", content: systemFor("writer", "修正 LaTeX 章節裡的引用。只改引用，其他內容不變。") },
      { role: "user", content: [`這些 \\cite key 不在研究文獻庫：${unknown.join("、")}。`, `每一個：換成 library 裡真的支持同一論點的 key；沒有就刪掉那個 \\cite，論點沒有文獻支持就刪掉或改寫成不需要引用的說法。絕對不要新增 library 以外的 key。只輸出這一節完整的 LaTeX（第一行 \\${st.command}{${s.title}}）。`, dataBlock("library", libraryList(st) || "（空）"), dataBlock("section", out.text)].join("\n\n") },
    ], maxTokens: unitTokens(u.unit?.budget, 7000) }, step.id);
    const again = sanitizeSection(r.text, scopeOf(st, i));
    if (again.text.length > out.text.length * 0.5) { out = { text: again.text, notes: [...out.notes, ...again.notes] }; citeFixed = true; }
  }
  const final = sanitizeSection(out.text, { ...scopeOf(st, i), keys: st.keys });
  const notes = [...new Set([...out.notes, ...final.notes])];
  if (notes.length) await env.note(`「${clipText(s.title, 30)}」：${notes.join("；")}。`);
  return { summary: `${final.text.length} 字${res.continued ? `（接續寫完 ${res.continued} 次）` : ""}${res.regenerated ? "（重寫精簡版）" : ""}${res.truncated ? "（輸出仍被截斷）" : ""}${citeFixed ? "（修正引用）" : ""}`, text: final.text };
}

async function writeAbstract(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const st = env.state<DraftState>("draft")!;
  const texts = await sectionTexts(env);
  const en = st.language === "en";
  const user = taskPrompt(env, step, { context: { paper: `題目：${st.title}\n\n${texts.map((t) => t.slice(0, 1800)).join("\n\n")}` }, format: `先寫摘要（${en ? "150–250 English words" : "200–350 字繁體中文"}，純文字段落，不要 \\begin{abstract}），最後一行寫「KEYWORDS: 關鍵字1, 關鍵字2, 關鍵字3」。只根據各節內容，不要新增結果。` }, fix);
  const res = await env.call({ purpose: "paper_abstract", role: "writer", aiRole: "writing", messages: [{ role: "system", content: systemFor("writer", en ? "Write English only." : "") }, { role: "user", content: user }], maxTokens: 2500 }, step.id);
  return { summary: `${res.text.length} 字`, text: stripFence(res.text) };
}

function splitAbstract(text: string) {
  const m = /^\s*(?:KEYWORDS|Keywords|關鍵字)\s*[:：]\s*(.+)$/im.exec(text);
  const keywords = m ? m[1]!.split(/[,，、;；]/).map((k) => k.trim()).filter(Boolean).slice(0, 6) : [];
  const body = stripPreamble(text.replace(/^\s*(?:KEYWORDS|Keywords|關鍵字)\s*[:：].*$/im, "").replace(/\\begin\{abstract\}|\\end\{abstract\}/g, "")).text.replace(/\\(?:chapter|section)\*?\{[^}]*\}/g, "").trim();
  return { body, keywords };
}

/**
 * De-duplication across sections (lib/latex/section-scope.ts `sectionOverlap`): every later section that repeats an
 * earlier one's paragraphs or sub-headings gets ONE rewrite call naming exactly what is repeated (and where); paragraphs
 * still repeated afterwards are dropped by code. Earlier sections are never touched.
 */
async function dedupeSections(env: WorkflowEnv, step: StepRow, st: DraftState, paths: string[], files: Map<string, string>, setFix: (p: string, text: string) => void) {
  const texts = () => paths.map((p) => files.get(p) ?? "");
  // One rewrite per section version: a version already rewritten once is only cleaned by code.
  const tried = new Set(env.state<string[]>("deduped") ?? []);
  const found = sectionOverlap(texts());
  const later = [...new Set(found.map((o) => o.later))].slice(0, 6);
  for (const i of later) {
    const s = st.sections[i]!;
    const mine = sectionOverlap(texts()).filter((o) => o.later === i);
    if (!mine.length) continue;
    await env.activity(step.key, "integrator", `「${clipText(s.title, 30)}」與前面的章節重複，只改寫重複的部分`);
    const version = `${paths[i]}:${sha256Hex(files.get(paths[i]!)!)}`;
    if (tried.has(version)) {
      const d = dropRepeatedParagraphs(files.get(paths[i]!)!, texts().slice(0, i));
      if (d.dropped) setFix(paths[i]!, sanitizeSection(d.text, scopeOf(st, i)).text);
      continue;
    }
    tried.add(version);
    await env.setState({ deduped: [...tried] });
    const list = mine.map((o) => `- ${o.kind === "heading" ? "小節標題" : "段落"}「${o.sample}」已經寫在第 ${o.earlier + 1} 節「${st.sections[o.earlier]!.title}」`).join("\n");
    const res = await env.call({ purpose: "paper_dedupe", role: "integrator", aiRole: "writing", messages: [
      { role: "system", content: systemFor("integrator", "你在整理一篇論文的章節，讓每一節只寫自己的內容。") },
      { role: "user", content: [`第 ${i + 1} 節「${s.title}」重複了前面章節的內容：\n${list}`, `刪掉或改寫這些重複的部分：前面已經講過的最多用一句話帶過並寫「見第 N 節」，把篇幅留給這一節自己的重點：${s.points.join("；") || "依標題"}。其他段落保持原樣，不要新增 \\cite key、不要加前言或參考文獻。只輸出這一節完整的 LaTeX（第一行 \\${st.command}{${s.title}}）。`, dataBlock("section", files.get(paths[i]!)!)].join("\n\n") },
    ], maxTokens: 8000 }, step.id);
    let text = sanitizeSection(res.text, { ...scopeOf(st, i), keys: st.keys }).text;
    if (text.length < (files.get(paths[i]!) ?? "").length * 0.3) text = files.get(paths[i]!)!;
    const earlier = texts().slice(0, i);
    if (sectionOverlap([...earlier, text]).some((o) => o.later === i && o.kind === "paragraph")) {
      const d = dropRepeatedParagraphs(text, earlier);
      text = sanitizeSection(d.text, scopeOf(st, i)).text;
      if (d.dropped) await env.note(`「${clipText(s.title, 30)}」改寫後仍有 ${d.dropped} 段與前面重複，已刪除。`);
    }
    setFix(paths[i]!, text);
  }
}

/** Creates the project (first round) or rewrites the run's own files, then compiles; a fix round first repairs the files the errors point at. */
async function assemble(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const st = env.state<DraftState>("draft")!;
  const studyId = env.run.study_id!;
  const access = await requireEditor(env, studyId);
  const texts = await sectionTexts(env);
  const steps = await getSteps(env.db, env.run.id);
  const abs = splitAbstract(steps.find((s) => s.key === "abstract")?.output?.text ?? "");
  const paths = st.sections.map((s, i) => sectionFile(i, s.title));
  const abstractPath = st.template === "zh-thesis" ? "sections/abstract-zh.tex" : "sections/abstract.tex";
  const prior = env.state<Written>("written");
  const files = new Map<string, string>(paths.map((p, i) => [p, texts[i] || withHeading("", st.sections[i]!.title, i, st.command)]));
  files.set(abstractPath, abstractTex(st.template, abs.body || (st.language === "en" ? "Abstract." : "摘要。"), abs.keywords));
  // Repairs of single files (de-duplication, compile fixes) apply only while the section they started from is unchanged:
  // a section rewritten by its writer (a repair round) drops them.
  const fixes: Record<string, FileFix> = Object.fromEntries(Object.entries(env.state<Record<string, FileFix | string>>("fixed") ?? {}).filter((e): e is [string, FileFix] => typeof e[1] === "object" && !!e[1]));
  const origin = new Map([...files].map(([p, t]) => [p, sha256Hex(t)]));
  for (const [p, f] of Object.entries(fixes)) if (files.has(p) && origin.get(p) === f.from) files.set(p, f.text);
  const setFix = (p: string, text: string) => { fixes[p] = { from: origin.get(p)!, text }; files.set(p, text); };
  // Each section only its own content: a later section repeating an earlier one gets one targeted rewrite of the repeated
  // parts; what is still repeated after it is removed by code.
  await dedupeSections(env, step, st, paths, files, setFix);
  // Fix round: only the files the compile errors name are repaired (main.tex and refs.bib are generated by code); no file
  // named → the sections with a visible syntax problem, else every section. A repair is a section again (sanitised).
  const errors = prior?.compile?.errors ?? [];
  if (fix && prior && errors.length) {
    const named = [...files.keys()].filter((p) => errors.some((e) => e.includes(p) || e.includes(p.replace(/\.tex$/, ""))));
    const broken = paths.filter((p) => { const t = files.get(p)!; return unbalanced(t).length > 0 || (t.match(/(?<!\\)\{/g) ?? []).length !== (t.match(/(?<!\\)\}/g) ?? []).length || scopeIssues(t, scopeOf(st, paths.indexOf(p))).length > 0; });
    const targets = named.length ? named : broken.length ? broken : paths;
    for (const p of targets.slice(0, 6)) {
      const i = paths.indexOf(p);
      await env.activity(step.key, "integrator", `依編譯錯誤修正 ${p}`);
      const current = files.get(p)!;
      const what = i >= 0 ? `這是被主檔 \\input 的章節檔（「${st.sections[i]!.title}」）：只輸出這一節完整的 LaTeX（第一行 \\${st.command}{…}），不要 \\documentclass、\\usepackage、\\begin{document}、摘要、thebibliography 或 \\input——前言與參考文獻都在主檔。` : "只輸出這個檔案完整的 LaTeX。";
      const res = await env.call({ purpose: "paper_fix", role: "integrator", aiRole: "writing", messages: [{ role: "system", content: systemFor("integrator", `修正 LaTeX 錯誤（未跳脫的特殊字元、未關閉的環境、未定義的指令、pdfLaTeX 不支援的字元），內容不變。${what}`) }, { role: "user", content: `編譯錯誤：\n${errors.join("\n")}\n\n${dataBlock(p, current)}` }], maxTokens: 8000 }, step.id);
      const fixed = i >= 0 ? sanitizeSection(res.text, { ...scopeOf(st, i), keys: st.keys }).text : `${stripFence(res.text)}\n`;
      // A repair that lost content, or that still writes outside its section, is not taken.
      if (fixed.length > current.length * 0.5 && (i < 0 || !scopeIssues(fixed, scopeOf(st, i)).some((x) => x.startsWith("章節檔")))) setFix(p, fixed);
    }
  }
  await env.setState({ fixed: fixes });
  const author = env.user.name || "作者";
  const main = paperMain(st.template, st.title, author, paths, abstractPath);
  // A record that cannot be exported leaves the template's refs.bib (the compile then reports the missing keys).
  const { bibtex, count } = await exportStudyBibtex(env.db, studyId).catch((e: Error) => (env.deps.log.warn({ err: e, workflowId: env.run.id }, "paper bib export failed"), { bibtex: "", count: 0 }));
  const sha: Record<string, string> = { ...(prior?.sha ?? {}) };
  let projectId = prior?.project_id ?? null;
  const skipped: string[] = [];
  await transaction(env.db, async (client) => {
    if (!projectId || !(await findProject(client, projectId))) {
      projectId = await createPaperProject(client, { studyId, studySlug: access.study.slug, title: st.title, template: st.template, actorId: env.user.id });
      await addArtifact(client, env.run.id, { kind: "latex_project", id: projectId, url: latexUrl(access.study.slug, projectId), title: st.title, role: "draft" });
    }
    await client.query("SELECT 1 FROM latex_projects WHERE id=$1 FOR UPDATE", [projectId]);
    if (!(await writeOwn(client, projectId, "main.tex", main, env.user.id, sha, "main"))) skipped.push("main.tex");
    if (count && !(await writeOwn(client, projectId, "refs.bib", `${BIB_HEADER(count)}${bibtex}`, env.user.id, sha, "bib"))) skipped.push("refs.bib");
    for (const [p, t] of files) if (!(await writeOwn(client, projectId!, p, t, env.user.id, sha, "section"))) skipped.push(p);
    await client.query("UPDATE latex_projects SET updated_at=now(), updated_by=$2 WHERE id=$1", [projectId, env.user.id]);
  });
  if (skipped.length) await env.note(`這些檔案在撰寫期間被修改過，沒有覆蓋：${skipped.join("、")}。`, "warn");
  const project = (await findProject(env.db, projectId!))!;
  const rootText = await liveText(env.db, null, (await findFileByPath(env.db, project.id, project.root_file))!);
  const compile = await verificationCompile(env, project.id, [], rootText);
  const written: Written = { project_id: project.id, paths, abstract_path: abstractPath, sha, compile };
  const full = [files.get(abstractPath)!, ...paths.map((p) => files.get(p)!)].join("\n\n");
  await env.setState({ written, tex: full });
  return { summary: `LaTeX 專案〈${clipText(st.title, 40)}〉：${paths.length} 節＋摘要；驗證編譯：${compile.status}${compile.errors.length ? `（${compile.errors.length} 個錯誤）` : ""}`, text: full, data: { compile, sections: st.sections.map((s) => s.title) } };
}

/** A new project from the template's settings without its sample sections (the run writes main.tex / sections / refs.bib right after). */
async function createPaperProject(client: Queryable, input: { studyId: string; studySlug: string; title: string; template: LatexTemplateId; actorId: string }) {
  const info = templateInfo(input.template);
  const id = (await client.query<{ id: string }>(
    `INSERT INTO latex_projects(study_id,title,kind,template,root_file,compiler,bib_mode,settings,created_by,updated_by)
     VALUES($1,$2,$3,$4,'main.tex',$5,'auto',$6,$7,$7) RETURNING id`,
    [input.studyId, clipText(input.title, 160), input.template === "zh-thesis" ? "thesis" : "paper", input.template, info.compiler, JSON.stringify({ bibFile: "refs.bib", sectionCommand: info.sectionCommand }), input.actorId],
  )).rows[0]!.id;
  // Template support files other than main / sections / refs.bib (none today; kept for future templates).
  const built = generateTemplate(input.template, { title: input.title });
  for (const f of built.files) {
    if (f.path === built.rootFile || built.sections.includes(f.path)) continue;
    await insertTextFile(client, { projectId: id, path: f.path, content: f.content, role: roleOf(f.path, built.rootFile, new Set(built.sections)), actorId: input.actorId });
  }
  await recordActivity(client, { studyId: input.studyId, actorId: input.actorId, kind: "latex_project_created", title: clipText(input.title, 160), url: latexUrl(input.studySlug, id), targetType: "latex_project", targetId: id });
  return id;
}

async function draftCommit(env: WorkflowEnv, outcome: "done" | "partial") {
  const w = env.state<Written>("written");
  if (!w) return "論文沒有寫入（流程在建立專案前就停止了）。";
  // A real compile gives the editor its preview PDF (best effort; the verification compile already ran).
  if (!env.state<boolean>("preview_requested")) {
    const project = await findProject(env.db, w.project_id);
    if (project) await requestCompile({ db: env.db, storage: env.storage, collab: null }, project, { actorId: env.user.id }).then(() => env.setState({ preview_requested: true })).catch((e: Error) => env.deps.log.warn({ err: e, workflowId: env.run.id }, "paper preview compile failed"));
  }
  const ok = w.compile?.status === "success" || (w.compile?.status === "partial" && !w.compile.errors.length);
  return `LaTeX 專案已建立：${w.paths.length} 節＋摘要${ok ? "，編譯成功" : `，編譯仍有錯誤（${(w.compile?.errors ?? []).slice(0, 2).join("；")}）`}${outcome === "partial" ? "；部分驗收標準未通過，見下方" : ""}。`;
}

async function draftApplyEdits(env: WorkflowEnv, edits: ApprovalEdits) {
  const st = env.state<DraftState>("draft");
  if (!st || !edits.outline?.length) return {};
  const sections: PaperSection[] = edits.outline.slice(0, 10).map((o) => {
    const cites = o.points.flatMap((p) => /^引用[:：]/.test(p) ? p.replace(/^引用[:：]\s*/, "").split(/[,，、\s]+/).filter((k) => st.keys.includes(k)) : []);
    return { title: clipText(o.title.trim(), 120), points: o.points.filter((p) => !/^引用[:：]/.test(p)).slice(0, 6), cites };
  });
  const next = { ...st, sections };
  await env.setState({ draft: next, units: paperUnits(next) });
  const outline: OutlineItem[] = sections.map((s, i) => ({ n: i + 1, title: s.title, points: [...s.points, ...(s.cites.length ? [`引用：${s.cites.join(", ")}`] : [])] }));
  const steps = await getSteps(env.db, env.run.id);
  const dep = steps.some((s) => s.key === "outline") ? "outline" : "research";
  return { steps: draftSteps(next, dep), outline };
}

const paperDraft: WorkflowPlaybook = {
  id: "paper_draft",
  title: "撰寫 LaTeX 論文",
  titleEn: "LaTeX paper draft",
  description: "依論文大綱建立新的 LaTeX 專案（中文 article-zh／碩論 zh-thesis，英文 IEEE），平行撰寫每一節與摘要、引用研究文獻庫，編譯並修正錯誤",
  descriptionEn: "From a paper outline: a new LaTeX project (article-zh / zh-thesis / IEEE), every section and the abstract drafted in parallel with library citations, compiled and fixed",
  capability: { produces: "paper", requires: { ...STUDY_ONLY, papers: 3, outline_note: true }, summary: "整篇 LaTeX 論文：依大綱筆記建立新的 LaTeX 專案，寫完每一節與摘要並編譯（沒有大綱時自己先規劃章節）" },
  autoApprovable: true,
  detect: (req) => (/(?:整篇|完整|一篇|從零|從 ?0)[^。\n]{0,10}(?:latex\s*)?(?:論文|paper)|latex\s*論文|論文(?:初稿|全文)/i.test(req) && !/簡報|投影片/.test(req) ? 0.75 : 0),
  plan: draftPlan,
  applyEdits: draftApplyEdits,
  async execute(env, step, fix) {
    if (step.key === "research" || step.key === "outline") return step.output ?? { summary: "", text: env.state<string>("brief") ?? "" };
    if (step.key.startsWith("sec_")) return writeSection(env, step, fix);
    if (step.key === "abstract") return writeAbstract(env, step, fix);
    if (step.key === "assemble") return assemble(env, step, fix);
    throw new WorkflowInputError(`未知的步驟 ${step.key}`);
  },
  async finalText(env) {
    const st = env.state<DraftState>("draft");
    const w = env.state<Written>("written");
    return { text: paperHeadings(env.state<string>("tex") ?? "", st?.command), data: { compile: w?.compile, sections: st?.sections.map((s) => s.title) ?? [] } };
  },
  async repair(env, failing) {
    const st = env.state<DraftState>("draft");
    const out: { key: string; issues: string[] }[] = [];
    const text = env.state<string>("tex") ?? "";
    for (const c of failing) {
      if (c.id === "compile") out.push({ key: "assemble", issues: [c.reason ?? "編譯失敗"] });
      else if (c.id === "distinct" && st) {
        // The later section of each repeated pair is rewritten (the earlier one keeps its content).
        const found = paperOverlap(text, st.command);
        for (const o of found.overlaps) {
          // Every section file has exactly one top-level heading, so block n is section n.
          const key = `sec_${o.later + 1}`;
          const issue = `與第 ${o.earlier + 1} 節「${found.titles[o.earlier]}」重複：「${o.sample}」。刪掉重複的部分，只寫這一節自己的重點。`;
          const hit = out.find((x) => x.key === key);
          if (hit) hit.issues.push(issue); else out.push({ key, issues: [issue] });
        }
      }
      else if (c.id === "structure") st?.sections.forEach((s, i) => { if (!text.includes(s.title)) out.push({ key: `sec_${i + 1}`, issues: [`這一節沒有寫出來或標題不對：${c.reason ?? ""}`] }); });
      else st?.sections.slice(0, 4).forEach((_, i) => out.push({ key: `sec_${i + 1}`, issues: [`${c.text}：${c.reason ?? ""}`] }));
    }
    return out;
  },
  commit: draftCommit,
};

for (const p of [paperOutline, paperDraft]) registerWorkflowPlaybook(p);
export { paperOutline, paperDraft };
