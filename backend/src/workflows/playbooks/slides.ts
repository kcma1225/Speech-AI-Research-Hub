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
import { bodyIssues, combineScores, fixFor, materializeVisuals, replaceSlides, scoreTable, sourceIssues, visionScores, visualShare, VISUAL_RULES, type PageScore, type ShotPage } from "./slides-visual.js";
import { parseSlides, titleMatches } from "../checks.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import { WorkflowStop, type CheckSpec, type Criterion, type OutlineItem, type PlannedWrite, type StepOutput, type StepRow, type StepSpec } from "../types.js";
import { abstractBrief, ensurePaperPdf } from "../paper-pdf.js";
import { clipText, paperOf, planningStep, resolveStudy, systemFor, taskPrompt } from "./common.js";
import { registerWorkflowPlaybook, type WorkflowPlaybook } from "./registry.js";
import { applyStudentPages, runStudentInput, STUDENT_INPUT_KEY, studentInputStep, studentPagesOf } from "../student-input.js";

type SlideOutline = OutlineItem & { student_owned?: boolean };
type DeckState = { qa?: { round: number; scores: PageScore[]; vision: boolean; failed: number[] }; last_written?: string; deck_id?: string; deck_slug?: string; deck_title?: string; body?: string; revision?: number; file_version?: number; render_error?: string | null; render_timed_out?: boolean; preview_id?: string | null };

export const PAGES_PER_WRITER = 3;
const WRITER_TOKENS = 9000;

const modeOf = (env: WorkflowEnv): DeckMode => (env.state<DeckMode>("mode") ?? "progress");
const outlineOf = (env: WorkflowEnv): SlideOutline[] => (env.run.plan?.outline as SlideOutline[] | undefined) ?? [];
const studentOwned = (o: SlideOutline[]) => o.filter((p) => p.student_owned).map((p) => p.title);

