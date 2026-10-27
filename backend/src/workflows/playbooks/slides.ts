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
import { bodyIssues, closeOpenBlocks, combineScores, fixContent, fixFor, inventedNumbers, materializeVisuals, pagesToScore, pruneGeneratedFiles, replaceSlides, scoreTable, sourceIssues, visionScores, visualShare, VISUAL_RULES, type PageScore, type ShotPage } from "./slides-visual.js";
import { assignTitles, duplicatePages, findByTitle, keptIssues, matchOriginals, parseSlides, PLACEHOLDER_RE, scrubPlaceholders, titleMatches, unbalanced, type OriginalPage } from "../checks.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps, insertSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import { WorkflowStop, type CheckSpec, type Criterion, type OutlineItem, type PlannedWrite, type StepOutput, type StepRow, type StepSpec } from "../types.js";
import { abstractBrief, ensurePaperPdf } from "../paper-pdf.js";
import { clipText, matchPaperTitle, paperIdOf, paperOf, planningStep, requireStudy, systemFor, taskPrompt } from "./common.js";
import { clarifyOnce, requestLine, userGuidance } from "../brief.js";
import { currentRoute, splitBatch, deckModeOf, PROGRESS_RE, PAPER_REPORT_RE, addedPages, editKindOf, requiredPages } from "../route.js";
import { registerWorkflowPlaybook, type WorkflowPlaybook } from "./registry.js";
import { ABSTRACT_ONLY, bibLine, decompose, extractPart, libraryPapers, paperSteps, pickLine, pickTitle, readPaper, searchOnline, select, stackOf, type Pick as TopicPick, type ReadPaper, type TopicState } from "./research.js";
import { generateUnit, neighbourBlock } from "../units.js";
import { loadMaterial, materialForPages, materialsOf, materialText, materialTitleOf, type LoadedMaterial } from "../material.js";
import { applyStudentPages, runStudentInput, STUDENT_INPUT_KEY, studentInputStep, studentPagesOf } from "../student-input.js";
import { checkedCriteria, LIBRARY_SURVEY_RE, localizeLabels, notesLanguage, runLabels, segmentClauses, targetLanguage, LANGUAGE_LABEL } from "../requirements.js";
import { deckSubtitle, failingPages, fixPages, frontMatterText, frontTitle, guardRequirements, keepSlideBodies, splitChunks } from "./slides-requirements.js";
import { contentPage, keepPages, keptPage, pageScope } from "./slides-scope.js";
import type { EditKind, Requirement } from "../types.js";

/**
 * A page of the outline (a unit): `item` = the method / model it presents (per-item fields: the check finds its pages by
 * it); `layout` = the layout pattern the planner chose (A–F, T; `LAYOUTS`); `purpose` = what the page is for; `kind` and
 * `sources` (topic decks) = the page's role in the survey and the papers (`P<n>` = pick n) its content rests on.
 */
/** `from`: an edit (revise / expand) — the original page this page rewrites or expands (1-based). */
export type SlideOutline = OutlineItem & { student_owned?: boolean; item?: string; layout?: string; purpose?: string; kind?: PageKind; sources?: string[]; from?: number };
export type PageKind = "title" | "motivation" | "taxonomy" | "method" | "comparison" | "synthesis" | "other";
const PAGE_KINDS: PageKind[] = ["title", "motivation", "taxonomy", "method", "comparison", "synthesis", "other"];

/** The finite layout library the planner picks from (the writer fills it; nobody emits positions — VISUAL_RULES has the patterns). */
export const LAYOUTS: Record<string, string> = {
  A: "標題 + 一個大視覺（```diagram 流程圖／架構圖）+ 一句結論",
  B: "左右對照（兩欄或 comparison diagram）",
  C: "大數字結果（一個關鍵數字 + 說明）",
  D: "結果圖表（```chart）+ 一句結論",
  E: "論文圖 + 3 個重點（只有論文報告能用）",
  F: "主張／引述 + 一到兩個支持點",
  T: "小表格（≤ 5×5）+ 一句結論",
};
const layoutList = (paper: boolean) => Object.entries(LAYOUTS).filter(([k]) => paper || k !== "E").map(([k, v]) => `${k}＝${v}`).join("；");
type DeckState = { qa?: { round: number; scores: PageScore[]; vision: boolean; /** hard defects */ failed: number[]; /** soft problems left (report notes) */ soft?: number[]; unseen?: boolean }; last_written?: string; deck_id?: string; deck_slug?: string; deck_title?: string; body?: string; revision?: number; file_version?: number; render_error?: string | null; render_timed_out?: boolean; preview_id?: string | null };

/** One writer per page (each page a unit: own call, own checks and fix rounds; a cut page never touches the others). */
export const PAGES_PER_WRITER = 1;
/** Per-page budget: bullets on the slide, words of slide text (CJK char = ½ word, as `slide_density`). */
const PAGE_BUDGET = { bullets: 4, words: 60 };
/** Section titles of experiments / results / ablations (their text gets most of the excerpt budget). */
const RESULTS_SECTION_RE = /experiment|result|evaluation|ablation|analysis|discussion|comparison|實驗|結果|分析/i;
// Reasoning models spend part of the budget thinking; 9000 truncated ~40 % of 3-page drafts on staging (one page now).
const WRITER_TOKENS = 16_000;
// 9000 left 3 of 18 page writes empty after reasoning (a `:budget` re-ask each) on staging.
const PAGE_TOKENS = 12_000;
/** The source material every writer (and its judge, the same blocks) gets: the brief is built to fit, nothing is cut after it. */
export const SOURCE_CHARS = 30_000;

const modeOf = (env: WorkflowEnv): DeckMode => (env.state<DeckMode>("mode") ?? "progress");
/** A topic deck (stored as a progress-kind deck): free structure over the study's library and notes, not Lab-Hub's fixed pages. */
const isTopicDeck = (env: WorkflowEnv) => env.state<string>("deck_style") === "topic";
/** A material deck (stored as a progress-kind deck): built from the user's own material (material.ts). */
const isMaterialDeck = (env: WorkflowEnv) => env.state<string>("deck_style") === "material";
/** Format rules of the deck: the topic / material rules, else Lab-Hub's for the mode. */
const deckRules = (env: WorkflowEnv, mode: DeckMode) => (isTopicDeck(env) ? TOPIC_RULES : isMaterialDeck(env) ? MATERIAL_RULES : LABHUB_RULES[mode]);

/**
 * A topic / survey deck (`topicDeckResearch`): papers from the study library — and, when the user asks for it or the
 * library is thin, from one online search batch + import (the topic_research machinery) — each read in its own extraction
 * step, then a survey outline (taxonomy, one page per method with its architecture and injection point, comparison,
 * synthesis) written page by page from the extractions of each page's source papers.
 */
export const TOPIC_RULES = `主題簡報規則（survey deck，不是 Lab-Hub 固定格式）：
- 封面由系統依簡報標題自動產生：大綱不要有封面／題目頁（第 1 頁就是內容）。
- 結構：動機與問題定義（任務、評估方式）→ 做法分類（kind taxonomy：表格或 grid diagram，一類一列並標代表論文）→ 代表方法一頁一個（kind method：\`\`\`diagram 架構圖畫出元件與「注入位置」（額外資訊接到哪個元件），寫需要訓練或只在推論時加、關鍵結果）→ 結果比較（kind comparison：表格或 \`\`\`chart，只把同資料集、同指標的數字放在一起）→ 綜合比較與開放問題（kind synthesis）→ 小結；頁數依計畫。
- 內容只用提供的論文摘錄（P1…Pn）與研究資料；提到論文時照「書目」寫（例如 Chen et al., 2018, Interspeech）；「僅依摘要」的論文不寫方法細節或數字；資料沒有的數字或結論不要寫。
- 不要用 paper-fig（論文圖）：架構與流程一律用 \`\`\`diagram。
- 每頁下方放 ::: {.notes} 講稿 :::。
- 沒有學生自填頁（student_owned 一律 false）。`;
/**
 * A deck from the user's own material (an attached Deep-Research file, pasted notes; production 301b6e1a): the material is
 * the main source — its structure, names and numbers; the study's progress data is background. No online search, no
 * imported papers.
 */
export const MATERIAL_RULES = `用使用者提供的資料做簡報的規則：
- 內容以「使用者提供的資料」為主要材料：重點、名稱、數字、結論都從資料來；研究進度資料只當背景。不要加入資料沒有的論文、方法或數字；資料沒寫的就不寫。
- 依使用者要的報告形式組織（例如向教授報告：背景與目標 → 現況與既有資源 → 限制與風險 → 可行方向與比較 → 建議與優先順序 → 下一步與需要決定的事）；使用者列出要呈現的部分時，每個部分至少一頁，頁面標題包含該部分的名稱。
- 資料裡有區分（已知事實／推論／待驗證、確定／不確定）時保留這個區分，不要把推測寫成事實。
- 封面由系統依簡報標題自動產生：大綱不要有封面／題目頁（第 1 頁就是內容）。
- 每頁下方放 ::: {.notes} 講稿 :::。
- 沒有學生自填頁（student_owned 一律 false）。`;
export const MATERIAL_DEFAULT_PAGES = 10;
/** The user asks for papers from outside the library (or for recent work): the topic deck searches online. */
/** (Whole English words: "research" is not "search".) */
export const ONLINE_RE = /線上|上網|網路上|搜尋|搜索|(?:找|查)(?:一些|更多|相關|新的)?(?:論文|文獻|paper)|最新|近期|\b(?:recent|latest|search|online)\b|\bfind (?:papers|literature|work)\b|\blook up\b/i;
/** A library with fewer full-text papers than this is thin for a survey deck: search online too. */
export const THIN_LIBRARY = 4;
export const TOPIC_DEFAULT_PAGES = 10;
/** The most library papers a topic deck reads in full (a library survey or a small library reads all of them, up to this). */
export const LIBRARY_ALL = 12;
export { LIBRARY_SURVEY_RE } from "../requirements.js";
// Which deck (PAPER_REPORT_RE, TOPIC_DECK_RE, PROGRESS_RE, deckModeOf) is route.ts: the router decides it once.
export { PAPER_REPORT_RE, TOPIC_DECK_RE, PROGRESS_RE, deckModeOf, REVISE_RE, EXPAND_RE, addedPages, editKindOf } from "../route.js";

/**
 * The subject a spoken request describes (「做一個簡報這個簡報裡面詳細描述了目前學界是怎麼在 Zipformer 和 RNNT 的架構下做
 * 熱詞機制的」 → 「在Zipformer和RNNT的架構下做熱詞機制」), or null when the words have no such phrase. Never the study's name:
 * the topic comes from the request (production 0668a3d7: the study name became the deck's title and topic).
 */
export function topicSubjectOf(words: string): string | null {
  const text = words.replace(/^（交給 Agent）/, "");
  const m = /(?:詳細)?(?:描述|介紹|說明|講解|探討|整理|討論|分析|比較)(?:了|一下)?\s*([^。！？!?\n]{4,120})/.exec(text) ?? /(?:關於|有關|針對)\s*([^。！？!?\n]{4,120})/.exec(text);
  if (!m) return null;
  // The clause only (a run-on request continues with other asks).
  let t = segmentClauses(m[1]!)[0] ?? m[1]!;
  t = t.replace(/^(?:目前|現在|現今|近年)?[^\s，。在]{0,6}?(?:是)?(?:怎麼|如何)/, "").replace(/^(?:的|是)/, "").replace(/(?:的)?(?:英文|中文)?(?:主題)?(?:簡報|投影片)$/, "").replace(/(?:的|呢|吧)$/, "").trim();
  if (t.replace(/[\s\p{P}]/gu, "").length < 4 || /簡報|投影片/.test(t)) return null;
  return clipText(t, 80);
}

/** A topic deck's working title from the user's words: 「幫我做一份關於 X 的簡報」 / "Make a presentation about X" → X. */
export function topicTitleOf(words: string): string {
  const first = words.replace(/\s+/g, " ").trim().split(/(?<=[。！？!?])\s*|(?<=\.)\s+/)[0] ?? words;
  const t = first
    .replace(/^(?:please\s+)?(?:make|create|prepare|build|give me|do|write)\s+(?:me\s+)?(?:an?\s+)?(?:(?:english|chinese|short|brief|research|academic|technical)\s+)*(?:presentation|deck|slide deck|slides|talk)\s+(?:about|on|for|of|introducing)\s+/i, "")
    .replace(/^(?:請|幫我|麻煩|可以|我想|我要)*(?:做|準備|製作|整理)?(?:一份|一個)?(?:英文|中文)?(?:的)?(?:關於|有關|介紹)?/, "")
    .replace(/(?:的)?(?:英文|中文)?(?:主題)?(?:簡報|投影片)$|[。.!！]$/, "")
    .trim();
  return clipText(t || first, 80);
}

/** The study's library and notes for a topic deck (the researcher's brief). */
async function topicContext(env: WorkflowEnv, studyId: string): Promise<string> {
  const papers = (await env.db.query<{ title: string; year: number | null; authors_text: string; venue: string | null; abstract: string | null }>(
    "SELECT p.title, p.year, p.authors_text, p.venue, p.abstract FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY p.year DESC NULLS LAST, p.title LIMIT 30",
    [studyId],
  )).rows;
  const notes = (await env.db.query<{ title: string; content_md: string }>("SELECT title, content_md FROM notes WHERE study_id=$1 AND kind IN ('research','reading') ORDER BY updated_at DESC LIMIT 4", [studyId])).rows;
  return [
    `# 研究文獻庫（${papers.length} 篇）`,
    ...(papers.length ? papers.map((p) => `## ${p.title}（${p.year ?? "年份不詳"}${p.venue ? `，${p.venue}` : ""}）\n作者：${p.authors_text.slice(0, 160) || "不詳"}\n摘要：${(p.abstract ?? "（文獻紀錄沒有摘要）").replace(/\s+/g, " ").slice(0, 700)}`) : ["（研究文獻庫還沒有論文）"]),
    ...(notes.length ? ["# 研究筆記", ...notes.map((n) => `## ${n.title}\n${n.content_md.slice(0, 2500)}`)] : []),
    "# 研究進度資料",
    (await progressContext(env.db, "00000000-0000-0000-0000-000000000000", studyId)).slice(0, 5000),
  ].join("\n\n");
}
/**
 * Planning of a topic deck: sub-questions (`decompose`, the request + study title only), ONE online search batch when the
 * user asks for it or the library is thin (`searchOnline`: keywords only, then the run is tainted), the picks (`select`:
 * library papers + importable candidates, ≤ 8), stored as `state.topic` (the shape topic_research uses, so `readPaper`
 * extracts them). No picks → the library / notes brief of a minimal topic deck.
 */
async function topicDeckResearch(env: WorkflowEnv, access: { study: { id: string; title: string } }, words: string, pages: number): Promise<{ brief: string; research: StepSpec; picks: TopicPick[]; note: string }> {
  const library = await libraryPapers(env, access.study.id);
  const stack = stackOf(words);
  const withPdf = library.filter((p) => p.has_pdf);
  const online = ONLINE_RE.test(words) || withPdf.length < THIN_LIBRARY;
  // How much of the library to read (production 0668a3d7: 4 of 10 papers were read although the user asked to tally the
  // library's methods; the taxonomy then had families with 「no representative」): the user asks to survey / tally the
  // library → every paper with a PDF (≤ LIBRARY_ALL); a small library → the planner picks by method family, up to all of
  // them; otherwise ≤ 8 by family coverage. Extraction runs in parallel, one fresh context per paper.
  const surveyLibrary = LIBRARY_SURVEY_RE.test(words) && withPdf.length > 0;
  const small = withPdf.length > 0 && withPdf.length <= LIBRARY_ALL;
  const readAll = surveyLibrary && withPdf.length <= LIBRARY_ALL;
  // A survey of a larger library still reads every related paper up to LIBRARY_ALL (the planner drops the off-topic ones).
  const wide = surveyLibrary || small;
  const max = wide ? Math.min(LIBRARY_ALL, Math.max(withPdf.length, Math.min(8, pages - 3))) : Math.min(8, Math.max(3, pages - 3));
  await env.activity("research", "orchestrator", "拆解主題與子問題");
  const d = await decompose(env, access.study.title, stack);
  const prev = env.state<TopicState>("topic");
  const found = online ? await searchOnline(env, d.queries) : { hits: [], seeds: [], searched: false, errors: [], queries: [] };
  const hits = found.searched ? found.hits : prev?.hits ?? [];
  await env.activity("research", "planner", "挑選這份簡報要讀的論文");
  const libraryRule = wide
    ? `研究文獻庫有 ${withPdf.length} 篇有全文的論文${surveyLibrary ? "，而且使用者要統計／涵蓋文獻庫裡的方法" : ""}：和主題相關的文獻庫論文全部選（最多 ${LIBRARY_ALL} 篇；每一類做法都要有代表論文，不要只挑幾篇），離題的才不選。`
    : "每一類做法（method family）都要有代表論文；選的篇數依做法的類別數，不要固定只挑幾篇。";
  const sel = await select(env, { topic: d.topic, subqs: d.subqs, hits, stack, max, maxLibrary: wide ? LIBRARY_ALL : 8, libraryRule }, library);
  let picks = sel.picks;
  const excluded = sel.excluded;
  // A library survey reads every paper with a PDF, whatever the planner picked.
  if (readAll) {
    for (const p of withPdf) {
      if (picks.some((x) => x.kind === "library" && x.paper_id === p.id)) continue;
      picks = [...picks, { kind: "library", paper_id: p.id, title: p.title, year: p.year, cite_key: p.cite_key, has_pdf: true, reason: "你要統計文獻庫裡的方法：文獻庫的論文全部讀", role: "core", ...(bibLine(p) ? { bib: bibLine(p) } : {}) }];
    }
  }
  if (!picks.length) {
    const data = await topicContext(env, access.study.id);
    const tried = online && d.queries.length ? `線上搜尋（${d.queries.map((q) => `「${q}」`).join("、")}）也沒有找到可以匯入的論文，` : "";
    return {
      brief: data, picks: [],
      research: { key: "research", role: "researcher", title: "整理研究的文獻庫與筆記", instructions: "讀研究文獻庫的論文（標題、年份、摘要）、研究與閱讀筆記和研究進度資料。", expected: "主題資料", done: { output: { summary: `文獻庫與筆記 ${data.length} 字`, text: data } } },
      note: `主題簡報：${tried}沒有挑到可以精讀的論文，改用研究文獻庫的論文摘要與研究筆記整理。`,
    };
  }
  const st: TopicState = {
    topic: d.topic, subqs: d.subqs, queries: found.searched ? found.queries : prev?.queries ?? [], seeds: found.searched ? found.seeds : prev?.seeds ?? [],
    hits, picks, excluded, searched: found.searched || !!prev?.searched, search_errors: found.errors, stack, title: d.title, read_all: readAll || (wide && surveyLibrary) || (small && picks.filter((p) => p.kind === "library").length >= withPdf.length),
  };
  await env.setState({ topic: st });
  const notes = (await env.db.query<{ title: string; content_md: string }>("SELECT title, content_md FROM notes WHERE study_id=$1 AND kind IN ('research','reading') ORDER BY updated_at DESC LIMIT 2", [access.study.id])).rows;
  const abstract = (p: TopicPick) => clipText((p.kind === "online" ? p.hit.abstract : library.find((l) => l.id === p.paper_id)?.abstract) ?? "", 500);
  const brief = [
    `# 主題：${d.topic}`,
    `## 子問題\n${d.subqs.map((q, i) => `${i + 1}. ${q.q}`).join("\n")}`,
    `## 要讀的論文（之後每篇從全文做摘錄；大綱的 sources 用這些編號）\n${picks.map((p, i) => `- P${i + 1} ${pickLine(p)}\n  摘要：${abstract(p) || "（沒有摘要）"}`).join("\n")}`,
    ...(notes.length ? ["## 研究筆記", ...notes.map((n) => `### ${n.title}\n${n.content_md.slice(0, 2000)}`)] : []),
  ].join("\n\n");
  const imports = picks.filter((p) => p.kind === "online").length;
  const why = readAll ? `你要統計文獻庫裡的方法，所以文獻庫 ${withPdf.length} 篇有全文的論文全部讀`
    : surveyLibrary ? `你要統計文獻庫裡的方法：文獻庫 ${withPdf.length} 篇有全文的論文中，和主題相關的都讀（${picks.length} 篇，上限 ${LIBRARY_ALL}）`
    : small ? `文獻庫只有 ${withPdf.length} 篇有全文的論文，和主題相關的都讀（${picks.length} 篇），每一類做法都有代表論文`
      : `依做法類別挑代表論文（文獻庫共 ${withPdf.length} 篇有全文）`;
  const note = online
    ? `主題簡報：${st.searched ? `線上搜尋只送出關鍵字（${st.queries.slice(0, 6).join("；")}）` : "沿用先前的線上搜尋結果"}，${imports ? `匯入 ${imports} 篇、` : ""}加上研究文獻庫 ${picks.length - imports} 篇，共 ${picks.length} 篇逐篇精讀後寫成簡報。不想匯入的論文可以在步驟中關掉。`
    : `主題簡報：讀 ${picks.length} 篇論文的全文（每篇一個研究者摘錄，平行進行）：${why}；要先線上找新論文，請在要求裡說「搜尋」或「找論文」。`;
  return {
    brief, picks, note,
    research: { key: "research", role: "researcher", title: online ? "拆解主題、線上搜尋與挑選論文" : "拆解主題並從文獻庫挑選論文", instructions: "拆成子問題、挑選要精讀的論文（文獻庫中相關的，以及要匯入的線上候選）。", expected: "子問題 + 要讀的論文（含理由）", done: { output: { summary: `${d.subqs.length} 個子問題${online ? `、${st.queries.length} 個查詢、${hits.length} 筆候選` : ""} → 讀 ${picks.length} 篇（${imports} 篇匯入）`, text: brief } } },
  };
}

