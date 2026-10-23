/**
 * 從 0 到 1 建立簡報: paper report (a library paper's full text) or progress report (study data).
 * research → outline of exactly N pages (both during planning; the plan card shows the outline) → writers per group of
 * ≤ 3 pages (parallel) → assemble into the deck's Quarto entry + preview render → visual review (vision only) →
 * speaker-notes pass → final verification. Writes only into a new deck or the run's own draft deck.
 */
import { randomUUID } from "node:crypto";
import { transaction } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { paperFullText, digest } from "../../lib/library/fulltext.js";
import { newShareKey } from "../../lib/slides/access.js";
import { cleanBody, draftQmd, expectedPages, fixMessages, progressContext, type DeckMode } from "../../lib/slides/ai-context.js";
import { freeSlug } from "../../lib/slides/create.js";
import { enqueuePreview, previewToken, previewViewUrl } from "../../lib/slides/preview.js";
import { createTree, loadTree, saveText } from "../../lib/slides/sources.js";
import { LABHUB_RULES, progressTitle, taipeiToday } from "../../lib/slides/templates.js";
import { previewImages } from "../../lib/vision/slides.js";
import { normalizeDiagrams } from "../../lib/slides/deck-visuals.js";
import { figureSyntax } from "../../lib/slides/content-lint.js";
import { buildContentRefs, contentRefsOf, paperFigures } from "../content-refs.js";
import { bodyIssues, closeOpenBlocks, combineScores, fixContent, fixFor, materializeVisuals, replaceSlides, scoreTable, sourceIssues, visionScores, visualShare, VISUAL_RULES, type PageScore, type ShotPage } from "./slides-visual.js";
import { parseSlides, PLACEHOLDER_RE, titleMatches } from "../checks.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import { WorkflowStop, type CheckSpec, type Criterion, type OutlineItem, type PlannedWrite, type StepOutput, type StepRow, type StepSpec } from "../types.js";
import { abstractBrief, ensurePaperPdf } from "../paper-pdf.js";
import { clipText, paperIdOf, paperOf, planningStep, resolveStudy, systemFor, taskPrompt, whichStudyQuestion } from "./common.js";
import { batchPapers } from "../context.js";
import { registerWorkflowPlaybook, type WorkflowPlaybook } from "./registry.js";
import { applyStudentPages, runStudentInput, STUDENT_INPUT_KEY, studentInputStep, studentPagesOf } from "../student-input.js";
import { checkedCriteria, localizeLabels, runLabels, targetLanguage, LANGUAGE_LABEL } from "../requirements.js";
import { deckSubtitle, failingPages, fixPages, frontMatterText, frontTitle, guardRequirements, splitChunks } from "./slides-requirements.js";
import type { EditKind, Requirement } from "../types.js";

/** `item` = the method / model this page presents (expand plans with per-item fields: the check finds its pages by it). */
type SlideOutline = OutlineItem & { student_owned?: boolean; item?: string };
type DeckState = { qa?: { round: number; scores: PageScore[]; vision: boolean; failed: number[]; unseen?: boolean }; last_written?: string; deck_id?: string; deck_slug?: string; deck_title?: string; body?: string; revision?: number; file_version?: number; render_error?: string | null; render_timed_out?: boolean; preview_id?: string | null };

export const PAGES_PER_WRITER = 3;
/** Section titles of experiments / results / ablations (their text gets most of the excerpt budget). */
const RESULTS_SECTION_RE = /experiment|result|evaluation|ablation|analysis|discussion|comparison|實驗|結果|分析/i;
// Reasoning models spend part of the budget thinking; 9000 truncated ~40 % of first drafts on staging.
const WRITER_TOKENS = 16_000;

const modeOf = (env: WorkflowEnv): DeckMode => (env.state<DeckMode>("mode") ?? "progress");
const outlineOf = (env: WorkflowEnv): SlideOutline[] => (env.run.plan?.outline as SlideOutline[] | undefined) ?? [];
const studentOwned = (o: SlideOutline[]) => o.filter((p) => p.student_owned).map((p) => p.title);

function writerChecks(pages: SlideOutline[], owned: string[]): { checks: CheckSpec[]; judge: boolean } {
  return {
    checks: [
      { id: "slide_count", params: { expected: pages.length } },
      { id: "slide_titles", params: { titles: pages.map((p) => p.title) } },
      { id: "speaker_notes", params: { min_chars: 30, allow_titles: owned } },
      { id: "no_placeholder", params: { allow_titles: owned, on_slide: true } },
      { id: "not_truncated" },
      { id: "slide_length", params: { max_chars: 1100, max_bullets: 9 } },
      { id: "slide_density", params: { max_words: 75, max_bullets: 6, allow_titles: owned } },
      { id: "diagram_syntax" },
      // Content against the sources (`data.refs`): names, figure numbers, diagram semantics, chart units.
      { id: "grounded_names", params: { allow_titles: owned } },
      { id: "figure_refs", params: { allow_titles: owned } },
      { id: "diagram_semantics", params: { allow_titles: owned } },
      { id: "chart_semantics", params: { allow_titles: owned } },
    ],
    judge: true,
  };
}

/** Writer steps: one per group of ≤ 3 consecutive pages. */
export function writerSteps(outline: SlideOutline[]): StepSpec[] {
  const owned = studentOwned(outline);
  const out: StepSpec[] = [];
  for (let i = 0; i < outline.length; i += PAGES_PER_WRITER) {
    const pages = outline.slice(i, i + PAGES_PER_WRITER);
    const a = pages[0]!.n;
    const b = pages.at(-1)!.n;
    out.push({
      key: `write_${a}`,
      role: "writer",
      title: a === b ? `撰寫第 ${a} 頁` : `撰寫第 ${a}–${b} 頁`,
      instructions: `依大綱寫出第 ${a}${a === b ? "" : `–${b}`} 頁投影片與講稿：${pages.map((p) => `「${p.title}」`).join("、")}。`,
      depends_on: ["outline"],
      inputs: { pages: pages.map((p) => p.n) },
      expected: `${pages.length} 頁，每頁以「## 標題」開頭並附講稿`,
      verify: writerChecks(pages, owned),
    });
  }
  return out;
}

function laterSteps(outline: SlideOutline[], vision: boolean): StepSpec[] {
  const writes = writerSteps(outline);
  const owned = studentOwned(outline);
  const n = outline.length;
  // Student-owned pages: ask the student (one card with grounded options) once the content pages are drafted.
  const ask = owned.length ? [studentInputStep(owned, writes.map((w) => w.key))] : [];
  const steps: StepSpec[] = [
    ...writes,
    ...ask,
    {
      key: "assemble",
      role: "integrator",
      kind: "integrate",
      title: "整合成簡報並編譯預覽",
      instructions: "依頁序合併各段投影片，寫入簡報草稿（Quarto），編譯預覽並確認能成功編譯。編譯失敗時依錯誤訊息修正語法。",
      depends_on: [...writes.map((w) => w.key), ...ask.map((a) => a.key)],
      expected: `一份 ${n} 頁、可以編譯的簡報草稿`,
      verify: { checks: [{ id: "render_ok" }, { id: "slide_count", params: { expected: n } }, { id: "slide_titles", params: { titles: outline.map((o) => o.title) } }, { id: "not_truncated" }], judge: false },
    },
  ];
  steps.push(
    {
      key: "notes",
      role: "writer",
      title: "補齊講稿",
      instructions: "檢查每一頁的講稿；缺少或太短（< 30 字）的頁面補上講稿（學生自填頁除外）。",
      depends_on: ["assemble"],
      expected: "每頁都有完整講稿",
      verify: { checks: [{ id: "speaker_notes", params: { min_chars: 30, allow_titles: owned } }, { id: "render_ok" }], judge: false },
    },
    {
      key: "constraints",
      role: "writer",
      title: "逐條檢查你的要求並修正（語言、頁數、主題、每項內容…）",
      instructions: "對整份簡報（含封面）逐條跑你的要求的自動檢查；沒有符合的頁面交給撰寫者只改那幾頁（封面標題換成要求的語言），重新檢查，最多 3 輪。",
      depends_on: ["notes"],
      expected: "整份簡報符合你的每一條要求",
      verify: { checks: [{ id: "req_ok" }, { id: "render_ok" }], judge: false },
      max_rounds: 0,
    },
    {
      key: "visual_qa",
      role: "designer",
      title: vision ? "逐頁截圖視覺檢查（看圖評分並修正）" : "逐頁版面檢查（量測，模型不能看圖）",
      instructions: vision
        ? "編譯並擷取每一頁截圖，交給能看圖的審查者逐頁評分（易讀、擁擠、版面、視覺、圖是否正確畫出、超出、一致、專業感；平均 ≥ 4 分且沒有嚴重問題才通過），並用版面量測檢查文字超出方框或投影片、字小於 16px、大片空白、圖表與表格重複；未通過的頁面交回撰寫者依指示修正後重新編譯，最多 3 輪，仍未通過的頁面會在報告中列出。"
        : "目前的模型不能看圖：改用版面量測（超出方框或投影片、字級 ≥ 16px、大片空白、字數、條列、圖是否編譯成功、圖表與表格重複）逐頁檢查，未通過的頁面交回撰寫者修正後重新編譯，最多 3 輪，仍未通過的頁面會在報告中列出。",
      depends_on: ["constraints"],
      expected: "每一頁都通過視覺檢查",
      verify: { checks: [{ id: "render_ok" }, { id: "visual_qa" }], judge: false },
      max_rounds: 0,
    },
    { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收整份簡報。", depends_on: ["visual_qa"], expected: "每一條驗收標準都通過" },
  );
  return steps;
}

function criteriaFor(n: number, mode: DeckMode, owned: string[], abstractOnly = false): Omit<Criterion, "status">[] {
  return [
    { id: "pages", kind: "check", text: `簡報正好 ${n} 頁，頁面順序與確認的大綱一致`, check: { id: "slide_count", params: { expected: n } } },
    { id: "render", kind: "check", text: "Quarto 預覽可以成功編譯", check: { id: "render_ok" } },
    { id: "notes", kind: "check", text: `每一頁都有講稿${owned.length ? "（學生自填頁除外）" : ""}`, check: { id: "speaker_notes", params: { min_chars: 30, allow_titles: owned } } },
    { id: "clean", kind: "check", text: `沒有佔位文字（〔　〕、待補、TODO）${owned.length ? "，學生自填頁除外" : ""}`, check: { id: "no_placeholder", params: { allow_titles: owned, on_slide: true } } },
    { id: "complete", kind: "check", text: "內容完整，沒有被截斷的頁面或未關閉的區塊", check: { id: "not_truncated" } },
    { id: "visuals", kind: "check", text: "以視覺為主：至少六成內容頁有流程圖、圖表、論文圖或表格，圖都正確編譯（沒有原始碼外露）", check: { id: "visual_ratio", params: { min_ratio: 0.6, allow_titles: owned } } },
    { id: "diagrams", kind: "check", text: "流程圖（diagram）與圖表語法正確，圖放得進投影片", check: { id: "diagram_syntax" } },
    { id: "names", kind: "check", text: "提到的模型、資料集與方法名稱都出現在論文或研究資料裡", check: { id: "grounded_names", params: { allow_titles: owned } } },
    { id: "figrefs", kind: "check", text: "論文圖的圖說、內文與講稿的圖號和放的圖一致", check: { id: "figure_refs", params: { allow_titles: owned } } },
    { id: "semantics", kind: "check", text: "流程圖語意正確：trainable／frozen 只標本文訓練或凍結的元件，並列項目不畫成流程", check: { id: "diagram_semantics", params: { allow_titles: owned } } },
    { id: "charts", kind: "check", text: "每張圖表只有一種單位並標出座標軸，同一組數字只畫一次", check: { id: "chart_semantics", params: { allow_titles: owned } } },
    { id: "visual_qa", kind: "check", text: "每一頁都通過截圖視覺檢查（字 ≥ 16px、不擁擠、沒有大片空白、文字不超出方框或投影片、圖表正確不重複）", check: { id: "visual_qa" } },
    { id: "grounded", kind: "judge", text: abstractOnly ? "沒有全文 PDF：內容只來自論文摘要與書目資料，清楚標示「僅依摘要」，沒有捏造方法細節或數字" : mode === "paper_report" ? "內容與數字都來自論文本身，重要結果標註出處（表／§），沒有捏造" : "內容只來自研究資料（待辦、筆記、會議回饋），沒有捏造的數字或結論" },
    { id: "coverage", kind: "judge", text: `每頁都涵蓋大綱列出的重點，前後連貫，適合在組會報告${owned.length ? `（${owned.map((o) => `「${o}」`).join("、")}是學生自填頁：內容來自報告者自己的回答；報告者選擇跳過時保留提示，自動駕駛代填時標示「AI 代填，待你確認」，都可以接受，不算缺漏）` : ""}` },
  ];
}

type OutlineJson = { pages: { title: string; points?: string[]; student_owned?: boolean; item?: string }[] };
const isOutline = (v: unknown): v is OutlineJson => !!v && typeof v === "object" && Array.isArray((v as OutlineJson).pages) && (v as OutlineJson).pages.every((p) => p && typeof p.title === "string");

/** `revise`: an existing deck's pages already carry the student's content — none is student-owned. */
/** An outline point as plain text: no Markdown emphasis / inline tables, cut at a sentence or word boundary. */
export function cleanPoint(x: string, max = 240): string {
  let t = x.replace(/\*\*|__|`/g, "").replace(/\s*\|[^\n]*\|\s*/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Pages with the same (normalized) title merged into the first one, renumbered. */
export function dedupeOutline(outline: SlideOutline[]): SlideOutline[] {
  const seen = new Map<string, SlideOutline>();
  for (const p of outline) {
    const k = p.title.toLowerCase().replace(/\s+/g, "");
    const first = seen.get(k);
    if (first) first.points = [...new Set([...first.points, ...p.points])].slice(0, 6);
    else seen.set(k, { ...p, points: [...p.points] });
  }
  return [...seen.values()].map((p, i) => ({ ...p, n: i + 1 }));
}

const toOutline = (pages: OutlineJson["pages"], revise = false): SlideOutline[] =>
  pages.map((p, i) => ({ n: i + 1, title: cleanPoint(p.title, 120), points: (p.points ?? []).filter((x) => typeof x === "string").map((x) => cleanPoint(x)).filter(Boolean).slice(0, 6), ...(!revise && (p.student_owned || STUDENT_TITLE_RE.test(p.title)) ? { student_owned: true } : {}), ...(typeof p.item === "string" && p.item.trim() ? { item: p.item.trim().slice(0, 80) } : {}) }));

/** A page the student left for themselves (its note is the fixed 「由報告者補充」 label, in either language). */
const STUDENT_NOTE_RE = /（由報告者補充）|\(To be added by the presenter\.\)/;

/** Lab-Hub pages that are always the student's own (even when the planner forgot to mark them). */
const STUDENT_TITLE_RE = /^\s*(?:Trace one example|My assessment|Takeaways for my work)\s*$/i;

/** Fallback when the planner answered with a numbered list instead of JSON: 「1. Title」 lines + 「- point」 lines. */
export function outlineFromText(text: string): OutlineJson["pages"] {
  const pages: OutlineJson["pages"] = [];
  for (const line of text.split("\n")) {
    const head = /^\s*(?:#+\s*)?(?:第\s*)?(\d{1,2})\s*(?:[.、)）:：]|頁[:：]?)\s*(.+)$/.exec(line);
    if (head) pages.push({ title: head[2]!.replace(/[*_`]/g, "").trim(), points: [] });
    else if (pages.length && /^\s*[-*•]\s+/.test(line)) pages.at(-1)!.points!.push(line.replace(/^\s*[-*•]\s+/, "").trim());
  }
  return pages.filter((p) => p.title);
}