function writerChecks(pages: SlideOutline[], owned: string[]): { checks: CheckSpec[]; judge: boolean } {
  return {
    checks: [
      { id: "slide_count", params: { expected: pages.length } },
      { id: "slide_titles", params: { titles: pages.map((p) => p.title) } },
      { id: "speaker_notes", params: { min_chars: 30, allow_titles: owned } },
      { id: "no_placeholder", params: { allow_titles: owned } },
      { id: "not_truncated" },
      { id: "slide_length", params: { max_chars: 1100, max_bullets: 9 } },
      { id: "slide_density", params: { max_words: 75, max_bullets: 6, allow_titles: owned } },
      { id: "diagram_syntax" },
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
      key: "visual_qa",
      role: "designer",
      title: vision ? "逐頁截圖視覺檢查（看圖評分並修正）" : "逐頁版面檢查（量測，模型不能看圖）",
      instructions: vision
        ? "編譯並擷取每一頁截圖，交給能看圖的審查者逐頁評分（易讀、擁擠、版面、視覺、圖是否正確畫出、超出、一致、專業感；平均 ≥ 4 分且沒有嚴重問題才通過），並用版面量測檢查文字超出方框或投影片、字小於 16px、大片空白、圖表與表格重複；未通過的頁面交回撰寫者依指示修正後重新編譯，最多 3 輪，仍未通過的頁面會在報告中列出。"
        : "目前的模型不能看圖：改用版面量測（超出方框或投影片、字級 ≥ 16px、大片空白、字數、條列、圖是否編譯成功、圖表與表格重複）逐頁檢查，未通過的頁面交回撰寫者修正後重新編譯，最多 3 輪，仍未通過的頁面會在報告中列出。",
      depends_on: ["notes"],
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
    { id: "clean", kind: "check", text: `沒有佔位文字（〔　〕、待補、TODO）${owned.length ? "，學生自填頁除外" : ""}`, check: { id: "no_placeholder", params: { allow_titles: owned } } },
    { id: "complete", kind: "check", text: "內容完整，沒有被截斷的頁面或未關閉的區塊", check: { id: "not_truncated" } },
    { id: "visuals", kind: "check", text: "以視覺為主：至少六成內容頁有流程圖、圖表、論文圖或表格，圖都正確編譯（沒有原始碼外露）", check: { id: "visual_ratio", params: { min_ratio: 0.6, allow_titles: owned } } },
    { id: "diagrams", kind: "check", text: "流程圖（diagram）與圖表語法正確，圖放得進投影片", check: { id: "diagram_syntax" } },
    { id: "visual_qa", kind: "check", text: "每一頁都通過截圖視覺檢查（字 ≥ 16px、不擁擠、沒有大片空白、文字不超出方框或投影片、圖表正確不重複）", check: { id: "visual_qa" } },
    { id: "grounded", kind: "judge", text: abstractOnly ? "沒有全文 PDF：內容只來自論文摘要與書目資料，清楚標示「僅依摘要」，沒有捏造方法細節或數字" : mode === "paper_report" ? "內容與數字都來自論文本身，重要結果標註出處（表／§），沒有捏造" : "內容只來自研究資料（待辦、筆記、會議回饋），沒有捏造的數字或結論" },
    { id: "coverage", kind: "judge", text: `每頁都涵蓋大綱列出的重點，前後連貫，適合在組會報告${owned.length ? `（${owned.map((o) => `「${o}」`).join("、")}是學生自填頁：內容來自報告者自己的回答；報告者選擇跳過時保留提示，自動駕駛代填時標示「AI 代填，待你確認」，都可以接受，不算缺漏）` : ""}` },
  ];
}

type OutlineJson = { pages: { title: string; points?: string[]; student_owned?: boolean }[] };
const isOutline = (v: unknown): v is OutlineJson => !!v && typeof v === "object" && Array.isArray((v as OutlineJson).pages) && (v as OutlineJson).pages.every((p) => p && typeof p.title === "string");

const toOutline = (pages: OutlineJson["pages"]): SlideOutline[] =>
  pages.map((p, i) => ({ n: i + 1, title: p.title.trim().slice(0, 120), points: (p.points ?? []).filter((x) => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 6), ...(p.student_owned || STUDENT_TITLE_RE.test(p.title) ? { student_owned: true } : {}) }));

/** Lab-Hub pages that are always the student's own (even when the planner forgot to mark them). */
const STUDENT_TITLE_RE = /^\s*(?:My assessment|Takeaways for my work)\s*$/i;

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

const outlineText = (o: SlideOutline[]) => o.map((p) => `${p.n}. ${p.title}${p.student_owned ? "（學生自填）" : ""}\n${p.points.map((x) => `   - ${x}`).join("\n")}`).join("\n");

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
  const r = await env.researcher({ id: `plan-research`, key: "research" }, { system: systemFor("researcher"), user, tools: ["read_paper", "view_paper_pages", "get_paper"], maxToolSteps: 8, purpose: "research_paper" });
  return { summary: `讀了論文全文（${r.toolCalls} 次工具呼叫），整理研究摘要 ${r.text.length} 字`, text: r.text };
}

