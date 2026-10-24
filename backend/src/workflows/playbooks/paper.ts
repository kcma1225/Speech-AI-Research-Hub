/**
 * Writing a whole paper (docs/architecture.md "Workflows" → Goals; the last stages of a 「從零寫一篇論文」 goal):
 * - `paper_outline` 論文大綱 — a new note in a fixed Markdown format (題目, 主要貢獻, 章節規劃 with each section's points
 *   and `[@key]` citations) from the research notes handed over by earlier stages and the study library.
 * - `paper_draft` 撰寫 LaTeX 論文 — reads that outline note (or plans an outline itself), writers draft every section in
 *   parallel plus the abstract, then `assemble` creates a **new LaTeX project** from a template (zh → article-zh /
 *   zh-thesis, en → ieee-conference) with one file per section and refs.bib from the study library, compiles it (a
 *   verification compile, no history row) and fixes compile errors in bounded rounds. Only the run's own new project is
 *   ever written (effect `new`); a file someone edited in the meantime is left alone.
 */
import { initialState } from "../../collab/text.js";
import { transaction, type Queryable } from "../../db.js";
import { exportStudyBibtex } from "../../lib/library/study-export.js";
import { addInput, listInputs, removeInput } from "../../lib/latex/inputs.js";
import { generateTemplate, templateInfo, type LatexTemplateId } from "../../lib/latex/templates.js";
import { requestCompile } from "../../lib/latex-projects/service.js";
import { findFileByPath, findProject, insertTextFile, latexDocName, latexUrl, liveText, roleOf, sha256Hex } from "../../lib/latex-projects/store.js";
import { recordActivity } from "../../lib/studies/activity.js";
import { CHECKS } from "../checks.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps, markTainted } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import type { CheckSpec, Criterion, OutlineItem, StepOutput, StepRow, StepSpec } from "../types.js";
import { clipText, planningStep, systemFor, taskPrompt } from "./common.js";
import { commitNote, finalSpec, studyOrQuestion } from "./documents.js";
import { latexHeadings, verificationCompile } from "./latex.js";
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
  const clean = sections.filter((s) => s.title && !/^參考文獻|^references$/i.test(s.title)).slice(0, 12);
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
};
Object.assign(CHECKS, OUTLINE_CHECKS);

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