/**
 * A material-deck page's sources: the whole run brief when the material fits it; otherwise the material sections most
 * related to the page in full + a digest of the whole material + the study background. Writer and judge see this block.
 */
async function materialPageBrief(env: WorkflowEnv, pages: SlideOutline[]): Promise<string> {
  const brief = env.state<string>("brief") ?? "";
  const mats: LoadedMaterial[] = await loadMaterial(env);
  const total = mats.reduce((a, m) => a + m.text.length, 0);
  if (!mats.length || total <= SOURCE_CHARS - 6_000) return brief;
  const at = brief.search(/^# 研究(?:文獻庫|進度資料)/m);
  const background = at >= 0 ? brief.slice(at).slice(0, 4_000) : "";
  const pageText = pages.map((p) => `${p.title}\n${p.purpose ?? ""}\n${p.points.join("\n")}`).join("\n");
  return `${materialForPages(mats, pageText, { full: 15_000, rest: SOURCE_CHARS - 15_000 - background.length - 1_000 })}${background ? `\n\n${background}` : ""}`;
}

/** The extraction steps of the topic deck's papers that finished, by step key. */
async function readPapers(env: WorkflowEnv): Promise<Map<string, ReadPaper>> {
  const steps = await getSteps(env.db, env.run.id);
  const out = new Map<string, ReadPaper>();
  for (const s of steps) {
    const d = (s.output?.data ?? {}) as Partial<ReadPaper> & { skipped?: boolean };
    if (s.key.startsWith("paper_") && s.status !== "skipped" && s.output?.text && d.paper_id && !d.skipped) out.set(s.key, { ...(d as ReadPaper), notes: s.output.text });
  }
  return out;
}

/** What a page's writer needs from each source paper's extraction, by the page's role (parts, chars). */
const PAGE_PARTS: Record<PageKind, [string, number][]> = {
  method: [["一句話", 200], ["方法", 1400], ["注入位置與訓練／推論", 600], ["關鍵公式", 600], ["數字表", 900], ["限制", 250]],
  comparison: [["實驗設定", 500], ["數字表", 1800]],
  taxonomy: [["一句話", 250], ["方法", 450], ["注入位置與訓練／推論", 300]],
  motivation: [["一句話", 300], ["實驗設定", 300]],
  synthesis: [["一句話", 200], ["限制", 600], ["子問題對應", 400]],
  title: [["一句話", 200]],
  other: [["一句話", 250], ["方法", 500], ["數字表", 500]],
};

/**
 * A topic-deck page's sources: the topic header + the extractions of the page's source papers (the parts its role
 * needs). The writer and its judge see exactly this block; the content refs are rebuilt from every extraction read so far.
 */
async function topicPageBrief(env: WorkflowEnv, pages: SlideOutline[]): Promise<string> {
  const st = env.state<TopicState>("topic");
  const papers = await readPapers(env);
  const n = st?.picks.length ?? 0;
  if (papers.size > (env.state<number>("topic_refs_n") ?? 0)) {
    // The run's material grows with every paper read: the content checks' names (rebuilt) and the brief the final
    // verification judges against (the planning brief only had abstracts: 「P1 只有摘要」 false fails on staging).
    const planBrief = env.state<string>("topic_plan_brief") ?? env.state<string>("brief") ?? "";
    // Each paper's share of the judge's sources, with the parts a claim is checked against first (numbers table, method,
    // injection point, limits): with a library survey's 10+ papers a plain clip cut every 數字表 off and the final judge
    // failed numbers the writers had from the full extraction (staging, 79ab0678 eval).
    const share = Math.floor(50_000 / Math.max(1, papers.size));
    const FIRST = ["數字表", "一句話", "方法", "注入位置與訓練／推論", "限制", "實驗設定", "關鍵公式"];
    const paperBlock = (k: string, p: ReadPaper) => {
      const head = `## P${k.slice(6)}〈${p.title}〉${p.bib ? `（${p.bib}）` : p.year ? `（${p.year}）` : ""}`;
      const parts = FIRST.map((n) => { const t = extractPart(p.notes, n); return t ? `#### ${n}\n${t}` : ""; }).filter(Boolean);
      return clipText(`${head}\n${parts.length >= 2 ? parts.join("\n\n") : p.notes}`, share);
    };
    const brief = `${planBrief.slice(0, 5000)}\n\n# 論文摘錄（每篇的全文摘錄）\n\n${[...papers.entries()].map(([k, p]) => paperBlock(k, p)).join("\n\n")}`;
    await env.setState({ content_refs: null, topic_refs_n: papers.size, topic_plan_brief: planBrief, brief: brief.slice(0, 58_000) });
    await buildContentRefs(env, { brief, extra: [...papers.values()].map((p) => p.title) });
  }
  const keys = [...new Set(pages.flatMap((p) => pageSources(p, n, usedPicks(outlineOf(env), n))))];
  const kind: PageKind = pages[0]?.kind ?? "other";
  const share = Math.floor(22_000 / Math.max(1, keys.length));
  const material = keys.map((k) => {
    const p = papers.get(k);
    const i = Number(k.slice(6));
    if (!p) return `### P${i}〈${clipText(st?.picks[i - 1] ? pickTitle(st.picks[i - 1]!) : k, 80)}〉\n（這篇沒有讀到，不要寫它的內容）`;
    const got = PAGE_PARTS[kind].map(([name, max]) => { const t = extractPart(p.notes, name); return t ? `**${name}**：${clipText(t, max)}` : ""; }).filter(Boolean);
    return clipText(`### P${i}〈${p.title}〉${p.bib ? `（${p.bib}）` : p.year ? `（${p.year}）` : ""}${p.has_pdf ? "（讀過全文）" : `（${ABSTRACT_ONLY}：不寫方法細節或數字）`}\n${got.length ? got.join("\n") : p.notes}`, share);
  });
  const bibs = (st?.picks ?? []).map((pk, j) => {
    const read = papers.get(`paper_${j + 1}`);
    const line = read?.bib ?? (pk.kind === "library" ? pk.bib : [pk.hit.authors?.split(/[;,]/)[0]?.trim(), pk.hit.year, pk.hit.venue ?? (pk.hit.arxiv_id ? "arXiv preprint" : "")].filter(Boolean).join(", "));
    return `- P${j + 1}〈${clipText(pickTitle(pk), 90)}〉${line ? `：${line}` : ""}`;
  });
  const head = `# 主題：${st?.topic ?? ""}\n子問題：${(st?.subqs ?? []).map((q, i) => `Q${i + 1} ${q.q}`).join("；")}${bibs.length ? `\n\n# 書目（提到論文時照這裡寫：第一作者 et al.、年份、會議／期刊；書目沒列會議／期刊的就省略，不要寫「未提供」）\n${bibs.join("\n")}` : ""}`;
  return `${head}\n\n# 這頁的來源論文（摘錄）\n\n${material.join("\n\n") || "（這頁沒有指定來源論文：只寫標題與主題）"}`;
}

/** A paper's short name for a source line: the part before a colon, else its first words (never cut mid-word with 「…」). */
export const shortTitle = (t: string) => {
  const head = t.split(/[:：]/)[0]!.trim();
  if (head.length <= 56) return head;
  const words = head.split(/\s+/);
  let out = "";
  for (const w of words) if (`${out} ${w}`.trim().length <= 56) out = `${out} ${w}`.trim(); else break;
  return out || head.slice(0, 56);
};

/** Per-page source tracing (topic decks): a short 「Sources」 line from the page's source papers, added by code. */
export function withSourceLines(body: string, outline: SlideOutline[], titles: (key: string) => string | null, lang: "en" | "zh" | null): string {
  const label = lang === "en" ? "Sources" : "來源";
  return body.split(/^(?=## )/m).map((part) => {
    if (!part.startsWith("## ") || /::: \{\.page-source\}/.test(part)) return part;
    const title = parseSlides(part)[0]?.title ?? "";
    const p = findByTitle(outline, title, (o) => o.title);
    const refs = (p?.sources ?? []).map((r) => titles(r)).filter((t): t is string => !!t).slice(0, 2);
    if (!refs.length) return part;
    const line = `::: {.page-source}\n${label}: ${refs.join("; ")}\n:::\n\n`;
    const notes = part.search(/^:::+\s*\{?\.?notes\}?\s*$/m);
    return notes < 0 ? `${part.trimEnd()}\n\n${line}` : `${part.slice(0, notes)}${line}${part.slice(notes)}`;
  }).join("");
}

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

/**
 * Writer steps: one per page (`PAGES_PER_WRITER`). `deps(page)` adds what a page's content rests on (topic decks: the
 * extraction steps of its source papers).
 */
export function writerSteps(outline: SlideOutline[], deps: (p: SlideOutline) => string[] = () => []): StepSpec[] {
  const owned = studentOwned(outline);
  const out: StepSpec[] = [];
  for (let i = 0; i < outline.length; i += PAGES_PER_WRITER) {
    const pages = outline.slice(i, i + PAGES_PER_WRITER);
    const a = pages[0]!.n;
    const b = pages.at(-1)!.n;
    out.push({
      key: `write_${a}`,
      role: "writer",
      title: a === b ? `撰寫第 ${a} 頁「${clipText(pages[0]!.title, 40)}」` : `撰寫第 ${a}–${b} 頁`,
      instructions: `依大綱寫出第 ${a}${a === b ? "" : `–${b}`} 頁投影片與講稿：${pages.map((p) => `「${p.title}」${p.layout ? `（版型 ${p.layout}）` : ""}`).join("、")}。`,
      depends_on: ["outline", ...new Set(pages.flatMap(deps))],
      inputs: { pages: pages.map((p) => p.n), budget: PAGE_BUDGET },
      expected: `${pages.length} 頁，每頁以「## 標題」開頭並附講稿`,
      verify: writerChecks(pages, owned),
    });
  }
  return out;
}

/** `P3` → `paper_3` (the extraction step of pick 3); unknown refs dropped. */
const paperKeyOf = (ref: string, n: number) => {
  const i = Number(/^P(\d+)$/i.exec(ref.trim())?.[1]);
  return i >= 1 && i <= n ? `paper_${i}` : null;
};

/**
 * The pages' source papers as extraction steps (topic decks). A page without valid source refs rests on every paper only
 * when its role is a survey-wide one (taxonomy, comparison, synthesis, motivation); a title page rests on none.
 */
export function pageSources(p: SlideOutline, papers: number, used?: number[]): string[] {
  const own = [...new Set((p.sources ?? []).map((r) => paperKeyOf(r, papers)).filter((k): k is string => !!k))];
  if (own.length) return own;
  const all = used ?? Array.from({ length: papers }, (_, i) => i);
  return p.kind === "title" || !papers ? [] : all.map((i) => `paper_${i + 1}`);
}

/**
 * The picks the outline actually uses (0-based): those some page names as a source. A pick no page rests on is never
 * imported or read (staging: 1 of 7 extractions was for a paper no page used). No source refs at all → every pick.
 */
export function usedPicks(outline: SlideOutline[], n: number): number[] {
  const used = new Set(outline.flatMap((p) => (p.sources ?? []).map((r) => paperKeyOf(r, n))).filter((k): k is string => !!k).map((k) => Number(k.slice(6)) - 1));
  return used.size ? [...used].sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => i);
}

/** The taxonomy page (else the first survey-wide page) rests on every pick P1…Pn. */
export function withAllSources(outline: SlideOutline[], n: number): SlideOutline[] {
  const all = Array.from({ length: n }, (_, i) => `P${i + 1}`);
  const at = outline.findIndex((p) => p.kind === "taxonomy");
  const i = at >= 0 ? at : outline.findIndex((p) => p.kind === "comparison" || p.kind === "synthesis" || p.kind === "motivation");
  if (i < 0) return outline;
  return outline.map((p, j) => (j === i ? { ...p, sources: all } : p));
}

/** Deck extractions read the results-weighted digest of the full text; a few tool rounds for figures / equations only. */
const DECK_READ_TOOLS = 4;

function laterSteps(outline: SlideOutline[], vision: boolean, picks: TopicPick[] = []): StepSpec[] {
  // Topic decks: one extraction step per paper a page uses (import + full-text extraction in a fresh context), before the writers.
  const used = picks.length ? usedPicks(outline, picks.length) : [];
  const papers = picks.length ? paperSteps(picks, { only: used, maxTools: DECK_READ_TOOLS }) : [];
  const writes = writerSteps(outline, (p) => (papers.length ? pageSources(p, picks.length, used) : []));
  const owned = studentOwned(outline);
  const n = outline.length;
  // Student-owned pages: ask the student (one card with grounded options) once the content pages are drafted.
  const ask = owned.length ? [studentInputStep(owned, writes.map((w) => w.key))] : [];
  const steps: StepSpec[] = [
    ...papers,
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
        ? "編譯並擷取每一頁截圖，交給能看圖的審查者逐頁評分（易讀、擁擠、版面、視覺、圖是否正確畫出、超出、一致、專業感；平均 ≥ 4 分且沒有嚴重問題才通過），並用版面量測檢查文字超出方框或投影片、字小於 16px、大片空白、圖表與表格重複；只重新評分有改過的頁面，未通過的頁面交回撰寫者修正，每頁最多 2 次，改壞的頁面換回較好的版本。版面硬傷才算不通過，其他建議列入報告。"
        : "目前的模型不能看圖：改用版面量測（超出方框或投影片、字級 ≥ 16px、大片空白、字數、條列、圖是否編譯成功、圖表與表格重複）逐頁檢查，未通過的頁面交回撰寫者修正，每頁最多 2 次，改壞的頁面換回較好的版本。版面硬傷才算不通過，其他建議列入報告。",
      depends_on: ["constraints"],
      expected: "沒有版面硬傷的頁面（其他版面建議列入報告）",
      verify: { checks: [{ id: "render_ok" }, { id: "visual_qa" }], judge: false },
      max_rounds: 0,
    },
    { key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收整份簡報。", depends_on: ["visual_qa"], expected: "每一條驗收標準都通過" },
  );
  return steps;
}

/** `titles`: the outline's page titles — the page criterion then also fails on a missing, duplicated or moved page. */
function criteriaFor(n: number, mode: DeckMode, owned: string[], abstractOnly = false, titles: string[] = []): Omit<Criterion, "status">[] {
  return [
    // (A new deck: the first page never repeats the cover — `no_cover_repeat`.)
    { id: "pages", kind: "check", text: `簡報正好 ${n} 頁，頁面順序與確認的大綱一致，沒有重複封面的頁面`, check: { id: "slide_count", params: { expected: n, no_cover_repeat: true, ...(titles.length === n ? { titles } : {}) } } },
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
    { id: "visual_qa", kind: "check", text: "逐頁截圖檢查沒有版面硬傷（文字不超出方框或投影片、字 ≥ 16px、圖都正確畫出）；擁擠、留白等版面建議列入報告", check: { id: "visual_qa" } },
    { id: "grounded", kind: "judge", text: abstractOnly ? "沒有全文 PDF：內容只來自論文摘要與書目資料，清楚標示「僅依摘要」，沒有捏造方法細節或數字" : mode === "paper_report" ? "內容與數字都來自論文本身，重要結果標註出處（表／§），沒有捏造" : "內容只來自研究資料（待辦、筆記、會議回饋），沒有捏造的數字或結論" },
    { id: "coverage", kind: "judge", text: `每頁都涵蓋大綱列出的重點，前後連貫，適合在組會報告${owned.length ? `（${owned.map((o) => `「${o}」`).join("、")}是學生自填頁：內容來自報告者自己的回答；報告者選擇跳過時保留提示，自動駕駛代填時標示「AI 代填，待你確認」，都可以接受，不算缺漏）` : ""}` },
  ];
}