async function makeOutline(env: WorkflowEnv, mode: DeckMode, pages: number, brief: string, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const user = [
    LABHUB_RULES[mode],
    `請規劃一份正好 ${pages} 頁的${mode === "paper_report" ? "論文報告" : "進度報告"}簡報大綱。使用者指定的頁數優先：與 Lab-Hub 固定頁數不同時，保留最重要的固定頁（標題逐字），其餘合併或刪減，但總數一定是 ${pages} 頁。`,
    "每頁給 2–5 個具體重點（來自資料的事實、數字要標出處）。只有規則明定由學生自己填寫的頁面（例如 My assessment、Takeaways for my work、卡住、Idea card、下週與要問）才標 student_owned: true。",
    `使用者的要求：${env.run.request}`,
    env.guidanceText(),
    dataBlock("research", brief.slice(0, 24_000)),
    fix ? `上一版大綱的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `只輸出 JSON：{"pages":[{"title":"頁面標題","points":["重點"],"student_owned":false}]}，pages 正好 ${pages} 個。`,
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 10_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  const outline = toOutline(pagesJson);
  return { summary: `${outline.length} 頁大綱`, text: outline.map((p) => `## ${p.title}\n${p.points.map((x) => `- ${x}`).join("\n")}\n\n::: {.notes}\n${p.student_owned ? "學生自填" : p.points.join("；")}\n:::`).join("\n\n"), data: { outline } };
}

async function plan(env: WorkflowEnv): Promise<import("./registry.js").PlanResult> {
  const access = await resolveStudy(env);
  if (!access) return { kind: "question", question: "要把簡報放在哪個研究？請在補充指示寫研究名稱，或從研究頁面再按一次「交給 Agent」。" };
  if (!access.canEdit) return { kind: "question", question: `你不是〈${access.study.title}〉的成員，不能在這個研究建立簡報。請指定你參與的研究。` };
  const inputMode = env.run.inputs.mode as DeckMode | undefined;
  let paper = await paperOf(env);
  const mode: DeckMode = inputMode ?? (paper || /論文|paper|arxiv|文獻報告/i.test(env.run.request) ? "paper_report" : "progress");
  if (mode === "paper_report" && !paper) return { kind: "question", question: "要報告哪一篇論文？請先把論文加入文獻庫（或附加它），再在補充指示寫出論文標題。" };
  // No PDF: open access + the record's URLs first; then autopilot skips (needs_pdf), otherwise the user chooses (paper-pdf.ts).
  let abstractOnly = false;
  if (mode === "paper_report" && !paper!.pdf_key) {
    const d = await ensurePaperPdf(env, paper!);
    if (d.kind === "needs_pdf" || d.kind === "skip") return d;
    paper = d.paper;
    abstractOnly = d.kind === "abstract";
  }
  const pages = Math.min(40, Math.max(3, Number(env.run.inputs.pages) || (abstractOnly ? 5 : expectedPages(mode, env.run.request))));
  await env.setState({ mode, pages, abstract_only: abstractOnly });

  // Research (paper: researcher sub-agent with read_paper; progress: the study's own data).
  let brief = "";
  let research: StepSpec;
  if (abstractOnly) {
    brief = abstractBrief(paper!);
    research = { key: "research", role: "researcher", title: "整理論文摘要（沒有 PDF：僅依摘要）", instructions: "沒有全文 PDF，只用文獻紀錄的摘要與書目資料。", expected: "摘要重點", done: { output: { summary: `僅依摘要（${brief.length} 字）`, text: brief } } };
  } else if (mode === "paper_report") {
    const ft = await paperFullText(env.storage, paper!.pdf_key!).catch(() => null);
    if (ft) await env.setState({ paper_digest: digest(ft, 14_000) });
    const r = await planningStep(env, {
      key: "research", role: "researcher", title: "精讀論文並整理重點",
      instructions: "用 read_paper 讀目錄與各章節（必要時看頁面圖），整理問題、方法、實驗、結果與限制，每個重點標註出處。",
      expected: "研究摘要（含 §／頁碼／表號出處）",
      verify: { checks: [{ id: "min_length", params: { chars: 800 } }, { id: "source_refs", params: { min: 4 } }], judge: false },
    }, (fix) => paperBrief(env, paper!, fix), 1);
    brief = r.output.text ?? "";
    // The deterministic digest backs a weak brief (cheap models sometimes stop reading early).
    if (!r.ok && env.state<string>("paper_digest")) brief = `${brief}\n\n${env.state<string>("paper_digest")}`;
    research = r.spec;
  } else {
    const data = await progressContext(env.db, (env.run.inputs.deck_id as string | undefined) ?? "00000000-0000-0000-0000-000000000000", access.study.id);
    brief = data;
    research = { key: "research", role: "researcher", title: "整理研究進度資料", instructions: "讀研究摘要、階段、里程碑、待辦、最近筆記與會議回饋。", expected: "進度資料", done: { output: { summary: `研究資料 ${data.length} 字`, text: data } } };
  }
  await env.setState({ brief: brief.slice(0, 40_000) });

  const outlineStep = await planningStep(env, {
    key: "outline", role: "planner", title: `規劃 ${pages} 頁大綱`,
    instructions: `依研究摘要規劃正好 ${pages} 頁的簡報大綱（每頁標題 + 重點）。`,
    depends_on: ["research"],
    expected: `${pages} 頁大綱`,
    verify: { checks: [{ id: "slide_count", params: { expected: pages } }], judge: false },
  }, (fix) => makeOutline(env, mode, pages, brief, fix), 2);
  const outline = ((outlineStep.output.data as { outline?: SlideOutline[] } | undefined)?.outline ?? []);
  if (!outline.length) throw new WorkflowInputError("無法產生簡報大綱，請稍後再試。");

  const vision = await env.vision("slides");
  const owned = studentOwned(outline);
  const date = taipeiToday();
  const title = mode === "paper_report" ? `${paper!.title}` : progressTitle(access.study.title, date);
  const steps = [research, outlineStep.spec, ...laterSteps(outline, vision)];
  const notes = [abstractOnly ? "這篇沒有全文 PDF：依你的選擇只用摘要，簡報標題與講稿會標示「僅依摘要」。" : "", outline.length !== pages ? `大綱有 ${outline.length} 頁（要求 ${pages} 頁）；可在下方調整後再開始。` : ""].filter(Boolean).join("\n") || undefined;
  const write = await plannedDeckWrite(env, access.study.id, title);
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
    },
    steps,
  };
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
  const baseTitle = mode === "paper_report" ? (paper?.title ?? "論文報告") : progressTitle(access.study.title, date);
  const title = clipText(want ? `${baseTitle}（Agent 草稿）` : baseTitle, 160);
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
  const title = deck.deck_title ?? "簡報";
  // The run keeps the source form (```chart specs, paper-fig refs); the deck gets rendered SVG / cropped figures.
  const visuals = await materializeVisuals(env, deck, body, { paperPdfKey: mode === "paper_report" ? paper?.pdf_key ?? null : null, vision: await env.vision("slides") });
  if (visuals.problems.length) await env.note(`圖表處理：${visuals.problems.slice(0, 4).join("；")}`, "warn");
  const qmd = draftQmd({ title, author: env.user.name, date: taipeiToday(), theme: true, ...(mode === "paper_report" && paper ? { subtitle: env.state<boolean>("abstract_only") ? "Paper report（僅依摘要，沒有全文 PDF）" : "Paper report" } : {}) }, visuals.body);
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

