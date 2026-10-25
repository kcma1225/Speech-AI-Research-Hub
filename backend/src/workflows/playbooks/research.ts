/**
 * 主題調研 (`topic_research`, docs/architecture.md "Workflows"): a 「研究有哪些做法」-style request without a specific
 * paper becomes a structured research note.
 *
 * Planning (before anything untrusted is read): the orchestrator splits the topic into 3–6 sub-questions with 1–3
 * English keyword queries each (query expansion; canonical method names it knows count as keywords) from the request
 * alone. All queries go to the scholarly APIs in ONE batch (`search_papers_online`, keywords only), then the top hits
 * are snowballed (Semantic Scholar references + citations; only their DOI / arXiv id leaves the hub) and the run is
 * tainted, so no step searches again. A planner picks 8–12 papers (seminal + recent, relevance, venue, open access)
 * incl. the study papers that are relevant and says why others were left out. The plan card shows the sub-questions
 * (outline, editable) and one step per paper (「匯入並精讀〈…〉」, can be switched off); `plan.writes` lists the library
 * imports, which are not a draft-only effect: without autopilot the plan waits for the user (autopilot approves it).
 *
 * Execution: per paper, import into the lab library + link to the study (open-access PDF via the library services),
 * then a structured extraction from the FULL text (a deterministic results-weighted digest + read tools): 一句話 /
 * 方法 / 注入位置與訓練／推論 / 關鍵公式 / 實驗設定 / 數字表 / 限制 / 子問題對應 (「僅依摘要」 without a PDF). Writers get
 * the per-paper parts they need (each writer's material is also its verifier's sources, `state.brief_<key>`):
 * 問題定義 + 方法分類 → 各方法詳解 ∥ 實驗結果比較 ∥ (在 <stack> 上怎麼做) ∥ 開放問題 + 與本研究的關係 → a consistency /
 * concision pass over the whole draft → assemble (+ 參考文獻, 搜尋紀錄) → final. Citations are the study's cite keys;
 * the deterministic checks below read the live key list and the paper labels from the step data.
 */
import { getAgentTool } from "../../agent/tools/registry.js";
import { importIntoStudy, linkPaperToStudy } from "../../agent/tools/library.js";
import { digest, paperFullText } from "../../lib/library/fulltext.js";
import { libraryService } from "../../lib/library/settings.js";
import { findPaperMatches, getPaper } from "../../lib/library/store.js";
import { authorDisplayName } from "../../lib/library/normalize.js";
import { CHECKS, titleMatches } from "../checks.js";
import { WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { tryFetchPdf } from "../paper-pdf.js";
import { getSteps, markTainted } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import { WorkflowStop, type CheckSpec, type Criterion, type OutlineItem, type StepOutput, type StepRow, type StepSpec } from "../types.js";
import { clipText, isTopicRequest, systemFor, taskPrompt } from "./common.js";
import { textTokens } from "../context.js";
import { stitch } from "../units.js";
import { commitNote, finalSpec, studyOrQuestion, writePart } from "./documents.js";
import { registerWorkflowPlaybook, type ApprovalEdits, type PlanResult, type WorkflowPlaybook } from "./registry.js";

type Fix = { previous: StepOutput; issues: string[] } | null;

export type SubQuestion = { q: string; keywords: string[]; queries?: string[] };
/** A `search_papers_online` hit (agent/tools/library.ts) or a snowballed paper. */
export type OnlineHit = {
  title: string; authors?: string; year: number | null; venue: string | null; doi: string | null; arxiv_id: string | null; abstract?: string;
  in_library: string | null; open_access?: boolean; cited_by?: number | null;
  /** How it was found: 「查詢 "…"」, 「〈seed〉的參考文獻」, 「引用〈seed〉」 (for the 搜尋紀錄). */
  via?: string[];
};
export type LibPaper = { id: string; title: string; year: number | null; cite_key: string; has_pdf: boolean; abstract: string | null; authors_text?: string; venue?: string | null; arxiv_id?: string | null; doi?: string | null };

/** Bibliographic fields of a paper (what a reader needs to name it: authors, year, venue). */
export type Bib = { authors_text?: string | null; year?: number | null; venue?: string | null; arxiv_id?: string | null; doi?: string | null };
const firstAuthor = (authors: string | null | undefined) => {
  const list = (authors ?? "").split(/;\s*/).map((a) => a.trim()).filter(Boolean);
  if (!list.length) return "";
  const head = list[0]!;
  const family = /\p{Script=Han}/u.test(head) ? head : head.split(/\s+/).at(-1)!;
  return list.length > 1 ? `${family} et al.` : family;
};
/**
 * 「Chen et al., 2018, Interspeech」: the line writers cite a paper with (production 0668a3d7: every library paper had a
 * venue, yet the deck said "Venues are not provided" because no step was ever given it). No venue but an arXiv id →
 * 「arXiv preprint」; neither → no venue at all (never 「未提供」).
 */
export function bibLine(b: Bib): string {
  const venue = b.venue?.trim() || (b.arxiv_id ? `arXiv preprint (arXiv:${b.arxiv_id})` : "");
  return [firstAuthor(b.authors_text), b.year ? String(b.year) : "", venue].filter(Boolean).join(", ");
}
/** The bibliographic lines of papers by id. */
export async function bibOf(db: WorkflowEnv["db"], ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  if (!uniq.length) return new Map();
  const rows = (await db.query<Bib & { id: string }>("SELECT id, authors_text, year, venue, arxiv_id, doi FROM papers WHERE id = ANY($1::uuid[])", [uniq])).rows;
  return new Map(rows.map((r) => [r.id, bibLine(r)]));
}
export type PickRole = "seminal" | "recent" | "core";
export type Pick =
  | { kind: "library"; paper_id: string; title: string; year: number | null; cite_key: string; has_pdf: boolean; reason: string; role?: PickRole; bib?: string }
  | { kind: "online"; hit: OnlineHit; reason: string; role?: PickRole };
/** A paper of the run once it is in the study (imported or already there). */
export type RunPaper = { paper_id: string; cite_key: string; title: string; year: number | null; has_pdf: boolean; /** 「Chen et al., 2018, Interspeech」 (bibLine). */ bib?: string };
export type TopicState = {
  topic: string; subqs: SubQuestion[]; queries: string[]; seeds: string[]; hits: OnlineHit[]; picks: Pick[]; excluded: { title: string; reason: string }[];
  searched: boolean; search_errors: string[]; stack: string[];
  /** The decomposition's short title (from the request). */ title?: string;
  /** Every relevant library paper is read (a library survey / a small library): every pick is a source of the taxonomy. */ read_all?: boolean;
};

export const TAXONOMY_COLUMNS = ["方法", "核心想法", "注入位置", "優缺點", "代表論文"];
/** Parts of a paper extraction (`#### ` headings), in order. */
export const EXTRACT_PARTS = ["一句話", "方法", "注入位置與訓練／推論", "關鍵公式", "實驗設定", "數字表", "限制", "子問題對應"];
const MAX_ONLINE = 10;
const MAX_LIBRARY = 4;
/** Library papers read when online search gave nothing importable (the library is then the only source). */
const LIBRARY_FALLBACK = 8;
const MAX_PAPERS = 12;
const MAX_QUERIES = 10;
const SEEDS = 3;
export const ABSTRACT_ONLY = "僅依摘要";
/** Table cells longer than this (citations excluded) are not concise. */
const CELL_MAX = 60;
/** Upper bound of a note body (chars; ≈ 15–20 KB of UTF-8 for mostly CJK text); the section budgets add up to about this. */
const NOTE_MAX_CHARS = 12_000;
const RESULTS_RE = /experiment|result|evaluation|ablation|analysis|comparison|benchmark|實驗|結果|分析/i;

/** Concrete toolkits / models a request names: the note gets a 「在 … 上怎麼做」 section for them. */
const STACK_RE = /\b(Zipformer|icefall|k2|sherpa(?:-onnx)?|ESPnet|NeMo|WeNet|Whisper|Conformer|Kaldi|SpeechBrain|fairseq|lhotse|Paraformer|FunASR)\b/gi;
export function stackOf(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(STACK_RE)) if (!seen.has(m[1]!.toLowerCase())) seen.set(m[1]!.toLowerCase(), m[1]!);
  return [...seen.values()].slice(0, 3);
}
const practiceTitle = (stack: string[]) => `在 ${stack.join(" / ")} 上怎麼做`;
export function sectionsFor(stack: string[]): string[] {
  return ["問題定義", "方法分類", "各方法詳解", "實驗結果比較", ...(stack.length ? [practiceTitle(stack)] : []), "開放問題", "與本研究的關係", "參考文獻", "搜尋紀錄"];
}
/** Back-compat export (no stack named). */
export const TOPIC_SECTIONS = sectionsFor([]);

// ---------------------------------------------------------------- network parts (replaceable in tests)

type Deps = {
  /** One keyword query to the scholarly APIs (the hub's `search_papers_online`). */
  search: (env: WorkflowEnv, query: string) => Promise<OnlineHit[]>;
  /** References + citations of a paper (by DOI / arXiv id only). */
  snowball: (env: WorkflowEnv, seed: OnlineHit) => Promise<OnlineHit[]>;
  /** Puts a candidate into the lab library + the study and fetches its open-access PDF. */
  importPaper: (env: WorkflowEnv, studyId: string, hit: OnlineHit) => Promise<RunPaper>;
};