type OutlineJson = { pages: { title: string; points?: string[]; student_owned?: boolean; item?: string; layout?: string; purpose?: string; kind?: string; sources?: string[]; from?: unknown }[] };
const isOutline = (v: unknown): v is OutlineJson => !!v && typeof v === "object" && Array.isArray((v as OutlineJson).pages) && (v as OutlineJson).pages.every((p) => p && typeof p.title === "string");

/** A cover / title page title (「封面」「Title slide」「題目」). */
const COVER_TITLE_RE = /^(?:封面|封面頁|標題頁|題目|題目頁|簡報標題|title|title slide|title page|cover|cover page)$/i;
const normTitle = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
/**
 * Pages of a new deck's outline that repeat the cover (the front matter already renders it): a `title`-kind page, a page
 * named 「封面」/「Title slide」, or a first page titled like the deck. Pure.
 */
export function dropCoverPages(outline: SlideOutline[], cover: string): { outline: SlideOutline[]; dropped: string[] } {
  const c = normTitle(cover);
  const isCover = (p: SlideOutline, i: number) => p.kind === "title" || COVER_TITLE_RE.test(p.title.trim()) || (i <= 1 && !!c && c.length >= 4 && (normTitle(p.title) === c || (normTitle(p.title).length >= 6 && (c.includes(normTitle(p.title)) || normTitle(p.title).includes(c)))));
  const dropped = outline.filter((p, i) => isCover(p, i) && !p.student_owned).map((p) => p.title);
  if (!dropped.length || dropped.length >= outline.length) return { outline, dropped: [] };
  return { outline: outline.filter((p, i) => !(isCover(p, i) && !p.student_owned)).map((p, i) => ({ ...p, n: i + 1 })), dropped };
}

/** The outline's check of the listed parts (no judged fallback: the planner can always title a page after a part). */
export const sectionChecks = (reqs: Requirement[]): CheckSpec[] =>
  reqs.filter((r) => r.type === "include_topics" && r.params?.sections && r.params.topics?.length).map((r) => ({ id: "req_sections", params: { topics: r.params!.topics } }));

/** Outline rule for the parts the user listed (「呈現 A、B、C」): each part gets its own page, titled with its name. */
export function sectionRule(reqs: Requirement[]): string {
  const r = reqs.find((x) => x.type === "include_topics" && x.params?.sections && x.params.topics?.length);
  if (!r) return "";
  return `使用者要呈現這幾個部分：${r.params!.topics!.map((t) => `「${t.name}」`).join("、")}。每個部分至少一頁，而且頁面標題要包含該部分的名稱（逐字，例如「${r.params!.topics![0]!.name}」）；其他頁再補充。`;
}

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

/** The planner's per-page choices kept on the outline: a layout id of the library, a role, source refs, a purpose. */
const pageMeta = (p: OutlineJson["pages"][number]): Partial<SlideOutline> => {
  const layout = typeof p.layout === "string" ? p.layout.trim().toUpperCase().slice(0, 1) : "";
  const kind = typeof p.kind === "string" ? (p.kind.trim().toLowerCase() as PageKind) : undefined;
  const sources = Array.isArray(p.sources) ? [...new Set(p.sources.filter((x): x is string => typeof x === "string" && /^P\d{1,2}$/i.test(x.trim())).map((x) => x.trim().toUpperCase()))].slice(0, 4) : [];
  return {
    ...(LAYOUTS[layout] ? { layout } : {}),
    ...(kind && PAGE_KINDS.includes(kind) ? { kind } : {}),
    ...(sources.length ? { sources } : {}),
    ...(typeof p.purpose === "string" && p.purpose.trim() ? { purpose: cleanPoint(p.purpose, 160) } : {}),
    ...((typeof p.from === "number" || (typeof p.from === "string" && /^\d{1,2}$/.test(p.from.trim()))) && Number.isInteger(Number(p.from)) && Number(p.from) > 0 ? { from: Number(p.from) } : {}),
  };
};

const toOutline = (pages: OutlineJson["pages"], revise = false): SlideOutline[] =>
  pages.map((p, i) => ({ n: i + 1, title: cleanPoint(p.title, 120), points: (p.points ?? []).filter((x) => typeof x === "string").map((x) => cleanPoint(x)).filter(Boolean).slice(0, 6), ...(!revise && (p.student_owned || STUDENT_TITLE_RE.test(p.title)) ? { student_owned: true } : {}), ...(typeof p.item === "string" && p.item.trim() ? { item: p.item.trim().slice(0, 80) } : {}), ...pageMeta(p) }));

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

const outlineText = (o: SlideOutline[]) => o.map((p) => `${p.n}. ${p.title}${p.student_owned ? "（學生自填）" : ""}${p.item ? `（介紹：${p.item}）` : ""}${p.layout ? `（版型 ${p.layout}）` : ""}${p.sources?.length ? `（來源 ${p.sources.join("、")}）` : ""}\n${p.purpose ? `   目的：${p.purpose}\n` : ""}${p.points.map((x) => `   - ${x}`).join("\n")}`).join("\n");