const renderData = (s: DeckState) => ({
  renderError: s.render_error ?? null, renderTimedOut: !!s.render_timed_out, revision: s.revision, previewId: s.preview_id,
  ...(s.qa ? { visualQa: { failed: s.qa.failed, scored: s.qa.scores.length, vision: s.qa.vision, round: s.qa.round } } : {}),
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
    pages.some((p) => p.student_owned) ? `學生自填頁（${pages.filter((p) => p.student_owned).map((p) => `「${p.title}」`).join("、")}）只放標題與〔　〕，講稿寫「（由報告者補充）」。` : "",
  ].filter(Boolean).join("\n");
  const user = taskPrompt(env, step, {
    context: {
      format_rules: `${LABHUB_RULES[mode]}\n\n${VISUAL_RULES}`,
      full_outline: outlineText(outline),
      your_pages: outlineText(pages),
      research: brief.slice(0, 20_000),
    },
    format,
  }, fix);
  const res = await env.call({ purpose: "write_slides", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: WRITER_TOKENS }, step.id);
  const body = normalizeDiagrams(cleanBody(res.text) ?? res.text);
  const n = parseSlides(body).length;
  await env.activity(step.key, "writer", `寫好 ${n} 頁${res.stopReason === "max_tokens" ? "（輸出被截斷）" : ""}`);
  return { summary: `寫了 ${n} 頁（${body.length} 字）${res.stopReason === "max_tokens" ? "，輸出達到上限被截斷" : ""}`, text: body, data: { stop: res.stopReason } };
}

async function assembledBody(env: WorkflowEnv): Promise<string> {
  const all = await getSteps(env.db, env.run.id);
  const writes = all.filter((s) => s.key.startsWith("write_") && s.output?.text).sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6)));
  const body = `${writes.map((w) => (cleanBody(w.output!.text!) ?? w.output!.text!).trim()).join("\n\n")}\n`;
  // Student-owned pages carry the student's own answers (student-input.ts).
  return applyStudentPages(body, await studentPagesOf(env));
}