const realDeps: Deps = {
  async search(env, query) {
    const def = getAgentTool("search_papers_online");
    if (!def) return [];
    const args = def.input.parse({ query, limit: 8 });
    const res = await def.execute(args as never, env.toolContext());
    return ((res.data as { hits?: OnlineHit[] } | null)?.hits ?? []).slice(0, 8);
  },
  async snowball(env, seed) {
    const { service } = await libraryService(env.db);
    const rel = await service.relatedPapers({ doi: seed.doi, arxivId: seed.arxiv_id }, { limit: 20, signal: env.signal });
    const out: OnlineHit[] = [];
    for (const r of rel) {
      const m = (await findPaperMatches(env.db, r.record, 1))[0];
      out.push({
        title: r.record.title, authors: (r.record.authors ?? []).slice(0, 3).map(authorDisplayName).join(", "), year: r.record.year ?? null,
        venue: r.record.venue ?? r.record.containerTitle ?? null, doi: r.record.doi ?? null, arxiv_id: r.record.arxivId ?? null,
        abstract: (r.record.abstract ?? "").slice(0, 600), in_library: m && (m.level === "same" || m.level === "likely") ? m.paper.id : null,
        open_access: !!(r.record.oaPdfUrl || r.record.arxivId), cited_by: r.citations,
        via: [r.relation === "references" ? `〈${clipText(seed.title, 40)}〉的參考文獻` : `引用〈${clipText(seed.title, 40)}〉`],
      });
    }
    return out;
  },
  async importPaper(env, studyId, hit) {
    const ctx = env.toolContext();
    if (hit.in_library) {
      const linked = await linkPaperToStudy(ctx, studyId, hit.in_library);
      const fetched = linked.paper.pdf_key ? linked.paper : (await tryFetchPdf(env, linked.paper)).paper;
      return { paper_id: linked.paper.id, cite_key: linked.citeKey, title: linked.paper.title, year: linked.paper.year, has_pdf: !!fetched.pdf_key };
    }
    const identifier = hit.arxiv_id ? `arXiv:${hit.arxiv_id}` : hit.doi;
    if (!identifier) throw new WorkflowInputError("這篇沒有 DOI 或 arXiv 編號，無法匯入。");
    const out = await importIntoStudy(ctx, studyId, identifier, { budgetMs: 30_000, queueOnFailure: false });
    return { paper_id: out.paper.id, cite_key: out.citeKey, title: out.paper.title, year: out.paper.year, has_pdf: out.hasPdf };
  },
};
let deps: Deps = realDeps;
/** Tests: stub the scholarly APIs and the import (never call real APIs from tests). */
export const setTopicResearchDeps = (d: Partial<Deps> | null) => {
  deps = d ? { ...realDeps, ...d } : realDeps;
};

const hitKey = (h: { title: string }) => h.title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Merges a hit into the pool (same title → one entry, `via` accumulated, ids / counts filled in). */
function addHit(pool: Map<string, OnlineHit>, h: OnlineHit, via: string) {
  const k = hitKey(h);
  if (!k) return;
  const cur = pool.get(k);
  if (!cur) {
    pool.set(k, { ...h, via: [...new Set([...(h.via ?? []), via].filter(Boolean))] });
    return;
  }
  cur.via = [...new Set([...(cur.via ?? []), ...(h.via ?? []), via].filter(Boolean))];
  cur.doi ??= h.doi;
  cur.arxiv_id ??= h.arxiv_id;
  cur.in_library ??= h.in_library;
  cur.open_access ||= h.open_access;
  if (h.cited_by != null) cur.cited_by = Math.max(cur.cited_by ?? 0, h.cited_by);
}

/** Pool order for the selection prompt: found by several queries / seeds, then citations, then open access. */
const hitScore = (h: OnlineHit) => (h.via?.length ?? 1) * 2 + (h.cited_by ? Math.log10(h.cited_by + 1) : 0) + (h.open_access ? 0.5 : 0);

/**
 * All queries in one batch while the run is still untainted (the queries were written from the request alone), then
 * citation snowballing of the top hits (only their identifiers leave the hub), then the run is tainted by the
 * results — later steps never search again (the open-world rule of the engine).
 */
type SearchBatch = { hits: OnlineHit[]; seeds: string[]; searched: boolean; errors: string[]; queries: string[] };
const OWN_SEARCH = "線上搜尋結果";

export async function searchOnline(env: WorkflowEnv, queries: string[]): Promise<SearchBatch> {
  await env.refresh();
  // Results of an earlier batch of this run (stored before anything else happens): a job interrupted after searching
  // (redeploy, crash) resumes with them instead of an empty pool.
  const stored = env.state<SearchBatch>("topic_search");
  if (stored?.searched) return stored;
  // Tainted only by our own search (its results were lost before they were stored): the queries still come from the
  // request alone, so searching again sends nothing new out. Any other untrusted content blocks open-world calls.
  const ownOnly = env.run.taint_sources.length > 0 && env.run.taint_sources.every((t) => t === OWN_SEARCH);
  if ((env.run.tainted && !ownOnly) || !queries.length) return { hits: [], seeds: [], searched: false, errors: [], queries };
  const pool = new Map<string, OnlineHit>();
  const errors: string[] = [];
  for (const q of queries) {
    await env.activity("research", "researcher", `線上搜尋論文「${q}」`);
    try {
      for (const h of await deps.search(env, q)) addHit(pool, h, `查詢「${q}」`);
    } catch (e) {
      errors.push(`「${q}」：${(e as Error).message ?? "搜尋失敗"}`.slice(0, 160));
    }
  }
  const seeds = [...pool.values()].filter((h) => h.doi || h.arxiv_id).sort((a, b) => hitScore(b) - hitScore(a)).slice(0, SEEDS);
  for (const s of seeds) {
    await env.activity("research", "researcher", `追蹤〈${clipText(s.title, 40)}〉的參考文獻與被引`);
    try {
      for (const h of await deps.snowball(env, s)) addHit(pool, h, "");
    } catch (e) {
      errors.push(`引用追蹤〈${clipText(s.title, 40)}〉：${(e as Error).message ?? "失敗"}`.slice(0, 160));
    }
  }
  const batch: SearchBatch = { hits: [...pool.values()].sort((a, b) => hitScore(b) - hitScore(a)).slice(0, 60), seeds: seeds.map((s) => s.title), searched: true, errors, queries };
  // Stored first, then tainted: a resume never finds a tainted run without its results.
  await env.setState({ topic_search: batch });
  await markTainted(env.db, env.run.id, OWN_SEARCH);
  env.run.tainted = true;
  env.run.taint_sources = [...new Set([...env.run.taint_sources, OWN_SEARCH])];
  return batch;
}

// ---------------------------------------------------------------- deterministic checks

/** Cite keys used as `[@key]` / `[@a; @b, p. 3]`. */
export function citedKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[([^\]\n]*@[^\]\n]*)\]/g)) for (const k of m[1]!.matchAll(/@([\w:.-]+)/g)) out.add(k[1]!.replace(/[.:-]+$/, ""));
  return out;
}