const outlineText = (o: SlideOutline[]) => o.map((p) => `${p.n}. ${p.title}${p.student_owned ? "（學生自填）" : ""}${p.item ? `（介紹：${p.item}）` : ""}\n${p.points.map((x) => `   - ${x}`).join("\n")}`).join("\n");

async function paperBrief(env: WorkflowEnv, paper: { id: string; title: string; pdf_key: string | null }, fix: { previous: StepOutput; issues: string[] } | null) {
  const user = [
    `要報告的論文：〈${paper.title}〉（paper_id ${paper.id}）。`,
    "請先呼叫 read_paper（不帶 section）取得目錄與摘要，再讀方法、實驗設定、主要結果、消融、結論等章節（長章節用 offset 分段）；目前的模型能看圖時，用 view_paper_pages 看關鍵公式、架構圖或結果表所在的頁面。",
    "讀完後輸出研究摘要（Markdown，1500–3000 字）：## 問題與動機、## 方法（核心想法、關鍵公式逐一說明符號）、## 實驗設定（資料集、指標、baseline）、## 主要結果（數字照原文，標表號）、## 消融與分析、## 限制、## 圖表清單、## 數字表。每個重點後面標註出處，例如（§3.2，p. 4）或（表 2）。",
    "「## 圖表清單」逐一列出論文中重要的圖與表（架構圖、方法圖、主要結果圖表）：`Fig. N — p. 頁碼 — type（architecture／method／result／table／example）— 位置 top-bottom（頁面高度比例，例如 0.08-0.50）— 內容一句`；論文有整體架構圖或方法示意圖時一定要列出（type architecture／method）。請用 view_paper_pages 看過那一頁再填位置。「## 數字表」把主要結果與消融的數字整理成 Markdown 表格（照原文數字，標表號），之後會用來畫圖表。",
    env.guidanceText(),
    env.run.request ? `使用者的要求：${env.run.request}` : "",
    fix ? `上一版的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}\n請補讀需要的章節後輸出完整的新版本。\n${dataBlock("previous_version", (fix.previous.text ?? "").slice(0, 12_000))}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await env.researcher({ id: `plan-research`, key: "research" }, { system: systemFor("researcher"), user, tools: ["read_paper", "view_paper_pages", "get_paper"], maxToolSteps: 80, purpose: "research_paper" });
  return { summary: `讀了論文全文（${r.toolCalls} 次工具呼叫），整理研究摘要 ${r.text.length} 字`, text: r.text };
}

async function makeOutline(env: WorkflowEnv, mode: DeckMode, pages: number, brief: string, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const user = [
    LABHUB_RULES[mode],
    `請規劃一份正好 ${pages} 頁的${mode === "paper_report" ? "論文報告" : "進度報告"}簡報大綱。使用者指定的頁數優先：與 Lab-Hub 固定頁數不同時，保留最重要的固定頁（標題逐字），其餘合併或刪減，但總數一定是 ${pages} 頁。`,
    "每頁給 2–5 個具體重點（來自資料的事實、數字要標出處）。結果與消融頁一定要寫出論文的實際數字（研究摘要沒有就從「論文原文節錄」找）；重點裡不要寫〔　〕、「資料未提供」或「待補」：資料真的沒有的重點就換成資料裡有的內容。只有規則明定由學生自己填寫的頁面（例如 My assessment、Takeaways for my work、卡住、Idea card、下週與要問）才標 student_owned: true。",
    `使用者的要求：${env.run.request}`,
    env.guidanceText(),
    itemRule(env.requirements()),
    dataBlock("research", brief.slice(0, 24_000)),
    fix ? `上一版大綱的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `只輸出 JSON：{"pages":[{"title":"頁面標題","points":["重點"],"student_owned":false${perItem(env.requirements()) ? ',"item":"這頁介紹的項目名稱（沒有就省略）"' : ""}}]}，pages 正好 ${pages} 個。`,
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 10_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  const outline = toOutline(pagesJson);
  return { summary: `${outline.length} 頁大綱`, text: outline.map((p) => `## ${p.title}\n${p.student_owned ? "- （學生自填）" : p.points.map((x) => `- ${x}`).join("\n")}\n\n::: {.notes}\n${p.student_owned ? "學生自填" : p.points.join("；")}\n:::`).join("\n\n"), data: { outline } };
}

async function plan(env: WorkflowEnv): Promise<import("./registry.js").PlanResult> {
  const access = await resolveStudy(env);
  if (!access) return { kind: "question", question: await whichStudyQuestion(env, "簡報") };
  if (!access.canEdit) return { kind: "question", question: `你不是〈${access.study.title}〉的成員，不能在這個研究建立簡報。請指定你參與的研究。` };
  const inputMode = env.run.inputs.mode as DeckMode | undefined;
  // 「每一篇文獻」 whose study was only found now (named in a guidance, or 「你決定」): split into the per-paper batch
  // that creation would have made, and end this run.
  if (!env.run.batch_id && !inputMode && !paperIdOf(env) && await batchPapers(env.db, { playbook: "slides", request: env.run.request, studyId: access.study.id })) {
    const { insertWorkflows, announceRuns } = await import("../service.js");
    const out = await transaction(env.db, (c) => insertWorkflows(c, env.user, { request: env.run.request, playbook: "slides", inputs: { study: access.study.id }, conversationId: env.run.conversation_id, autopilot: env.run.autopilot }));
    await announceRuns(env.db, out.runs);
    return { kind: "skip", message: `已拆成 ${out.runs.length} 個工作流程（〈${access.study.title}〉的每篇論文各一份簡報），請在批次卡片查看進度。` };
  }
  // An existing deck with content + an edit request (translate, rewrite, restyle…) → revise it in place.
  const revise = await reviseSource(env, access.study.id);
  if (revise) return revisePlan(env, access, revise);
  let paper = await paperOf(env);
  // An explicit 「進度報告」 wins over a study paper picked by fallback (the study's only paper is not a reason for a paper report).
  const progressAsked = /進度報告|進度簡報|週報|週會進度|progress report|weekly report/i.test(env.run.request);
  if (progressAsked && paper && !paperIdOf(env)) paper = null;
  const mode: DeckMode = inputMode ?? (!progressAsked && (paper || /論文|paper|arxiv|文獻報告/i.test(env.run.request)) ? "paper_report" : "progress");
  if (mode === "paper_report" && !paper) return { kind: "question", question: "要報告哪一篇論文？請先把論文加入文獻庫（或附加它），再在補充指示寫出論文標題。" };
  // No PDF: open access + the record's URLs first; then autopilot skips (needs_pdf), otherwise the user chooses (paper-pdf.ts).
  let abstractOnly = false;
  if (mode === "paper_report" && !paper!.pdf_key) {
    const d = await ensurePaperPdf(env, paper!);
    if (d.kind === "needs_pdf" || d.kind === "skip") return d;
    paper = d.paper;
    abstractOnly = d.kind === "abstract";
  }
  const pages = Math.min(40, Math.max(3, Number(env.run.inputs.pages) || requiredPages(env.requirements()) || (abstractOnly ? 5 : expectedPages(mode, env.run.request))));
  await env.setState({ mode, pages, abstract_only: abstractOnly });

  // Research (paper: researcher sub-agent with read_paper; progress: the study's own data).
  let brief = "";
  let research: StepSpec;
  if (abstractOnly) {
    brief = abstractBrief(paper!);
    research = { key: "research", role: "researcher", title: "整理論文摘要（沒有 PDF：僅依摘要）", instructions: "沒有全文 PDF，只用文獻紀錄的摘要與書目資料。", expected: "摘要重點", done: { output: { summary: `僅依摘要（${brief.length} 字）`, text: brief } } };
  } else if (mode === "paper_report") {
    const ft = await paperFullText(env.storage, paper!.pdf_key!).catch(() => null);
    if (ft) await env.setState({ paper_digest: digest(ft, 14_000, { focus: RESULTS_SECTION_RE }) });
    const r = await planningStep(env, {
      key: "research", role: "researcher", title: "精讀論文並整理重點",
      instructions: "用 read_paper 讀目錄與各章節（必要時看頁面圖），整理問題、方法、實驗、結果與限制，每個重點標註出處。",
      expected: "研究摘要（含 §／頁碼／表號出處）",
      verify: { checks: [{ id: "min_length", params: { chars: 800 } }, { id: "source_refs", params: { min: 4 } }], judge: false },
    }, (fix) => paperBrief(env, paper!, fix), 1);
    brief = r.output.text ?? "";
    // The deterministic excerpt of the paper always backs the brief: cheap models often stop reading before the
    // results tables, and an outline / slide without the paper's numbers ends up with 「資料未提供」.
    const excerpt = env.state<string>("paper_digest");
    const figs = await paperFigureList(env, paper!.pdf_key!);
    if (excerpt || figs) brief = `${brief.slice(0, r.ok ? 9_000 : 6_000)}${figs}${excerpt ? `\n\n# 論文原文節錄（自動擷取；研究摘要沒有的數字、表格、設定從這裡找，照原文引用）\n\n${excerpt}` : ""}`;
    research = r.spec;
  } else {
    const data = await progressContext(env.db, (env.run.inputs.deck_id as string | undefined) ?? "00000000-0000-0000-0000-000000000000", access.study.id);
    brief = data;
    research = { key: "research", role: "researcher", title: "整理研究進度資料", instructions: "讀研究摘要、階段、里程碑、待辦、最近筆記與會議回饋。", expected: "進度資料", done: { output: { summary: `研究資料 ${data.length} 字`, text: data } } };
  }
  await env.setState({ brief: brief.slice(0, 40_000) });
  // Names, training sentences and the figure list the content checks compare slides against.
  await buildContentRefs(env, { brief, pdfKey: mode === "paper_report" && !abstractOnly ? paper!.pdf_key : null, extra: [paper?.title ?? "", access.study.title] });

  const outlineStep = await planningStep(env, {
    key: "outline", role: "planner", title: `規劃 ${pages} 頁大綱`,
    instructions: `依研究摘要規劃正好 ${pages} 頁的簡報大綱（每頁標題 + 重點）。`,
    depends_on: ["research"],
    expected: `${pages} 頁大綱`,
    // Points of the planner's own pages may not be placeholders (student-owned pages are written as 「學生自填」).
    verify: { checks: [{ id: "slide_count", params: { expected: pages } }, { id: "no_placeholder", params: { on_slide: true } }], judge: false },
  }, (fix) => makeOutline(env, mode, pages, brief, fix), 2);
  const outline = await settleOutline(env, ((outlineStep.output.data as { outline?: SlideOutline[] } | undefined)?.outline ?? []));
  if (!outline.length) throw new WorkflowInputError("無法產生簡報大綱，請稍後再試。");

  const vision = await env.vision("slides");
  const owned = studentOwned(outline);
  const date = taipeiToday();
  const title = mode === "paper_report" ? `${paper!.title}` : progressTitle(access.study.title, date);
  const steps = [research, outlineStep.spec, ...laterSteps(outline, vision)];
  const notes = [abstractOnly ? "這篇沒有全文 PDF：依你的選擇只用摘要，簡報標題與講稿會標示「僅依摘要」。" : "", outline.length !== pages ? `大綱有 ${outline.length} 頁（要求 ${pages} 頁）；可在下方調整後再開始。` : ""].filter(Boolean).join("\n") || undefined;
  const write = await plannedDeckWrite(env, access.study.id, title);
  const cover = await frontTitle(env, title);
  return {
    kind: "plan",
    title: `${mode === "paper_report" ? (abstractOnly ? "論文報告（僅依摘要）" : "論文報告") : "進度報告"}簡報：${clipText(title, 60)}`,
    studyId: access.study.id,
    objective: `為〈${access.study.title}〉建立一份 ${pages} 頁的${mode === "paper_report" ? `論文報告簡報（〈${clipText(paper!.title, 80)}〉）` : "進度報告簡報"}：依確認的大綱逐頁撰寫投影片與講稿，編譯成可預覽的草稿，並通過驗收。`,
    criteria: criteriaFor(pages, mode, owned, abstractOnly),
    plan: {
      summary: `先讀${mode === "paper_report" ? "論文全文" : "研究資料"}並規劃 ${pages} 頁大綱（下方可修改），再由 ${Math.ceil(outline.length / PAGES_PER_WRITER)} 個撰寫者平行寫投影片與講稿，每段都經過檢查與驗收；整合後編譯預覽${vision ? "、看截圖檢查版面" : ""}、補齊講稿，最後逐條驗收。`,
      outline,
      writes: [write],
      ...(notes ? { notes } : {}),
      ...(cover !== title ? { front_title: cover } : {}),
    },
    steps,
  };
}

/**
 * The paper's captioned figures and tables, found and measured from the PDF layout (deterministic; cheap models often
 * skip the 圖表清單 or guess positions). Each line carries the exact `paper-fig` syntax for that figure, so a caption's
 * Fig. N and the crop cannot disagree.
 */
async function paperFigureList(env: WorkflowEnv, pdfKey: string): Promise<string> {
  const cached = env.state<string>("figure_list");
  if (typeof cached === "string" && Array.isArray(env.state("figures"))) return cached;
  const figs = await paperFigures(env, pdfKey);
  const text = figs.length
    ? `\n\n## 圖表清單（自動從 PDF 偵測，位置已量好；放論文的圖或表時只用這些，整段複製該行的語法，只改「一句說明」，Fig. N／Table N 與 paper-fig 的頁碼位置都不要改）\n${figs.map((f) => `- ${f.label} — p. ${f.page}${(f.right ?? 1) - (f.left ?? 0) < 0.6 ? "（單欄）" : ""} — 語法：${figureSyntax(f)} — ${(f.caption ?? "").slice(0, 140)}`).join("\n")}`
    : "";
  await env.setState({ figure_list: text });
  return text;
}

// ---------------------------------------------------------------- revising an existing deck

/** 「把這份簡報改成英文」、「精簡」、「重排」… — an edit of the deck itself, not a new deck. */
export const REVISE_RE = /翻譯|translate|改成|改為|轉成|換成|修改|改寫|重寫|精簡|潤飾|潤稿|調整|英文版|中文版|英文|rewrite|revise|edit|polish|shorten|condense/i;
/** 「再詳細一點」「focus 在…」「擴充成 20 頁」「每個方法要有 Pros/Cons」: a deeper / restructured version (new outline). */
export const EXPAND_RE = /詳細|細一點|不夠細|更細|太淺|擴充|擴寫|展開|加深|深入|聚焦|重點放在|主軸|重新規劃|重新組織|重組|focus|expand|elaborate|in[- ]depth|more detail|detailed|deeper|restructure|reorgani[sz]e|rework|每(?:一)?(?:個|種)[^，。\n]{0,10}(?:都)?要有/i;
/** Translation / language-only passes stay revisions even when they say "detailed" in passing. */
const TRANSLATE_RE = /翻譯|翻成|translate|英文化|中文化|corrective|只改語言|只翻/i;
const STRONG_EXPAND_RE = /詳細|細一點|不夠細|更細|擴充|擴寫|展開|深入|聚焦|重點放在|重新規劃|重組|focus|expand|elaborate|in[- ]depth|more detail|restructure|每(?:一)?(?:個|種)[^，。\n]{0,10}(?:都)?要有/i;

/**
 * `revise` (translate / polish: same pages, nothing dropped) or `expand` (deeper / restructured: a new outline grounded
 * in the deck and the study's sources). Per-item fields or a page count well above the deck's are expansions too.
 */
export function editKindOf(request: string, reqs: Requirement[], pages: number): EditKind {
  const want = requiredPages(reqs);
  if (reqs.some((r) => r.type === "per_item_fields") || (want && want > pages + 2)) return "expand";
  if (TRANSLATE_RE.test(request)) return STRONG_EXPAND_RE.test(request) ? "expand" : "revise";
  return EXPAND_RE.test(request) ? "expand" : "revise";
}

/** The page count a requirement asks for (exact, else the range's lower / upper bound). */
function requiredPages(reqs: Requirement[]): number | null {
  const p = reqs.find((r) => r.type === "page_count")?.params;
  return p ? (p.exact ?? (p.min && p.max ? Math.round((p.min + p.max) / 2) : p.min ?? p.max ?? null)) : null;
}

const perItem = (reqs: Requirement[]) => reqs.find((r) => r.type === "per_item_fields");
/** Outline rule for per-item fields: one page (or consecutive pages) per item, the item named in `item`. */
function itemRule(reqs: Requirement[]): string {
  const r = perItem(reqs);
  if (!r) return "";
  const p = r.params ?? {};
  return `使用者要求每個${p.item_kind ?? "項目"}都要有：${(p.fields ?? []).map((f) => f.name).join("、")}。每個${p.item_kind ?? "項目"}${p.items?.length ? `（${p.items.join("、")}）` : ""}獨立成一頁（內容多就連續兩頁），頁面標題包含它的名稱，JSON 的 item 欄位寫出項目名稱，重點分別寫出這些欄位（用欄位名稱開頭，例如「${(p.fields ?? []).map((f) => f.name).slice(0, 2).join("：…」「")}：…」）。`;
}

/**
 * After the outline: pages the user asked to remove are dropped (deterministic), and the per-item requirement learns
 * which items the outline presents (its check then finds each item's pages).
 */
async function settleOutline(env: WorkflowEnv, outline: SlideOutline[], original?: { title: string }[]): Promise<SlideOutline[]> {
  const reqs = env.requirements();
  let out = outline;
  const ex = reqs.find((r) => r.type === "exclude")?.params;
  if (ex) {
    const titles = [...(ex.terms ?? []).flatMap((t) => [t.name, ...(t.aliases ?? [])]), ...(ex.pages ?? []).map((n) => original?.[n - 1]?.title ?? "").filter(Boolean)];
    const kept = out.filter((p) => !titles.some((t) => titleMatches(t, p.title)));
    if (kept.length && kept.length < out.length) {
      await env.note(`依你的要求刪掉：${out.filter((p) => !kept.includes(p)).map((p) => `「${p.title}」`).join("、")}。`);
      out = kept.map((p, i) => ({ ...p, n: i + 1 }));
    }
    // A removal by page number becomes a title the check can find.
    const named = (ex.pages ?? []).map((n) => original?.[n - 1]?.title).filter((t): t is string => !!t);
    if (named.length) await setRequirement(env, "exclude", (p) => ({ ...p, terms: [...(p.terms ?? []), ...named.filter((t) => !(p.terms ?? []).some((x) => x.name === t)).map((name) => ({ name }))] }));
  }
  const items = [...new Set(out.map((p) => p.item).filter((x): x is string => !!x))];
  if (perItem(reqs) && items.length) await setRequirement(env, "per_item_fields", (p) => ({ ...p, items: [...new Set([...(p.items ?? []), ...items])].slice(0, 16) }));
  return out;
}

async function setRequirement(env: WorkflowEnv, type: Requirement["type"], patch: (p: NonNullable<Requirement["params"]>) => Requirement["params"]) {
  const reqs = env.requirements().map((r) => (r.type === type ? { ...r, params: patch(r.params ?? {}) } : r));
  await env.setState({ requirements: reqs });
}

type ReviseSource = { deck: { id: string; title: string; kind: DeckMode; paper_id: string | null }; slides: { title: string; raw: string }[] };

/**
 * The deck to revise and its slides in source form: the body the workflow that wrote it kept (chart specs, paper-fig
 * refs), else the deck's entry file. Null when this is not a revise request or the deck has no slides.
 */
async function reviseSource(env: WorkflowEnv, studyId: string): Promise<ReviseSource | null> {
  const id = env.run.inputs.deck_id as string | undefined;
  // An edit of this deck: a revise / expand request, or requirements that change it (language, page count, per-item…).
  const asked = REVISE_RE.test(env.run.request) || EXPAND_RE.test(env.run.request) || env.requirements().some((r) => r.source !== "standing" && ["language", "page_count", "per_item_fields", "exclude", "include_topics"].includes(r.type));
  if (!id || env.run.inputs.mode || !asked) return null;
  const deck = (await env.db.query<{ id: string; title: string; kind: string; paper_id: string | null; study_id: string }>("SELECT id,title,kind,paper_id,study_id FROM decks WHERE id=$1", [id])).rows[0];
  if (!deck || deck.study_id !== studyId) return null;
  const made = (await env.db.query<{ body: string | null }>(
    "SELECT state->'deck'->>'body' AS body FROM workflow_runs WHERE id<>$2 AND playbook='slides' AND artifacts @> $1::jsonb ORDER BY updated_at DESC LIMIT 1",
    [JSON.stringify([{ kind: "deck", id }]), env.run.id],
  )).rows[0]?.body;
  const tree = await loadTree(env.db, id);
  const entry = (await env.db.query<{ content: string | null }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path=$2", [id, tree?.entry ?? "index.qmd"])).rows[0]?.content ?? "";
  // An untouched template (「草稿產生中」) is not something to revise: the normal plan fills it.
  if (!made && (tree?.revision ?? 0) <= 1) return null;
  const text = made && parseSlides(made).length ? made : entry.replace(/^---\n[\s\S]*?\n---\n/, "");
  const slides = text.replace(/\r\n/g, "\n").split(/^(?=## )/m).filter((p) => p.startsWith("## ")).map((raw) => ({ title: parseSlides(raw)[0]?.title ?? "", raw: raw.trim() }));
  if (!slides.length) return null;
  return { deck: { id: deck.id, title: deck.title, kind: deck.kind === "paper_report" ? "paper_report" : "progress", paper_id: deck.paper_id }, slides };
}

/**
 * Plan for editing an existing deck. `revise` (translate / polish): the same pages rewritten from the originals, nothing
 * dropped. `expand` (「再詳細一點」「focus 在…」「每個方法要有 Pros/Cons」): a new outline grounded in the deck, the study's
 * data and notes on the requested focus (and the paper), original figures reused where they fit.
 */
async function revisePlan(env: WorkflowEnv, access: { study: { id: string; title: string } }, src: ReviseSource): Promise<import("./registry.js").PlanResult> {
  const mode = src.deck.kind;
  // The deck's paper backs figure crops and the content checks.
  if (src.deck.paper_id && !env.run.inputs.paper_id) {
    env.run.inputs.paper_id = src.deck.paper_id;
    await env.db.query("UPDATE workflow_runs SET inputs = inputs || jsonb_build_object('paper_id', $2::text) WHERE id=$1", [env.run.id, src.deck.paper_id]);
  }
  const paper = await paperOf(env);
  const kind = editKindOf(env.run.request, env.requirements(), src.slides.length);
  // The deck's built-in labels (AI-filled marks, 「這頁留給你自己寫」, 「由報告者補充」 on student pages) in the target
  // language before any writer sees them: writers keep such lines verbatim otherwise.
  const lang = targetLanguage(env.requirements());
  src = { ...src, slides: src.slides.map((p) => ({ ...p, raw: localizeLabels(p.raw, lang) })) };
  const original = src.slides.map((p, i) => `<!-- 第 ${i + 1} 頁 -->\n${p.raw}`).join("\n\n");
  // Expanding needs more than the deck: the study's data, notes about the requested focus, the paper's text.
  const extra = kind === "expand" ? await expandSources(env, access.study.id, paper?.pdf_key ?? null) : "";
  const brief = kind === "expand" ? `# 原本的簡報（素材：可以沿用其中的圖、圖表、論文圖與數字）\n\n${original.slice(0, 20_000)}\n\n${extra}` : original;
  await env.setState({ mode, revise: true, edit_kind: kind, original_slides: src.slides.map((p) => p.raw), brief: brief.slice(0, 40_000) });
  await buildContentRefs(env, { brief, pdfKey: mode === "paper_report" ? paper?.pdf_key ?? null : null, extra: [paper?.title ?? "", access.study.title] });
  const research: StepSpec = kind === "expand"
    ? { key: "research", role: "researcher", title: "讀取現有簡報與研究資料", instructions: "讀出這份簡報每一頁的原始內容，加上研究進度、和要求焦點相關的筆記與論文內容。", expected: "原始投影片 + 研究資料", done: { output: { summary: `現有簡報 ${src.slides.length} 頁 + 研究資料 ${extra.length} 字`, text: brief.slice(0, 60_000) } } }
    : { key: "research", role: "researcher", title: "讀取現有簡報", instructions: "讀出這份簡報目前每一頁的原始內容（含圖表語法與講稿）。", expected: "原始投影片", done: { output: { summary: `現有簡報 ${src.slides.length} 頁`, text: original } } };
  const want = kind === "expand" ? Math.min(30, Math.max(3, Number(env.run.inputs.pages) || requiredPages(env.requirements()) || Math.max(src.slides.length + 2, Math.round(src.slides.length * 1.5)))) : null;
  const outlineStep = await planningStep(env, {
    key: "outline", role: "planner", title: kind === "expand" ? `規劃擴充後的 ${want} 頁大綱` : "規劃修改後的每一頁",
    instructions: kind === "expand" ? `依使用者的要求重新規劃正好 ${want} 頁的大綱：深入要求的焦點，內容來自原簡報與研究資料。` : "依使用者的修改要求，列出修改後每一頁的標題與重點（頁數與順序照原本，除非使用者要求改變）。",
    depends_on: ["research"],
    expected: kind === "expand" ? `${want} 頁大綱` : `${src.slides.length} 頁大綱`,
    verify: { checks: kind === "expand" ? [{ id: "slide_count", params: { expected: want } }, { id: "no_placeholder", params: { on_slide: true } }] : [{ id: "min_length", params: { chars: 20 } }], judge: false },
  }, (fix) => (kind === "expand" ? expandOutline(env, src, brief, want!, fix) : reviseOutline(env, src, fix)), 2);
  const outline = await settleOutline(env, ((outlineStep.output.data as { outline?: SlideOutline[] } | undefined)?.outline ?? []), src.slides);
  if (!outline.length) throw new WorkflowInputError("無法規劃修改後的簡報，請稍後再試。");
  const vision = await env.vision("slides");
  // Pages whose original speaker notes were already short (e.g. the student's own pages) are not required to grow notes.
  const shortNotes = kind === "revise" ? outline.filter((o, i) => (parseSlides(src.slides[i]?.raw ?? "")[0]?.notes ?? "").replace(/\s+/g, "").length < 30 || STUDENT_NOTE_RE.test(src.slides[i]?.raw ?? "")).map((o) => o.title) : [];
  // …nor (writers included) are pages that were left for the student to write (their placeholder stays, in the target language).
  const leftOpen = kind === "revise" ? outline.filter((o, i) => PLACEHOLDER_RE.test(src.slides[i]?.raw ?? "") || /Left for you to write/.test(src.slides[i]?.raw ?? "")).map((o) => o.title) : [];
  const allow = (c: CheckSpec, extra: string[]) => (extra.length ? { ...c, params: { ...(c.params ?? {}), allow_titles: [...new Set([...((c.params?.allow_titles as string[] | undefined) ?? []), ...extra])] } } : c);
  const steps = [research, outlineStep.spec, ...laterSteps(outline, vision)].map((st) =>
    st.verify ? { ...st, verify: { ...st.verify, checks: st.verify.checks.map((c) => (c.id === "speaker_notes" ? allow(c, shortNotes) : c.id === "no_placeholder" ? allow(c, leftOpen) : c)) } } : st);
  const write = await plannedDeckWrite(env, access.study.id, src.deck.title);
  const cover = await frontTitle(env, src.deck.title);
  const removed = env.requirements().some((r) => r.type === "exclude");
  return {
    kind: "plan",
    title: `${kind === "expand" ? "擴充簡報" : "修改簡報"}：${clipText(src.deck.title, 60)}`,
    studyId: access.study.id,
    objective: kind === "expand"
      ? `依使用者的要求把簡報〈${clipText(src.deck.title, 80)}〉擴充成更深入的 ${outline.length} 頁版本：${clipText(env.run.request, 200)}。可以重新組織頁面，內容來自原簡報、研究資料與筆記，編譯成可預覽的草稿。`
      : `依使用者的要求修改簡報〈${clipText(src.deck.title, 80)}〉：${clipText(env.run.request, 200)}。保留原本的頁面結構、圖、圖表、公式與出處，只改要求的部分，編譯成可預覽的草稿。`,
    criteria: [
      ...criteriaFor(outline.length, mode, [], false).map((c) => (c.id === "notes" && shortNotes.length ? { ...c, text: `${c.text}（原本講稿就很短的頁面除外：${shortNotes.map((t) => `「${t}」`).join("、")}）`, check: { id: "speaker_notes", params: { min_chars: 30, allow_titles: shortNotes } } } : c.id === "clean" && leftOpen.length ? { ...c, text: `${c.text}（留給報告者自己寫的頁面除外：${leftOpen.map((t) => `「${t}」`).join("、")}）`, check: { id: "no_placeholder", params: { allow_titles: leftOpen, on_slide: true } } } : c)),
      kind === "expand"
        ? { id: "expanded", kind: "judge" as const, text: `依要求擴充（${clipText(env.run.request, 120)}）：要求的焦點講得夠深入（每頁有具體的機制、例子或數字），內容都來自原簡報、研究資料或論文，沒有捏造` }
        : { id: "revised", kind: "judge" as const, text: `每一頁都照使用者的要求修改（${clipText(env.run.request, 120)}），沒有遺漏頁面或講稿${removed ? "（使用者要求刪掉的頁面除外）" : ""}，也沒有改掉原本的數字、圖與出處` },
    ],
    plan: {
      summary: kind === "expand"
        ? `讀取現有 ${src.slides.length} 頁與研究資料，重新規劃 ${outline.length} 頁大綱（下方可修改），由 ${Math.ceil(outline.length / PAGES_PER_WRITER)} 個撰寫者平行撰寫，整合後逐條檢查你的要求、編譯預覽${vision ? "、看截圖檢查版面" : ""}並驗收。`
        : `讀取現有 ${src.slides.length} 頁，依要求規劃每一頁（下方可修改），由 ${Math.ceil(outline.length / PAGES_PER_WRITER)} 個撰寫者平行改寫投影片與講稿，整合後逐條檢查你的要求、編譯預覽${vision ? "、看截圖檢查版面" : ""}並驗收。`,
      outline,
      writes: [write],
      edit_kind: kind,
      ...(cover !== src.deck.title ? { front_title: cover, notes: `封面標題會改成${lang ? LANGUAGE_LABEL[lang] : ""}：「${cover}」（原標題保留在簡報資訊中）。` } : {}),
    },
    steps,
  };
}

/** Study data for an expansion: progress, notes about the requested focus (topics / request words) and the paper's text. */
async function expandSources(env: WorkflowEnv, studyId: string, pdfKey: string | null): Promise<string> {
  const progress = await progressContext(env.db, (env.run.inputs.deck_id as string | undefined) ?? "00000000-0000-0000-0000-000000000000", studyId).catch(() => "");
  const topics = env.requirements().flatMap((r) => (r.params?.topics ?? []).flatMap((t) => [t.name, ...(t.aliases ?? [])]));
  const words = [...topics, ...(env.run.request.match(/[A-Za-z][A-Za-z0-9+-]{3,}|[\p{Script=Han}]{2,6}/gu) ?? [])].filter((w) => !/^(?:this|that|with|from|deck|slides?|english|detail(?:ed)?|focus|每個|簡報|詳細|一點)$/i.test(w)).slice(0, 12);
  const notes = words.length
    ? (await env.db.query<{ title: string; content_md: string }>(
        `SELECT title, content_md FROM notes WHERE study_id=$1 AND (${words.map((_, i) => `title ILIKE $${i + 2} OR content_md ILIKE $${i + 2}`).join(" OR ")}) ORDER BY updated_at DESC LIMIT 3`,
        [studyId, ...words.map((w) => `%${w.replace(/[%_]/g, "")}%`)],
      ).catch(() => ({ rows: [] as { title: string; content_md: string }[] }))).rows
    : [];
  const paper = pdfKey ? await paperFullText(env.storage, pdfKey).then((ft) => (ft ? digest(ft, 10_000, { focus: RESULTS_SECTION_RE }) : "")).catch(() => "") : "";
  return [
    progress ? `# 研究資料\n\n${progress.slice(0, 12_000)}` : "",
    ...notes.map((n) => `# 筆記〈${n.title}〉\n\n${n.content_md.slice(0, 8_000)}`),
    paper ? `# 論文原文節錄\n\n${paper}` : "",
  ].filter(Boolean).join("\n\n");
}

async function expandOutline(env: WorkflowEnv, src: ReviseSource, brief: string, pages: number, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const user = [
    LABHUB_RULES[src.deck.kind],
    `使用者要把現有的 ${src.slides.length} 頁簡報擴充成更深入的版本：${env.run.request}`,
    env.guidanceText(),
    `規劃正好 ${pages} 頁的新大綱：可以重新組織、拆頁或加頁，深入使用者要求的焦點；每頁 2–5 個具體重點（機制、例子、數字，數字要標出處），內容只能來自原簡報與研究資料，不要編造。原本的圖、圖表、論文圖適合的就沿用（重點中寫「沿用原第 k 頁的圖」）。`,
    itemRule(env.requirements()),
    dataBlock("sources", brief.slice(0, 36_000)),
    fix ? `上一版大綱的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `只輸出 JSON：{"pages":[{"title":"頁面標題","points":["重點"]${perItem(env.requirements()) ? ',"item":"這頁介紹的項目名稱（沒有就省略）"' : ""}}]}，pages 正好 ${pages} 個。`,
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 12_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  // A page title appears once (production: the expanded outline repeated 「Table 1 現況」「對帳」… → 22 pages for 12).
  const outline = dedupeOutline(toOutline(pagesJson, true));
  return { summary: `${outline.length} 頁大綱`, text: outline.map((p) => `## ${p.title}\n${p.points.map((x) => `- ${x}`).join("\n")}`).join("\n\n"), data: { outline } };
}

async function reviseOutline(env: WorkflowEnv, src: ReviseSource, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const user = [
    `使用者對這份簡報的修改要求：${env.run.request}`,
    env.guidanceText(),
    `現有簡報有 ${src.slides.length} 頁。列出修改後每一頁的標題與 2–5 個重點：頁數與順序照原本（除非要求改變），內容照要求修改（例如翻譯就把標題與重點都翻成要求的語言），不要新增原本沒有的事實或數字。`,
    dataBlock("original_slides", src.slides.map((p, i) => `<!-- 第 ${i + 1} 頁 -->\n${p.raw}`).join("\n\n").slice(0, 40_000)),
    fix ? `上一版的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    '只輸出 JSON：{"pages":[{"title":"頁面標題","points":["重點"],"student_owned":false}]}',
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 10_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  const outline = toOutline(pagesJson, true);
  return { summary: `${outline.length} 頁`, text: outline.map((p) => `## ${p.title}\n${p.points.map((x) => `- ${x}`).join("\n")}`).join("\n\n"), data: { outline } };
}

// ---------------------------------------------------------------- deck writes

/**
 * The plan card's write + its effect for autopilot (autopilot.ts), mirroring `ensureDeck`: the run's own draft deck or
 * an untouched template → `draft_own`; an existing deck with edits that would be written into → `overwrite` (asks);
 * otherwise a new deck → `new`.
 */
async function plannedDeckWrite(env: WorkflowEnv, studyId: string, title: string): Promise<PlannedWrite> {
  const own = env.state<DeckState>("deck");
  if (own?.deck_id) return { kind: "deck", label: `這個工作流程的簡報草稿〈${clipText(own.deck_title ?? title, 60)}〉（新的修訂，不會發布版本）`, effect: "draft_own" };
  const want = env.run.inputs.deck_id as string | undefined;
  if (want) {
    const deck = (await env.db.query<{ id: string; title: string; study_id: string }>("SELECT id,title,study_id FROM decks WHERE id=$1", [want])).rows[0];
    const tree = deck ? await loadTree(env.db, deck.id) : null;
    if (deck && deck.study_id === studyId && (!tree || tree.origin === "ai" || tree.revision <= 1)) {
      const untouched = !tree || tree.revision <= 1;
      return { kind: "deck", label: untouched ? `簡報〈${clipText(deck.title, 60)}〉（還沒有內容的範本，寫入草稿，不會發布版本）` : `覆寫簡報〈${clipText(deck.title, 60)}〉的原始檔（新的修訂，不會發布版本）`, effect: untouched ? "draft_own" : "overwrite" };
    }
    return { kind: "deck", label: `新簡報「${clipText(title, 60)}（Agent 草稿）」（不會動到原本的簡報，不會發布版本）`, effect: "new" };
  }
  return { kind: "deck", label: `新簡報「${clipText(title, 60)}」（草稿，不會發布版本）`, effect: "new" };
}

async function ensureDeck(env: WorkflowEnv): Promise<DeckState & { deck_id: string }> {
  const st = (env.state<DeckState>("deck") ?? {}) as DeckState;
  if (st.deck_id) return st as DeckState & { deck_id: string };
  if (!env.run.study_id) throw new WorkflowInputError("工作流程沒有研究。");
  const access = await requireEditor(env, env.run.study_id);
  const mode = modeOf(env);
  const paper = await paperOf(env);
  const date = taipeiToday();
  const want = env.run.inputs.deck_id as string | undefined;
  if (want) {
    const deck = (await env.db.query<{ id: string; slug: string; title: string; study_id: string }>("SELECT id,slug,title,study_id FROM decks WHERE id=$1", [want])).rows[0];
    const tree = deck ? await loadTree(env.db, deck.id) : null;
    // Only an untouched template or an AI draft is written into; anything the user edited gets a new deck.
    if (deck && deck.study_id === access.study.id && (!tree || tree.origin === "ai" || tree.revision <= 1)) {
      const s: DeckState = { deck_id: deck.id, deck_slug: deck.slug, deck_title: deck.title };
      await env.setState({ deck: s });
      return s as DeckState & { deck_id: string };
    }
  }
  // A revision of a deck the user edited keeps that deck's name (in the target language), not a fresh template title.
  const edited = want && env.state<boolean>("revise") ? (await env.db.query<{ title: string }>("SELECT title FROM decks WHERE id=$1", [want])).rows[0]?.title : undefined;
  const baseTitle = await frontTitle(env, edited ?? (mode === "paper_report" ? (paper?.title ?? "論文報告") : progressTitle(access.study.title, date)));
  const title = clipText(want ? `${baseTitle}${targetLanguage(env.requirements()) === "en" ? " (Agent draft)" : "（Agent 草稿）"}` : baseTitle, 160);
  const deckId = randomUUID();
  const slug = await freeSlug(env.db, title, date);
  await transaction(env.db, async (client) => {
    await client.query(
      `INSERT INTO decks(id,study_id,kind,paper_id,metadata,title,slug,public_view,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,'{}',$5,$6,false,$7,$8,$8)`,
      [deckId, access.study.id, mode, mode === "paper_report" ? (paper?.id ?? null) : null, title, slug, newShareKey(), env.user.id],
    );
    await createTree(client, deckId, env.user.id, "ai", [{ path: "index.qmd", content: draftQmd({ title, author: env.user.name, date }, "## 草稿產生中\n\n工作流程正在撰寫這份簡報。\n") }]);
    await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [access.study.id]);
  });
  const file = (await env.db.query<{ version: number }>("SELECT version FROM deck_sources WHERE deck_id=$1 AND path='index.qmd'", [deckId])).rows[0];
  const s: DeckState = { deck_id: deckId, deck_slug: slug, deck_title: title, file_version: file?.version };
  await env.setState({ deck: s });
  await addArtifact(env.db, env.run.id, { kind: "deck", id: deckId, url: `/studies/${access.study.slug}/decks/${deckId}/edit`, title, role: "draft" });
  return s as DeckState & { deck_id: string };
}

/** Writes the body into the deck's entry (optimistic lock against user edits), renders a preview and waits. */
export async function writeAndRender(env: WorkflowEnv, body: string, opts: { shots?: boolean } = {}): Promise<DeckState> {
  const deck = await ensureDeck(env);
  if (env.run.study_id) await requireEditor(env, env.run.study_id);
  const mode = modeOf(env);
  const paper = await paperOf(env);
  // The cover in the artifact's language (an English deck never keeps a Chinese title from the deck's name).
  const title = await frontTitle(env, deck.deck_title ?? "簡報");
  if (env.state<string>("front_title") !== title) await env.setState({ front_title: title });
  // The run keeps the source form (```chart specs, paper-fig refs); the deck gets rendered SVG / cropped figures.
  const visuals = await materializeVisuals(env, deck, body, { paperPdfKey: mode === "paper_report" ? paper?.pdf_key ?? null : null, vision: await env.vision("slides") });
  if (visuals.problems.length) await env.note(`圖表處理：${visuals.problems.slice(0, 4).join("；")}`, "warn");
  const subtitle = deckSubtitle(env, mode === "paper_report" && !!paper, !!env.state<boolean>("abstract_only"));
  const qmd = draftQmd({ title, author: env.user.name, date: taipeiToday(), theme: true, ...(subtitle ? { subtitle } : {}) }, visuals.body);
  let revision: number;
  let version: number | undefined;
  try {
    revision = await transaction(env.db, async (client) => {
      await client.query("SELECT 1 FROM decks WHERE id=$1 FOR UPDATE", [deck.deck_id]);
      const tree = await loadTree(client, deck.deck_id, true);
      const entry = tree?.entry ?? "index.qmd";
      const cur = (await client.query<{ version: number; content: string | null }>("SELECT version, content FROM deck_sources WHERE deck_id=$1 AND path=$2", [deck.deck_id, entry])).rows[0];
      // The file is still exactly what this run wrote last (e.g. the job was interrupted before it recorded the new
      // version): that is our own draft, not a user edit.
      const ours = !!cur && !!deck.last_written && cur.content === deck.last_written;
      const saved = await saveText(client, deck.deck_id, entry, qmd, env.user.id, ours ? cur!.version : (deck.file_version ?? cur?.version));
      version = (await client.query<{ version: number }>("SELECT version FROM deck_sources WHERE id=$1", [saved.file.id])).rows[0]?.version;
      await client.query("UPDATE deck_source_trees SET origin='ai' WHERE deck_id=$1", [deck.deck_id]);
      return saved.revision;
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) throw new WorkflowStop("conflict", "簡報在執行期間被修改了；為了不覆蓋你的內容，工作流程已停止寫入。");
    throw e;
  }
  // Record the write before waiting for the render, so an interrupted job does not mistake it for a user edit.
  await env.setState({ deck: { ...deck, body, revision, file_version: version, last_written: qmd } });
  const preview = await enqueuePreview(env.db, env.storage, deck.deck_id, env.user.id, { shots: !!opts.shots });
  await env.note(`已寫入簡報草稿（修訂 ${revision}），編譯預覽中。`);
  const err = await env.waitJob(preview.preview.job_id, env.deps.previewWaitMs ?? 240_000);
  const row = (await env.db.query<{ entry_html: string | null; status: string }>("SELECT entry_html,status FROM deck_previews WHERE id=$1", [preview.preview.id])).rows[0];
  const next: DeckState = { ...deck, body, revision, file_version: version, last_written: qmd, render_error: typeof err === "string" ? err : null, render_timed_out: err === undefined, preview_id: preview.preview.id };
  await env.setState({ deck: next });
  const studySlug = (await env.db.query<{ slug: string }>("SELECT slug FROM studies WHERE id=$1", [env.run.study_id])).rows[0]?.slug ?? "";
  const secret = (env.deps.app as unknown as { config?: { AUTH_SECRET?: string } }).config?.AUTH_SECRET;
  const previewUrl = row?.entry_html && secret && deck.deck_slug ? previewViewUrl(deck.deck_slug, previewToken(secret, deck.deck_id, preview.preview.id), preview.preview.id, row.entry_html) : undefined;
  await addArtifact(env.db, env.run.id, { kind: "deck", id: deck.deck_id, url: `/studies/${studySlug}/decks/${deck.deck_id}/edit`, title, role: "draft", revision, ...(previewUrl ? { preview_url: previewUrl } : {}) });
  return next;
}

/** The deck's cover as the requirement checks see it (front matter title / subtitle in the run's language). */
async function frontOf(env: WorkflowEnv): Promise<string> {
  const st = env.state<DeckState>("deck");
  const base = st?.deck_title ?? (modeOf(env) === "paper_report" ? (await paperOf(env))?.title ?? "簡報" : "簡報");
  const title = env.state<string>("front_title") ?? (await frontTitle(env, base));
  return frontMatterText(title, deckSubtitle(env, modeOf(env) === "paper_report", !!env.state<boolean>("abstract_only")));
}

const renderData = (s: DeckState) => ({
  renderError: s.render_error ?? null, renderTimedOut: !!s.render_timed_out, revision: s.revision, previewId: s.preview_id,
  ...(s.qa ? { visualQa: { failed: s.qa.failed, scored: s.qa.scores.length, vision: s.qa.vision, round: s.qa.round, ...(s.qa.unseen ? { unseen: true } : {}) } } : {}),
});

// ---------------------------------------------------------------- step execution

async function writeSection(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const outline = outlineOf(env);
  const nums = (step.inputs.pages as number[] | undefined) ?? [];
  const pages = outline.filter((p) => nums.includes(p.n));
  const mode = modeOf(env);
  const brief = env.state<string>("brief") ?? "";
  const format = [
    `只輸出第 ${nums[0]}${nums.length > 1 ? `–${nums.at(-1)}` : ""} 頁（共 ${pages.length} 頁），依序每頁：`,
    "`## 頁面標題`（標題照大綱逐字）→ 投影片內容（依視覺規則挑一個版型：圖／圖表／論文圖／表格 + 最多 4 個精簡條列）→ `::: {.notes}` 講稿（3–6 句，細節與數字都放這裡）`:::`。",
    "不要 YAML front matter、不要 ``` 包住整段、不要寫其他頁、不要任何說明文字。",
    pages.some((p) => p.student_owned) ? `學生自填頁（${pages.filter((p) => p.student_owned).map((p) => `「${p.title}」`).join("、")}）只放標題與「${runLabels(env).skipped}」，講稿寫「${runLabels(env).skippedNote}」。` : "",
  ].filter(Boolean).join("\n");
  const original = env.state<string[]>("original_slides");
  const expand = env.state<EditKind>("edit_kind") === "expand";
  const user = taskPrompt(env, step, {
    context: original && expand
      ? {
          // Expanding: the new outline is the plan; the original deck and the study's sources are the material.
          request: `使用者的要求：${env.run.request}\n依新的大綱寫出這幾頁，深入要求的焦點；原本的簡報是素材（適合的圖、圖表規格、paper-fig 語法、數字與出處照原文沿用），其他內容只能來自研究資料，不要編造。`,
          format_rules: `${LABHUB_RULES[mode]}\n\n${VISUAL_RULES}`,
          full_outline: outlineText(outline),
          your_pages: outlineText(pages),
          research: brief.slice(0, 30_000),
        }
      : original
      ? {
          // Revising an existing deck: rewrite these pages from their originals, changing only what the user asked.
          request: `使用者的修改要求：${env.run.request}\n只照這個要求修改；保留原本的版型、圖、圖表（\`\`\`chart / diagram 規格）、論文圖（paper-fig 語法）、公式、表格、數字與出處，講稿一起修改。`,
          your_pages: outlineText(pages),
          original_pages: nums.map((n) => `<!-- 第 ${n} 頁 -->\n${original[n - 1] ?? ""}`).join("\n\n"),
          format_rules: VISUAL_RULES,
        }
      : {
          format_rules: `${LABHUB_RULES[mode]}\n\n${VISUAL_RULES}`,
          full_outline: outlineText(outline),
          your_pages: outlineText(pages),
          research: brief.slice(0, 24_000),
        },
    format,
  }, fix);
  const res = await env.call({ purpose: "write_slides", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: WRITER_TOKENS }, step.id);
  const refs = contentRefsOf(env, pages);
  // Deterministic content fixes first (figure refs → the measured list, unfounded markers, peer chains → grid).
  let draft = normalizeDiagrams(localizeLabels(cleanBody(res.text) ?? res.text, targetLanguage(env.requirements())));
  // Revising: a page the student left for themselves stays theirs (only its prompt changes language), never AI-written.
  if (original && env.state<EditKind>("edit_kind") !== "expand") {
    const L = runLabels(env);
    const open = pages.map((p, i) => ({ p, i })).filter(({ p }) => /Left for you to write/.test(localizeLabels(original[p.n - 1] ?? "", "en")));
    if (open.length && parseSlides(draft).length === pages.length) {
      const { pre, chunks } = splitChunks(draft);
      for (const { p, i } of open) chunks[i] = `## ${p.title}\n\n${L.skipped}\n\n::: {.notes}\n${L.skippedNote}\n:::\n\n`;
      draft = `${pre}${chunks.join("")}`;
    }
  }
  const { body, fixed } = fixContent(draft, refs);
  const n = parseSlides(body).length;
  await env.activity(step.key, "writer", `寫好 ${n} 頁${res.stopReason === "max_tokens" ? "（輸出被截斷）" : ""}${fixed ? `，自動修正 ${fixed} 處圖號或圖的語意` : ""}`);
  return { summary: `寫了 ${n} 頁（${body.length} 字）${res.stopReason === "max_tokens" ? "，輸出達到上限被截斷" : ""}`, text: body, data: { stop: res.stopReason, refs } };
}

async function assembledBody(env: WorkflowEnv): Promise<string> {
  const all = await getSteps(env.db, env.run.id);
  const writes = all.filter((s) => s.key.startsWith("write_") && s.output?.text).sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6)));
  const body = closeOpenBlocks(`${writes.map((w) => (cleanBody(w.output!.text!) ?? w.output!.text!).trim()).join("\n\n")}\n`);
  // Student-owned pages carry the student's own answers (student-input.ts).
  return fixContent(applyStudentPages(body, await studentPagesOf(env), runLabels(env)), contentRefsOf(env, outlineOf(env))).body;
}

async function assemble(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  let body = await assembledBody(env);
  const prevState = env.state<DeckState>("deck");
  // A fix round of the assembly = a render error: ask once for a syntax fix of the whole body (pages unchanged).
  if (fix && prevState?.render_error && prevState.body) {
    await env.activity(step.key, "integrator", "依編譯錯誤修正語法");
    const res = await env.call({ purpose: "render_fix", role: "integrator", aiRole: "slides", messages: fixMessages(modeOf(env), prevState.body, prevState.render_error), maxTokens: 14_000 }, step.id);
    const repaired = cleanBody(res.text);
    if (repaired && parseSlides(repaired).length === parseSlides(prevState.body).length) body = await guardRequirements(env, prevState.body, repaired, "依編譯錯誤修正語法", await frontOf(env), step.id);
  }
  const st = await writeAndRender(env, body);
  const pages = parseSlides(body).length;
  return { summary: `合併 ${pages} 頁並寫入草稿（修訂 ${st.revision}）；${st.render_error ? "編譯失敗" : st.render_timed_out ? "編譯逾時" : "預覽編譯成功"}`, text: body, data: renderData(st) };
}

const QA_ROUNDS = 3;

type ShotsRow = { output_prefix: string; result: { shots?: { count?: number } } | null };

/** Screenshots + layout metrics of the newest ready shot preview of the run's deck. */
async function shotPages(env: WorkflowEnv, previewId: string): Promise<{ pages: ShotPage[]; images: import("../../lib/vision/review.js").ReviewImage[] } | null> {
  const row = (await env.db.query<ShotsRow>("SELECT p.output_prefix, j.result FROM deck_previews p JOIN jobs j ON j.id=p.job_id WHERE p.id=$1 AND p.status='ready'", [previewId])).rows[0];
  const count = row?.result?.shots?.count ?? 0;
  if (!row || !count) return null;
  const manifest = await env.storage.getBuffer(`${row.output_prefix}_hub/shots.json`).then((b) => (b ? (JSON.parse(b.toString("utf8")) as { pages?: ShotPage[] }) : null)).catch(() => null);
  const pages = (manifest?.pages ?? []).map((p) => ({ index: p.index, title: p.title, metrics: p.metrics }));
  const vision = await env.vision("slides");
  const images = vision ? (await previewImages(env.storage, row.output_prefix, count)).images : [];
  return { pages, images };
}

/**
 * Mandatory final visual QA: render with screenshots → per-page rubric (vision verifier in batches when the bound
 * model can see; the worker's layout metrics always) → failing pages rewritten by a writer with the concrete fix
 * instructions → re-render; ≤ QA_ROUNDS rounds. A rewrite that breaks the render is rolled back.
 */
async function visualQa(env: WorkflowEnv, step: StepRow): Promise<StepOutput> {
  let st = env.state<DeckState>("deck");
  if (!st?.deck_id || !st.body) return { summary: "簡報還沒有寫入，無法做視覺檢查。", text: st?.body ?? "", data: st ? renderData(st) : { renderError: "簡報還沒有寫入。" } };
  const vision = await env.vision("slides");
  const outline = outlineOf(env);
  const owned = studentOwned(outline);
  const deckTitle = env.state<string>("front_title") ?? st.deck_title ?? "";
  const allowed = (title: string) => !title || titleMatches(deckTitle, title) || owned.some((o) => titleMatches(o, title));
  let scores: PageScore[] = [];
  // A section cut off mid-block (e.g. an unclosed notes div) hides every later slide: repair before measuring.
  let body = closeOpenBlocks(st.body);
  let round = 0;
  let lastGood: string | null = null;
  let unseen = false;
  const log: string[] = [];
  for (; round < QA_ROUNDS; round++) {
    await env.checkpoint();
    await env.activity(step.key, "designer", `第 ${round + 1} 輪：編譯並擷取每一頁截圖`);
    st = await writeAndRender(env, body, { shots: true });
    if (st.render_error || !st.preview_id) {
      log.push(`第 ${round + 1} 輪編譯失敗`);
      break;
    }
    lastGood = body;
    let shots = await shotPages(env, st.preview_id);
    if (!shots?.pages.length) {
      // A failed capture (busy / broken Chrome) is retried once; passing pages unseen would hide every visual defect.
      await env.note(`第 ${round + 1} 輪沒有拿到截圖，重新擷取一次。`, "warn");
      st = await writeAndRender(env, body, { shots: true });
      if (!st.render_error && st.preview_id) shots = await shotPages(env, st.preview_id);
    }
    unseen = !shots?.pages.length;
    if (!shots?.pages.length) {
      // No screenshots (capture failed): fall back to the source heuristics only.
      const issues = bodyIssues(body, allowed);
      scores = parseSlides(body).map((s, i) => { const hit = issues.find((x) => x.title === s.title); return { page: i + 2, title: s.title, scores: {}, score: hit ? 2 : 4, pass: !hit, issues: hit?.issues ?? [], fix: hit ? fixFor(hit.issues) || "精簡文字、改用視覺元素。" : "", source: "metrics" as const }; });
    } else {
      await env.activity(step.key, "verifier", vision ? `審查者看 ${shots.images.length} 張截圖逐頁評分` : `依版面量測檢查 ${shots.pages.length} 頁（模型不能看圖）`);
      const v = vision && shots.images.length ? await visionScores(env, shots.images, shots.pages, { allowed, stepId: step.id }).catch(() => []) : [];
      // The verifier failing silently must not look like a pass: say the round was judged by the metrics only.
      if (vision && shots.images.length && !v.length) await env.note(`第 ${round + 1} 輪審查者沒有回覆評分，這一輪只用版面量測判斷。`, "warn");
      scores = combineScores(shots.pages, v, allowed, sourceIssues(body, { paper: modeOf(env) === "paper_report", refs: contentRefsOf(env, outline) }));
    }
    // Visual share: text-only content pages beyond the allowed share fail too.
    const share = visualShare(body, allowed);
    if (share.total && share.with / share.total < 0.6) {
      const textOnly = parseSlides(body).filter((s) => !allowed(s.title) && !/^```\{?\.?(mermaid|chart|diagram)|!\[|^\s*\|/m.test(s.body));
      for (const s of textOnly.slice(0, Math.ceil(share.total * 0.6) - share.with)) {
        const sc = scores.find((x) => titleMatches(s.title, x.title));
        if (sc) {
          sc.pass = false;
          sc.issues = [...sc.issues, "這頁只有文字：請改用流程圖、圖表、論文圖或表格呈現（版型 A/D/E）"];
          sc.fix = [fixFor(["只有文字"]), sc.fix].filter(Boolean).join(" ");
        }
      }
    }
    const failing = scores.filter((s) => !s.pass && !allowed(s.title));
    const hardOwned = scores.filter((s) => !s.pass && allowed(s.title) && s.title && !titleMatches(deckTitle, s.title));
    st = { ...st, qa: { round: round + 1, scores, vision, failed: [...failing, ...hardOwned].map((s) => s.page), ...(unseen ? { unseen: true } : {}) } };
    await env.setState({ deck: st });
    log.push(`第 ${round + 1} 輪：${scores.length - failing.length}/${scores.length} 頁通過`);
    if (!failing.length || round === QA_ROUNDS - 1) break;

    // Targeted fix of the failing pages.
    await env.activity(step.key, "writer", `修正 ${failing.length} 頁：${failing.map((f) => `第 ${f.page} 頁`).join("、")}`);
    const slides = parseSlides(body);
    const targets = failing.map((f) => ({ f, s: slides.find((s) => titleMatches(s.title, f.title)) })).filter((x) => x.s);
    if (!targets.length) break;
    const user = [
      LABHUB_RULES[modeOf(env)],
      VISUAL_RULES,
      "下面這些投影片沒有通過逐頁截圖檢查。依每頁的問題與修改指示重寫這幾頁（標題逐字不變、講稿保留或改善、數字只能用研究資料裡的）。流程圖／架構圖一律用 ```diagram（不要 Mermaid）；論文圖被裁切或包含正文時，調整 paper-fig 的 @上緣-下緣，或改用 ```chart／表格呈現同樣的數字；同一組數字只留圖表或表格其中一種；頁面太空就把視覺元素放大到整頁寬。只輸出這幾頁（每頁以「## 標題」開頭，含 ::: {.notes}），不要其他文字。",
      ...targets.map(({ f, s }) => `### 第 ${f.page} 頁「${s!.title}」\n問題：${f.issues.join("；") || "（未通過）"}\n修改指示：${f.fix || "精簡文字、改用視覺元素"}\n${dataBlock("slide", `## ${s!.title}\n${s!.body}\n\n::: {.notes}\n${s!.notes}\n:::`)}`),
      dataBlock("research", (env.state<string>("brief") ?? "").slice(0, 14_000)),
    ].join("\n\n");
    const res = await env.call({ purpose: "visual_fix", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: WRITER_TOKENS }, step.id);
    const fixed = cleanBody(res.text);
    if (!fixed) break;
    const rewritten = fixContent(replaceSlides(body, normalizeDiagrams(fixed)), contentRefsOf(env, outline)).body;
    if (rewritten === body || parseSlides(rewritten).length !== slides.length) break;
    // The layout fix must not break a requirement that held (e.g. bring Chinese back into an English deck).
    const next = await guardRequirements(env, body, rewritten, "版面修正", await frontOf(env), step.id);
    if (next === body) break;
    body = next;
  }
  // Keep the last version that rendered.
  if (st.render_error && lastGood && lastGood !== body) st = { ...(await writeAndRender(env, lastGood)), qa: st.qa };
  const failed = st.qa?.failed ?? [];
  const table = scoreTable(scores);
  await env.setState({ qa_table: table });
  return {
    summary: `${vision ? "逐頁截圖評分" : "版面量測（模型不能看圖）"}：${log.join("；")}${failed.length ? `；仍有 ${failed.length} 頁未通過` : "；全部通過"}`,
    text: st.body ?? body,
    data: renderData(st),
  };
}

const REQ_ROUNDS = 3;

/**
 * Step `constraints`: the deterministic requirement checks on the whole deck (cover + every page); failing pages are
 * rewritten (only those, `fixPages`), the cover title is put in the target language, re-checked, ≤ REQ_ROUNDS rounds.
 */
async function constraintsStep(env: WorkflowEnv, step: StepRow): Promise<StepOutput> {
  let st = env.state<DeckState>("deck");
  if (!st?.deck_id || !st.body) return { summary: "簡報還沒有寫入，無法檢查你的要求。", text: st?.body ?? "", data: { ...(st ? renderData(st) : { renderError: "簡報還沒有寫入。" }), requirements: { failed: ["簡報還沒有寫入"] } } };
  if (!checkedCriteria(env.run.criteria).length) return { summary: "沒有需要自動檢查的要求。", text: st.body, data: { ...renderData(st), requirements: { failed: [] } } };
  let body = st.body;
  const log: string[] = [];
  let left: string[] = [];
  for (let round = 0; round < REQ_ROUNDS; round++) {
    await env.checkpoint();
    const front = await frontOf(env);
    const f = failingPages(env, body, front);
    left = f.issues;
    if (!f.issues.length) break;
    log.push(`第 ${round + 1} 輪：${f.issues.length} 條要求未達成${f.pages.length ? `（${f.pages.map((p) => `第 ${p} 頁`).join("、")}）` : ""}`);
    if (f.cover) await env.setState({ front_titles: {}, front_title: null });
    if (!f.pages.length) {
      if (!f.cover) break;
      continue;
    }
    await env.activity(step.key, "writer", `依你的要求修正 ${f.pages.length} 頁：${f.pages.map((p) => `第 ${p} 頁`).join("、")}`);
    const fixed = await fixPages(env, body, f.pages, f.issues, step.id).catch(() => null);
    if (!fixed || fixed === body) break;
    body = fixContent(fixed, contentRefsOf(env, outlineOf(env))).body;
  }
  if (body !== st.body || env.state<string>("front_title") === null) {
    const written = await writeAndRender(env, body);
    // A rewrite that breaks the render keeps the previous body.
    st = written.render_error && st.body ? await writeAndRender(env, st.body) : written;
    if (st.body !== body) body = st.body ?? body;
    left = failingPages(env, body, await frontOf(env)).issues;
  }
  return { summary: `${left.length ? `還有 ${left.length} 條要求未達成` : "每一條可以自動檢查的要求都符合"}${log.length ? `（${log.join("；")}）` : ""}`, text: body, data: { ...renderData(st), requirements: { failed: left } } };
}

type NotesJson = { notes: { title: string; notes: string }[] };
const isNotes = (v: unknown): v is NotesJson => !!v && typeof v === "object" && Array.isArray((v as NotesJson).notes);

/** Inserts / replaces the notes block of the slides whose title matches. */
export function injectNotes(body: string, notes: { title: string; notes: string }[]): string {
  const parts = body.split(/^(?=## )/m);
  return parts
    .map((p) => {
      if (!p.startsWith("## ")) return p;
      const title = p.slice(3, p.indexOf("\n") < 0 ? undefined : p.indexOf("\n")).replace(/\{[^}]*\}\s*$/, "").trim();
      const hit = notes.find((n) => titleMatches(n.title, title));
      if (!hit || !hit.notes.trim()) return p;
      const without = p.replace(/^:::+\s*\{?\.?notes\}?\s*\n[\s\S]*?^:::+\s*$\n?/gm, "").trimEnd();
      return `${without}\n\n::: {.notes}\n${hit.notes.trim()}\n:::\n\n`;
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}

async function notesPass(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const st = env.state<DeckState>("deck");
  const body = st?.body ?? (await assembledBody(env));
  const owned = studentOwned(outlineOf(env));
  const missing = parseSlides(body).filter((s) => s.notes.replace(/\s+/g, "").length < 30 && !owned.some((o) => titleMatches(o, s.title)));
  if (!missing.length && !fix) return { summary: "每頁都有講稿，不需要補。", text: body, data: st ? renderData(st) : { renderError: null } };
  await env.activity(step.key, "writer", `補 ${missing.length} 頁講稿`);
  const user = taskPrompt(env, step, {
    context: { slides: missing.map((s) => `## ${s.title}\n${s.body}`).join("\n\n").slice(0, 20_000), research: (env.state<string>("brief") ?? "").slice(0, 12_000) },
    format: `為這 ${missing.length} 頁各寫 2–5 句講稿（報告者要說的話，${LANGUAGE_LABEL[targetLanguage(env.requirements()) ?? "zh"]}）。只輸出 JSON：{"notes":[{"title":"頁面標題（照原文）","notes":"講稿"}]}`,
  }, fix);
  const { value } = await env.callJson<NotesJson>({ purpose: "speaker_notes", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer") }, { role: "user", content: user }], maxTokens: 5000 }, isNotes, step.id);
  if (!value?.notes.length) return { summary: "講稿沒有產生成功。", text: body, data: st ? renderData(st) : { renderError: null } };
  const next = await guardRequirements(env, body, injectNotes(body, value.notes), "補齊講稿", await frontOf(env), step.id);
  const written = await writeAndRender(env, next);
  return { summary: `補上 ${value.notes.length} 頁講稿並重新編譯。`, text: next, data: renderData(written) };
}

async function execute(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  if (step.key.startsWith("write_")) return writeSection(env, step, fix);
  if (step.key === "assemble") return assemble(env, step, fix);
  if (step.key === STUDENT_INPUT_KEY) {
    const outline = outlineOf(env);
    const drafted = (await getSteps(env.db, env.run.id)).filter((s) => s.key.startsWith("write_") && s.output?.text).map((s) => s.output!.text!).join("\n\n");
    return runStudentInput(env, step, { owned: outline.filter((p) => p.student_owned), drafted, brief: env.state<string>("brief") ?? "" });
  }
  if (step.key === "visual_qa" || step.key === "design") return visualQa(env, step);
  if (step.key === "constraints") return constraintsStep(env, step);
  if (step.key === "notes") return notesPass(env, step, fix);
  if (step.key === "outline") {
    const pages = env.state<number>("pages") ?? outlineOf(env).length;
    return makeOutline(env, modeOf(env), pages, env.state<string>("brief") ?? "", fix);
  }
  if (step.key === "research") return step.output ?? { summary: "（已完成）", text: env.state<string>("brief") ?? "" };
  throw new WorkflowInputError(`未知的步驟：${step.key}`);
}

async function finalText(env: WorkflowEnv) {
  const st = env.state<DeckState>("deck");
  const body = st?.body ?? (await assembledBody(env));
  const refs = contentRefsOf(env, outlineOf(env));
  // Requirement checks see the whole deck incl. the cover (`full`).
  const full = `${await frontOf(env)}${body}`;
  return { text: body, data: st ? { ...renderData(st), refs, full } : { renderError: "簡報還沒有寫入。", refs, full } };
}

/** Maps failing criteria back to the steps that can fix them. */
async function repair(env: WorkflowEnv, failing: Criterion[]) {
  const outline = outlineOf(env);
  const st = env.state<DeckState>("deck");
  const body = st?.body ?? "";
  const slides = parseSlides(body);
  const writes = writerSteps(outline);
  const writeOf = (n: number) => writes.find((w) => ((w.inputs?.pages as number[]) ?? []).includes(n))?.key;
  const out = new Map<string, string[]>();
  const add = (key: string | undefined, issue: string) => {
    if (!key) return;
    out.set(key, [...(out.get(key) ?? []), issue]);
  };
  for (const c of failing) {
    if (c.id === "pages" || c.id === "complete") {
      for (const p of outline) if (!slides.some((s) => titleMatches(p.title, s.title))) add(writeOf(p.n), `缺少第 ${p.n} 頁「${p.title}」，請完整寫出。`);
      if (!out.size && slides.length > outline.length) add("assemble", `頁數比大綱多（${slides.length} > ${outline.length}）。`);
      if (c.id === "complete") for (const w of writes) add(w.key, c.reason ?? "內容被截斷，請輸出完整版本。");
    } else if (c.id === "render") add("assemble", c.reason ?? "編譯失敗");
    else if (c.id === "visual_qa" || c.id === "visuals" || c.id === "diagrams") add("visual_qa", c.reason ?? "視覺檢查未通過");
    // Content faults are per page and deterministic: the visual QA rewrites exactly those pages (sourceIssues).
    else if (c.id === "names" || c.id === "figrefs" || c.id === "semantics" || c.id === "charts") add("visual_qa", c.reason ?? c.text);
    else if (c.id === "notes") add("notes", c.reason ?? "講稿不完整");
    // The user's requirements: the checked ones are fixed page by page in `constraints`; judged ones go to the writers below.
    else if (c.id.startsWith("req_") && c.kind === "check") add("constraints", c.reason ?? c.text);
    else if (c.id === "clean") {
      for (const s of slides) {
        const p = outline.find((o) => titleMatches(o.title, s.title));
        if (p && !p.student_owned && /〔|待補|TODO|TBD/i.test(`${s.body}${s.notes}`)) add(writeOf(p.n), `第 ${p.n} 頁「${p.title}」還有佔位文字，請填入依據資料的內容。`);
      }
    } else {
      // Judged criteria: the pages named in the reason, else every writer (bounded: small decks only).
      const named = [...(c.reason ?? "").matchAll(/第\s*(\d+)\s*頁/g)].map((m) => Number(m[1]));
      const keys = named.length ? [...new Set(named.map(writeOf))] : writes.length <= 5 ? writes.map((w) => w.key) : [];
      for (const k of keys) add(k, `${c.text}：${c.reason ?? "未達成"}`);
    }
  }
  return [...out.entries()].map(([key, issues]) => ({ key, issues }));
}

async function applyEdits(env: WorkflowEnv, edits: import("./registry.js").ApprovalEdits, current: OutlineItem[] | undefined) {
  if (!edits.outline?.length) return {};
  const prev = (current ?? []) as SlideOutline[];
  const outline: SlideOutline[] = edits.outline.slice(0, 40).map((p, i) => {
    const old = prev.find((o) => o.title === p.title);
    const owned = old?.student_owned || (!env.state<boolean>("revise") && STUDENT_TITLE_RE.test(p.title));
    return { n: i + 1, title: p.title.trim().slice(0, 120) || `第 ${i + 1} 頁`, points: (p.points ?? []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6), ...(owned ? { student_owned: true } : {}) };
  });
  await env.setState({ pages: outline.length });
  const vision = await env.vision("slides");
  return { outline, steps: laterSteps(outline, vision) };
}

async function commit(env: WorkflowEnv, outcome: "done" | "partial") {
  const st = env.state<DeckState>("deck");
  if (!st?.deck_id) return outcome === "partial" ? "簡報沒有寫入（流程在整合前就停止了）。" : null;
  // The deck's name follows its cover when the language changed (the original name stays in metadata.original_title).
  const cover = env.state<string>("front_title");
  if (cover && st.deck_title && cover !== st.deck_title && targetLanguage(env.requirements())) {
    await env.db.query(
      "UPDATE decks SET title=$2, metadata = metadata || jsonb_build_object('original_title', coalesce(metadata->>'original_title', title)), updated_at=now() WHERE id=$1 AND title <> $2",
      [st.deck_id, cover.slice(0, 160)],
    );
    await env.setState({ deck: { ...st, deck_title: cover.slice(0, 160) }, front_titles: { ...(env.state<Record<string, string>>("front_titles") ?? {}), [cover.slice(0, 160)]: cover } });
  }
  const table = env.state<string>("qa_table");
  return `簡報草稿已寫入〈${st.deck_title}〉（原始檔修訂 ${st.revision ?? "?"}），還沒有發布成版本；確認內容後可以按「發布為新版本」。${table ? `\n\n逐頁視覺檢查：\n\n${table}` : ""}`;
}

export const slidesPlaybook: WorkflowPlaybook = {
  id: "slides",
  title: "從 0 到 1 建立簡報",
  titleEn: "Build a deck from scratch",
  description: "讀論文全文或研究資料 → 確認大綱 → 平行撰寫投影片與講稿 → 編譯、檢查版面與驗收",
  descriptionEn: "Read the paper or study data → agree on the outline → write slides and notes in parallel → render, layout check, verify",
  autoApprovable: true,
  detect: (req, inputs) => (inputs.deck_id ? 0.9 : /簡報|投影片|slides?\b|deck|presentation|組會報告|論文報告|進度報告/i.test(req) ? 0.8 : 0),
  plan,
  applyEdits,
  execute,
  finalText,
  repair,
  handlesRequirements: true,
  commit,
};

registerWorkflowPlaybook(slidesPlaybook);

export const _test = { cleanPoint, dedupeOutline, toOutline, outlineText, criteriaFor, laterSteps, injectNotes, writerSteps };