async function assemble(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  let body = await assembledBody(env);
  const prevState = env.state<DeckState>("deck");
  // A fix round of the assembly = a render error: ask once for a syntax fix of the whole body (pages unchanged).
  if (fix && prevState?.render_error && prevState.body) {
    await env.activity(step.key, "integrator", "依編譯錯誤修正語法");
    const res = await env.call({ purpose: "render_fix", role: "integrator", aiRole: "slides", messages: fixMessages(modeOf(env), prevState.body, prevState.render_error), maxTokens: 14_000 }, step.id);
    const repaired = cleanBody(res.text);
    if (repaired && parseSlides(repaired).length === parseSlides(prevState.body).length) body = repaired;
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
  const deckTitle = st.deck_title ?? "";
  const allowed = (title: string) => !title || titleMatches(deckTitle, title) || owned.some((o) => titleMatches(o, title));
  let scores: PageScore[] = [];
  let body = st.body;
  let round = 0;
  let lastGood: string | null = null;
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
    const shots = await shotPages(env, st.preview_id);
    if (!shots?.pages.length) {
      // No screenshots (capture failed): fall back to the source heuristics only.
      const issues = bodyIssues(body, allowed);
      scores = parseSlides(body).map((s, i) => { const hit = issues.find((x) => x.title === s.title); return { page: i + 2, title: s.title, scores: {}, score: hit ? 2 : 4, pass: !hit, issues: hit?.issues ?? [], fix: hit ? fixFor(hit.issues) || "精簡文字、改用視覺元素。" : "", source: "metrics" as const }; });
    } else {
      await env.activity(step.key, "verifier", vision ? `審查者看 ${shots.images.length} 張截圖逐頁評分` : `依版面量測檢查 ${shots.pages.length} 頁（模型不能看圖）`);
      const v = vision && shots.images.length ? await visionScores(env, shots.images, shots.pages, { allowed, stepId: step.id }).catch(() => []) : [];
      scores = combineScores(shots.pages, v, allowed, sourceIssues(body));
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
    st = { ...st, qa: { round: round + 1, scores, vision, failed: [...failing, ...hardOwned].map((s) => s.page) } };
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
    const next = replaceSlides(body, normalizeDiagrams(fixed));
    if (next === body || parseSlides(next).length !== slides.length) break;
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
    format: `為這 ${missing.length} 頁各寫 2–5 句講稿（報告者要說的話，繁體中文）。只輸出 JSON：{"notes":[{"title":"頁面標題（照原文）","notes":"講稿"}]}`,
  }, fix);
  const { value } = await env.callJson<NotesJson>({ purpose: "speaker_notes", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer") }, { role: "user", content: user }], maxTokens: 5000 }, isNotes, step.id);
  if (!value?.notes.length) return { summary: "講稿沒有產生成功。", text: body, data: st ? renderData(st) : { renderError: null } };
  const next = injectNotes(body, value.notes);
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
  return { text: body, data: st ? renderData(st) : { renderError: "簡報還沒有寫入。" } };
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
    else if (c.id === "notes") add("notes", c.reason ?? "講稿不完整");
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
    return { n: i + 1, title: p.title.trim().slice(0, 120) || `第 ${i + 1} 頁`, points: (p.points ?? []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6), ...(old?.student_owned ? { student_owned: true } : {}) };
  });
  await env.setState({ pages: outline.length });
  const vision = await env.vision("slides");
  return { outline, steps: laterSteps(outline, vision) };
}

async function commit(env: WorkflowEnv, outcome: "done" | "partial") {
  const st = env.state<DeckState>("deck");
  if (!st?.deck_id) return outcome === "partial" ? "簡報沒有寫入（流程在整合前就停止了）。" : null;
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
  commit,
};

registerWorkflowPlaybook(slidesPlaybook);

export const _test = { toOutline, outlineText, criteriaFor, laterSteps, injectNotes, writerSteps };