async function paperBrief(env: WorkflowEnv, paper: { id: string; title: string; pdf_key: string | null }, fix: { previous: StepOutput; issues: string[] } | null) {
  const user = [
    `要報告的論文：〈${paper.title}〉（paper_id ${paper.id}）。`,
    "請先呼叫 read_paper（不帶 section）取得目錄與摘要，再讀方法、實驗設定、主要結果、消融、結論等章節（長章節用 offset 分段）；目前的模型能看圖時，用 view_paper_pages 看關鍵公式、架構圖或結果表所在的頁面。",
    "讀完後輸出研究摘要（Markdown，1500–3000 字）：## 問題與動機、## 方法（核心想法、關鍵公式逐一說明符號）、## 實驗設定（資料集、指標、baseline）、## 主要結果（數字照原文，標表號）、## 消融與分析、## 限制、## 圖表清單、## 數字表。每個重點後面標註出處，例如（§3.2，p. 4）或（表 2）。",
    "「## 圖表清單」逐一列出論文中重要的圖與表（架構圖、方法圖、主要結果圖表）：`Fig. N — p. 頁碼 — type（architecture／method／result／table／example）— 位置 top-bottom（頁面高度比例，例如 0.08-0.50）— 內容一句`；論文有整體架構圖或方法示意圖時一定要列出（type architecture／method）。請用 view_paper_pages 看過那一頁再填位置。「## 數字表」把主要結果與消融的數字整理成 Markdown 表格（照原文數字，標表號），之後會用來畫圖表。",
    env.guidanceText(),
    env.run.request ? requestLine(env) : "",
    fix ? `上一版的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}\n請補讀需要的章節後輸出完整的新版本。\n${dataBlock("previous_version", (fix.previous.text ?? "").slice(0, 12_000))}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await env.researcher({ id: `plan-research`, key: "research" }, { system: systemFor("researcher"), user, tools: ["read_paper", "view_paper_pages", "get_paper"], maxToolSteps: 80, purpose: "research_paper" });
  return { summary: `讀了論文全文（${r.toolCalls} 次工具呼叫），整理研究摘要 ${r.text.length} 字`, text: r.text };
}

async function makeOutline(env: WorkflowEnv, mode: DeckMode, pages: number, brief: string, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const topicPicks = isTopicDeck(env) ? env.state<TopicState>("topic")?.picks.length ?? 0 : 0;
  const user = [
    deckRules(env, mode),
    `請規劃一份正好 ${pages} 頁的${isTopicDeck(env) ? "主題" : isMaterialDeck(env) ? "以使用者提供的資料為主要材料的" : mode === "paper_report" ? "論文報告" : "進度報告"}簡報大綱。封面由系統自動產生，不要規劃封面／題目頁。使用者指定的頁數優先：與 Lab-Hub 固定頁數不同時，保留最重要的固定頁（標題逐字），其餘合併或刪減，但總數一定是 ${pages} 頁。`,
    "每頁給 2–5 個具體重點（來自資料的事實、數字要標出處）。結果與消融頁一定要寫出論文的實際數字（研究摘要沒有就從「論文原文節錄」找）；重點裡不要寫〔　〕、「資料未提供」或「待補」：資料真的沒有的重點就換成資料裡有的內容。只有規則明定由學生自己填寫的頁面（例如 My assessment、Takeaways for my work、卡住、Idea card、下週與要問）才標 student_owned: true。",
    requestLine(env),
    env.guidanceText(),
    itemRule(env.requirements()),
    sectionRule(env.requirements()),
    `每頁從版型庫挑一個 layout（只寫代號）：${layoutList(mode === "paper_report")}。版型決定這頁的視覺；不要寫位置、座標或尺寸。`,
    topicPicks ? `這是 survey 簡報：每頁標 kind（${PAGE_KINDS.join("／")}）與 sources（這頁根據的論文編號，例如 ["P2"]，只能用「要讀的論文」列出的 P1–P${topicPicks}）；每個代表方法一頁（kind method，sources 是提出它的論文，item 寫方法名稱），做法分類（taxonomy）與結果比較（comparison）頁的 sources 列出涵蓋的論文。${env.state<TopicState>("topic")?.read_all ? `使用者要涵蓋整個文獻庫：做法分類頁要統計 P1–P${topicPicks} 全部論文分成哪幾類（每類幾篇、代表論文），每一類都要有論文，不能寫某類「沒有代表論文」；方法頁依類別安排。` : ""}` : "",
    dataBlock("research", brief.slice(0, SOURCE_CHARS)),
    fix ? `上一版大綱的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `只輸出 JSON：{"pages":[{"title":"頁面標題","purpose":"這頁的目的（一句）","points":["重點"],"layout":"A"${topicPicks ? ',"kind":"method","sources":["P1"],"item":"方法名稱（method 頁）"' : ""},"student_owned":false${perItem(env.requirements()) && !topicPicks ? ',"item":"這頁介紹的項目名稱（沒有就省略）"' : ""}}]}，pages 正好 ${pages} 個。`,
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 14_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  // The cover is the deck's front matter: a planned title / cover page repeats it (production 301b6e1a: pages 1 and 2
  // had the same title). Dropped here, so the page-count check asks the planner for a content page instead.
  const { outline, dropped } = dropCoverPages(toOutline(pagesJson), env.state<string>("cover_title") ?? "");
  if (dropped.length) await env.note(`大綱的封面頁和系統產生的封面重複，已拿掉：${dropped.map((t) => `「${t}」`).join("、")}。`, "warn");
  return { summary: `${outline.length} 頁大綱`, text: outline.map((p) => `## ${p.title}\n${p.student_owned ? "- （學生自填）" : p.points.map((x) => `- ${x}`).join("\n")}\n\n::: {.notes}\n${p.student_owned ? "學生自填" : p.points.join("；")}\n:::`).join("\n\n"), data: { outline } };
}

/**
 * A paper report was asked for but no paper is given / named: ONE clarifying card (brief.ts `clarifyOnce`) with the study's
 * papers as options, plus a topic deck from the library or a progress report. Unanswered (autopilot) → a topic deck,
 * 「論文：未指定」. The chosen paper is stored in the inputs.
 */
async function whichPaper(env: WorkflowEnv, studyId: string): Promise<DeckMode | "topic"> {
  const rows = (await env.db.query<{ id: string; title: string; year: number | null; has_pdf: boolean }>(
    "SELECT p.id, p.title, p.year, (p.pdf_key IS NOT NULL) AS has_pdf FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY (p.pdf_key IS NOT NULL) DESC, sp.created_at DESC LIMIT 6",
    [studyId],
  ).catch(() => ({ rows: [] as { id: string; title: string; year: number | null; has_pdf: boolean }[] }))).rows;
  const answer = await clarifyOnce(env, {
    id: "paper", title: "要報告哪一篇論文？", prompt: "這份簡報要報告哪一篇論文？",
    intro: "你要的是論文報告，但沒有指定論文。選一篇研究文獻庫裡的論文，或在「其他」寫論文標題；也可以改成用整個文獻庫做主題簡報。",
    options: [
      ...rows.map((r) => ({ value: r.id, label: clipText(r.title, 110), description: `${r.year ?? "年份不詳"}${r.has_pdf ? "" : "，沒有 PDF（會先找開放全文）"}` })),
      { value: "topic", label: "不指定論文：用研究的文獻庫與筆記做主題簡報" },
      { value: "progress", label: "改做進度報告（用研究資料）" },
    ],
    unspecified: "要報告的論文",
  });
  if (!answer) return "topic";
  if (answer.value === "topic" || answer.value === "progress") return answer.value as "topic" | "progress";
  let id = answer.value && rows.some((r) => r.id === answer.value) ? answer.value : null;
  if (!id && answer.other) {
    const all = (await env.db.query<{ id: string; title: string }>("SELECT p.id, p.title FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 LIMIT 500", [studyId])).rows;
    id = matchPaperTitle(answer.other, all)?.id ?? null;
  }
  if (!id) return "paper_report";
  await env.db.query("UPDATE workflow_runs SET inputs = inputs || jsonb_build_object('paper_id', $2::text) WHERE id=$1", [env.run.id, id]);
  env.run.inputs = { ...env.run.inputs, paper_id: id };
  return "paper_report";
}

async function plan(env: WorkflowEnv): Promise<import("./registry.js").PlanResult> {
  const access = await requireStudy(env, "簡報");
  if ("question" in access) return { kind: "question", question: access.question, setup: true };
  if (!access.canEdit) return { kind: "question", question: `你不是〈${access.study.title}〉的成員，不能在這個研究建立簡報。請指定你參與的研究。`, setup: true };
  // The routing decision (route.ts) says which deck — this deck itself (edit), progress, paper report or topic; the
  // playbook executes it and never re-reads the request for a mode. Batches were split by the router.
  const r = await currentRoute(env);
  // 「每一篇文獻」 whose study was only found now (named in a guidance, or 「你決定」): the batch, and this run ends.
  if (r?.batch && !env.run.batch_id) {
    const message = await splitBatch(env, "slides");
    if (message) return { kind: "skip", message };
  }
  // An existing deck with content + an edit request (translate, rewrite, restyle…) → revise it in place.
  const revise = r?.deck === "edit" ? await reviseSource(env, access.study.id) : null;
  if (revise) return revisePlan(env, access, revise, r?.edit, r?.scope);
  const b = env.brief();
  const words = [...(b ? b.user_words : [env.run.request]), ...(b ? [] : userGuidance(env.run))].join("\n");
  // A paper given with the run (inputs / page context at creation) — not a fallback pick.
  const explicitId = r?.explicit_paper ?? !!paperIdOf(env);
  let paper = await paperOf(env);
  // A run routed before the deck decision existed (or an edit whose deck has no slides): the same pure rule.
  const given = materialsOf(env.run.inputs);
  let picked: DeckMode | "topic" | "material" = r?.deck && r.deck !== "edit" ? r.deck : deckModeOf(words, { inputMode: env.run.inputs.mode as string | undefined, explicitPaper: explicitId, progressAsked: PROGRESS_RE.test(words), material: given.length > 0 });
  // The user's own material (material.ts): read with the owner's permissions; nothing readable → a progress deck says so.
  const mats = given.length && picked !== "paper_report" ? await loadMaterial(env) : [];
  let materialNote = "";
  if (picked === "material" && !mats.length) {
    picked = "progress";
    materialNote = "你提供的資料讀不到文字內容，改用研究的進度資料做簡報。";
  }
  if (picked === "paper_report" && !paper) picked = await whichPaper(env, access.study.id);
  if (picked !== "paper_report" && paper && !explicitId) {
    // The study's only paper (paperOf's fallback) is not this deck's subject: forget it.
    paper = null;
    await env.db.query("UPDATE workflow_runs SET inputs = inputs - 'paper_id' WHERE id=$1", [env.run.id]);
    env.run.inputs = Object.fromEntries(Object.entries(env.run.inputs).filter(([k]) => k !== "paper_id"));
  }
  const topic = picked === "topic";
  const material = picked === "material";
  const mode: DeckMode = picked === "topic" || picked === "material" ? "progress" : picked;
  await env.setState({ deck_style: topic ? "topic" : material ? "material" : null });
  if (picked === "paper_report") paper = await paperOf(env);
  if (mode === "paper_report" && !paper) return { kind: "question", question: "要報告哪一篇論文？請先把論文加入文獻庫（或附加它），再在補充指示寫出論文標題。" };
  // No PDF: open access + the record's URLs first; then autopilot skips (needs_pdf), otherwise the user chooses (paper-pdf.ts).
  let abstractOnly = false;
  if (mode === "paper_report" && !paper!.pdf_key) {
    const d = await ensurePaperPdf(env, paper!);
    if (d.kind === "needs_pdf" || d.kind === "skip") return d;
    paper = d.paper;
    abstractOnly = d.kind === "abstract";
  }
  // Pages: the user's number (a requirement / inputs.pages), else a working default — 「頁數：未指定」, never a requirement.
  let pages = Math.min(40, Math.max(3, Number(env.run.inputs.pages) || requiredPages(env.requirements()) || (abstractOnly ? 5 : topic ? TOPIC_DEFAULT_PAGES : material ? MATERIAL_DEFAULT_PAGES : expectedPages(mode, words))));
  await env.setState({ mode, pages, abstract_only: abstractOnly });

  // Research (paper: researcher sub-agent with read_paper; topic: papers to extract; progress: the study's own data).
  let brief = "";
  let research: StepSpec;
  let picks: TopicPick[] = [];
  let topicNote = "";
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
    // Everything fits the writers' window (SOURCE_CHARS): the summary is trimmed so the excerpt (last) is never cut off
    // — for the writers or their judges (verify.ts gives the judge exactly the writer's blocks).
    const tail = `${figs}${excerpt ? `\n\n# 論文原文節錄（自動擷取；研究摘要沒有的數字、表格、設定從這裡找，照原文引用）\n\n${excerpt}` : ""}`;
    if (excerpt || figs) brief = `${brief.slice(0, Math.max(3_000, Math.min(r.ok ? 12_000 : 8_000, SOURCE_CHARS - tail.length)))}${tail}`.slice(-SOURCE_CHARS);
    research = r.spec;
  } else if (material) {
    // The material is the main source; the study's progress data is background; the library only when the words ask.
    const progress = (await progressContext(env.db, "00000000-0000-0000-0000-000000000000", access.study.id).catch(() => "")).slice(0, 4_000);
    const library = /文獻庫|library|our papers|study papers/i.test(words) ? (await topicContext(env, access.study.id)).slice(0, 6_000) : "";
    brief = [materialText(mats, SOURCE_CHARS - 2_000 - progress.length - library.length), library ? `# 研究文獻庫（你要求參考，次要來源）\n\n${library}` : "", progress ? `# 研究進度資料（背景，次要）\n\n${progress}` : ""].filter(Boolean).join("\n\n");
    const chars = mats.reduce((a, m) => a + m.text.length, 0);
    research = { key: "research", role: "researcher", title: "讀你提供的資料", instructions: "讀使用者提供的資料（主要材料）與研究進度資料（背景）。", expected: "簡報的材料", done: { output: { summary: `你提供的資料 ${mats.map((m) => `〈${clipText(m.title, 40)}〉`).join("、")}（${chars} 字）＋研究進度資料`, text: brief } } };
    topicNote = `以你提供的${mats.map((m) => `〈${clipText(m.title, 50)}〉`).join("、")}為主要材料（${chars} 字${chars > SOURCE_CHARS ? "；每頁拿到和它最相關的原文段落與整份摘要" : ""}），研究進度資料只當背景；不做線上搜尋、不匯入論文${library ? "；你要求參考文獻庫，文獻庫的摘要當補充" : ""}。`;
  } else if (topic) {
    const t = await topicDeckResearch(env, access, words, pages);
    brief = t.brief;
    research = t.research;
    picks = t.picks;
    topicNote = t.note;
  } else {
    const data = await progressContext(env.db, (env.run.inputs.deck_id as string | undefined) ?? "00000000-0000-0000-0000-000000000000", access.study.id);
    // Material handed over with a progress / topic-less request joins the study data as a source.
    brief = mats.length ? `${data.slice(0, 14_000)}\n\n${materialText(mats, SOURCE_CHARS - Math.min(data.length, 14_000) - 1_000)}` : data;
    research = { key: "research", role: "researcher", title: "整理研究進度資料", instructions: "讀研究摘要、階段、里程碑、待辦、最近筆記與會議回饋。", expected: "進度資料", done: { output: { summary: `研究資料 ${data.length} 字`, text: data } } };
  }
  await env.setState({ brief: brief.slice(0, 40_000) });
  // Names, training sentences and the figure list the content checks compare slides against.
  // (The material in full: names and numbers anywhere in it count as grounded, not only the part the brief kept.)
  await buildContentRefs(env, { brief, pdfKey: mode === "paper_report" && !abstractOnly ? paper!.pdf_key : null, extra: [paper?.title ?? "", access.study.title, ...mats.map((m) => m.text)] });

  // The deck's title before the outline (the outline must not repeat it as a cover page; `dropCoverPages`).
  const firstWords = b?.user_words.at(0) ?? env.run.request;
  const plain = topicTitleOf(firstWords);
  const subject = topic ? topicSubjectOf(firstWords) ?? (PAPER_REPORT_RE.test(plain) || /簡報|投影片|presentation|slides/i.test(plain) || plain.length > 60 ? "" : plain) : "";
  const topicTitle = topic ? subject || env.state<TopicState>("topic")?.title || access.study.title : material ? materialTitleOf(words, mats, access.study.title) : "";
  if (topic || material) await env.setState({ topic_title: topicTitle });
  const date = taipeiToday();
  const title = mode === "paper_report" ? `${paper!.title}` : topic || material ? topicTitle : progressTitle(access.study.title, date);
  await env.setState({ cover_title: title });

  const outlineStep = await planningStep(env, {
    key: "outline", role: "planner", title: `規劃 ${pages} 頁大綱`,
    instructions: `依研究摘要規劃正好 ${pages} 頁的簡報大綱（每頁標題 + 重點）。`,
    depends_on: ["research"],
    expected: `${pages} 頁大綱`,
    // Points of the planner's own pages may not be placeholders (student-owned pages are written as 「學生自填」).
    // The parts the user listed (「呈現 A、B、C」) each get a page already in the outline (requirements.ts `req_sections`).
    verify: { checks: [{ id: "slide_count", params: { expected: pages } }, { id: "no_placeholder", params: { on_slide: true } }, ...sectionChecks(env.requirements())], judge: false },
  }, (fix) => makeOutline(env, mode, pages, brief, fix), 2);
  let outline = await settleOutline(env, dropCoverPages((outlineStep.output.data as { outline?: SlideOutline[] } | undefined)?.outline ?? [], title).outline);
  if (!outline.length) throw new WorkflowInputError("無法產生簡報大綱，請稍後再試。");
  // No page count from the user: the working count follows the outline (a cover page the planner added was dropped).
  if (!Number(env.run.inputs.pages) && !requiredPages(env.requirements()) && outline.length !== pages) {
    pages = outline.length;
    await env.setState({ pages });
  }
  // Every paper read for a library survey is a source of the taxonomy page (so each is read and every family is tallied).
  if (topic && picks.length && env.state<TopicState>("topic")?.read_all) outline = withAllSources(outline, picks.length);

  const vision = await env.vision("slides");
  const owned = studentOwned(outline);
  // (No subject in the words — 「做一份論文報告簡報」 answered with 「不指定論文」 — the study's title; the topic comes from the
  // request's subject phrase, else the plain 「關於 X」 title, else the decomposition's title: computed before the outline.)
  const steps = [research, outlineStep.spec, ...laterSteps(outline, vision, picks)];
  const pagesUnset = !Number(env.run.inputs.pages) && !requiredPages(env.requirements());
  const usedIdx = picks.length ? usedPicks(outline, picks.length) : [];
  const imports = usedIdx.filter((i) => picks[i]!.kind === "online").length;
  const notes = [
    materialNote,
    topicNote,
    picks.length && usedIdx.length < picks.length ? `大綱沒有用到的 ${picks.length - usedIdx.length} 篇不匯入也不精讀：${picks.filter((_, i) => !usedIdx.includes(i)).map((p) => `〈${clipText(pickTitle(p), 50)}〉`).join("、")}。` : "",
    abstractOnly ? "這篇沒有全文 PDF：依你的選擇只用摘要，簡報標題與講稿會標示「僅依摘要」。" : "",
    pagesUnset ? `頁數：未指定，大綱暫定 ${pages} 頁（可在下方增刪頁面）。` : "",
    outline.length !== pages ? `大綱有 ${outline.length} 頁（要求 ${pages} 頁）；可在下方調整後再開始。` : "",
  ].filter(Boolean).join("\n") || undefined;
  const write = await plannedDeckWrite(env, access.study.id, title);
  const cover = await frontTitle(env, title);
  const matNames = mats.map((m) => `〈${clipText(m.title, 50)}〉`).join("、");
  const grounded = material
    ? `內容來自你提供的資料（${matNames}）與研究資料：名稱、數字與結論都找得到出處，沒有加入資料沒有的論文、方法或數字`
    : picks.length
    ? "內容只來自讀過的論文摘錄與研究資料：方法頁的架構、注入位置、需要訓練或只在推論與數字都有來源論文，「僅依摘要」的論文沒有寫方法細節或數字，沒有捏造"
    : "內容只來自研究文獻庫的論文（標題、年份、摘要）與研究筆記，提到的論文都在文獻庫裡，沒有捏造的數字或結論";
  return {
    kind: "plan",
    title: `${mode === "paper_report" ? (abstractOnly ? "論文報告（僅依摘要）" : "論文報告") : topic ? "主題" : material ? "用你的資料做的" : "進度報告"}簡報：${clipText(title, 60)}`,
    studyId: access.study.id,
    objective: `為〈${access.study.title}〉建立一份 ${pages} 頁的${mode === "paper_report" ? `論文報告簡報（〈${clipText(paper!.title, 80)}〉）` : topic ? `主題簡報（${clipText(topicTitle, 60)}）` : material ? `簡報（${clipText(topicTitle, 60)}；以你提供的${matNames}為主要材料）` : "進度報告簡報"}：依確認的大綱逐頁撰寫投影片與講稿，編譯成可預覽的草稿，並通過驗收。`,
    criteria: criteriaFor(pages, mode, owned, abstractOnly, outline.map((o) => o.title)).map((c) => ((topic || material) && c.id === "grounded" ? { ...c, text: grounded } : topic && c.id === "coverage" ? { ...c, text: "每頁都涵蓋大綱列出的重點，前後連貫，切合使用者要的主題" } : material && c.id === "coverage" ? { ...c, text: "每頁都涵蓋大綱列出的重點，前後連貫，以你提供的資料為主要內容，符合你要的報告形式" } : c)),
    plan: {
      summary: picks.length
        ? `${imports ? `匯入 ${imports} 篇、` : ""}共讀 ${usedIdx.length} 篇論文（每篇一個研究者從全文做結構化摘錄），依 ${pages} 頁大綱（做法分類、每個方法一頁含架構與注入位置、結果比較、綜合；下方可修改）逐頁撰寫，每頁只用它的來源論文；整合後編譯預覽${vision ? "、看截圖檢查版面" : ""}、補齊講稿，最後逐條驗收。`
        : `先讀${mode === "paper_report" ? "論文全文" : topic ? "研究文獻庫與筆記" : material ? `你提供的${matNames}（主要材料）與研究資料` : "研究資料"}並規劃 ${pages} 頁大綱（下方可修改），再逐頁撰寫投影片與講稿（每頁一個撰寫者、各自有長度預算與檢查）；整合後編譯預覽${vision ? "、看截圖檢查版面" : ""}、補齊講稿，最後逐條驗收。`,
      outline,
      // Importing papers is not a draft-only write: the plan waits for the user unless autopilot is on.
      writes: [write, ...(imports ? [{ kind: "paper", label: `匯入 ${imports} 篇論文到實驗室文獻庫並加入〈${clipText(access.study.title, 40)}〉（下載開放取用 PDF）` }] : [])],
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

/** The user's own words (Brief) — what added pages / edit kinds are read from, never the assistant's paraphrase. */
const userText = (env: WorkflowEnv) => (env.brief()?.user_words ?? [env.run.request, ...userGuidance(env.run)]).join("\n");

// Edit detection (REVISE_RE, EXPAND_RE, addedPages, editKindOf) is route.ts: the router decides edit vs new and revise vs expand.

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
async function settleOutline(env: WorkflowEnv, outline: SlideOutline[], original?: { title: string }[], cover = false): Promise<SlideOutline[]> {
  const reqs = env.requirements();
  let out = outline;
  const ex = reqs.find((r) => r.type === "exclude")?.params;
  // The user's page numbers count the cover (the player's numbering) when the deck has one.
  const byNumber = (n: number) => (original ? original[(contentPage(n, original.length, cover) ?? 0) - 1]?.title : undefined);
  if (ex) {
    const titles = [...(ex.terms ?? []).flatMap((t) => [t.name, ...(t.aliases ?? [])]), ...(ex.pages ?? []).map((n) => byNumber(n) ?? "").filter(Boolean)];
    const kept = out.filter((p) => !titles.some((t) => titleMatches(t, p.title)));
    if (kept.length && kept.length < out.length) {
      await env.note(`依你的要求刪掉：${out.filter((p) => !kept.includes(p)).map((p) => `「${p.title}」`).join("、")}。`);
      out = kept.map((p, i) => ({ ...p, n: i + 1 }));
    }
    // A removal by page number becomes a title the check can find.
    const named = (ex.pages ?? []).map(byNumber).filter((t): t is string => !!t);
    if (named.length) await setRequirement(env, "exclude", (p) => ({ ...p, terms: [...(p.terms ?? []), ...named.filter((t) => !(p.terms ?? []).some((x) => x.name === t)).map((name) => ({ name }))] }));
  }
  // The check finds an item's pages by their title: an item the title does not name is tracked under the page title.
  const named = (p: SlideOutline) => (!p.item ? null : p.title.toLowerCase().includes(p.item.toLowerCase()) || titleMatches(p.item, p.title) ? p.item : p.title);
  const items = [...new Set(out.map(named).filter((x): x is string => !!x))];
  if (perItem(reqs) && items.length) await setRequirement(env, "per_item_fields", (p) => ({ ...p, items: [...new Set([...(p.items ?? []), ...items])].slice(0, 16) }));
  return out;
}

async function setRequirement(env: WorkflowEnv, type: Requirement["type"], patch: (p: NonNullable<Requirement["params"]>) => Requirement["params"]) {
  const reqs = env.requirements().map((r) => (r.type === type ? { ...r, params: patch(r.params ?? {}) } : r));
  await env.setState({ requirements: reqs });
}


// ---------------------------------------------------------------- original pages preserved

/** The user's words free the deck's structure (pages may be merged / dropped) or only its order. */
const RESTRUCTURE_RE = /重新組織|重組|重新規劃|打掉重[做寫]|restructure|reorgani[sz]e|rework/i;
const REORDER_RE = /順序|重新排|排序|調換|對調|移到|移至|挪到|放到最?[前後]|reorder|re-order|swap|move\s/i;

/**
 * Which original pages an edit must keep: every page except the ones the user's words remove (exclude) and, in an
 * expansion, the ones they name to expand (「把『動態熱詞的做法』展開」: that page may become several new ones). Order is
 * kept unless the words ask to reorder; titles of kept pages are kept in an expansion that is not a translation. Null
 * when the words ask to restructure the deck (nothing to protect).
 */
type KeepRule = { originals: OriginalPage[]; ordered: boolean; translate: boolean; keepTitles: boolean; targets: string[] };
function keepRule(words: string, reqs: Requirement[], src: ReviseSource, kind: EditKind): KeepRule | null {
  if (RESTRUCTURE_RE.test(words)) return null;
  const ex = reqs.find((r) => r.type === "exclude")?.params;
  const removed = [...(ex?.terms ?? []).flatMap((t) => [t.name, ...(t.aliases ?? [])]), ...(ex?.pages ?? []).map((n) => src.slides[(contentPage(n, src.slides.length, src.cover) ?? 0) - 1]?.title ?? "")].filter(Boolean);
  const squash = (x: string) => x.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const said = squash(words);
  const targets = kind === "expand" ? src.slides.map((p) => p.title).filter((t) => squash(t).length >= 2 && said.includes(squash(t))) : [];
  const originals = src.slides
    .map((p, i) => ({ n: i + 1, title: p.title, text: slideText(p.raw) }))
    .filter((o) => o.title && !removed.some((t) => titleMatches(t, o.title)) && !targets.includes(o.title));
  if (!originals.length) return null;
  const lang = targetLanguage(reqs);
  const translate = !!lang && lang !== deckLanguage(src.slides.map((p) => p.raw).join("\n"));
  return { originals, ordered: !REORDER_RE.test(words), translate, keepTitles: kind === "expand" && !translate, targets };
}

/** A slide's visible text (title + body, no notes), clipped: the content signature the matcher compares. */
const slideText = (raw: string) => {
  const p = parseSlides(raw)[0];
  return clipText(p ? `${p.title}\n${p.body}` : raw, 1200);
};
const deckLanguage = (text: string): "zh" | "en" => ((text.match(/[\u3400-\u9fff]/g) ?? []).length > (text.match(/[A-Za-z]{2,}/g) ?? []).length ? "zh" : "en");

/** A kept page the plan dropped, back from the original: its title and bullet points. */
function restoredPage(o: OriginalPage, raw: string): SlideOutline {
  const body = parseSlides(raw)[0]?.body ?? "";
  const bullets = body.split("\n").map((l) => /^\s*[-*+]\s+(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x).map((x) => cleanPoint(x)).slice(0, 5);
  return { n: 0, title: o.title, points: bullets.length ? bullets : [`沿用原第 ${o.n} 頁的內容`], from: o.n };
}

/**
 * Deterministic repair of an edit's outline: every kept original carried by one page (`from` set), dropped ones put back
 * from the original, retitled ones (expansion) get their title back, and — unless the user asked to reorder — the
 * originals in their order with the new pages staying after the original they followed.
 */
function keepOriginals(outline: SlideOutline[], rule: KeepRule, raws: string[]): { outline: SlideOutline[]; restored: string[]; retitled: string[]; changed: boolean } {
  const match = matchOriginals(rule.originals, outline, { translate: rule.translate });
  const pivot = new Map<number, number>();
  match.at.forEach((j, i) => j !== null && pivot.set(j, i));
  const restored: string[] = [];
  const retitled: string[] = [];
  const carried = rule.originals.map((o, i) => {
    const j = match.at[i];
    if (j === null || j === undefined) {
      restored.push(o.title);
      return restoredPage(o, raws[o.n - 1] ?? "");
    }
    const p = outline[j]!;
    // Retitled without being split, or a merged title naming another original (「Idea card、下週與要問」).
    const merged = rule.originals.some((x) => x !== o && titleMatches(x.title, p.title));
    const rename = rule.keepTitles && ((match.by[i] !== "title" && !match.split[i] && !titleMatches(o.title, p.title)) || merged);
    if (rename && p.title !== o.title) retitled.push(`「${p.title}」→「${o.title}」`);
    return { ...p, ...(rename ? { title: o.title } : {}), from: o.n };
  });
  let out: SlideOutline[];
  if (rule.ordered) {
    const head: SlideOutline[] = [];
    const after = rule.originals.map(() => [] as SlideOutline[]);
    let anchor = -1;
    outline.forEach((p, j) => {
      const i = pivot.get(j);
      if (i !== undefined) anchor = i;
      else (anchor < 0 ? head : after[anchor]!).push(p);
    });
    out = [...head, ...carried.flatMap((p, i) => [p, ...after[i]!])];
  } else {
    // Reordering asked: the planner's order stands; a page put back goes after the previous original's page.
    out = outline.map((p, j) => (pivot.has(j) ? carried[pivot.get(j)!]! : p));
    rule.originals.forEach((_, i) => {
      if (match.at[i] !== null) return;
      const prev = i > 0 ? out.indexOf(carried[i - 1]!) : -1;
      out.splice(prev + 1, 0, carried[i]!);
    });
  }
  const changed = out.length !== outline.length || out.some((p, k) => p.title !== outline[k]?.title);
  return { outline: out.map((p, k) => ({ ...p, n: k + 1 })), restored, retitled, changed };
}

/** The outline step's output for an outline (the text the checks and the plan card read). */
const outlineOutput = (outline: SlideOutline[], summary = `${outline.length} 頁大綱`): StepOutput => ({ summary, text: outline.map((p) => `## ${p.title}\n${p.points.map((x) => `- ${x}`).join("\n")}`).join("\n\n"), data: { outline } });

/** The planner's rule for kept pages (outline prompts). */
function keepLine(rule: KeepRule | null, kind: EditKind): string {
  if (!rule) return "";
  const pages = rule.originals.map((o) => `第 ${o.n} 頁「${o.title}」`).join("、");
  return kind === "expand"
    ? `這些原本的頁面使用者沒有要求刪掉或改動，都要保留${rule.ordered ? "、順序不變" : ""}${rule.keepTitles ? "、標題照原文" : ""}：${pages}。可以把它們寫得更具體，也可以在前後插入新頁${rule.targets.length ? `；使用者要求展開的是${rule.targets.map((t) => `「${t}」`).join("、")}，這幾頁可以拆成多頁` : ""}。每頁的 from 寫出它改寫或展開自原本的第幾頁（新頁省略）。`
    : `原本的每一頁都要保留${rule.ordered ? "、順序不變" : ""}（使用者要求刪掉的除外）：${pages}。每頁的 from 寫出它改寫自原本的第幾頁。`;
}

/** `cover`: the deck opens with a title page from its front matter (the user's page numbers count it: 「第九頁」 = slides[7]). */
type ReviseSource = { deck: { id: string; title: string; kind: DeckMode; paper_id: string | null }; slides: { title: string; raw: string }[]; cover: boolean };

/**
 * The deck to revise and its slides in source form: the body the workflow that wrote it kept (chart specs, paper-fig
 * refs), else the deck's entry file. Null when this is not a revise request or the deck has no slides.
 */
async function reviseSource(env: WorkflowEnv, studyId: string): Promise<ReviseSource | null> {
  const id = env.run.inputs.deck_id as string | undefined;
  // Called only when the router decided this is an edit of the given deck.
  if (!id) return null;
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
  // Decks a workflow wrote always get a cover (draftQmd); a hand-made source has one when its front matter has a title.
  const cover = !!made || /^---\n[\s\S]*?^title:\s*\S/m.test(entry);
  return { deck: { id: deck.id, title: deck.title, kind: deck.kind === "paper_report" ? "paper_report" : "progress", paper_id: deck.paper_id }, slides, cover };
}

/**
 * Plan for editing an existing deck. `revise` (translate / polish): the same pages rewritten from the originals, nothing
 * dropped. `expand` (「再詳細一點」「focus 在…」「每個方法要有 Pros/Cons」): a new outline grounded in the deck, the study's
 * data and notes on the requested focus (and the paper), original figures reused where they fit.
 */
/** A writer step for a kept page: done at plan time with the original page (no model call). */
function keptWriter(st: StepSpec, outline: SlideOutline[], keptRaw: (from: number) => string | undefined): StepSpec {
  if (!st.key.startsWith("write_")) return st;
  const pages = outline.filter((o) => ((st.inputs?.pages as number[] | undefined) ?? []).includes(o.n));
  const raws = pages.map((o) => (o.from ? keptRaw(o.from) : undefined));
  if (!raws.length || raws.some((r) => r === undefined)) return st;
  const { verify: _v, ...rest } = st;
  return { ...rest, title: `沿用第 ${pages.map((o) => o.n).join("、")} 頁「${clipText(pages[0]!.title, 40)}」（沒有要求修改，原樣保留）`, done: { output: { summary: "沒有要求修改：原頁照原樣保留", text: raws.join("\n\n") } } };
}

/** The pages a page-scoped edit removes become (part of) the exclude requirement, checked on the deck. */
async function requireRemoval(env: WorkflowEnv, titles: string[]) {
  const reqs = env.requirements();
  if (reqs.some((r) => r.type === "exclude")) {
    await setRequirement(env, "exclude", (p) => ({ ...p, scope: p.scope ?? "page", terms: [...(p.terms ?? []), ...titles.filter((t) => !(p.terms ?? []).some((x) => titleMatches(x.name, t))).map((name) => ({ name }))] }));
    return;
  }
  const id = `r${Math.max(0, ...reqs.map((r) => Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0))) + 1}`;
  await env.setState({ requirements: [...reqs, { id, type: "exclude", text: `刪掉：${titles.map((t) => `「${t}」`).join("、")}`, params: { scope: "page", terms: titles.map((name) => ({ name })) }, source: "request" }] });
}

/** Criteria about the slides themselves: not a notes-only edit's to meet (the user's slides stay exactly as they are). */
const SLIDE_BODY_CRITERIA = new Set(["visual_qa", "visuals", "diagrams", "charts", "semantics", "figrefs", "names", "coverage"]);

async function revisePlan(env: WorkflowEnv, access: { study: { id: string; title: string } }, src: ReviseSource, routed?: EditKind, scope?: "notes"): Promise<import("./registry.js").PlanResult> {
  const mode = src.deck.kind;
  // The deck's paper backs figure crops and the content checks.
  if (src.deck.paper_id && !env.run.inputs.paper_id) {
    env.run.inputs.paper_id = src.deck.paper_id;
    await env.db.query("UPDATE workflow_runs SET inputs = inputs || jsonb_build_object('paper_id', $2::text) WHERE id=$1", [env.run.id, src.deck.paper_id]);
  }
  const paper = await paperOf(env);
  // Revise vs expand: the router's decision (the user's words + requirements against the deck's pages).
  // Only the speaker notes asked for (「把講稿改成中文」「從講稿拿掉引用」): same pages, every slide body kept as it is.
  const notesOnly = scope === "notes";
  const kind = notesOnly ? "revise" : routed ?? editKindOf(userText(env), env.requirements(), src.slides.length);
  // The deck's built-in labels (AI-filled marks, 「這頁留給你自己寫」, 「由報告者補充」 on student pages) in the target
  // language before any writer sees them: writers keep such lines verbatim otherwise. (Not on a notes-only edit: the
  // slides stay exactly as they are.)
  const lang = targetLanguage(env.requirements());
  // Only the pages the words name (「把第九頁刪掉」「第三頁的標題改成…」): every other page stays exactly as it is — no
  // writer, no screenshot pass, no requirement rewrite (production 12e713d3: one deleted page rewrote all ten).
  const pageEdit = kind === "revise" ? pageScope(userText(env), env.requirements(), src.slides.map((p) => p.title), src.cover) : null;
  const keptIdx = new Set(pageEdit ? src.slides.map((_, i) => i + 1).filter((i) => !pageEdit.removed.includes(i) && !pageEdit.touched.includes(i)) : []);
  const kept = src.slides.filter((_, i) => keptIdx.has(i + 1)).map((p) => p.raw);
  if (pageEdit?.removed.length) await requireRemoval(env, pageEdit.removed.map((i) => src.slides[i - 1]!.title));
  // A page list the words fix (notes only, or removals only): no planner call.
  const fixedOutline = notesOnly || (!!pageEdit && !pageEdit.touched.length);
  if (!notesOnly) src = { ...src, slides: src.slides.map((p, i) => (keptIdx.has(i + 1) ? p : { ...p, raw: localizeLabels(p.raw, lang) })) };
  const original = src.slides.map((p, i) => `<!-- 第 ${i + 1} 頁 -->\n${p.raw}`).join("\n\n");
  // Expanding needs more than the deck: the study's data, notes about the requested focus, the paper's text.
  const extra = kind === "expand" ? await expandSources(env, access.study.id, paper?.pdf_key ?? null) : "";
  const brief = kind === "expand" ? `# 原本的簡報（素材：可以沿用其中的圖、圖表、論文圖與數字）\n\n${original.slice(0, 20_000)}\n\n${extra}` : original;
  await env.setState({ mode, revise: true, edit_kind: kind, notes_only: notesOnly, kept_pages: kept, removed_pages: (pageEdit?.removed ?? []).map((i) => src.slides[i - 1]!.title), original_slides: src.slides.map((p) => p.raw), brief: brief.slice(0, 40_000) });
  await buildContentRefs(env, { brief, pdfKey: mode === "paper_report" ? paper?.pdf_key ?? null : null, extra: [paper?.title ?? "", access.study.title] });
  const research: StepSpec = kind === "expand"
    ? { key: "research", role: "researcher", title: "讀取現有簡報與研究資料", instructions: "讀出這份簡報每一頁的原始內容，加上研究進度、和要求焦點相關的筆記與論文內容。", expected: "原始投影片 + 研究資料", done: { output: { summary: `現有簡報 ${src.slides.length} 頁 + 研究資料 ${extra.length} 字`, text: brief.slice(0, 60_000) } } }
    : { key: "research", role: "researcher", title: "讀取現有簡報", instructions: "讀出這份簡報目前每一頁的原始內容（含圖表語法與講稿）。", expected: "原始投影片", done: { output: { summary: `現有簡報 ${src.slides.length} 頁`, text: original } } };
  // 「加上一頁…」: exactly the deck's pages + the added ones (not the generic expansion size).
  const added = addedPages(userText(env));
  const want = kind === "expand" ? Math.min(30, Math.max(3, Number(env.run.inputs.pages) || requiredPages(env.requirements()) || (added ? src.slides.length + added : Math.max(src.slides.length + 2, Math.round(src.slides.length * 1.5))))) : null;
  // Original pages the user did not ask to remove / expand / reorder stay (checked on the outline and on the deck).
  const keep = keepRule(userText(env), env.requirements(), src, kind);
  const keptCheck: CheckSpec[] = keep ? [{ id: "pages_kept", params: { originals: keep.originals, ordered: keep.ordered, translate: keep.translate, keep_titles: keep.keepTitles } }] : [];
  const outlineChecks = (n: number | null): CheckSpec[] => [...(kind === "expand" ? [{ id: "slide_count", params: { expected: n } }, { id: "no_placeholder", params: { on_slide: true } }] : [{ id: "min_length", params: { chars: 20 } }]), ...keptCheck];
  const raws = src.slides.map((p) => p.raw);
  const outlineStep = await planningStep(env, {
    key: "outline", role: "planner", title: kind === "expand" ? `規劃擴充後的 ${want} 頁大綱` : "規劃修改後的每一頁",
    instructions: kind === "expand" ? `依使用者的要求重新規劃正好 ${want} 頁的大綱：深入要求的焦點，內容來自原簡報與研究資料；沒有要求改動的原頁保留。` : "依使用者的修改要求，列出修改後每一頁的標題與重點（頁數與順序照原本，除非使用者要求改變）。",
    depends_on: ["research"],
    expected: kind === "expand" ? `${want} 頁大綱` : `${src.slides.length} 頁大綱`,
    verify: { checks: outlineChecks(want), judge: false },
  }, (fix) => (fixedOutline ? Promise.resolve(outlineOutput(src.slides.map((p, i) => ({ p, i })).filter(({ i }) => !pageEdit?.removed.includes(i + 1)).map(({ p, i }, k) => ({ ...restoredPage({ n: i + 1, title: p.title, text: "" }, p.raw), n: k + 1 })))) : kind === "expand" ? expandOutline(env, src, brief, want!, fix, keep) : reviseOutline(env, src, fix, keep)), fixedOutline ? 0 : 2, async (out, round) => {
    // After the planner's own fix round, kept pages it still dropped / moved / retitled are put back deterministically.
    const planned = (out.data as { outline?: SlideOutline[] } | undefined)?.outline;
    if (!keep || round < 1) return null;
    // The planner never produced an outline (staging: a cheap model spent every budget thinking): the deck's own pages
    // (minus removed ones) are the outline, so the edit still runs instead of failing the run.
    const all = !planned?.length && round >= 2 ? keepRule(userText(env), env.requirements(), src, "revise") : null;
    if (all) {
      const r = keepOriginals([], all, raws);
      await env.note(`沒有規劃出新的大綱，改照原本的 ${r.outline.length} 頁${kind === "expand" ? "逐頁擴充" : "修改"}。`);
      return { output: outlineOutput(r.outline), verify: kind === "expand" ? { checks: outlineChecks(r.outline.length), judge: false } : undefined };
    }
    if (!planned?.length) return null;
    const r = keepOriginals(planned, keep, raws);
    if (!r.changed && !r.retitled.length) return null;
    await env.note(`大綱保留原本的頁面：${[r.restored.length ? `放回 ${r.restored.map((t) => `「${t}」`).join("、")}` : "", r.retitled.length ? `標題改回 ${r.retitled.join("、")}` : "", !r.restored.length && !r.retitled.length ? "順序改回原本的順序" : ""].filter(Boolean).join("；")}。`);
    return { output: outlineOutput(r.outline), verify: kind === "expand" ? { checks: outlineChecks(r.outline.length), judge: false } : undefined };
  });
  const settled = await settleOutline(env, ((outlineStep.output.data as { outline?: SlideOutline[] } | undefined)?.outline ?? []), src.slides, src.cover);
  if (!settled.length) throw new WorkflowInputError("無法規劃修改後的簡報，請稍後再試。");
  // Each page knows the original it rewrites (writers read that page; a removal no longer shifts the mapping).
  const carried = keep ? matchOriginals(keep.originals, settled, { translate: keep.translate }) : null;
  const outline = settled.map((p, j) => {
    const i = carried?.at.indexOf(j) ?? -1;
    const from = i >= 0 ? keep!.originals[i]!.n : p.from && p.from <= src.slides.length ? p.from : kind === "revise" && settled.length === src.slides.length ? j + 1 : undefined;
    const { from: _drop, ...rest } = p;
    // A kept page keeps its own title (the planner may not retitle a page the user did not ask to change).
    return from ? { ...rest, ...(keptIdx.has(from) ? { title: src.slides[from - 1]!.title } : {}), from } : rest;
  });
  const keptTitles = carried ? carried.at.filter((j): j is number => j !== null).map((j) => outline[j]!.title) : [];
  const vision = await env.vision("slides");
  // Pages whose original speaker notes were already short (e.g. the student's own pages) are not required to grow notes.
  const origOf = (o: SlideOutline) => (o.from ? src.slides[o.from - 1]?.raw ?? "" : "");
  const shortNotes = kind === "revise" ? outline.filter((o) => (parseSlides(origOf(o))[0]?.notes ?? "").replace(/\s+/g, "").length < 30 || STUDENT_NOTE_RE.test(origOf(o))).map((o) => o.title) : [];
  // …nor (writers included) are pages that were left for the student to write (their placeholder stays, in the target language).
  const leftOpen = kind === "revise" ? outline.filter((o) => PLACEHOLDER_RE.test(origOf(o)) || /Left for you to write/.test(origOf(o))).map((o) => o.title) : [];
  // Kept pages are the user's as they are: no notes / placeholder / layout demands on them.
  const keptTitles0 = outline.filter((o) => keptIdx.has((o as SlideOutline).from ?? 0)).map((o) => o.title);
  shortNotes.push(...keptTitles0.filter((t) => !shortNotes.includes(t)));
  leftOpen.push(...keptTitles0.filter((t) => !leftOpen.includes(t)));
  const allow = (c: CheckSpec, extra: string[]) => (extra.length ? { ...c, params: { ...(c.params ?? {}), allow_titles: [...new Set([...((c.params?.allow_titles as string[] | undefined) ?? []), ...extra])] } } : c);
  // A notes-only edit has no screenshot pass: the slides are the user's, unchanged (a layout defect already on a page is
  // not this request's to fix — production 79ab: a notes rewrite ended 「partial」 for page 3's own layout).
  const noShots = notesOnly || (!!pageEdit && !pageEdit.touched.length);
  const later = (noShots
    ? laterSteps(outline, false).filter((st) => st.key !== "visual_qa").map((st) => (st.depends_on?.includes("visual_qa") ? { ...st, depends_on: st.depends_on.map((d) => (d === "visual_qa" ? "constraints" : d)) } : st))
    : laterSteps(outline, vision)).map((st) => keptWriter(st, outline, (n) => (keptIdx.has(n) ? src.slides[n - 1]!.raw : undefined)));
  const steps = [research, outlineStep.spec, ...later].map((st) =>
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
      : notesOnly
      ? `依使用者的要求修改簡報〈${clipText(src.deck.title, 80)}〉的講稿：${clipText(env.run.request, 200)}。只改每一頁的講稿（speaker notes），投影片本體（標題、文字、圖、圖表、出處）一字不改，編譯成可預覽的草稿。`
      : `依使用者的要求修改簡報〈${clipText(src.deck.title, 80)}〉：${clipText(env.run.request, 200)}。保留原本的頁面結構、圖、圖表、公式與出處，只改要求的部分，編譯成可預覽的草稿。`,
    criteria: [
      // (An existing deck's own first page is the user's: no cover-repeat rule on an edit.)
      ...criteriaFor(outline.length, mode, [], false, outline.map((o) => o.title)).filter((c) => !((notesOnly || pageEdit) && SLIDE_BODY_CRITERIA.has(c.id) && !(c.id === "visual_qa" && !noShots))).map((c) => (c.id === "pages" ? { ...c, text: `簡報正好 ${outline.length} 頁，頁面順序與確認的大綱一致`, check: { id: "slide_count", params: { ...(c.check!.params ?? {}), no_cover_repeat: false } } } : c)).map((c) => (c.id === "notes" && shortNotes.length ? { ...c, text: `${c.text}（原本講稿就很短的頁面除外：${shortNotes.map((t) => `「${t}」`).join("、")}）`, check: { id: "speaker_notes", params: { min_chars: 30, allow_titles: shortNotes } } } : c.id === "clean" && leftOpen.length ? { ...c, text: `${c.text}（留給報告者自己寫的頁面除外：${leftOpen.map((t) => `「${t}」`).join("、")}）`, check: { id: "no_placeholder", params: { allow_titles: leftOpen, on_slide: true } } } : c)),
      kind === "expand"
        ? { id: "expanded", kind: "judge" as const, text: `依要求擴充（${clipText(env.run.request, 120)}）：要求的焦點講得夠深入（每頁有具體的機制、例子或數字），內容都來自原簡報、研究資料或論文，沒有捏造` }
        : pageEdit
        ? { id: "revised", kind: "judge" as const, text: `只照使用者的要求（${clipText(env.run.request, 120)}）${[pageEdit.removed.length ? `刪掉${pageEdit.removed.map((i) => `「${src.slides[i - 1]!.title}」`).join("、")}` : "", pageEdit.touched.length ? `修改${pageEdit.touched.map((i) => `「${src.slides[i - 1]!.title}」`).join("、")}${notesOnly ? "的講稿" : ""}` : ""].filter(Boolean).join("，")}；其他頁面由系統保留原樣，不在這次修改範圍` }
        : notesOnly
        ? { id: "revised", kind: "judge" as const, text: `每一頁的講稿都照使用者的要求修改（${clipText(env.run.request, 120)}），沒有遺漏頁面或講稿；投影片本體由系統保留原樣，不在這次修改範圍` }
        : { id: "revised", kind: "judge" as const, text: `每一頁都照使用者的要求修改（${clipText(env.run.request, 120)}），沒有遺漏頁面或講稿${removed ? "（使用者要求刪掉的頁面除外）" : ""}，也沒有改掉原本的數字、圖與出處` },
      ...(keptTitles.length ? [{ id: "kept", kind: "check" as const, text: `原本的頁面都保留${keep!.ordered ? "且順序不變" : ""}（使用者要求刪掉${kind === "expand" ? "或展開" : ""}的除外）：${clipText(keptTitles.map((t) => `「${t}」`).join(""), 240)}`, check: { id: "pages_kept", params: { titles: keptTitles, ordered: keep!.ordered } } }] : []),
    ],
    plan: {
      summary: kind === "expand"
        ? `讀取現有 ${src.slides.length} 頁與研究資料，重新規劃 ${outline.length} 頁大綱（下方可修改），由 ${Math.ceil(outline.length / PAGES_PER_WRITER)} 個撰寫者平行撰寫，整合後逐條檢查你的要求、編譯預覽${vision ? "、看截圖檢查版面" : ""}並驗收。`
        : pageEdit
        ? `讀取現有 ${src.slides.length} 頁，${[pageEdit.removed.length ? `刪掉${pageEdit.removed.map((i) => `「${src.slides[i - 1]!.title}」`).join("、")}` : "", pageEdit.touched.length ? `只改寫${pageEdit.touched.map((i) => `「${src.slides[i - 1]!.title}」`).join("、")}${notesOnly ? "的講稿" : ""}` : ""].filter(Boolean).join("，")}；其他 ${keptIdx.size} 頁原封不動（不重寫${noShots ? "、不重新截圖" : ""}），整合後${pageEdit.touched.length ? "逐條檢查你的要求、" : ""}編譯預覽${!noShots && vision ? "、看改過的頁面截圖" : ""}並驗收。`
        : notesOnly
        ? `讀取現有 ${src.slides.length} 頁，由 ${Math.ceil(outline.length / PAGES_PER_WRITER)} 個撰寫者平行改寫每一頁的講稿（投影片本體不動），整合後逐條檢查你的要求、編譯預覽並驗收。`
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

async function expandOutline(env: WorkflowEnv, src: ReviseSource, brief: string, pages: number, fix: { previous: StepOutput; issues: string[] } | null, keep: KeepRule | null = null): Promise<StepOutput> {
  const user = [
    LABHUB_RULES[src.deck.kind],
    `使用者要把現有的 ${src.slides.length} 頁簡報擴充成更深入的版本：${env.run.request}`,
    env.guidanceText(),
    addedPages(userText(env))
      ? `使用者要「新增」頁面：原本的 ${src.slides.length} 頁都要保留（主題不變，可以改寫得更具體），另外新增使用者描述的頁面，總共 ${pages} 頁。不要把新頁的內容併進舊頁，也不要拿掉舊頁。`
      : "",
    `規劃正好 ${pages} 頁的新大綱：可以重新組織、拆頁或加頁，深入使用者要求的焦點；每頁 2–5 個具體重點（機制、例子、數字，數字要標出處），內容只能來自原簡報與研究資料，不要編造。原本的圖、圖表、論文圖適合的就沿用（重點中寫「沿用原第 k 頁的圖」）。`,
    itemRule(env.requirements()),
    keepLine(keep, "expand"),
    dataBlock("sources", brief.slice(0, 36_000)),
    fix ? `上一版大綱的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    `每頁從版型庫挑一個 layout（只寫代號）：${layoutList(src.deck.kind === "paper_report")}；沿用原頁的圖時用原本的版型。不要寫位置、座標或尺寸。`,
    `只輸出 JSON：{"pages":[{"title":"頁面標題","purpose":"這頁的目的（一句）","points":["重點"],"layout":"A"${perItem(env.requirements()) ? ',"item":"這頁介紹的項目名稱（沒有就省略）"' : ""},"from":2}]}，pages 正好 ${pages} 個；from 是這頁改寫或展開自原本的第幾頁（新頁省略）。`,
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 14_000 }, isOutline);
  const pagesJson = value?.pages ?? outlineFromText(text);
  if (!pagesJson.length) return { summary: "大綱不是有效的 JSON", text: "", data: { outline: [], raw: text.slice(0, 2000) } };
  // A page title appears once (production: the expanded outline repeated 「Table 1 現況」「對帳」… → 22 pages for 12).
  const outline = dedupeOutline(toOutline(pagesJson, true));
  return outlineOutput(outline);
}

async function reviseOutline(env: WorkflowEnv, src: ReviseSource, fix: { previous: StepOutput; issues: string[] } | null, keep: KeepRule | null = null): Promise<StepOutput> {
  const user = [
    `使用者對這份簡報的修改要求：${env.run.request}`,
    env.guidanceText(),
    `現有簡報有 ${src.slides.length} 頁。列出修改後每一頁的標題與 2–5 個重點：頁數與順序照原本（除非要求改變），內容照要求修改（例如翻譯就把標題與重點都翻成要求的語言），不要新增原本沒有的事實或數字。`,
    keepLine(keep, "revise"),
    dataBlock("original_slides", src.slides.map((p, i) => `<!-- 第 ${i + 1} 頁 -->\n${p.raw}`).join("\n\n").slice(0, 40_000)),
    fix ? `上一版的問題：\n${fix.issues.map((i) => `- ${i}`).join("\n")}` : "",
    '只輸出 JSON：{"pages":[{"title":"頁面標題","points":["重點"],"student_owned":false,"from":1}]}（from = 這頁改寫自原本的第幾頁）',
  ].filter(Boolean).join("\n\n");
  const { value, text } = await env.callJson<OutlineJson>({ purpose: "outline", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 14_000 }, isOutline);
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
    if (deck && deck.study_id === studyId && writesInto(env, tree)) {
      const untouched = !tree || tree.revision <= 1;
      return { kind: "deck", label: untouched ? `簡報〈${clipText(deck.title, 60)}〉（還沒有內容的範本，寫入草稿，不會發布版本）` : `覆寫簡報〈${clipText(deck.title, 60)}〉的原始檔（新的修訂，不會發布版本）`, effect: untouched ? "draft_own" : "overwrite" };
    }
    return { kind: "deck", label: `新簡報「${clipText(title, 60)}（Agent 草稿）」（不會動到原本的簡報，不會發布版本）`, effect: "new" };
  }
  return { kind: "deck", label: `新簡報「${clipText(title, 60)}」（草稿，不會發布版本）`, effect: "new" };
}

/**
 * The given deck is written into only when it is an untouched template, or an AI draft this run edits. A run making a
 * new deck never writes over a deck that has content, AI-made or not (production 79ab: a notes request routed as a new
 * progress report replaced the user's deck); it gets its own 「Agent 草稿」 deck.
 */
function writesInto(env: WorkflowEnv, tree: { origin: string; revision: number } | null): boolean {
  return !tree || tree.revision <= 1 || (tree.origin === "ai" && !!env.state<boolean>("revise"));
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
    // Only an untouched template or an AI draft this run edits is written into (writesInto); otherwise a new deck.
    if (deck && deck.study_id === access.study.id && writesInto(env, tree)) {
      const s: DeckState = { deck_id: deck.id, deck_slug: deck.slug, deck_title: deck.title };
      await env.setState({ deck: s });
      return s as DeckState & { deck_id: string };
    }
  }
  // A revision of a deck the user edited keeps that deck's name (in the target language), not a fresh template title.
  const edited = want && env.state<boolean>("revise") ? (await env.db.query<{ title: string }>("SELECT title FROM decks WHERE id=$1", [want])).rows[0]?.title : undefined;
  const baseTitle = await frontTitle(env, edited ?? (mode === "paper_report" ? (paper?.title ?? "論文報告") : env.state<string>("topic_title") || progressTitle(access.study.title, date)));
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
  // A notes-only edit never changes a slide: whatever a writer or a fix round produced, each page is its original with
  // the new notes (production 79ab: 「只改講稿」 runs rewrote titles and turned a diagram into a bar chart).
  const originals = env.state<boolean>("notes_only") ? env.state<string[]>("original_slides") : null;
  if (originals?.length) body = keepSlideBodies(body, originals);
  // A page-scoped edit: the pages the user did not name are their originals, byte for byte (production 12e713d3).
  body = keepPages(body, env.state<string[]>("kept_pages") ?? []);
  // Placeholders a writer kept after its fix rounds never reach the deck (the student's own pages keep theirs).
  const scrub = scrubPlaceholders(body, outlineOf(env).filter((p) => p.student_owned).map((p) => p.title));
  if (scrub.removed) {
    body = scrub.body;
    await env.note(`移除 ${scrub.removed} 處沒填的佔位文字：${scrub.pages.slice(0, 4).map((t) => `「${t}」`).join("、")}`, "warn");
  }
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
  // Generated files the new entry no longer uses go (an earlier revision's diagrams / charts / figure crops).
  await pruneGeneratedFiles(env, deck.deck_id, qmd).catch((e) => env.deps.log.warn({ err: e, workflowId: env.run.id }, "deck file prune failed"));
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
  ...(s.qa ? { visualQa: { failed: s.qa.failed, soft: s.qa.soft ?? [], scored: s.qa.scores.length, vision: s.qa.vision, round: s.qa.round, ...(s.qa.unseen ? { unseen: true } : {}) } } : {}),
});

// ---------------------------------------------------------------- step execution

/**
 * Positions are never the model's: Quarto absolute placement (`.absolute`, `top=` / `left=` …) and inline position / size
 * styles are removed from a writer's page; the layout library and the fit variants (visual QA) place everything.
 */
export function stripPositions(body: string): string {
  return body
    .replace(/\{([^{}\n]*)\}/g, (m, inner: string) => {
      if (!/\.absolute|\b(?:top|left|right|bottom)\s*=|style\s*=\s*"[^"]*(?:position|top|left|right|bottom|margin)\s*:/i.test(inner)) return m;
      const kept = inner.replace(/\.absolute\b/g, "").replace(/\b(?:top|left|right|bottom)\s*=\s*("[^"]*"|\S+)/gi, "").replace(/style\s*=\s*"[^"]*"/gi, "").replace(/\s+/g, " ").trim();
      return kept ? `{${kept}}` : "";
    })
    .replace(/(<[a-z][^>]*?)\sstyle\s*=\s*"[^"]*(?:position|top|left)\s*:[^"]*"/gi, "$1")
    // Hand-shrunk text is below the 16 px floor on the slide (eval deck_expand_fields_zh: a 15.6 px `<small>` citation
    // failed the page twice as 「字太小」): the layout's own sizes (and the fit variants) decide.
    .replace(/<\/?small>/gi, "")
    .replace(/(<[a-z][^>]*?\sstyle\s*=\s*")([^"]*)"/gi, (_m, head: string, css: string) => `${head}${css.replace(/font-size\s*:[^;"]*;?/gi, "")}"`)
    .replace(/\[([^\]\n]*)\]\{\s*\.(?:small|tiny)\s*\}/g, "$1");
}

/** The page outline as a writer sees it: its own unit in full, the deck's other pages by title. */
const deckOutlineText = (outline: SlideOutline[], own: number[]) => outline.map((p) => (own.includes(p.n) ? outlineText([p]) : `${p.n}. ${p.title}`)).join("\n");

async function writeSection(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  const outline = outlineOf(env);
  const nums = (step.inputs.pages as number[] | undefined) ?? [];
  const pages = outline.filter((p) => nums.includes(p.n));
  // A page the user did not ask to change (page-scoped edit): its original, no model call — also on a repair round.
  const kept = pages.map((p) => keptPage(env.state<string[]>("kept_pages"), p.title));
  if (pages.length && kept.every((k) => k !== undefined)) return { summary: "沒有要求修改：原頁照原樣保留", text: kept.join("\n\n") };
  const mode = modeOf(env);
  const brief = isTopicDeck(env) && env.state<TopicState>("topic")?.picks.length ? await topicPageBrief(env, pages) : isMaterialDeck(env) ? await materialPageBrief(env, pages) : env.state<string>("brief") ?? "";
  const layoutRule = pages.map((p) => (p.layout ? `第 ${p.n} 頁用版型 ${p.layout}（${LAYOUTS[p.layout]}）。` : "")).filter(Boolean).join("");
  const format = [
    `只輸出第 ${nums[0]}${nums.length > 1 ? `–${nums.at(-1)}` : ""} 頁（共 ${pages.length} 頁），依序每頁：`,
    "`## 頁面標題`（標題照大綱逐字）→ 投影片內容（依視覺規則與指定的版型：圖／圖表／論文圖／表格 + 最多 4 個精簡條列）→ `::: {.notes}` 講稿（3–6 句，細節與數字都放這裡）`:::`。",
    layoutRule,
    `長度預算（每頁）：投影片上最多 ${PAGE_BUDGET.bullets} 個條列、約 ${PAGE_BUDGET.words} 個字詞以內（中文字算半個）；講稿 3–6 句。`,
    "不要寫位置、座標、尺寸或 style（不要 .absolute、top=、left=、width=、position）：版面由版型決定，放不下時系統會自動縮放。",
    "不要 YAML front matter、不要 ``` 包住整段、不要寫其他頁、不要任何說明文字。",
    `範本裡的〔　〕槽位都要換成依據資料的內容：能從資料算出來的就算出來（今天是 ${taipeiToday()}；例如「距上次新數字：N 週」＝今天減去最近一次出現新實驗數字的日期）；資料真的沒有就刪掉那一行或那一段。投影片和講稿都不要留〔〕、「待補」，也不要在講稿解釋為什麼留空。`,
    pages.some((p) => p.student_owned) ? `學生自填頁（${pages.filter((p) => p.student_owned).map((p) => `「${p.title}」`).join("、")}）只放標題與「${runLabels(env).skipped}」，講稿寫「${runLabels(env).skippedNote}」。` : "",
  ].filter(Boolean).join("\n");
  const original = env.state<string[]>("original_slides");
  const expand = env.state<EditKind>("edit_kind") === "expand";
  // The original page each planned page rewrites (`from`; older plans without it: the same position).
  const fromOf = (p: SlideOutline) => (p.from ?? (expand ? 0 : p.n));
  const carried = original && expand ? pages.filter((p) => p.from && original[p.from - 1]) : [];
  // Neighbouring pages (their text once written): the page continues the line of the deck without writing the others.
  const i0 = outline.findIndex((p) => p.n === nums[0]);
  const all = await getSteps(env.db, env.run.id);
  const written = outline.map((p) => all.find((x) => x.key === `write_${p.n}`)?.output?.text);
  const neighbours = i0 >= 0 ? neighbourBlock(outline.map((p) => ({ title: p.title, purpose: p.purpose, points: p.points })), i0, written) : "";
  const user = taskPrompt(env, step, {
    context: original && expand
      ? {
          // Expanding: the new outline is the plan; the original deck and the study's sources are the material.
          request: `${requestLine(env)}\n依新的大綱寫出這幾頁，深入要求的焦點；原本的簡報是素材（適合的圖、圖表規格、paper-fig 語法、數字與出處照原文沿用），其他內容只能來自研究資料，不要編造。`,
          format_rules: `${deckRules(env, mode)}\n\n${VISUAL_RULES}`,
          full_outline: deckOutlineText(outline, nums),
          your_pages: outlineText(pages),
          ...(neighbours ? { neighbours } : {}),
          // A page that keeps an original page: written from that page (title, figures, numbers kept), made more specific.
          ...(carried.length ? { original_pages: `${carried.map((p) => `第 ${p.n} 頁改寫自原本的第 ${p.from} 頁：以原頁為基礎（標題照大綱、原頁的圖、表、數字與出處保留），依要求寫得更具體。`).join("\n")}\n\n${carried.map((p) => `<!-- 原第 ${p.from} 頁 -->\n${original![p.from! - 1]}`).join("\n\n")}` } : {}),
          research: brief.slice(0, SOURCE_CHARS),
        }
      : original
      ? {
          // Revising an existing deck: rewrite these pages from their originals, changing only what the user asked.
          request: env.state<boolean>("notes_only")
            ? `使用者的修改要求：${env.run.request}\n這次只改講稿（::: {.notes} 裡的文字）：投影片本體（標題、條列、圖、圖表、表格、出處）逐字照原頁輸出，系統也會把本體還原成原頁。`
            : `使用者的修改要求：${env.run.request}\n只照這個要求修改；保留原本的版型、圖、圖表（\`\`\`chart / diagram 規格）、論文圖（paper-fig 語法）、公式、表格、數字與出處，講稿一起修改。`,
          your_pages: outlineText(pages),
          original_pages: pages.map((p) => `<!-- 第 ${p.n} 頁 -->\n${original[fromOf(p) - 1] ?? ""}`).join("\n\n"),
          format_rules: VISUAL_RULES,
        }
      : {
          format_rules: `${deckRules(env, mode)}\n\n${VISUAL_RULES}`,
          full_outline: deckOutlineText(outline, nums),
          your_pages: outlineText(pages),
          ...(neighbours ? { neighbours } : {}),
          research: brief.slice(0, SOURCE_CHARS),
        },
    format,
  }, fix);
  // One page = one unit: a reply cut at the output limit (or with an open block) is continued / regenerated for this page only.
  const res = await generateUnit(env, { purpose: "write_slides", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: pages.length > 1 ? WRITER_TOKENS : PAGE_TOKENS }, step.id, { complete: (t) => !unbalanced(t).length });
  const refs = contentRefsOf(env, pages);
  // Deterministic content fixes first (figure refs → the measured list, unfounded markers, peer chains → grid, no positions).
  let draft = outlineHeadings(stripPositions(normalizeDiagrams(localizeLabels(cleanBody(res.text) ?? res.text, targetLanguage(env.requirements())))), pages.map((p) => p.title));
  // Revising: a page the student left for themselves stays theirs (only its prompt changes language), never AI-written.
  if (original && env.state<EditKind>("edit_kind") !== "expand") {
    const L = runLabels(env);
    const open = pages.map((p, i) => ({ p, i })).filter(({ p }) => /Left for you to write/.test(localizeLabels(original[fromOf(p) - 1] ?? "", "en")));
    if (open.length && parseSlides(draft).length === pages.length) {
      const { pre, chunks } = splitChunks(draft);
      for (const { p, i } of open) chunks[i] = `## ${p.title}\n\n${L.skipped}\n\n::: {.notes}\n${L.skippedNote}\n:::\n\n`;
      draft = `${pre}${chunks.join("")}`;
    }
  }
  const { body, fixed } = fixContent(draft, refs);
  const n = parseSlides(body).length;
  const cut = res.continued ? `（被截斷，接續寫完 ${res.continued} 次）` : "";
  await env.activity(step.key, "writer", `寫好 ${n} 頁${cut}${res.regenerated ? "（重寫精簡版）" : ""}${res.truncated ? "（輸出仍被截斷）" : ""}${fixed ? `，自動修正 ${fixed} 處圖號或圖的語意` : ""}`);
  return { summary: `寫了 ${n} 頁（${body.length} 字）${cut}${res.truncated ? "，輸出仍被截斷" : ""}`, text: body, data: { stop: res.stopReason, refs, continued: res.continued, regenerated: res.regenerated } };
}

/**
 * A writer's pages carry the outline's titles verbatim: when it wrote exactly its pages, each `## ` heading is set to
 * the outline title in order (eval deck_followup_expand: the writer of an English deck titled its page in Chinese,
 * the page check failed after its fix round and the run ended partial although a later step fixed the page).
 */
export function outlineHeadings(text: string, titles: string[]): string {
  const { pre, chunks } = splitChunks(text);
  if (chunks.length !== titles.length) return text;
  return `${pre}${chunks.map((c, i) => c.replace(/^## [^\n]*/, `## ${titles[i]}`)).join("")}`;
}

async function assembledBody(env: WorkflowEnv): Promise<string> {
  const all = await getSteps(env.db, env.run.id);
  const writes = all.filter((s) => s.key.startsWith("write_") && s.output?.text).sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6)));
  const body = closeOpenBlocks(`${writes.map((w) => (cleanBody(w.output!.text!) ?? w.output!.text!).trim()).join("\n\n")}\n`);
  // Student-owned pages carry the student's own answers (student-input.ts).
  const out = fixContent(applyStudentPages(body, await studentPagesOf(env), runLabels(env)), contentRefsOf(env, outlineOf(env))).body;
  // Topic decks: every page names the papers it rests on (deterministic source tracing).
  const picks = isTopicDeck(env) ? env.state<TopicState>("topic")?.picks ?? [] : [];
  if (!picks.length) return out;
  const papers = await readPapers(env);
  const label = (ref: string) => {
    const k = paperKeyOf(ref, picks.length);
    const p = k ? papers.get(k) : undefined;
    return p ? `${shortTitle(p.title)} (${p.year ?? "n.d."})` : null;
  };
  return withSourceLines(out, outlineOf(env), label, targetLanguage(env.requirements()));
}

async function assemble(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  let body = await assembledBody(env);
  const prevState = env.state<DeckState>("deck");
  // Re-run after a repair: the deck keeps the later passes' work (notes, requirement fixes, visual fixes) on every page
  // the writers did not change; only the changed pages come from the new merge. Nothing changed → no new render.
  const merged = body;
  if (!fix && prevState?.body && step.output?.text) {
    const changed = changedPages(step.output.text, merged);
    if (changed && !changed.length && prevState.preview_id && !prevState.render_error && !prevState.render_timed_out) {
      return { summary: `頁面沒有改變，沿用上次的草稿（修訂 ${prevState.revision}）`, text: merged, data: renderData(prevState) };
    }
    if (changed?.length && parseSlides(prevState.body).length === parseSlides(merged).length) body = replaceSlides(prevState.body, changed.join("\n\n"));
  }
  // A fix round of the assembly = a render error: ask once for a syntax fix of the whole body (pages unchanged).
  if (fix && prevState?.render_error && prevState.body) {
    // Only the pages the error points at (a quoted token, an open block) are sent for a syntax fix; the rest stay as they are.
    const suspects = suspectPages(prevState.body, prevState.render_error);
    const all = parseSlides(prevState.body).length;
    await env.activity(step.key, "integrator", suspects.length && suspects.length < all ? `依編譯錯誤修正第 ${suspects.map((p) => p.index).join("、")} 頁的語法` : "依編譯錯誤修正語法");
    const scope = suspects.length && suspects.length < all ? suspects.map((p) => p.raw).join("\n\n") : prevState.body;
    const res = await env.call({ purpose: "render_fix", role: "integrator", aiRole: "slides", messages: fixMessages(modeOf(env), scope, prevState.render_error), maxTokens: 14_000 }, step.id);
    const repaired = cleanBody(res.text);
    const merged = repaired && scope !== prevState.body ? replaceSlides(prevState.body, repaired) : repaired;
    if (merged && parseSlides(merged).length === all) body = await guardRequirements(env, prevState.body, merged, "依編譯錯誤修正語法", await frontOf(env), step.id);
  }
  const st = await writeAndRender(env, body);
  const pages = parseSlides(body).length;
  // The output is the writers' merge (what a later re-run compares against); the deck state holds the written body.
  return { summary: `合併 ${pages} 頁並寫入草稿（修訂 ${st.revision}）；${st.render_error ? "編譯失敗" : st.render_timed_out ? "編譯逾時" : "預覽編譯成功"}`, text: fix ? body : merged, data: renderData(st) };
}

/**
 * The pages a render error points at: one that holds a token the error quotes (`'…'`, "…", `…`), else the ones with an
 * open block or an unparsable chart / diagram spec. Empty = no clue (the whole body is fixed).
 */
export function suspectPages(body: string, error: string): { index: number; raw: string }[] {
  const pages = body.replace(/\r\n/g, "\n").split(/^(?=## )/m).filter((p) => p.startsWith("## ")).map((raw, i) => ({ index: i + 1, raw: raw.trim() }));
  const tokens = [...error.matchAll(/['"`‘“]([^'"`’”\n]{4,60})['"`’”]/g)].map((m) => m[1]!.trim()).filter((t) => !/^(?:index|html|qmd|yaml|true|false)$/i.test(t));
  const byToken = pages.filter((p) => tokens.some((t) => p.raw.includes(t)));
  if (byToken.length) return byToken;
  return pages.filter((p) => unbalanced(p.raw).length > 0 || [...p.raw.matchAll(/```(?:chart|diagram)\s*\n([\s\S]*?)\n```/g)].some((m) => { try { JSON.parse(m[1]!); return false; } catch { return true; } }));
}

/** Pages of `next` that differ from `prev` (same titles in the same order), or null when the page list changed. */
export function changedPages(prev: string, next: string): string[] | null {
  const a = parseSlides(prev);
  const b = parseSlides(next);
  if (a.length !== b.length || a.some((p, i) => !titleMatches(p.title, b[i]!.title))) return null;
  const raw = (x: string) => x.replace(/\r\n/g, "\n").split(/^(?=## )/m).filter((p) => p.startsWith("## ")).map((p) => p.trim());
  const ra = raw(prev);
  return raw(next).filter((p, i) => p !== ra[i]);
}

/** Scoring cycles of the visual QA: each page gets at most QA_PAGE_FIXES rewrites (2), so 3 cycles cover it. */
const QA_ROUNDS = 3;
export const QA_PAGE_FIXES = 2;

type ShotsRow = { output_prefix: string; result: { shots?: { count?: number } } | null };

/** Screenshots + layout metrics of the newest ready shot preview of the run's deck; images only of the `want` pages. */
async function shotPages(env: WorkflowEnv, previewId: string, want?: number[]): Promise<{ pages: ShotPage[]; images: import("../../lib/vision/review.js").ReviewImage[] } | null> {
  const row = (await env.db.query<ShotsRow>("SELECT p.output_prefix, j.result FROM deck_previews p JOIN jobs j ON j.id=p.job_id WHERE p.id=$1 AND p.status='ready'", [previewId])).rows[0];
  const count = row?.result?.shots?.count ?? 0;
  if (!row || !count) return null;
  const manifest = await env.storage.getBuffer(`${row.output_prefix}_hub/shots.json`).then((b) => (b ? (JSON.parse(b.toString("utf8")) as { pages?: ShotPage[] }) : null)).catch(() => null);
  const pages = (manifest?.pages ?? []).map((p) => ({ index: p.index, title: p.title, metrics: p.metrics }));
  const vision = await env.vision("slides");
  const images = vision && (!want || want.length) ? (await previewImages(env.storage, row.output_prefix, count, want)).images : [];
  return { pages, images };
}

/** Per-page visual QA memory across rounds and re-runs (`state.visual_qa`): scores by slide hash, rewrites, fit variants and the best version per title. */
type QaMemory = { cache: Record<string, PageScore>; fixes: Record<string, number>; variants?: Record<string, number>; best: Record<string, { raw: string; score: number; pass: boolean; hard: boolean }> };

/** Deterministic fit variants of a page (font + figure scale, `DECK_CSS` `.fit-90/80/70`), smallest last. */
export const FIT_VARIANTS = ["fit-90", "fit-80", "fit-70"];
/** Overflow-type defects: fixed by the next fit variant (code), not by a rewrite. */
const OVERFLOW_RE = /超出(?:投影片|版面|範圍)|overflow|cut off|超出頁面/i;

/** The page with fit variant `level` (1-based; 0 = none) on its heading: other classes / attributes are kept. */
export function withVariant(raw: string, level: number): string {
  const nl = raw.indexOf("\n");
  const head = nl < 0 ? raw : raw.slice(0, nl);
  const rest = nl < 0 ? "" : raw.slice(nl);
  const attrs = /\{([^}]*)\}\s*$/.exec(head);
  const base = attrs ? head.slice(0, attrs.index).trimEnd() : head.trimEnd();
  const kept = (attrs?.[1] ?? "").split(/\s+/).filter((a) => a && !/^\.fit-\d+$/.test(a));
  const cls = level > 0 ? [`.${FIT_VARIANTS[Math.min(level, FIT_VARIANTS.length) - 1]}`] : [];
  const all = [...cls, ...kept];
  return `${base}${all.length ? ` {${all.join(" ")}}` : ""}${rest}`;
}

/** The fit level a page's heading carries (0 = none). */
export const variantOf = (raw: string) => {
  const m = /\{[^}]*\.fit-(\d+)[^}]*\}\s*$/.exec(raw.split("\n")[0] ?? "");
  return m ? FIT_VARIANTS.indexOf(`fit-${m[1]}`) + 1 : 0;
};
const rank = (s: Pick<PageScore, "pass" | "hard" | "score">) => (s.pass ? 2 : s.hard ? 0 : 1) * 10 + (s.score || 0);

/**
 * Visual QA (per page, not an all-pages gate): render with screenshots → only pages whose source changed since they were
 * scored go to the vision model (the rest keep their cached verdict; the layout metrics are re-measured for all) →
 * failing pages that still have rewrites left (≤ QA_PAGE_FIXES each) are rewritten → re-render; ≤ QA_ROUNDS cycles. A
 * rewrite that scores worse than the page's best version is rolled back to it. Only hard defects (overflow, raw code,
 * text < 16 px, a defect seen on the screenshot) fail the step's check; soft problems are report notes.
 */
async function visualQa(env: WorkflowEnv, step: StepRow): Promise<StepOutput> {
  let st = env.state<DeckState>("deck");
  if (!st?.deck_id || !st.body) return { summary: "簡報還沒有寫入，無法做視覺檢查。", text: st?.body ?? "", data: st ? renderData(st) : { renderError: "簡報還沒有寫入。" } };
  const vision = await env.vision("slides");
  const outline = outlineOf(env);
  const owned = studentOwned(outline);
  const deckTitle = env.state<string>("front_title") ?? st.deck_title ?? "";
  const allowed = (title: string) => !title || titleMatches(deckTitle, title) || owned.some((o) => titleMatches(o, title));
  // Pages a page-scoped edit keeps are not this request's to judge or fix: never scored, never failing.
  const keptList = env.state<string[]>("kept_pages") ?? [];
  const isKept = (title: string) => !!title && keptPage(keptList, title) !== undefined;
  const mem: QaMemory = { cache: {}, fixes: {}, best: {}, ...(env.state<QaMemory>("visual_qa") ?? {}) };
  // A re-run (repair / 繼續改) gives every page its rewrites and variants again; scores of unchanged pages are kept.
  mem.fixes = {};
  mem.variants = {};
  let scores: PageScore[] = [];
  // A section cut off mid-block (e.g. an unclosed notes div) hides every later slide: repair before measuring.
  let body = closeOpenBlocks(st.body);
  let lastGood: string | null = null;
  let unseen = false;
  let visionCalls = 0;
  const log: string[] = [];
  for (let round = 0; round < QA_ROUNDS; round++) {
    await env.checkpoint();
    await env.activity(step.key, "designer", `第 ${round + 1} 輪：編譯並擷取每一頁截圖`);
    st = await writeAndRender(env, body, { shots: true });
    if (st.render_error || !st.preview_id) {
      log.push(`第 ${round + 1} 輪編譯失敗`);
      break;
    }
    lastGood = body;
    const slides = parseSlides(body);
    const plan = pagesToScore(slides, vision ? mem.cache : {});
    const need = plan.filter((p, i) => (!p.cached || p.cached.source !== "vision") && !isKept(slides[i]?.title ?? "")).map((p) => p.index);
    let shots = await shotPages(env, st.preview_id, need);
    if (!shots?.pages.length) {
      // A failed capture (busy / broken Chrome) is retried once; passing pages unseen would hide every visual defect.
      await env.note(`第 ${round + 1} 輪沒有拿到截圖，重新擷取一次。`, "warn");
      st = await writeAndRender(env, body, { shots: true });
      if (!st.render_error && st.preview_id) shots = await shotPages(env, st.preview_id, need);
    }
    unseen = !shots?.pages.length;
    if (!shots?.pages.length) {
      // No screenshots (capture failed): fall back to the source heuristics only.
      const issues = bodyIssues(body, allowed);
      scores = slides.map((s, i) => { const hit = issues.find((x) => x.title === s.title); return { page: i + 2, title: s.title, scores: {}, score: hit ? 2 : 4, pass: !hit, hard: false, issues: hit?.issues ?? [], fix: hit ? fixFor(hit.issues) || "精簡文字、改用視覺元素。" : "", source: "metrics" as const }; });
    } else {
      if (vision && need.length) {
        await env.activity(step.key, "verifier", `審查者看 ${shots.images.length} 張截圖逐頁評分（${plan.length - need.length} 頁沒有改，沿用上次的評分）`);
        visionCalls++;
      } else await env.activity(step.key, "verifier", vision ? "每一頁都沒有改，沿用上次的評分" : `依版面量測檢查 ${shots.pages.length} 頁（模型不能看圖）`);
      const fresh = vision && shots.images.length ? await visionScores(env, shots.images, shots.pages, { allowed, stepId: step.id }).catch(() => []) : [];
      // The verifier failing silently must not look like a pass: say the round was judged by the metrics only.
      if (vision && shots.images.length && !fresh.length) await env.note(`第 ${round + 1} 輪審查者沒有回覆評分，這一輪只用版面量測判斷。`, "warn");
      const v = [...fresh, ...plan.filter((p) => p.cached?.source === "vision" && !fresh.some((f) => f.page === p.index)).map((p) => ({ ...p.cached!, page: p.index }))];
      scores = combineScores(shots.pages, v, allowed, sourceIssues(body, { paper: modeOf(env) === "paper_report", refs: contentRefsOf(env, outline) }));
      for (const sc of scores) if (isKept(sc.title)) Object.assign(sc, { pass: true, hard: false });
      for (const sc of scores) {
        const p = plan.find((x) => x.index === sc.page);
        if (!p) continue;
        sc.hash = p.hash;
        const vs = v.find((x) => x.page === sc.page);
        if (vs) mem.cache[p.hash] = { ...vs, hash: p.hash };
      }
    }
    // Visual share: text-only content pages beyond the allowed share fail too (a soft, fixable problem).
    const share = visualShare(body, allowed);
    if (share.total && share.with / share.total < 0.6) {
      const textOnly = slides.filter((s) => !allowed(s.title) && !isKept(s.title) && !/^```\{?\.?(mermaid|chart|diagram)|!\[|^\s*\|/m.test(s.body));
      for (const s of textOnly.slice(0, Math.ceil(share.total * 0.6) - share.with)) {
        const sc = findByTitle(scores, s.title, (x) => x.title);
        if (sc) {
          sc.pass = false;
          sc.issues = [...sc.issues, "這頁只有文字：請改用流程圖、圖表、論文圖或表格呈現（版型 A/D/E）"];
          sc.fix = [fixFor(["只有文字"]), sc.fix].filter(Boolean).join(" ");
        }
      }
    }
    // Keep the best version of every page; a rewrite that made a page worse goes back to it (re-rendered below).
    let rolledBack = 0;
    for (const sc of scores) {
      const s = findByTitle(slides, sc.title, (x) => x.title);
      if (!s || !sc.title) continue;
      const best = mem.best[sc.title];
      const raw = `## ${s.title}\n${s.body}${s.notes ? `\n\n::: {.notes}\n${s.notes}\n:::` : ""}`;
      if (!best || rank(sc) >= rank({ pass: best.pass, hard: best.hard, score: best.score })) mem.best[sc.title] = { raw, score: sc.score, pass: sc.pass, hard: !!sc.hard };
      else if ((mem.fixes[sc.title] ?? 0) > 0 || (mem.variants?.[sc.title] ?? 0) > 0) {
        body = replaceSlides(body, best.raw);
        Object.assign(sc, { pass: best.pass, hard: best.hard, score: best.score });
        rolledBack++;
      }
    }
    const failing = scores.filter((s) => !s.pass && !allowed(s.title));
    const hardOwned = scores.filter((s) => !s.pass && allowed(s.title) && s.title && !titleMatches(deckTitle, s.title));
    const hard = [...failing.filter((s) => s.hard), ...hardOwned];
    st = { ...st, qa: { round: round + 1, scores, vision, failed: hard.map((s) => s.page), soft: failing.filter((s) => !s.hard).map((s) => s.page), ...(unseen ? { unseen: true } : {}) } };
    await env.setState({ deck: st, visual_qa: mem });
    log.push(`第 ${round + 1} 輪：${scores.length - failing.length}/${scores.length} 頁通過${rolledBack ? `（${rolledBack} 頁改壞了，換回較好的版本）` : ""}`);
    if (rolledBack) {
      // The rolled-back pages must be what the deck shows: one more render (no new scoring needed, their verdict is known).
      st = { ...(await writeAndRender(env, body)), qa: st.qa };
      lastGood = body;
    }
    // Overflow / crowding: the next deterministic fit variant of the page (code, not a rewrite); the next round's scoring
    // (vision, else the metrics) keeps the best variant (`mem.best`, rolled back when a variant scored worse).
    const variants = (mem.variants ??= {});
    // (A page already on its smallest variant — also from an earlier session — is left to the rewrite.)
    const rawOf = (title: string) => findByTitle(body.split(/^(?=## )/m).filter((p) => p.startsWith("## ")), title, (p) => parseSlides(p)[0]?.title ?? "");
    const sized = round < QA_ROUNDS - 1 ? failing.filter((f) => { const raw = rawOf(f.title); return !!raw && f.issues.some((i) => OVERFLOW_RE.test(i)) && variantOf(raw) < FIT_VARIANTS.length; }) : [];
    for (const f of sized) {
      const raw = rawOf(f.title)!;
      const level = variantOf(raw) + 1;
      variants[f.title] = level;
      body = replaceSlides(body, withVariant(raw.trim(), level));
    }
    if (sized.length) {
      log.push(`第 ${round + 1} 輪：${sized.length} 頁超出或擁擠，改用縮放版型（${sized.map((f) => `第 ${f.page} 頁 ${FIT_VARIANTS[(variants[f.title] ?? 1) - 1]}`).join("、")}）`);
      await env.activity(step.key, "designer", `${sized.length} 頁改用縮放版型（字級／圖縮小），下一輪重新評分`);
    }
    // Only pages with rewrites left are fixed (≤ QA_PAGE_FIXES per page); the others stay as report items. Editing an
    // existing deck (translate / polish) rewrites only pages with a hard defect: design suggestions on the user's own
    // layout are report items, not a reason to redesign pages the user did not ask to change (eval deck_translate_en).
    const revising = env.state<boolean>("revise") && env.state<EditKind>("edit_kind") !== "expand";
    const fixable = failing.filter((f) => (mem.fixes[f.title] ?? 0) < QA_PAGE_FIXES && !sized.includes(f) && (!revising || f.hard));
    if ((!fixable.length && !sized.length) || round === QA_ROUNDS - 1) break;
    if (!fixable.length) continue;

    // Targeted fix of the failing pages.
    await env.activity(step.key, "writer", `修正 ${fixable.length} 頁：${fixable.map((f) => `第 ${f.page} 頁`).join("、")}`);
    const targets = fixable.map((f) => ({ f, s: findByTitle(slides, f.title, (s) => s.title) })).filter((x) => x.s);
    if (!targets.length) break;
    for (const { f } of targets) mem.fixes[f.title] = (mem.fixes[f.title] ?? 0) + 1;
    const user = [
      LABHUB_RULES[modeOf(env)],
      VISUAL_RULES,
      "下面這些投影片沒有通過逐頁截圖檢查。依每頁的問題與修改指示重寫這幾頁（標題逐字不變、講稿保留或改善、數字只能用研究資料裡的）。流程圖／架構圖一律用 ```diagram（不要 Mermaid）；論文圖被裁切或包含正文時，換成圖表清單裡另一張圖的那一行語法（不要自己改 paper-fig 的頁碼或位置），或改用 ```chart／表格呈現同樣的數字；不要寫位置、座標、尺寸或 style；同一組資訊（數字或項目清單）只用一種視覺元素呈現：圖表、流程圖、時間軸或表格擇一；頁面太空就把視覺元素放大到整頁寬。只輸出這幾頁（每頁以「## 標題」開頭，含 ::: {.notes}），不要其他文字。",
      ...targets.map(({ f, s }) => `### 第 ${f.page} 頁「${s!.title}」\n問題：${f.issues.join("；") || "（未通過）"}\n修改指示：${f.fix || "精簡文字、改用視覺元素"}\n${dataBlock("slide", `## ${s!.title}\n${s!.body}\n\n::: {.notes}\n${s!.notes}\n:::`)}`),
      dataBlock("research", (env.state<string>("brief") ?? "").slice(0, 14_000)),
    ].join("\n\n");
    const res = await env.call({ purpose: "visual_fix", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: WRITER_TOKENS }, step.id);
    let fixed = cleanBody(res.text);
    if (!fixed) break;
    // A layout fix never brings new numbers: a page whose charts / tables gained numbers the page and the sources
    // do not have keeps its previous version.
    const sources = `${env.state<string>("brief") ?? ""}\n${(env.state<string[]>("original_slides") ?? []).join("\n")}`;
    const invented: string[] = [];
    fixed = splitChunks(fixed).chunks.filter((c) => {
      const before = rawOf(parseSlides(c)[0]?.title ?? "");
      const bad = before ? inventedNumbers(c, before, sources) : [];
      if (bad.length) invented.push(`「${parseSlides(c)[0]?.title}」（${bad.slice(0, 4).join("、")}）`);
      return !bad.length;
    }).join("");
    if (invented.length) await env.note(`版面修正在這些頁加了資料裡沒有的數字，保留原本的版本：${invented.join("、")}。`, "warn");
    if (!fixed.trim()) continue;
    const rewritten = fixContent(replaceSlides(body, stripPositions(normalizeDiagrams(fixed))), contentRefsOf(env, outline)).body;
    if (rewritten === body || parseSlides(rewritten).length !== slides.length) break;
    // The layout fix must not break a requirement that held (e.g. bring Chinese back into an English deck).
    const next = await guardRequirements(env, body, rewritten, "版面修正", await frontOf(env), step.id);
    if (next === body) break;
    body = next;
  }
  // Keep the last version that rendered.
  if (st.render_error && lastGood && lastGood !== body) st = { ...(await writeAndRender(env, lastGood)), qa: st.qa };
  const failed = st.qa?.failed ?? [];
  const soft = st.qa?.soft ?? [];
  const table = scoreTable(scores);
  await env.setState({ qa_table: table });
  return {
    summary: `${vision ? "逐頁截圖評分" : "版面量測（模型不能看圖）"}：${log.join("；")}${failed.length ? `；${failed.length} 頁有版面硬傷` : "；沒有版面硬傷"}${soft.length ? `；${soft.length} 頁的版面建議列入報告` : ""}${vision ? `（看圖評分 ${visionCalls} 次）` : ""}`,
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
    // Pages a page-scoped edit keeps are never rewritten for a requirement (they are the user's, as they were).
    const keptList = env.state<string[]>("kept_pages") ?? [];
    if (keptList.length) {
      const slides = parseSlides(body);
      f.pages = f.pages.filter((n) => keptPage(keptList, slides[n - 1]?.title ?? "") === undefined);
    }
    left = f.hard;
    if (!f.issues.length) break;
    // Only judge-fallback misses left after one targeted try: the final judge decides (they may be met in other words).
    if (!f.hard.length && round > 0) break;
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
    left = failingPages(env, body, await frontOf(env)).hard;
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
      const hit = findByTitle(notes, title, (n) => n.title);
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
  const kept = env.state<string[]>("kept_pages");
  const missing = parseSlides(body).filter((s) => s.notes.replace(/\s+/g, "").length < 30 && !owned.some((o) => titleMatches(o, s.title)) && keptPage(kept, s.title) === undefined);
  if (!missing.length && !fix) return { summary: "每頁都有講稿，不需要補。", text: body, data: st ? renderData(st) : { renderError: null } };
  await env.activity(step.key, "writer", `補 ${missing.length} 頁講稿`);
  const user = taskPrompt(env, step, {
    context: { slides: missing.map((s) => `## ${s.title}\n${s.body}`).join("\n\n").slice(0, 20_000), research: (env.state<string>("brief") ?? "").slice(0, 12_000) },
    format: `為這 ${missing.length} 頁各寫 2–5 句講稿（報告者要說的話，${LANGUAGE_LABEL[notesLanguage(env.requirements()) ?? "zh"]}）。只輸出 JSON：{"notes":[{"title":"頁面標題（照原文）","notes":"講稿"}]}`,
  }, fix);
  const { value } = await env.callJson<NotesJson>({ purpose: "speaker_notes", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer") }, { role: "user", content: user }], maxTokens: 5000 }, isNotes, step.id);
  if (!value?.notes.length) return { summary: "講稿沒有產生成功。", text: body, data: st ? renderData(st) : { renderError: null } };
  const next = await guardRequirements(env, body, injectNotes(body, value.notes), "補齊講稿", await frontOf(env), step.id);
  const written = await writeAndRender(env, next);
  return { summary: `補上 ${value.notes.length} 頁講稿並重新編譯。`, text: next, data: renderData(written) };
}

async function execute(env: WorkflowEnv, step: StepRow, fix: { previous: StepOutput; issues: string[] } | null): Promise<StepOutput> {
  if (step.key.startsWith("write_")) return writeSection(env, step, fix);
  // Topic decks: import (online picks) + structured full-text extraction of one paper, in its own context (research.ts).
  if (step.key.startsWith("paper_")) return readPaper(env, step, fix);
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

const NAME_STOP = new Set(["the", "and", "for", "with", "of", "in", "on", "to", "a", "an", "by", "via", "based", "method", "methods", "approach", "approaches", "model", "models", "using"]);
const nameTokens = (n: string) => n.toLowerCase().replace(/[-_/]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !NAME_STOP.has(w));
/** Method / family names a judged failure says are missing: Latin phrases (≥ 2 words or hyphenated) and 「quoted」 terms. */
export function missingNames(reason: string): string[] {
  const latin = (reason.match(/[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*(?:\s+(?:and\s+|of\s+|for\s+)?[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*)*/g) ?? [])
    .filter((n) => /\s|-/.test(n) && nameTokens(n).length >= 1 && n.length >= 6 && !/^approved_outline$/i.test(n));
  const quoted = [...reason.matchAll(/[「『"]([^」』"]{3,40})[」』"]/g)].map((m) => m[1]!);
  return [...new Set([...latin, ...quoted].map((n) => n.trim()))].slice(0, 8);
}
/** ≥ 60 % of a name's content words appear in the text. */
export const nameIn = (name: string, text: string) => {
  const toks = nameTokens(name);
  if (!toks.length) return text.toLowerCase().includes(name.toLowerCase());
  const hay = ` ${text.toLowerCase().replace(/[-_/]/g, " ")} `;
  return toks.filter((t) => hay.includes(t)).length / toks.length >= 0.6;
};

/**
 * Topic decks: a judged failure that names method families none of the papers read covers (e.g. 「缺少 Contextual
 * density-ratio」) is not a writing fault. Unread library papers that cover them are added (extraction steps + the pages'
 * sources) and those pages rewritten once with them; names nothing in the library covers need a new plan (told plainly).
 */
async function structural(env: WorkflowEnv, failing: Criterion[], open: Set<string> = new Set(failing.map((c) => c.id))) {
  const none = { sources: [] as { key: string; issues: string[] }[], fixed: [] as string[], replan: [] as { id: string; why: string }[] };
  const st = env.state<TopicState>("topic");
  if (!isTopicDeck(env) || !st?.picks.length || !env.run.study_id) return none;
  const papers = await readPapers(env);
  const readText = [...papers.values()].map((p) => `${p.title}\n${p.notes}`).join("\n");
  const library = await libraryPapers(env, env.run.study_id);
  const unread = library.filter((p) => p.has_pdf && !st.picks.some((k) => k.kind === "library" && k.paper_id === p.id));
  const outline = outlineOf(env);
  const add: TopicPick[] = [];
  const pagesFor = new Map<number, string[]>();
  for (const c of failing) {
    if (c.kind !== "judge" && !c.check?.params?.judge_fallback) continue;
    if (c.id === "grounded") continue;
    const names = missingNames(c.reason ?? "");
    const notRead = names.filter((n) => !nameIn(n, readText));
    if (!notRead.length) continue;
    const found = unread.filter((p) => notRead.some((n) => nameIn(n, `${p.title}\n${p.abstract ?? ""}`)));
    // Nothing unread covers it, or sources were already added for it (a repair already tried): only a new plan helps.
    if (!found.length || !open.has(c.id)) {
      none.replan.push({ id: c.id, why: `需要的做法（${notRead.join("、")}）在讀過的論文和研究文獻庫裡都找不到，改寫頁面補不出來：要先補論文（例如在要求裡說「搜尋」）再重新規劃。` });
      continue;
    }
    for (const p of found) {
      if (add.some((x) => x.kind === "library" && x.paper_id === p.id)) continue;
      add.push({ kind: "library", paper_id: p.id, title: p.title, year: p.year, cite_key: p.cite_key, has_pdf: true, reason: `最終驗收缺少：${notRead.join("、")}`, role: "core", ...(bibLine(p) ? { bib: bibLine(p) } : {}) });
    }
    // The pages the reason names, else the taxonomy page.
    const named = [...(c.reason ?? "").matchAll(/第\s*(\d+)\s*頁/g)].map((m) => Number(m[1]));
    const targets = named.length ? named : outline.filter((p) => p.kind === "taxonomy").map((p) => p.n);
    for (const n of targets) pagesFor.set(n, [...(pagesFor.get(n) ?? []), `${c.text}：${c.reason ?? ""}`]);
    none.fixed.push(c.id);
  }
  if (!add.length) return none;
  const start = st.picks.length;
  const picks = [...st.picks, ...add];
  await env.setState({ topic: { ...st, picks } });
  const fresh = paperSteps(picks, { only: add.map((_, i) => start + i), maxTools: DECK_READ_TOOLS });
  const steps = await getSteps(env.db, env.run.id);
  await insertSteps(env.db, env.run.id, fresh, Math.max(0, ...steps.map((s) => s.position ?? 0)) + 1);
  const refs = add.map((_, i) => `P${start + i + 1}`);
  const next = outline.map((p) => (pagesFor.has(p.n) ? { ...p, sources: [...new Set([...(p.sources ?? []), ...refs])] } : p));
  await env.db.query("UPDATE workflow_runs SET plan = jsonb_set(plan, '{outline}', $2::jsonb), updated_at=now() WHERE id=$1", [env.run.id, JSON.stringify(next)]);
  const writes = writerSteps(next);
  for (const [n, issues] of pagesFor) {
    const key = writes.find((w) => ((w.inputs?.pages as number[]) ?? []).includes(n))?.key;
    if (!key) continue;
    await env.db.query("UPDATE workflow_steps SET depends_on = (SELECT array_agg(DISTINCT x) FROM unnest(depends_on || $3::text[]) x) WHERE run_id=$1 AND key=$2", [env.run.id, key, fresh.map((f) => f.key)]);
    none.sources.push({ key, issues: [...issues, `新增來源 ${refs.join("、")}（${add.map((p) => `〈${clipText(pickTitle(p), 50)}〉`).join("、")}）：用它們補上缺少的做法。`] });
  }
  await env.refresh();
  await env.note(`最終驗收缺少的做法不在讀過的論文裡：加讀文獻庫的 ${add.length} 篇（${add.map((p) => `〈${clipText(pickTitle(p), 40)}〉`).join("、")}），再改寫相關頁面一次。`);
  return none;
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
    if (c.id === "pages" || c.id === "kept" || c.id === "complete") {
      // One page per outline page (one-to-one): a page another page's copy stood in for is missing too.
      const at = assignTitles(outline.map((p) => p.title), slides.map((s) => s.title));
      outline.forEach((p, i) => at[i]! < 0 && add(writeOf(p.n), `缺少第 ${p.n} 頁「${p.title}」，請完整寫出。`));
      // Every writer's page is there but some page is doubled: re-assembling from the writers' pages restores the deck.
      const dups = duplicatePages(slides, outline.map((p) => p.title));
      if (!out.size && (slides.length > outline.length || dups.length)) add("assemble", dups.length ? `有重複的頁面：${dups.join("、")}。` : `頁數比大綱多（${slides.length} > ${outline.length}）。`);
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
        const p = findByTitle(outline, s.title, (o) => o.title);
        if (p && !p.student_owned && /〔|待補|TODO|TBD/i.test(`${s.body}${s.notes}`)) add(writeOf(p.n), `第 ${p.n} 頁「${p.title}」還有佔位文字「${(PLACEHOLDER_RE.exec(`${s.body}\n${s.notes}`) ?? /〔[^〕]*〕|待補|TODO|TBD/i.exec(`${s.body}${s.notes}`))?.[0] ?? "〔　〕"}」：能從資料算出來就算出來，資料沒有就刪掉那一行，講稿也不要提到它。`);
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
    const old = prev.find((o) => o.title === p.title) ?? (prev.length === edits.outline!.length ? prev[i] : undefined);
    const owned = prev.find((o) => o.title === p.title)?.student_owned || (!env.state<boolean>("revise") && STUDENT_TITLE_RE.test(p.title));
    // The planner's per-page choices (layout, role, source papers) stay with the page the user kept or edited in place.
    const meta = old ? { ...(old.layout ? { layout: old.layout } : {}), ...(old.kind ? { kind: old.kind } : {}), ...(old.sources ? { sources: old.sources } : {}), ...(old.item ? { item: old.item } : {}), ...(old.from ? { from: old.from } : {}) } : {};
    return { n: i + 1, title: p.title.trim().slice(0, 120) || `第 ${i + 1} 頁`, points: (p.points ?? []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6), ...meta, ...(owned ? { student_owned: true } : {}) };
  });
  await env.setState({ pages: outline.length });
  const vision = await env.vision("slides");
  return { outline, steps: laterSteps(outline, vision, isTopicDeck(env) ? env.state<TopicState>("topic")?.picks ?? [] : []) };
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
  structural,
  handlesRequirements: true,
  // The deck's own criteria re-check every writer / assemble check on the shipped deck: pages (count, outline titles
  // one-to-one, order, no duplicates), notes, placeholders, truncation; density / length are judged on the rendered
  // pages by the screenshot QA (`visual_qa`).
  coveredChecks: { slide_titles: "pages", slide_count: "pages", speaker_notes: "notes", no_placeholder: "clean", not_truncated: "complete", slide_density: "visual_qa", slide_length: "visual_qa", render_ok: "render" },
  commit,
};

registerWorkflowPlaybook(slidesPlaybook);

export const _test = { outlineHeadings, keepRule, keepOriginals, changedPages, addedPages, cleanPoint, dedupeOutline, toOutline, outlineText, criteriaFor, laterSteps, injectNotes, writerSteps, withVariant, variantOf, stripPositions, suspectPages, withSourceLines, pageSources, usedPicks };