type DraftState = { sections: PaperSection[]; title: string; language: "zh" | "en"; template: LatexTemplateId; keys: string[]; command: "chapter" | "section" };
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
  const st: DraftState = { sections, title: outline.title, language: lang, template, keys: src.keys, command };
  await env.setState({ draft: st, brief: src.brief.slice(0, 30_000), outline_note: outlineNote ? { id: outlineNote.n.id, title: outlineNote.n.title } : null, units: paperUnits(st) });
  const info = templateInfo(template);
  return {
    kind: "plan",
    title: clipText(`論文：${outline.title}`, 120),
    studyId,
    objective: `依${outlineNote ? `大綱〈${outlineNote.n.title}〉` : "規劃的大綱"}寫完整的 LaTeX 論文「${outline.title}」：新的 LaTeX 專案（${info.name_zh}），${sections.length} 節＋摘要，引用研究文獻庫，編譯通過。`,
    criteria: draftCriteria(src.keys),
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

const draftCriteria = (keys: string[]): Omit<Criterion, "status">[] => [
  { id: "compile", kind: "check", text: "LaTeX 專案編譯成功（沒有錯誤）", check: { id: "compile_ok" } },
  { id: "structure", kind: "check", text: "大綱的每一節都寫出來了", check: { id: "paper_sections" } },
  ...(keys.length ? [{ id: "cites", kind: "check" as const, text: "所有 \\cite 都對應到研究文獻庫的 cite key", check: { id: "citations", params: { keys, min: 1 } } }] : []),
  { id: "complete", kind: "check", text: "沒有佔位文字或被截斷的內容", check: { id: "no_placeholder" } },
  { id: "grounded", kind: "judge", text: "論述來自調研筆記與文獻，引用對應正確的論點，沒有捏造實驗結果或數字" },
];

function sectionChecks(st: DraftState, s: PaperSection): CheckSpec[] {
  return [
    { id: "citations", params: { keys: st.keys, min: s.cites.length && st.keys.length ? 1 : 0 } },
    { id: "not_truncated" }, { id: "no_placeholder" }, { id: "min_length", params: { chars: 500 } },
    { id: "sections_present", params: { sections: [s.title] } },
  ];
}

function draftSteps(st: DraftState, dep: string): StepSpec[] {
  const secs: StepSpec[] = st.sections.map((s, i) => ({
    key: `sec_${i + 1}`, role: "writer", title: `撰寫「${clipText(s.title, 40)}」`,
    instructions: `寫 \\${st.command}{${s.title}} 的 LaTeX 內文。重點：${s.points.join("；") || "依大綱與資料"}${s.cites.length ? `。引用：${s.cites.join(", ")}` : ""}。`,
    depends_on: [dep], inputs: { index: i }, expected: `一個 \\${st.command} 的 LaTeX 內文`, verify: { checks: sectionChecks(st, s), judge: true },
  }));
  return [
    ...secs,
    { key: "abstract", role: "writer", title: "撰寫摘要與關鍵字", instructions: "依各節內容寫摘要（150–250 字／words）與 3–5 個關鍵字。", depends_on: secs.map((s) => s.key), expected: "摘要＋關鍵字", verify: { checks: [{ id: "min_length", params: { chars: 120 } }, { id: "no_placeholder" }], judge: false } },
    { key: "assemble", role: "integrator", kind: "integrate", title: "建立 LaTeX 專案並編譯", instructions: "建立 LaTeX 專案（每節一個檔案、參考文獻來自研究文獻庫）並編譯；有錯誤時依錯誤修正。", depends_on: ["abstract", ...secs.map((s) => s.key)], expected: "可以編譯的論文", max_rounds: 3, verify: { checks: [{ id: "compile_ok" }, ...(st.keys.length ? [{ id: "citations", params: { keys: st.keys, min: 0 } }] : []), { id: "not_truncated" }], judge: false } },
    finalSpec(),
  ];
}

async function sectionTexts(env: WorkflowEnv) {
  const st = env.state<DraftState>("draft")!;
  const steps = await getSteps(env.db, env.run.id);
  return st.sections.map((s, i) => {
    const out = steps.find((x) => x.key === `sec_${i + 1}`)?.output?.text ?? "";
    return out.trim() ? withHeading(out, s.title, i, st.command) : "";
  });
}

async function writeSection(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const st = env.state<DraftState>("draft")!;
  const i = Number(step.inputs.index ?? 0);
  const s = st.sections[i]!;
  const en = st.language === "en";
  // One section = one unit: its budget and its neighbours (their text once written), generated alone (units.ts).
  const u = await unitContext(env, step, st.language);
  const user = taskPrompt(env, step, {
    context: {
      paper: `題目：${st.title}\n章節：\n${st.sections.map((x, j) => `${j + 1}. ${x.title}${j === i ? "（← 你寫這一節）" : ""}`).join("\n")}`,
      sources: (env.state<string>("brief") ?? "").slice(0, 16_000),
      cite_keys: st.keys.join(", ") || "（文獻庫是空的：不要用 \\cite）",
    },
    format: [`只輸出這一節的 LaTeX：第一行 \\${st.command}{${s.title}}，接著 3–6 段內文（必要時 \\subsection、itemize、table）。引用用 \\cite{key}，key 只能用 cite_keys 裡的。不要 \\documentclass、不要 \\begin{document}、不要 Markdown、不要 \`\`\`。特殊字元要跳脫（\\%、\\&、\\_、\\#）。${en ? "用英文（English）撰寫，不要出現中文字。" : "用繁體中文撰寫。"}資料沒有的實驗數字不要寫。`, u.budget, u.neighbours].filter(Boolean).join("\n"),
  }, fix);
  const res = await generateUnit(env, { purpose: "paper_section", role: "writer", aiRole: "writing", messages: [{ role: "system", content: systemFor("writer", `你在寫一篇學術論文的 LaTeX 內文。${en ? "This paper is written in English: write English only (the 繁體中文 rule does not apply to the paper text)." : ""}`) }, { role: "user", content: user }], maxTokens: unitTokens(u.unit?.budget, 7000) }, step.id, { clean: stripFence });
  const tex = withHeading(res.text, s.title, i, st.command);
  return { summary: `${tex.length} 字${res.continued ? `（接續寫完 ${res.continued} 次）` : ""}${res.regenerated ? "（重寫精簡版）" : ""}${res.truncated ? "（輸出仍被截斷）" : ""}`, text: tex };
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
  const body = text.replace(/^\s*(?:KEYWORDS|Keywords|關鍵字)\s*[:：].*$/im, "").replace(/\\begin\{abstract\}|\\end\{abstract\}/g, "").trim();
  return { body, keywords };
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
  // Fix round: the files the compile errors name (else all sections) are repaired by the integrator, content unchanged.
  const errors = prior?.compile?.errors ?? [];
  if (fix && prior && errors.length) {
    const named = [...files.keys()].filter((p) => errors.some((e) => e.includes(p)));
    const targets = named.length ? named : [...files.keys()].filter((p) => p !== abstractPath);
    for (const p of targets.slice(0, 6)) {
      await env.activity(step.key, "integrator", `依編譯錯誤修正 ${p}`);
      const current = env.state<Record<string, string>>("fixed")?.[p] ?? files.get(p)!;
      const res = await env.call({ purpose: "paper_fix", role: "integrator", aiRole: "writing", messages: [{ role: "system", content: systemFor("integrator", "修正 LaTeX 錯誤（未跳脫的特殊字元、未關閉的環境、未定義的指令、pdfLaTeX 不支援的字元），內容不變。只輸出這個檔案完整的 LaTeX。") }, { role: "user", content: `編譯錯誤：\n${errors.join("\n")}\n\n${dataBlock(p, current)}` }], maxTokens: 8000 }, step.id);
      const fixed = stripFence(res.text);
      if (fixed.length > current.length * 0.5) await env.setState({ fixed: { ...(env.state<Record<string, string>>("fixed") ?? {}), [p]: `${fixed}\n` } });
    }
  }
  for (const [p, t] of Object.entries(env.state<Record<string, string>>("fixed") ?? {})) if (files.has(p)) files.set(p, t);
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
    return { text: latexHeadings(env.state<string>("tex") ?? ""), data: { compile: w?.compile, sections: st?.sections.map((s) => s.title) ?? [] } };
  },
  async repair(env, failing) {
    const st = env.state<DraftState>("draft");
    const out: { key: string; issues: string[] }[] = [];
    const text = env.state<string>("tex") ?? "";
    for (const c of failing) {
      if (c.id === "compile") out.push({ key: "assemble", issues: [c.reason ?? "編譯失敗"] });
      else if (c.id === "structure") st?.sections.forEach((s, i) => { if (!text.includes(s.title)) out.push({ key: `sec_${i + 1}`, issues: [`這一節沒有寫出來或標題不對：${c.reason ?? ""}`] }); });
      else st?.sections.slice(0, 4).forEach((_, i) => out.push({ key: `sec_${i + 1}`, issues: [`${c.text}：${c.reason ?? ""}`] }));
    }
    return out;
  },
  commit: draftCommit,
};

for (const p of [paperOutline, paperDraft]) registerWorkflowPlaybook(p);
export { paperOutline, paperDraft };