/** Body of the `## title` section (up to the next `## ` / `# `), or null. */
export function sectionOf(text: string, title: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+/.test(l) && titleMatches(title, l.replace(/^##\s+/, "").trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s+/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/**
 * English headings a model writes for the parts when the artifact is English (the extraction is internal; its headings
 * are asked in Chinese, but a cheap model follows the language reminder).
 */
const PART_ALIASES: Record<string, string[]> = {
  "一句話": ["One-sentence summary", "One sentence summary", "Summary", "One-liner"],
  "方法": ["Method", "Methods", "Approach"],
  "注入位置": ["Injection point", "Where the bias is injected", "Injection"],
  "注入位置與訓練／推論": ["Injection point and training / inference", "Injection point and training/inference", "Injection point", "Training vs. inference", "Injection"],
  "關鍵公式": ["Key equations", "Key formulas", "Equations", "Formulas"],
  "實驗設定": ["Experimental setup", "Experiment setup", "Setup"],
  "數字表": ["Numbers table", "Results table", "Number table", "Numbers", "Results"],
  "限制": ["Limitations", "Limits"],
  "子問題對應": ["Sub-question mapping", "Sub-questions", "Mapping to sub-questions"],
};
const partHead = (part: string, heading: string) => titleMatches(part, heading) || (PART_ALIASES[part] ?? []).some((a) => heading.toLowerCase().startsWith(a.toLowerCase()) || titleMatches(a, heading));

/** One `#### part` of a paper extraction (up to the next `####` / `###`), trimmed; "" when absent (English headings accepted). */
export function extractPart(notes: string, part: string): string {
  const lines = notes.split("\n");
  const start = lines.findIndex((l) => /^####\s+/.test(l) && partHead(part, l.replace(/^####\s+/, "").replace(/[*_`]/g, "").trim()));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^#{2,4}\s+/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

const tableLines = (text: string) => text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l));
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}/.test(line);
const dataRows = (text: string) => tableLines(text).slice(1).filter((l) => !isSeparator(l));

/** Method names of the 方法分類 table (first column, Markdown and citations stripped). */
export function taxonomyMethods(text: string): string[] {
  const sec = sectionOf(text, "方法分類") ?? text;
  return dataRows(sec).map((l) => cells(l)[0] ?? "").map((c) => c.replace(/\[[^\]]*@[^\]]*\]/g, "").replace(/[*_`]/g, "").trim()).filter(Boolean).slice(0, 12);
}

type CheckData = { keys?: string[]; methods?: string[]; source?: string; abstract_only?: string[]; full?: string[]; with_numbers?: string[]; draft_keys?: string[] };
const dataOf = (data: unknown) => (data ?? {}) as CheckData;
const keysOf = (data: unknown) => new Set((dataOf(data).keys ?? []).filter((k): k is string => typeof k === "string"));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Detail markers that need the full text: §, page, equation, table / figure numbers. */
const DETAIL_RE = /§\s*\d|\bpp?\.\s*\d|頁\s*\d|第\s*\d+\s*頁|式\s*[（(]?\d|\bEq\.?\s*\(?\d|Table\s*\d|表\s*\d|Fig(?:ure|\.)\s*\d|圖\s*\d/;
/** Disclaimers that contradict having read the full text. */
const LIMITED_RE = /僅依摘要|僅依定位|僅有定位|定位層級|無完整內文|沒有(?:完整)?內文|沒有全文|只有標題|只讀(?:了|到)?摘要/;
const TRUNCATED_RE = /(?:筆記|資料|內容|全文|來源)[^。\n]{0,6}(?:被|已|遭)?截斷|截斷的(?:筆記|資料|內容)/;

/** Checks of this playbook (registered into the engine's check table; params/keys come from the step data). */
export const TOPIC_CHECKS: typeof CHECKS = {
  /** Every `[@key]` is a cite key of the study library (`data.keys`), and at least `min` are used. */
  topic_cites(text, { params, data }) {
    const keys = keysOf(data);
    const used = citedKeys(text);
    const unknown = [...used].filter((k) => !keys.has(k));
    if (unknown.length) return { ok: false, detail: `這些引用鍵不在研究的文獻庫中：${unknown.slice(0, 10).join("、")}。只能使用：${[...keys].slice(0, 30).join("、") || "（文獻庫是空的）"}。` };
    const min = num(params.min, 1);
    if (used.size < min) return { ok: false, detail: `引用太少：用了 ${used.size} 個，至少需要 ${min} 個（用 [@key]；可用：${[...keys].slice(0, 30).join("、")}）。` };
    return { ok: true, detail: `引用 ${used.size} 筆，皆在文獻庫中` };
  },
  /** The 方法分類 table: the five columns, ≥ `min` rows, each row cites a library paper. */
  topic_taxonomy(text, { params, data }) {
    const sec = sectionOf(text, "方法分類");
    if (sec === null) return { ok: false, detail: "缺少「## 方法分類」段落。" };
    const lines = tableLines(sec);
    if (lines.length < 2) return { ok: false, detail: `「## 方法分類」需要一個 Markdown 表格（欄位：${TAXONOMY_COLUMNS.join("｜")}）。` };
    const head = cells(lines[0]!);
    const missing = TAXONOMY_COLUMNS.filter((c) => !head.some((h) => h.includes(c)));
    if (missing.length) return { ok: false, detail: `方法分類表缺少欄位：${missing.join("、")}（欄位依序為 ${TAXONOMY_COLUMNS.join("｜")}）。` };
    const rows = dataRows(sec);
    const min = num(params.min, 2);
    if (rows.length < min) return { ok: false, detail: `方法分類表只有 ${rows.length} 列，至少需要 ${min} 類做法。` };
    const keys = keysOf(data);
    const bad = rows.filter((r) => ![...citedKeys(r)].some((k) => !keys.size || keys.has(k))).map((r) => cells(r)[0] ?? "");
    return bad.length ? { ok: false, detail: `這些做法沒有引用代表論文（[@key]，只能用文獻庫的 key）：${bad.slice(0, 8).join("、")}。` } : { ok: true, detail: `${rows.length} 類做法，每類都有代表論文` };
  },
  /** 各方法詳解: a `### ` subsection per taxonomy method (`data.methods`), each citing ≥ 1 library paper. */
  topic_approaches(text, { params, data }) {
    const sec = sectionOf(text, "各方法詳解");
    if (sec === null) return { ok: false, detail: "缺少「## 各方法詳解」段落。" };
    const subs = sec.split(/^(?=###\s)/m).filter((p) => p.startsWith("###"));
    const min = num(params.min, 2);
    if (subs.length < min) return { ok: false, detail: `「## 各方法詳解」只有 ${subs.length} 個「### 方法」小節，至少需要 ${min} 個（方法分類表的每一列一節）。` };
    const keys = keysOf(data);
    const uncited = subs.filter((p) => ![...citedKeys(p)].some((k) => !keys.size || keys.has(k))).map((p) => p.split("\n")[0]!.replace(/^###\s+/, "").trim());
    if (uncited.length) return { ok: false, detail: `這些方法小節沒有引用論文（[@key]）：${uncited.slice(0, 8).join("、")}。` };
    const methods = dataOf(data).methods ?? [];
    const heads = subs.map((p) => p.split("\n")[0]!.replace(/^###\s+/, "").trim());
    const absent = methods.filter((m) => !heads.some((h) => titleMatches(m, h)));
    return absent.length ? { ok: false, detail: `方法分類表的這些做法沒有對應的「### 」小節（名稱要和表格一致）：${absent.slice(0, 8).join("、")}。` } : { ok: true, detail: `${subs.length} 個方法小節，都有引用` };
  },
  /** Numbers in the 實驗結果比較 tables come from what the researchers extracted (`data.source`). */
  topic_numbers(text, { data }) {
    const sec = sectionOf(text, "實驗結果比較") ?? text;
    return CHECKS.numbers_from_source!(sec, { params: { source: String(dataOf(data).source ?? "") }, data });
  },
  /** Every paper whose extraction has a numbers table (`data.with_numbers`) has a row in 實驗結果比較. */
  topic_results_coverage(text, { data }) {
    const sec = sectionOf(text, "實驗結果比較");
    if (sec === null) return { ok: false, detail: "缺少「## 實驗結果比較」段落。" };
    const rows = dataRows(sec);
    const missing = (dataOf(data).with_numbers ?? []).filter((k) => !rows.some((r) => citedKeys(r).has(k)));
    return missing.length ? { ok: false, detail: `這些論文有報告數字，但結果比較表沒有它們的列：${missing.map((k) => `[@${k}]`).join("、")}。每篇至少放一列主要結果（數字照它的數字表，標表號／頁碼）。` } : { ok: true, detail: `結果比較表涵蓋 ${rows.length} 列` };
  },
  /**
   * Labels match what was read: an abstract-only paper is never cited with §/page/equation/table detail, a full-text
   * paper is never described as abstract-only / 「僅有定位」, and no 「筆記被截斷」 disclaimers.
   */
  topic_consistency(text, { data }) {
    const d = dataOf(data);
    const problems: string[] = [];
    for (const k of d.abstract_only ?? []) {
      for (const m of text.matchAll(new RegExp(`\\[[^\\]\\n]*@${escapeRe(k)}\\b[^\\]\\n]*\\]([^\\n[]{0,24})`, "g"))) {
        if (DETAIL_RE.test(m[0])) {
          problems.push(`[@${k}] 只讀了摘要，不能標章節／頁碼／公式／表號（「${clipText(m[0], 40)}」）`);
          break;
        }
      }
    }
    for (const k of d.full ?? []) {
      const line = text.split("\n").find((l) => l.includes(`@${k}`) && LIMITED_RE.test(l));
      if (line) problems.push(`[@${k}] 讀了全文，卻被寫成只有摘要／定位（「${clipText(line.trim(), 50)}」）`);
    }
    const t = TRUNCATED_RE.exec(text);
    if (t) problems.push(`有「${t[0]}」之類的免責說明：資料是完整的，刪掉這句，缺的內容寫「資料未提供」`);
    return problems.length ? { ok: false, detail: `前後不一致：${problems.slice(0, 6).join("；")}。` } : { ok: true, detail: "論文標示與引用細節一致" };
  },
  /** Table cells stay short (≤ 60 chars without citations); details belong in the sections. */
  topic_concise(text) {
    const long: string[] = [];
    for (const l of tableLines(text)) {
      if (isSeparator(l)) continue;
      for (const c of cells(l)) {
        const bare = c.replace(/\[[^\]]*@[^\]]*\]/g, "").replace(/（[^）]*(?:p\.|§|表|頁)[^）]*）/g, "").trim();
        if (bare.length > CELL_MAX) long.push(clipText(bare, 24));
      }
    }
    return long.length ? { ok: false, detail: `${long.length} 個表格儲存格太長（> ${CELL_MAX} 字，例如「${long.slice(0, 3).join("」「")}」）：表格只寫關鍵詞（≤ 40 字），細節放到各方法小節。` } : { ok: true, detail: "表格精簡" };
  },
  /** Overall length of a note body. */
  topic_length(text, { params }) {
    const max = num(params.max, NOTE_MAX_CHARS);
    const n = text.trim().length;
    return n <= max ? { ok: true, detail: `${n} 字` } : { ok: false, detail: `內容太長：${n} 字，請精簡到 ${max} 字以內（刪除表格與小節之間重複的句子，保留所有引用與數字）。` };
  },
  /** The consistency pass keeps (almost) every citation of the draft (`data.draft_keys`). */
  topic_keep_cites(text, { data }) {
    const want = dataOf(data).draft_keys ?? [];
    const used = citedKeys(text);
    const lost = want.filter((k) => !used.has(k));
    return lost.length > Math.floor(want.length * 0.1) ? { ok: false, detail: `精簡後少了這些引用：${lost.map((k) => `[@${k}]`).join("、")}；保留草稿中每一篇論文的引用。` } : { ok: true, detail: "引用都保留了" };
  },
  /**
   * A paper extraction (≥ 300 chars, cites its key). Full text: the parts 方法 / 注入位置 / 數字表 and ≥ 2 page refs;
   * abstract only: the 「僅依摘要」 label and no page / equation detail.
   */
  topic_reading(text, { data }) {
    const d = (data ?? {}) as { cite_key?: string; has_pdf?: boolean; skipped?: boolean };
    if (d.skipped) return { ok: true, detail: "這篇沒有匯入，略過" };
    if (text.trim().length < 300) return { ok: false, detail: `摘錄太短：${text.trim().length} 字，至少需要 300 字。` };
    if (d.cite_key && !citedKeys(text).has(d.cite_key)) return { ok: false, detail: `摘錄要用 [@${d.cite_key}] 標出這篇論文。` };
    if (d.has_pdf === false) {
      if (!text.includes(ABSTRACT_ONLY)) return { ok: false, detail: `這篇沒有全文 PDF：開頭要寫「（${ABSTRACT_ONLY}）」，而且不要寫摘要以外的細節。` };
      return DETAIL_RE.test(text) ? { ok: false, detail: "只讀了摘要，不能標章節、頁碼、公式或表號；刪掉這些細節。" } : { ok: true, detail: "只有摘要，已標示" };
    }
    const missing = ["方法", "注入位置", "數字表"].filter((p) => !extractPart(text, p));
    if (missing.length) return { ok: false, detail: `摘錄缺少這些部分（用「#### 」小標）：${missing.join("、")}。` };
    const pages = (text.match(/p\.\s*\d|pp\.\s*\d|頁\s*\d|第\s*\d+\s*頁/g) ?? []).length;
    return pages >= 2 ? { ok: true, detail: `標註 ${pages} 處頁碼` } : { ok: false, detail: `頁碼標註不足：${pages} 處，至少 2 處（例如（p. 4）、表 2（p. 6））。` };
  },
};
Object.assign(CHECKS, TOPIC_CHECKS);

// ---------------------------------------------------------------- planning

type Decomposition = { title?: string; topic?: string; subquestions: { q: string; keywords?: string[]; queries?: string[] }[]; queries?: string[] };
const isDecomposition = (v: unknown): v is Decomposition => !!v && typeof v === "object" && Array.isArray((v as Decomposition).subquestions);

type Selection = { library?: { id: string; reason?: string; role?: string }[]; candidates?: { n: number; reason?: string; role?: string }[]; excluded?: { n: number; reason?: string }[] };
const isSelection = (v: unknown): v is Selection => !!v && typeof v === "object" && (Array.isArray((v as Selection).candidates) || Array.isArray((v as Selection).library));

/** A query that may leave the hub: keywords only (no URLs, no long tokens, ≤ 12 words / 120 chars). */
export function keywordQuery(q: string): string {
  return q.replace(/https?:\/\/\S+/gi, " ").replace(/[A-Za-z0-9+/_=-]{40,}/g, " ").replace(/[^\p{L}\p{N}\s+\-/.]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 12).join(" ").slice(0, 120);
}

/** Fallback queries from the request: its Latin keywords (「Zipformer RNN-T streaming ASR contextual biasing」). */
const latinQuery = (request: string) => keywordQuery((request.match(/[A-Za-z][A-Za-z0-9+\-/.]*/g) ?? []).filter((w) => w.length > 1).join(" "));

const DEFAULT_SUBQS = ["這個問題要解決什麼？怎麼評估（指標、資料集）？", "主要有哪幾類做法？核心想法與差別是什麼？", "各做法的實驗結果如何？在什麼條件下比較好？", "還有哪些尚未解決的問題？"];

/** Library papers for a topic when the selection came back empty: by keyword overlap with the topic, full text first. */
export function libraryFallback(library: LibPaper[], topic: string): Pick[] {
  const want = textTokens(topic);
  const score = (p: LibPaper) => [...textTokens(`${p.title} ${p.abstract ?? ""}`)].filter((t) => want.has(t)).length;
  const ranked = library.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || Number(b.p.has_pdf) - Number(a.p.has_pdf));
  const related = ranked.filter((x) => x.s > 0);
  return (related.length ? related : ranked).slice(0, LIBRARY_FALLBACK).map(({ p }) => ({ kind: "library" as const, paper_id: p.id, title: p.title, year: p.year, cite_key: p.cite_key, has_pdf: p.has_pdf, reason: "研究文獻庫中與主題相關（線上沒有可匯入的結果）", role: "core" as const }));
}

export async function libraryPapers(env: WorkflowEnv, studyId: string): Promise<LibPaper[]> {
  return (await env.db.query<LibPaper>(
    `SELECT p.id, p.title, p.year, sp.cite_key, (p.pdf_key IS NOT NULL) AS has_pdf, left(p.abstract, 400) AS abstract, p.authors_text, p.venue, p.arxiv_id, p.doi
       FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 ORDER BY sp.created_at DESC LIMIT 40`,
    [studyId],
  )).rows;
}

const studyKeys = async (env: WorkflowEnv) =>
  env.run.study_id ? (await env.db.query<{ cite_key: string }>("SELECT cite_key FROM study_papers WHERE study_id=$1", [env.run.study_id])).rows.map((r) => r.cite_key) : [];

export async function decompose(env: WorkflowEnv, studyTitle: string, stack: string[]): Promise<{ title: string; topic: string; subqs: SubQuestion[]; queries: string[] }> {
  // Only the user's own words + the study title: the queries written here may leave the hub.
  const user = [
    `使用者的要求：${env.run.request}`,
    env.guidanceText(),
    // The study's name is where the work is filed, not the topic (production 0668a3d7: 〈…效率研究〉 turned a hotword
    // survey into 「how to define efficiency」).
    `研究名稱（只是背景：主題與子問題只照使用者的要求，不要把研究名稱裡的詞當成主題或子問題）：〈${studyTitle}〉`,
    "把這個主題拆成 3–6 個具體的子問題（例如：問題定義與評估方式、有哪幾類做法、各做法放在模型的哪裡、結果比較、限制），每個子問題附 2–4 個英文關鍵字。",
    "每個子問題再寫 1–3 個英文學術搜尋查詢（query expansion：同義詞、不同說法、你知道的經典方法名稱或代表作的關鍵字，例如 \"contextual biasing RNN-T\"、\"deep context listen attend spell\"）；另外寫 1–2 個找經典／綜述的查詢（\"survey\"、\"seminal\" 方向）。",
    stack.length ? `使用者提到具體的工具／模型（${stack.join("、")}）：加 1–2 個查詢找它的實作或在它上面做這個主題的論文。` : "",
    "查詢只能是主題關鍵字（每個 ≤ 8 個字）；不要放句子、人名、網址或研究的私人內容。",
    '只輸出 JSON：{"title":"簡短主題（≤ 30 字，取自使用者的要求）","topic":"一句話主題","subquestions":[{"q":"子問題","keywords":["…"],"queries":["…"]}],"queries":["經典／綜述查詢"]}',
  ].filter(Boolean).join("\n\n");
  const { value } = await env.callJson<Decomposition>({ purpose: "topic_plan", role: "orchestrator", messages: [{ role: "system", content: systemFor("planner", "你是主要的協調者（orchestrator），負責規劃主題調研。") }, { role: "user", content: user }], maxTokens: 4000 }, isDecomposition);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const subqs: SubQuestion[] = (value?.subquestions ?? [])
    .filter((s) => s && typeof s.q === "string" && s.q.trim())
    .slice(0, 6)
    .map((s) => ({
      q: clipText(s.q.trim(), 160),
      keywords: strs(s.keywords).map(keywordQuery).filter(Boolean).slice(0, 4),
      queries: [...new Set(strs(s.queries).map(keywordQuery).filter((q) => q.length >= 3))].slice(0, 3),
    }));
  // Round-robin over the sub-questions so every one gets searched before the cap, then the general queries.
  const ordered: string[] = [];
  for (let i = 0; i < 3; i++) for (const s of subqs) if (s.queries?.[i]) ordered.push(s.queries[i]!);
  // The survey / seminal queries right after the first query of every sub-question.
  ordered.splice(subqs.filter((s) => s.queries?.[0]).length, 0, ...strs(value?.queries).map(keywordQuery).filter((q) => q.length >= 3).slice(0, 2));
  const queries = [...new Set(ordered)].slice(0, MAX_QUERIES);
  const fallbackQuery = latinQuery(env.run.request);
  return {
    title: clipText((value?.title ?? "").trim() || env.run.request.split("\n")[0]!, 60),
    topic: clipText((value?.topic ?? "").trim() || env.run.request, 200),
    subqs: subqs.length >= 2 ? subqs : DEFAULT_SUBQS.map((q) => ({ q, keywords: [] })),
    queries: queries.length ? queries : fallbackQuery.length >= 3 ? [fallbackQuery] : [],
  };
}

const ROLE_LABEL: Record<PickRole, string> = { seminal: "經典", recent: "近期", core: "核心" };
const asRole = (v: unknown): PickRole | undefined => (v === "seminal" || v === "recent" || v === "core" ? v : undefined);

export async function select(env: WorkflowEnv, st: { topic: string; subqs: SubQuestion[]; hits: OnlineHit[]; stack: string[]; max?: number; maxLibrary?: number; libraryRule?: string }, library: LibPaper[]): Promise<{ picks: Pick[]; excluded: { title: string; reason: string }[] }> {
  const maxLibrary = st.maxLibrary ?? MAX_LIBRARY;
  if (!st.hits.length && !library.length) return { picks: [], excluded: [] };
  const importable = (h: OnlineHit) => !!(h.doi || h.arxiv_id || h.in_library);
  const year = new Date().getFullYear();
  const user = [
    `主題：${st.topic}`,
    `子問題：\n${st.subqs.map((s, i) => `${i + 1}. ${s.q}`).join("\n")}`,
    env.guidanceText(),
    dataBlock("online_hits", st.hits.map((h, i) => `[${i}] ${h.title}（${h.year ?? "?"}；${h.venue ?? "venue 不明"}${h.cited_by != null ? `；被引 ${h.cited_by}` : ""}${h.open_access ? "；有開放取用全文" : ""}${h.in_library ? "；已在實驗室文獻庫" : ""}${importable(h) ? "" : "；沒有 DOI/arXiv，不能匯入"}；來源：${(h.via ?? []).slice(0, 2).join("、")}）\n${clipText(h.abstract ?? "", 200)}`).join("\n\n") || "（沒有線上結果）"),
    dataBlock("study_library", library.map((p) => `${p.id}｜${p.title}（${bibLine(p) || p.year || "?"}）[@${p.cite_key}]${p.has_pdf ? "" : "（沒有 PDF）"}\n${clipText(p.abstract ?? "", 200)}`).join("\n\n") || "（研究文獻庫是空的）"),
    [
      `選出 ${st.max && st.max < 8 ? `${Math.max(3, st.max - 2)}–${st.max}` : `8–${st.max ?? 12}`} 篇最能回答子問題的論文：研究文獻庫中相關的（≤ ${maxLibrary} 篇，用 id），以及要匯入的線上候選（≤ ${MAX_ONLINE} 篇，用 [編號]）。`,
      st.libraryRule ?? "",
      `要兼顧：經典（role "seminal"：被引很多或最早提出該類做法的代表作，至少 2 篇）與近期（role "recent"：${year - 3} 年以後，至少 3 篇），其他直接相關的標 "core"；每類做法至少一篇代表作；優先正式發表（venue）與有開放取用全文的。`,
      st.stack.length ? `使用者用 ${st.stack.join("、")}：有在它上面實作或可直接套用的論文要選。` : "",
      "不能匯入的不要選；和文獻庫重複的不要再選；離題的不要選。每篇一句理由（相關性、venue、年份、被引）。",
      "另外列出最多 8 篇你看過但沒選的代表性結果與原因（離題、重複、太舊被取代、不能匯入…）。",
    ].filter(Boolean).join("\n"),
    '只輸出 JSON：{"library":[{"id":"…","reason":"…","role":"core"}],"candidates":[{"n":0,"reason":"…","role":"seminal"}],"excluded":[{"n":3,"reason":"…"}]}',
  ].filter(Boolean).join("\n\n");
  const { value } = await env.callJson<Selection>({ purpose: "topic_select", role: "planner", messages: [{ role: "system", content: systemFor("planner") }, { role: "user", content: user }], maxTokens: 8000 }, isSelection);
  const picks: Pick[] = [];
  const libPick = (p: LibPaper, reason: unknown, role: unknown) => {
    if (!picks.some((x) => x.kind === "library" && x.paper_id === p.id)) picks.push({ kind: "library", paper_id: p.id, title: p.title, year: p.year, cite_key: p.cite_key, has_pdf: p.has_pdf, reason: clipText(String(reason ?? ""), 200), role: asRole(role), ...(bibLine(p) ? { bib: bibLine(p) } : {}) });
  };
  for (const l of (value?.library ?? []).slice(0, maxLibrary)) {
    const p = library.find((x) => x.id === l?.id);
    if (p) libPick(p, l.reason, l.role);
  }
  const inStudy = new Set(library.map((p) => p.id));
  const chosen = value ? (value.candidates ?? []) : st.hits.map((_, n) => ({ n, reason: "", role: undefined }));
  for (const c of chosen) {
    if (picks.filter((p) => p.kind === "online").length >= MAX_ONLINE) break;
    const h = typeof c?.n === "number" ? st.hits[c.n] : undefined;
    if (!h || !importable(h)) continue;
    if (h.in_library && inStudy.has(h.in_library)) {
      // Already a study paper: read it from the library instead of importing.
      libPick(library.find((x) => x.id === h.in_library)!, c.reason, c.role);
      continue;
    }
    if (picks.some((x) => x.kind === "online" && hitKey(x.hit) === hitKey(h))) continue;
    picks.push({ kind: "online", hit: h, reason: clipText(String(c.reason ?? ""), 200), role: asRole(c.role) });
  }
  const excluded = (value?.excluded ?? [])
    .map((x) => ({ h: typeof x?.n === "number" ? st.hits[x.n] : undefined, reason: clipText(String(x?.reason ?? ""), 120) }))
    .filter((x): x is { h: OnlineHit; reason: string } => !!x.h && !picks.some((p) => p.kind === "online" && hitKey(p.hit) === hitKey(x.h!)))
    .slice(0, 8)
    .map((x) => ({ title: x.h.title, reason: x.reason || "未選" }));
  return { picks: picks.slice(0, st.max ?? MAX_PAPERS), excluded };
}

export const pickTitle = (p: Pick) => (p.kind === "library" ? p.title : p.hit.title);
export const pickLine = (p: Pick) => {
  const role = p.role ? `［${ROLE_LABEL[p.role]}］` : "";
  return p.kind === "library"
    ? `${role}〈${p.title}〉（${p.bib || p.year || "?"}，研究文獻庫 [@${p.cite_key}]${p.has_pdf ? "" : "，沒有 PDF"}）${p.reason ? `：${p.reason}` : ""}`
    : `${role}〈${p.hit.title}〉（${p.hit.year ?? "?"}${p.hit.venue ? `，${p.hit.venue}` : ""}${p.hit.cited_by != null ? `，被引 ${p.hit.cited_by}` : ""}${p.hit.arxiv_id ? `，arXiv ${p.hit.arxiv_id}` : p.hit.doi ? `，DOI ${p.hit.doi}` : ""}${p.hit.open_access ? "，開放取用" : ""}）${p.reason ? `：${p.reason}` : ""}`;
};

type WriterKey = "taxonomy" | "approaches" | "results" | "practice" | "discussion";
const writerKeys = (stack: string[]): WriterKey[] => ["taxonomy", "approaches", "results", ...(stack.length ? (["practice"] as const) : []), "discussion"];
const writerChecks = (sections: string[], extra: CheckSpec[], minCites = 1): CheckSpec[] => [{ id: "sections_present", params: { sections } }, ...extra, { id: "topic_cites", params: { min: minCites } }, { id: "topic_consistency" }, { id: "no_placeholder" }, { id: "not_truncated" }];
const CONCISE = "精簡：不要重複其他段落已寫的句子；表格儲存格只寫關鍵詞（≤ 40 字），細節放到各方法小節。";

/** Per paper (parallel): import (online picks) + a structured full-text extraction in a fresh context. */
export function paperSteps(picks: Pick[], opts: { only?: number[]; maxTools?: number } = {}): StepSpec[] {
  return picks.map((p, i): StepSpec => ({
    key: `paper_${i + 1}`,
    role: "researcher",
    title: p.kind === "online" ? `匯入並精讀〈${clipText(p.hit.title, 50)}〉` : `精讀〈${clipText(p.title, 50)}〉`,
    instructions: `${p.kind === "online" ? `把${pickLine(p)}匯入實驗室文獻庫並加入本研究（下載開放取用 PDF），再` : `對研究文獻庫中的${pickLine(p)}`}從全文做結構化摘錄：${EXTRACT_PARTS.join("、")}（數字照原文，標表號與頁碼）。沒有 PDF 時只依摘要，並清楚標示「${ABSTRACT_ONLY}」。`,
    inputs: { pick: i, ...(opts.maxTools ? { max_tools: opts.maxTools } : {}) },
    expected: `結構化摘錄（${EXTRACT_PARTS.join("／")}；[@key]、頁碼、表號）`,
    verify: { checks: [{ id: "topic_reading" }, { id: "not_truncated" }], judge: false },
  })).filter((_, i) => !opts.only || opts.only.includes(i));
}

/** Length budget of each section unit (chars): together ≈ NOTE_MAX_CHARS, without a whole-document rewrite. */
const WRITER_BUDGET: Record<WriterKey, number> = { taxonomy: 1800, approaches: 4000, results: 2200, practice: 1400, discussion: 1400 };
/** The note's outline units (`state.units`): one per section writer, with purpose and budget. */
export const topicUnits = (stack: string[], papers = 8) => writerKeys(stack).map((k) => ({ key: k, title: k === "practice" ? practiceTitle(stack) : WRITER_TITLE[k], budget: { chars: budgetOf(k, papers) } }));
/** A section's budget grows with the papers it covers beyond 8 (12 papers → × 1.5). */
const budgetOf = (k: WriterKey, papers: number) => Math.round(WRITER_BUDGET[k] * Math.max(1, papers / 8) / 100) * 100;
const WRITER_TITLE: Record<WriterKey, string> = { taxonomy: "問題定義與方法分類", approaches: "各方法詳解", results: "實驗結果比較", practice: "", discussion: "開放問題與研究關聯" };

/**
 * Steps after the planning-time research: one per paper, one writer per section (each a unit with its budget), and an
 * assemble that stitches the sections by code and removes contradictory disclaimers deterministically (no model pass over
 * the whole note), then final.
 */
export function laterSteps(picks: Pick[], stack: string[] = []): StepSpec[] {
  const papers = paperSteps(picks);
  const paperKeys = papers.map((p) => p.key);
  const sections = sectionsFor(stack);
  const writers: StepSpec[] = [
    { key: "taxonomy", role: "writer", title: "問題定義與方法分類", instructions: `寫「## 問題定義」（≤ 300 字：要解決什麼、輸入輸出、評估指標與常用資料集，只寫摘錄裡有的）與「## 方法分類」：一個 Markdown 表格，欄位依序為 ${TAXONOMY_COLUMNS.join("｜")}，每一列是一類做法（3–7 類，經典與近期的做法都要涵蓋），「代表論文」欄用 [@key]。表格後用 1–2 句說明分類依據。${CONCISE}`, depends_on: paperKeys, expected: "## 問題定義 + ## 方法分類（五欄表格）", verify: { checks: writerChecks(["問題定義", "方法分類"], [{ id: "topic_taxonomy", params: { min: 2 } }, { id: "topic_concise" }]), judge: true } },
    { key: "approaches", role: "writer", title: "各方法詳解", instructions: `寫「## 各方法詳解」：方法分類表的每一列一個「### 方法名」小節（名稱和表格一致，每節 ≤ 300 字），寫核心想法、怎麼接到模型（注入位置；需要訓練或只在推論時）、關鍵公式（LaTeX 並說明符號；摘錄有公式才寫）、優缺點，以及代表論文 [@key] 與頁碼。只寫摘錄裡有的內容；不要重複表格的句子。`, depends_on: [...paperKeys, "taxonomy"], expected: "## 各方法詳解（每類做法一個 ### 小節）", verify: { checks: writerChecks(["各方法詳解"], [{ id: "topic_approaches", params: { min: 2 } }]), judge: true } },
    { key: "results", role: "writer", title: "實驗結果比較", instructions: `寫「## 實驗結果比較」：Markdown 表格（欄位：論文｜資料集｜指標｜基線｜方法結果｜出處（表／頁）），**每一篇摘錄裡有數字表的論文至少一列主要結果**，數字照它的數字表抄並標表號／頁碼；同一列只放同一資料集、同一指標的數字。表格後 1–3 句說明哪些可以互相比較、哪些不行（資料集或指標不同）。${CONCISE}`, depends_on: [...paperKeys, "taxonomy"], expected: "## 實驗結果比較（每篇有數字的論文至少一列）", verify: { checks: writerChecks(["實驗結果比較"], [{ id: "topic_numbers" }, { id: "topic_results_coverage" }, { id: "topic_concise" }], 0), judge: true } },
    ...(stack.length ? [{ key: "practice", role: "writer" as const, title: practiceTitle(stack), instructions: `寫「## ${practiceTitle(stack)}」：依摘錄說明在 ${stack.join("、")} 上落地各類做法：接在哪個元件（encoder／predictor／joiner／decoder／beam search…）、需要重新訓練還是只在推論時加、額外成本（延遲、參數量、記憶體，照論文數字）、論文是否在這個框架上做過。用條列或小表格，每點標 [@key]；摘錄沒有提到的實作細節寫「資料未提供」，不要憑印象補 API 或程式碼。`, depends_on: [...paperKeys, "taxonomy"], expected: `## ${practiceTitle(stack)}（落地方式、訓練或推論、成本）`, verify: { checks: writerChecks([practiceTitle(stack)], [], 1), judge: true } }] : []),
    { key: "discussion", role: "writer", title: "開放問題與研究關聯", instructions: "寫「## 開放問題」（論文自述的限制與尚未解決的問題，標 [@key]，≤ 6 點）與「## 與本研究的關係」（≤ 6 點）：說明哪些做法或結論和這個研究有關、可以參考什麼；只說明關聯，不替使用者決定方向、題目或時程。", depends_on: [...paperKeys, "taxonomy"], expected: "## 開放問題 + ## 與本研究的關係", verify: { checks: writerChecks(["開放問題", "與本研究的關係"], [], 0), judge: true } },
  ];
  const keys = writers.map((w) => w.key);
  return [
    ...papers,
    ...writers,
    { key: "assemble", role: "integrator", kind: "integrate", title: "拼接成一份研究筆記", instructions: "依大綱順序拼接各節（程式，不呼叫模型），刪掉互相矛盾的免責句，附上參考文獻與搜尋紀錄。", depends_on: keys, expected: "完整的研究筆記", verify: { checks: [{ id: "sections_present", params: { sections } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: false } },
    finalSpec(),
  ];
}

const outlineOf = (subqs: SubQuestion[]): OutlineItem[] => subqs.map((s, i) => ({ n: i + 1, title: s.q, points: s.keywords }));

function criteriaFor(subqs: SubQuestion[], stack: string[] = []): Omit<Criterion, "status">[] {
  const sections = sectionsFor(stack);
  return [
    { id: "sections", kind: "check", text: `包含${sections.join("、")}`, check: { id: "sections_present", params: { sections } } },
    { id: "taxonomy", kind: "check", text: `方法分類表有 ${TAXONOMY_COLUMNS.join("／")} 五欄，每類做法都有代表論文`, check: { id: "topic_taxonomy", params: { min: 2 } } },
    { id: "approaches", kind: "check", text: "每類做法都有詳解小節並引用至少一篇論文", check: { id: "topic_approaches", params: { min: 2 } } },
    { id: "cites", kind: "check", text: "引用都是研究文獻庫的 cite key", check: { id: "topic_cites", params: { min: 2 } } },
    { id: "numbers", kind: "check", text: "結果比較表的數字都來自論文摘錄", check: { id: "topic_numbers" } },
    { id: "coverage", kind: "check", text: "每篇有報告數字的論文都在結果比較表中", check: { id: "topic_results_coverage" } },
    { id: "consistency", kind: "check", text: "論文標示與引用細節一致（只讀摘要的不附頁碼細節；讀過全文的不寫成只有摘要）", check: { id: "topic_consistency" } },
    { id: "concise", kind: "check", text: "表格精簡（儲存格只寫關鍵詞，細節在小節中）", check: { id: "topic_concise" } },
    { id: "clean", kind: "check", text: "沒有佔位文字或被截斷的內容", check: { id: "no_placeholder" } },
    { id: "subq", kind: "judge", text: `回答了確認的 ${subqs.length} 個子問題（每個都有具體內容與出處）` },
    { id: "grounded", kind: "judge", text: "方法描述、公式與數字都來自論文（附頁碼／表號），只讀摘要的論文有標示「僅依摘要」，沒有捏造" },
    ...(stack.length ? [{ id: "practice", kind: "judge" as const, text: `「${practiceTitle(stack)}」說明了接在哪裡、需要訓練或只在推論、成本，且只根據來源` }] : []),
    { id: "assist", kind: "judge", text: "「與本研究的關係」只說明關聯與可參考之處，沒有替使用者決定研究方向或時程" },
  ];
}

async function plan(env: WorkflowEnv): Promise<PlanResult> {
  const access = await studyOrQuestion(env);
  if ("question" in access) return { kind: "question", question: access.question, setup: true };
  await env.activity("research", "orchestrator", "拆解主題與子問題");
  const prev = env.state<TopicState>("topic");
  const stack = stackOf(`${env.run.request}\n${env.run.guidance.map((g) => g.text).join("\n")}`);
  const d = await decompose(env, access.study.title, stack);
  // Search once per run: after the first batch the run is tainted, a re-plan (修改) reuses the earlier results.
  const found = await searchOnline(env, d.queries);
  const hits = found.searched ? found.hits : prev?.hits ?? [];
  const library = await libraryPapers(env, access.study.id);
  await env.activity("research", "planner", "挑選候選論文");
  const sel = await select(env, { topic: d.topic, subqs: d.subqs, hits, stack }, library);
  const { excluded } = sel;
  let picks = sel.picks;
  // Nothing importable online (or no usable selection) while the study's library has papers: work from the library
  // instead of stopping on a question (production eval: autopilot stopped although the library had 10 relevant papers).
  if (!picks.length && library.length) {
    picks = libraryFallback(library, `${d.topic}\n${d.subqs.map((q) => q.q).join("\n")}\n${env.run.request}`);
    await env.note(`線上沒有找到可以匯入的論文，改用研究文獻庫中的 ${picks.length} 篇論文繼續。`, "warn");
  }
  const st: TopicState = {
    topic: d.topic, subqs: d.subqs, queries: found.searched ? found.queries : prev?.queries ?? [], seeds: found.searched ? found.seeds : prev?.seeds ?? [],
    hits, picks, excluded, searched: found.searched || !!prev?.searched, search_errors: found.errors, stack,
  };
  const title = `主題調研：${d.title}`;
  await env.setState({ topic: st, note_title: clipText(title, 190), sections: sectionsFor(stack), units: topicUnits(stack, picks.length) });
  if (!picks.length) {
    const tried = d.queries.length ? `（線上搜尋：${d.queries.map((q) => `「${q}」`).join("、")}${found.errors.length ? `；${found.errors[0]}` : ""}）` : "";
    return { kind: "question", question: `找不到和這個主題相關、可以匯入的論文${tried}。請在補充指示提供更具體的英文關鍵字、論文標題或 arXiv 編號，或先把論文加入研究文獻庫後按「繼續」。` };
  }
  const online = picks.filter((p) => p.kind === "online");
  const lib = picks.filter((p) => p.kind === "library");
  const brief = [
    `# 主題：${d.topic}`,
    `## 子問題\n${d.subqs.map((s, i) => `${i + 1}. ${s.q}${s.queries?.length ? `（查詢：${s.queries.join("；")}）` : ""}`).join("\n")}`,
    `## 線上搜尋（只送出關鍵字）\n${st.searched ? st.queries.map((q) => `- ${q}`).join("\n") || "- （沒有查詢）" : "- 這次沒有線上搜尋（流程已讀過外部內容，沿用先前的結果）"}${st.seeds.length ? `\n- 引用追蹤：${st.seeds.map((s) => `〈${clipText(s, 50)}〉`).join("、")}` : ""}${found.errors.length ? `\n- 失敗：${found.errors.join("；")}` : ""}\n- 共 ${hits.length} 筆候選`,
    `## 要匯入的論文（${online.length}）\n${online.map((p) => `- ${pickLine(p)}`).join("\n") || "- （沒有）"}`,
    `## 研究文獻庫中相關的論文（${lib.length}）\n${lib.map((p) => `- ${pickLine(p)}`).join("\n") || "- （沒有）"}`,
    excluded.length ? `## 沒有選的代表性結果\n${excluded.map((x) => `- 〈${clipText(x.title, 70)}〉：${x.reason}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const research: StepSpec = { key: "research", role: "researcher", title: "拆解主題、線上搜尋與挑選論文", instructions: "拆成子問題、用關鍵字線上搜尋並追蹤引用、挑選候選與文獻庫中相關的論文。", expected: "子問題 + 候選論文（含理由）", verify: { checks: [], judge: false }, done: { output: { summary: `${d.subqs.length} 個子問題、${st.queries.length} 個查詢、${hits.length} 筆候選 → ${online.length} 篇匯入、${lib.length} 篇文獻庫論文`, text: brief } } };
  return {
    kind: "plan",
    title,
    studyId: access.study.id,
    objective: `調研「${clipText(d.topic, 120)}」：回答 ${d.subqs.length} 個子問題，讀 ${picks.length} 篇論文（經典與近期），整理問題定義、做法分類、各方法細節、實驗結果比較${stack.length ? `、在 ${stack.join("／")} 上的落地方式` : ""}與開放問題，引用研究文獻庫的論文，寫成一份新的研究筆記。`,
    criteria: criteriaFor(d.subqs, stack),
    plan: {
      summary: `把主題拆成 ${d.subqs.length} 個子問題（下方大綱，可修改），用 ${st.queries.length} 個關鍵字查詢與引用追蹤找到 ${hits.length} 筆候選；${online.length ? `匯入 ${online.length} 篇、` : ""}${lib.length ? `加上研究文獻庫的 ${lib.length} 篇，` : ""}由研究者子代理平行從全文做結構化摘錄（方法、注入位置、公式、數字表，附頁碼），再寫做法分類表、各方法詳解、結果比較${stack.length ? "、落地方式" : ""}與開放問題，經一致性與精簡檢查後整合成新筆記（附搜尋紀錄）。不想匯入的論文可以在步驟中關掉。`,
      outline: outlineOf(d.subqs),
      writes: [
        { kind: "note", label: `新筆記「${clipText(title, 60)}」`, effect: "new" },
        // Not a draft: shared lab library rows + the study's reading list → waits for the user unless autopilot is on.
        ...(online.length ? [{ kind: "paper", label: `匯入 ${online.length} 篇論文到實驗室文獻庫並加入〈${clipText(access.study.title, 40)}〉（下載開放取用 PDF）` }] : []),
      ],
      notes: st.searched ? `線上搜尋只送出關鍵字：${st.queries.join("；")}${st.seeds.length ? `；引用追蹤只送出論文的 DOI／arXiv 編號` : ""}` : "這次沒有重新線上搜尋（沿用先前的結果）。",
    },
    steps: [research, ...laterSteps(picks, stack)],
  };
}

async function applyEdits(env: WorkflowEnv, edits: ApprovalEdits) {
  const st = env.state<TopicState>("topic");
  if (!edits.outline?.length || !st) return {};
  const subqs = edits.outline.slice(0, 8).map((o) => ({ q: clipText(o.title.trim(), 160), keywords: (o.points ?? []).map((p) => String(p).slice(0, 60)).filter(Boolean).slice(0, 4) })).filter((s) => s.q);
  if (!subqs.length) return {};
  await env.setState({ topic: { ...st, subqs } });
  return { outline: outlineOf(subqs), steps: laterSteps(st.picks, st.stack ?? []) };
}

// ---------------------------------------------------------------- execution

const subqText = (env: WorkflowEnv) => (env.state<TopicState>("topic")?.subqs ?? []).map((s, i) => `Q${i + 1}. ${s.q}`).join("\n");

export type ReadPaper = RunPaper & { notes: string };

/** The run's papers (imported / library) with their extractions, in plan order. */
export async function runPapers(env: WorkflowEnv): Promise<{ papers: ReadPaper[]; steps: StepRow[] }> {
  const steps = await getSteps(env.db, env.run.id);
  const papers = steps
    .filter((s) => s.key.startsWith("paper_") && s.status !== "skipped" && s.output?.text)
    .map((s) => ({ ...((s.output!.data ?? {}) as RunPaper & { skipped?: boolean }), notes: s.output!.text! }))
    .filter((p) => p.paper_id && !(p as { skipped?: boolean }).skipped);
  return { papers, steps };
}

async function importOrLibrary(env: WorkflowEnv, step: StepRow, pick: Pick): Promise<(RunPaper & { pdf_key?: string | null }) | { error: string }> {
  // Per-step state key: paper steps run in parallel and a shared map would lose entries.
  const done = env.state<RunPaper>(`import_${step.key}`);
  if (done) return done;
  let paper: RunPaper;
  if (pick.kind === "library") {
    const row = await getPaper(env.db, pick.paper_id);
    paper = { paper_id: pick.paper_id, cite_key: pick.cite_key, title: pick.title, year: pick.year, has_pdf: !!row?.pdf_key };
  } else {
    await env.activity(step.key, "researcher", `匯入〈${clipText(pick.hit.title, 40)}〉到文獻庫`);
    try {
      paper = await deps.importPaper(env, env.run.study_id!, pick.hit);
    } catch (e) {
      if (e instanceof WorkflowStop) throw e;
      return { error: (e as { message_zh?: string }).message_zh ?? (e as Error).message ?? "匯入失敗" };
    }
    await env.note(`已匯入〈${clipText(paper.title, 60)}〉[@${paper.cite_key}]${paper.has_pdf ? "（有全文 PDF）" : `（沒有 PDF，${ABSTRACT_ONLY}）`}。`);
  }
  await env.setState({ [`import_${step.key}`]: paper });
  return paper;
}

export async function readPaper(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const st = env.state<TopicState>("topic");
  const pick = st?.picks[Number(step.inputs.pick ?? -1)];
  if (!pick) return { summary: "找不到這篇論文的資料，略過", text: "（沒有這篇論文的資料，略過）", data: { skipped: true } };
  const got = await importOrLibrary(env, step, pick);
  // A paper that could not be imported is left out (the writers only cite papers in the study).
  if ("error" in got) return { summary: `未能匯入：${got.error}`.slice(0, 200), text: `〈${pickTitle(pick)}〉未能匯入（${got.error}），這篇不納入筆記。`, data: { skipped: true, error: got.error } };
  // The full text as a deterministic, results-weighted digest: the extraction never depends on how far a model read.
  const row = got.has_pdf ? await getPaper(env.db, got.paper_id) : null;
  const ft = row?.pdf_key ? await paperFullText(env.storage, row.pdf_key).catch(() => null) : null;
  const text = ft ? digest(ft, 14_000, { focus: RESULTS_RE }) : "";
  const parts = EXTRACT_PARTS.map((p) => `#### ${p}`).join("、");
  const user = taskPrompt(env, step, {
    context: {
      paper: `論文：〈${got.title}〉${got.year ? `（${got.year}）` : ""}，paper_id ${got.paper_id}，引用鍵 [@${got.cite_key}]，${got.has_pdf ? "有全文 PDF：下方 paper_text 是全文摘錄（含頁碼）；公式、表格看不清或需要細節時用 read_paper（章節）或 view_paper_pages（頁面圖片）。" : `沒有全文 PDF：只能用 get_paper 讀摘要。開頭寫「（${ABSTRACT_ONLY}）」，不要寫章節、頁碼、公式或摘要以外的數字。`}`,
      subquestions: subqText(env),
      ...(text ? { paper_text: text } : {}),
    },
    format: `Markdown：開頭「### [@${got.cite_key}] ${clipText(got.title, 80)}」，接著依序用小標 ${parts}（小標照抄這些中文字，即使內容用英文寫；每部分精簡、具體；全篇約 1500–3000 字）。「#### 數字表」是 Markdown 表格（設定／方法｜資料集｜指標｜基線｜結果｜出處（表／頁）），把主要結果與消融的數字照原文列出；論文沒有數字結果時寫「本文沒有報告數字結果」。每個重點標 [@${got.cite_key}] 與頁碼（p. N）、表號或圖號；公式用 LaTeX 並說明符號。「#### 子問題對應」用 Q1…Qn 各一句，無關的寫「本文未涉及」。`,
  }, fix);
  const r = await env.researcher(step, { system: systemFor("researcher", "你讀完需要的內容後，直接寫出這篇論文的結構化摘錄。"), user, tools: ["read_paper", "view_paper_pages", "get_paper"], maxToolSteps: Number(step.inputs.max_tools) || 12, maxTokens: 16_000, purpose: "topic_read" });
  const bib = (await bibOf(env.db, [got.paper_id])).get(got.paper_id) ?? "";
  return { summary: `${got.has_pdf ? "讀全文" : ABSTRACT_ONLY}：讀了 ${r.toolCalls} 次，${r.text.length} 字`, text: r.text, data: { paper_id: got.paper_id, cite_key: got.cite_key, title: got.title, year: got.year, has_pdf: got.has_pdf, ...(bib ? { bib } : {}) } };
}

/** Each paper's material clipped to an equal share of `total` chars (what a writer and its verifier both read). */
export function compactNotes(papers: { notes: string }[], total = 15_000): string {
  const share = Math.floor(total / Math.max(1, papers.length));
  return papers.map((p) => clipText(p.notes.trim(), share)).join("\n\n");
}

export const header = (p: RunPaper) => `### [@${p.cite_key}] ${p.title}${p.bib ? `（${p.bib}）` : p.year ? `（${p.year}）` : ""}${p.has_pdf ? "（讀過全文）" : `（${ABSTRACT_ONLY}）`}`;
const part = (p: ReadPaper, name: string, max: number) => {
  const t = extractPart(p.notes, name);
  return t ? `**${name}**：${clipText(t, max)}` : "";
};

/** The per-paper parts a writer needs (an extraction without the parts → its whole text, clipped). */
export function materialFor(kind: WriterKey, papers: ReadPaper[]): string {
  const share = Math.floor(15_000 / Math.max(1, papers.length));
  const parts: Record<WriterKey, [string, number][]> = {
    taxonomy: [["一句話", 200], ["方法", 500], ["注入位置與訓練／推論", 300], ["實驗設定", 300], ["限制", 200]],
    approaches: [["方法", 1400], ["注入位置與訓練／推論", 400], ["關鍵公式", 800]],
    results: [["實驗設定", 500], ["數字表", 2200]],
    practice: [["方法", 500], ["注入位置與訓練／推論", 700], ["數字表", 600], ["限制", 300]],
    discussion: [["一句話", 200], ["限制", 700], ["子問題對應", 600]],
  };
  return papers.map((p) => {
    const got = parts[kind].map(([n, m]) => part(p, n, m)).filter(Boolean);
    const body = got.length ? got.join("\n") : p.notes;
    return clipText(`${header(p)}\n${body}`, share);
  }).join("\n\n");
}

/** Data the topic checks read: library keys, paper labels, extraction text, taxonomy methods, papers with numbers. */
async function checkData(env: WorkflowEnv, papers: ReadPaper[], text: string, extra: Partial<CheckData> = {}): Promise<CheckData> {
  return {
    keys: await studyKeys(env),
    methods: taxonomyMethods(text),
    source: papers.map((p) => p.notes).join("\n\n"),
    abstract_only: papers.filter((p) => !p.has_pdf).map((p) => p.cite_key),
    full: papers.filter((p) => p.has_pdf).map((p) => p.cite_key),
    with_numbers: papers.filter((p) => dataRows(extractPart(p.notes, "數字表")).some((r) => /\d/.test(r))).map((p) => p.cite_key),
    ...extra,
  };
}

const paperList = (papers: RunPaper[]) => papers.map((p) => `[@${p.cite_key}] ${p.title}${p.bib ? `（${p.bib}）` : p.year ? `（${p.year}）` : ""}${p.has_pdf ? "（讀過全文）" : `（${ABSTRACT_ONLY}：不要附章節、頁碼、公式）`}`).join("\n");


async function writeSection(env: WorkflowEnv, step: StepRow, fix: Fix): Promise<StepOutput> {
  const { papers, steps } = await runPapers(env);
  if (!papers.length) return { summary: "沒有讀到任何論文", text: "BLOCKED: 沒有成功匯入或讀到任何論文" };
  const st = env.state<TopicState>("topic");
  const kind = step.key as WriterKey;
  const material = materialFor(kind, papers);
  // The writer's material is also its verifier's sources (verify.ts reads `brief_<key>` first).
  if (env.state<string>(`brief_${step.key}`) !== material) await env.setState({ [`brief_${step.key}`]: material });
  const taxonomy = step.key !== "taxonomy" ? steps.find((s) => s.key === "taxonomy")?.output?.text ?? "" : "";
  const study = step.key === "discussion" && env.run.study_id ? await env.tool("get_study", { study: env.run.study_id }) : null;
  const out = await writePart(env, step, fix, {
    subquestions: subqText(env),
    papers: paperList(papers),
    paper_extracts: material,
    ...(taxonomy ? { taxonomy } : {}),
    ...(step.key === "practice" && st?.stack.length ? { stack: st.stack.join("、") } : {}),
    ...(study?.ok ? { study: study.text.slice(0, 6000) } : {}),
  }, `Markdown；引用寫成 [@key]（只能用 papers 列出的 key），重點附頁碼或表號；只輸出要求的段落（## 標題開頭），不要前言。${ABSTRACT_ONLY}的論文只能用它的摘要內容，不附章節、頁碼、公式。`);
  return { ...out, data: await checkData(env, papers, taxonomy || out.text || "") };
}

/**
 * Deterministic consistency pass over the stitched note (replaces a model rewriting the whole note): sentences with
 * 「筆記被截斷」-style disclaimers go, a full-text paper described as abstract-only loses that sentence, and an
 * abstract-only paper's citation loses its page / table / equation detail. What is left is judged per section.
 */
export function scrubNote(text: string, d: { abstract_only?: string[]; full?: string[] }): { text: string; removed: number } {
  let removed = 0;
  const sentences = (line: string, drop: (s: string) => boolean) => {
    const parts = line.split(/(?<=[。！？])/);
    const kept = parts.filter((p) => !drop(p));
    removed += parts.length - kept.length;
    return kept.join("");
  };
  const fullKeys = d.full ?? [];
  let lines = text.split("\n").map((l) => {
    if (/^\s*\|/.test(l) || /^#/.test(l)) return l;
    return sentences(l, (p) => TRUNCATED_RE.test(p) || fullKeys.some((k) => p.includes(`@${k}`) && LIMITED_RE.test(p)));
  });
  for (const k of d.abstract_only ?? []) {
    const cite = new RegExp(`\\[([^\\]\\n]*@${escapeRe(k)}\\b)([^\\]\\n]*)\\]((?:\\s*[（(][^）)\\n]{0,20}[）)])?)`, "g");
    lines = lines.map((l) => l.replace(cite, (m, a: string, rest: string, paren: string) => {
      const detail = DETAIL_RE.test(rest) || (!!paren && DETAIL_RE.test(paren));
      if (!detail) return m;
      removed++;
      const keepRest = rest.replace(/,\s*(?:p\.|pp\.|§|表|Table|Fig|圖|式|Eq)[^;\]]*/gi, "");
      return `[${a}${keepRest}]${paren && DETAIL_RE.test(paren) ? "" : paren}`;
    }));
  }
  return { text: lines.join("\n").replace(/[ \t]+\n/g, "\n"), removed };
}

function references(papers: RunPaper[]): string {
  return `## 參考文獻\n\n${papers.map((p) => `- [@${p.cite_key}] ${p.title}${p.year ? `（${p.year}）` : ""}${p.has_pdf ? "" : `（${ABSTRACT_ONLY}）`}`).join("\n")}\n`;
}

/** 搜尋紀錄: the queries sent, the citation tracking, what was kept (why) and what was left out (why). */
function searchLog(st: TopicState | undefined, papers: ReadPaper[], steps: StepRow[]): string {
  if (!st) return "## 搜尋紀錄\n\n- 資料未提供\n";
  const kept = st.picks.map((p, i) => {
    const s = steps.find((x) => x.key === `paper_${i + 1}`);
    const paper = papers.find((x) => x.paper_id === (s?.output?.data as { paper_id?: string } | undefined)?.paper_id);
    const role = p.role ? `［${ROLE_LABEL[p.role]}］` : "";
    if (paper) return { ok: true, line: `- ${role}[@${paper.cite_key}]：${clipText(p.reason || "相關", 80)}` };
    const why = s?.status === "skipped" ? "你在計畫中關掉" : (s?.output?.data as { error?: string } | undefined)?.error ? `未能匯入（${clipText((s!.output!.data as { error: string }).error, 60)}）` : "沒有完成";
    return { ok: false, line: `- 〈${clipText(pickTitle(p), 70)}〉：${why}` };
  });
  return [
    "## 搜尋紀錄",
    "",
    `- 查詢（只送出關鍵字）：${st.queries.map((q) => `\`${q}\``).join("、") || "（沒有）"}`,
    ...(st.seeds.length ? [`- 引用追蹤（參考文獻與被引）：${st.seeds.map((s) => `〈${clipText(s, 50)}〉`).join("、")}`] : []),
    `- 候選 ${st.hits.length} 筆，納入 ${kept.filter((k) => k.ok).length} 篇：`,
    ...kept.filter((k) => k.ok).map((k) => `  ${k.line}`),
    ...(kept.some((k) => !k.ok) || st.excluded.length ? ["- 沒有納入："] : []),
    ...kept.filter((k) => !k.ok).map((k) => `  ${k.line}`),
    ...st.excluded.map((x) => `  - 〈${clipText(x.title, 70)}〉：${x.reason}`),
    "",
  ].join("\n");
}

async function assemble(env: WorkflowEnv): Promise<StepOutput> {
  const { papers, steps } = await runPapers(env);
  const st = env.state<TopicState>("topic");
  // The section units in outline order, stitched by code; contradictory disclaimers removed deterministically.
  const parts = writerKeys(st?.stack ?? []).map((k) => steps.find((s) => s.key === k)?.output?.text?.trim()).filter((t): t is string => !!t && !/^\s*BLOCKED/.test(t));
  const data = await checkData(env, papers, "");
  const scrubbed = scrubNote(stitch(parts), data);
  const title = env.state<string>("note_title") ?? env.run.title;
  const text = `# ${title}\n\n${scrubbed.text.trim()}\n\n${references(papers)}\n${searchLog(st, papers, steps)}`;
  await env.setState({ doc: text });
  return { summary: `依大綱拼接 ${parts.length} 節、${papers.length} 篇論文，共 ${text.length} 字${scrubbed.removed ? `（刪掉 ${scrubbed.removed} 處矛盾的說明）` : ""}`, text, data: await checkData(env, papers, text) };
}

export const topicResearch: WorkflowPlaybook = {
  id: "topic_research",
  title: "主題調研",
  titleEn: "Topic research",
  description: "拆成子問題 → 線上找論文（關鍵字擴展與引用追蹤，只送關鍵字／編號）→ 確認後匯入並從全文摘錄 → 做法分類表、各方法詳解、結果比較、落地方式與開放問題（引用文獻庫）",
  descriptionEn: "Split into sub-questions → search papers online (query expansion + citation snowballing; keywords / ids only) → import and extract from the full text after approval → taxonomy, per-approach sections, result comparison, implementation notes and open problems (citing the library)",
  autoApprovable: true,
  detect: (req, inputs) => (isTopicRequest(req, inputs) ? 0.9 : 0),
  plan,
  applyEdits: (env, edits) => applyEdits(env, edits),
  async execute(env, step, fix) {
    if (step.key.startsWith("paper_")) return readPaper(env, step, fix);
    if (step.key === "assemble") return assemble(env);
    return writeSection(env, step, fix);
  },
  async finalText(env) {
    const { papers } = await runPapers(env);
    const text = env.state<string>("doc") ?? "";
    return { text, data: await checkData(env, papers, text) };
  },
  async repair(env, failing) {
    const stack = env.state<TopicState>("topic")?.stack ?? [];
    const out = new Map<string, string[]>();
    const add = (key: string, c: Criterion) => out.set(key, [...(out.get(key) ?? []), `${c.text}：${c.reason ?? "未達成"}`]);
    for (const c of failing) {
      if (c.id === "taxonomy" || c.id === "sections") add("taxonomy", c);
      if (c.id === "approaches" || c.id === "subq" || c.id === "grounded") add("approaches", c);
      if (c.id === "numbers" || c.id === "coverage" || c.id === "grounded") add("results", c);
      if (c.id === "practice" && stack.length) add("practice", c);
      if (c.id === "assist" || c.id === "sections") add("discussion", c);
      // Consistency / concision: only the section units whose own text fails the check.
      if (c.id === "consistency" || c.id === "concise") {
        const { papers, steps } = await runPapers(env);
        const data = await checkData(env, papers, "");
        for (const k of writerKeys(stack)) {
          const t = steps.find((s) => s.key === k)?.output?.text ?? "";
          if (t && !CHECKS[c.id === "consistency" ? "topic_consistency" : "topic_concise"]!(t, { params: {}, data }).ok) add(k, c);
        }
      }
      if (c.id === "cites" || c.id === "clean") for (const k of writerKeys(stack)) add(k, c);
    }
    return [...out].map(([key, issues]) => ({ key, issues }));
  },
  commit: (env, outcome) => commitNote(env, outcome, "research"),
};

registerWorkflowPlaybook(topicResearch);
export const _test = { laterSteps, criteriaFor, select, decompose, searchLog };
