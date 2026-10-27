/**
 * The routing decision (docs/architecture.md "Workflows" → Routing): ONE pure function that decides, from the Brief, what
 * a run is and which playbook executes it — the deliverable kind, the playbook, edit vs new (decks), which deck (progress /
 * paper report / topic), one run vs one run per paper, and when it cannot decide, what to ask. Production lost the user's
 * intent because ~7 layers re-read the request text (a deck became a note through a fallback; "paper title" turned a survey
 * deck into a paper report; 5 paper ids became 5 decks; 「每個方法」 was read as a per-paper batch; a goal kept adding
 * research stages). Now:
 * - creation (`insertWorkflows`) routes with the Brief's seed and stores the decision in `state.route` (with its reason);
 * - planning (engine `planPhase`) routes again only when the Brief got a new version (a clarifying answer, guidance), and
 *   switches the playbook when the decision changed (always within the Brief's deliverable);
 * - playbooks read `env.route()` (slides: `deck`, `edit`; batches) and no longer detect a mode from the request text;
 * - the assistant's `playbook` is a hint: kept when it produces the Brief's deliverable and its must-have input is there,
 *   otherwise the mismatch is recorded (`hint.accepted = false`, logged on the run) and the Brief wins;
 * - goal stages route the same way (`routeStage`), and a re-plan may only add stage kinds that serve the goal's deliverable.
 * Only the user's own words decide (the assistant's paraphrase never sets a kind or a mode).
 */
import { BRIEF_KIND_LABEL, briefKindOf, deliverableFromWords, playbookKind, sameDeliverable, type BriefKind } from "./brief.js";
import type { Queryable } from "../db.js";
import { capabilityOf, DELIVERABLE_LABEL, deliverableOf, readinessOf, type DeliverableKind, type Readiness } from "./goals/capabilities.js";
import { isTopicRequest, matchPaperTitle } from "./playbooks/common.js";
import { detectPlaybook, getWorkflowPlaybook, listWorkflowPlaybooks, playbookLabel } from "./playbooks/registry.js";
import { EACH_PAPER_RE, PER_PAPER_PLAYBOOKS } from "./context.js";
import { detectExclude, detectLanguage, detectPartLanguages, detectPageCount, detectPerItemFields } from "./requirements.js";
import type { EditKind, Requirement } from "./types.js";
import type { WorkflowEnv } from "./env.js";
import { ASKS_SEARCH_RE } from "./material.js";

// ---------------------------------------------------------------- which deck (pure; slides.ts re-exports them)

/** 「論文報告」「這篇論文做成簡報」「present this paper」: a report on ONE paper (a mention of "paper title(s)" is not). */
export const PAPER_REPORT_RE = /論文報告|文獻報告|paper report|journal club|報告(?:這|那|一)篇|(?:這|那|此|該)篇(?:論文|paper|文章)|(?:present|presenting|report on|summari[sz]e|walk through) (?:this|the|that|one|a single) (?:paper|article)\b|(?:this|the) paper'?s? (?:slides|deck|presentation)|\b\d{4}\.\d{4,5}\b/i;
/** A deck about a subject — a topic, methods, the literature (「關於…」「介紹…」"about …"), not one paper and not a progress report. */
export const TOPIC_DECK_RE = /literature|related work|state[- ]of[- ]the[- ]art|\bsurvey|overview|\bapproach(?:es)?\b|\bmethods?\b|\btechniques?\b|\btrends?\b|landscape|\babout\b|\bintroduc(?:e|ing|tion to)\b|研究現況|文獻(?!報告)|有哪些|做法|方法|技術|調研|趨勢|主題|關於|有關|介紹|探討/i;
/** An explicit progress report (wins over a topic: 「介紹這週的進度」 is a progress deck). */
export const PROGRESS_RE = /進度|週報|週會|組會|group meeting|progress|weekly|this week'?s? (?:work|results)/i;

export type DeckMode = "progress" | "paper_report";
/** `material`: a new deck built from the user's own material (an attached file, pasted notes; material.ts). */
export type DeckRoute = DeckMode | "topic" | "material" | "edit";

/**
 * Which new deck: an explicit progress report → progress; a report on one paper (asked for, or a paper given / named while
 * the words are not about a topic) → paper_report; a topic / literature deck → topic; else progress. A word like "paper
 * title" never forces a paper report (production 50b49d80), and the study's only paper is not a reason for one.
 */
export function deckModeOf(words: string, opts: { inputMode?: string; explicitPaper: boolean; progressAsked: boolean; material?: boolean }): DeckMode | "topic" | "material" {
  if (opts.inputMode === "topic" || opts.inputMode === "progress" || opts.inputMode === "paper_report" || opts.inputMode === "material") return opts.inputMode as DeckMode | "topic" | "material";
  if (opts.progressAsked) return "progress";
  // The user handed over material (production 301b6e1a: 「以此做成…簡報」 with an attached Deep-Research file went the
  // topic route — online search, imported papers — and never used the file): the deck is built from it, unless the words
  // ask for a report on one paper.
  if (opts.material && !PAPER_REPORT_RE.test(words)) return "material";
  const topic = isTopicRequest(words) || TOPIC_DECK_RE.test(words);
  if (PAPER_REPORT_RE.test(words) || (opts.explicitPaper && !topic)) return "paper_report";
  return topic ? "topic" : "progress";
}

// ---------------------------------------------------------------- editing an existing deck

/** 「把這份簡報改成英文」、「精簡」、「重排」… — an edit of the deck itself, not a new deck. */
export const REVISE_RE = /翻譯|translate|改成|改為|轉成|換成|修改|改寫|重寫|精簡|潤飾|潤稿|調整|英文版|中文版|英文|rewrite|revise|edit|polish|shorten|condense|\bchange\b|\bconvert|\bswitch\b|\b(?:to|into) (?:english|chinese|mandarin)\b|拿掉|拿走|去掉|刪掉|刪除|刪去|移除|不要再|\bremove\b|\bdelete\b|\bdrop\b|get rid of|\btake\b[^.\n]{0,60}\bout\b/i;
/**
 * Words that point at a part of a deck (its notes, a page, a title, a figure…). With a deck given and no new deck asked
 * they make the request an edit of that deck whatever the verb (production 79ab: 「從講稿中拿掉引用論文的部分」 had no
 * edit verb the router knew and became a new progress report written over the deck).
 */
export const DECK_PART_RE = /講稿|逐字稿|口稿|講者備註|備註|這(?:一)?頁|那(?:一)?頁|每(?:一)?頁|第\s*[0-9一二三四五六七八九十]+\s*頁|投影片|標題|圖表|這份簡報|這個簡報|簡報裡|\bspeaker notes?\b|\bnotes\b|\bslides?\b|\bthis (?:deck|presentation)\b|\bpage \d+\b|\btitle\b/i;
/** The speaker notes are what the words ask to change. */
const NOTES_RE = /講稿|逐字稿|口稿|講者備註|備註|\bspeaker notes?\b|\bnotes\b|\bscript\b/i;
/** …and the slides themselves too (their text, titles, figures, layout, pages). */
const SLIDE_BODY_RE = /投影片(?!的?講稿|的?備註)|頁面?(?:上|的內容|的文字)|標題|圖表?|表格|版面|排版|字體|字太|bullet|條列|加(?:上|一)?頁|新增.{0,4}頁|刪掉第|\bslide (?:text|content|titles?|body)\b|\btitles?\b|\blayout\b|\bcharts?\b|\bfigures?\b|\bdiagrams?\b|\badd (?:a |\d+ )?(?:slides?|pages?)\b/i;
/** 「把講稿改成中文」「從講稿中拿掉引用」: only the speaker notes change; every slide body stays as it is (slides.ts enforces it). */
export const notesOnlyAsked = (text: string) => NOTES_RE.test(text) && !SLIDE_BODY_RE.test(text);
/** 「再詳細一點」「focus 在…」「擴充成 20 頁」「每個方法要有 Pros/Cons」: a deeper / restructured version (new outline). */
export const EXPAND_RE = /詳細|細一點|不夠細|更細|太淺|擴充|擴寫|展開|加深|深入|聚焦|重點放在|主軸|重新規劃|重新組織|重組|focus|expand|elaborate|in[- ]depth|more detail|detailed|deeper|restructure|reorgani[sz]e|rework|每(?:一)?(?:個|種)[^，。\n]{0,10}(?:都)?要有/i;
/** Translation / language-only passes stay revisions even when they say "detailed" in passing. */
const TRANSLATE_RE = /翻譯|翻成|translate|英文化|中文化|corrective|只改語言|只翻/i;
const STRONG_EXPAND_RE = /詳細|細一點|不夠細|更細|擴充|擴寫|展開|深入|聚焦|重點放在|重新規劃|重組|focus|expand|elaborate|in[- ]depth|more detail|restructure|每(?:一)?(?:個|種)[^，。\n]{0,10}(?:都)?要有/i;

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 「加上一頁…」「新增兩頁」「add 2 slides」: how many pages the request adds to the deck (0 when none). */
export function addedPages(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(?:加上|加入|新增|增加|多加|補上|再加|加)\s*(\d{1,2}|[一二兩三四五六七八九十])\s*(?:頁|張)/g)) n += Number(m[1]) || CN_NUM[m[1]!] || 0;
  for (const m of text.matchAll(/\badd(?:ing)?\s+(?:an?|one|(\d{1,2}))\s+(?:new\s+|more\s+|extra\s+)?(?:slides?|pages?)\b/gi)) n += Number(m[1]) || 1;
  return Math.min(n, 20);
}

/** The page count a requirement asks for (exact, else the range's lower / upper bound). */
export function requiredPages<R extends Pick<Requirement, "type" | "params">>(reqs: R[]): number | null {
  const p = reqs.find((r) => r.type === "page_count")?.params;
  return p ? (p.exact ?? (p.min && p.max ? Math.round((p.min + p.max) / 2) : p.min ?? p.max ?? null)) : null;
}

/**
 * `revise` (translate / polish: same pages, nothing dropped) or `expand` (deeper / restructured: a new outline grounded
 * in the deck and the study's sources). Per-item fields, added pages or a page count well above the deck's are expansions.
 */
export function editKindOf<R extends Pick<Requirement, "type" | "params">>(words: string, reqs: R[], pages: number): EditKind {
  const want = requiredPages(reqs);
  if (reqs.some((r) => r.type === "per_item_fields") || (want && want > pages + 2) || addedPages(words)) return "expand";
  if (TRANSLATE_RE.test(words)) return STRONG_EXPAND_RE.test(words) ? "expand" : "revise";
  return EXPAND_RE.test(words) ? "expand" : "revise";
}

/** Requirement types that change an existing deck (a language, a page count, per-item fields, a removal, topics to add). */
const EDIT_REQS = new Set<Requirement["type"]>(["language", "page_count", "per_item_fields", "exclude", "include_topics"]);

/** The user's words (+ the Brief's requirements) ask to change the deck itself. */
/**
 * The words ask for a NEW deck (「幫我做一份…簡報」「make a progress report deck」), not an edit of the deck on the page
 * (scenario matrix g03 / g06 / g09: a new deck asked on a deck page became a revise of that deck).
 */
export const NEW_DECK_RE = /(?:做|建立|產生|生成|準備|製作|弄)\s*(?:一份|一個|個|份|新的?)?[^。！？\n]{0,30}?(?:簡報|投影片|slides|deck)|\b(?:make|create|build|prepare|generate)\s+(?:me\s+)?(?:a|an|another|new)\b[^.\n]{0,50}?\b(?:deck|presentation|slides)\b/i;
/** A new-deck request that does not also point at an existing deck (「把這個簡報做成英文版」 is an edit). */
export const newDeckAsked = (text: string) => NEW_DECK_RE.test(text) && !/(?:這個|那個|這份|那份|同一個|剛剛的?|原本的?)\s*(?:簡報|投影片|deck)|\b(?:this|that|the same) (?:deck|presentation|slides)\b|(?:改|修改|翻譯|翻成|加一頁|刪掉|展開|擴充)/i.test(text);

export function editAsked(words: string, reqs: Pick<Requirement, "type" | "source">[]): boolean {
  if (REVISE_RE.test(words) || EXPAND_RE.test(words) || addedPages(words) > 0 || detectExclude(words)) return true;
  if (detectLanguage(words) || detectPartLanguages(words).length || detectPageCount(words) || detectPerItemFields(words)) return true;
  return reqs.some((r) => r.source !== "standing" && EDIT_REQS.has(r.type));
}

// ---------------------------------------------------------------- per paper

/** 「這幾篇」「these papers」 without 「每一篇」 or 「一份」: one deck about them, or one each? (asked once). */
const PLURAL_PAPERS_RE = /這(?:幾|些|兩|三|四|五|六|七|八|九|十)\s*篇|這些(?:論文|文獻|paper)|\b(?:these|those|the|all (?:the|of the)) (?:\w+ )?(?:papers|articles)\b/i;
const ONE_ARTIFACT_RE = /一份|一個|一篇(?:筆記|簡報)|整合|綜合|合成|合併|放在一起|\bone (?:deck|presentation|note)\b|\ba single\b|\bcombined?\b|\btogether\b/i;

// ---------------------------------------------------------------- the router

/** What the router knows about the study (null = not known yet: routed again at planning). */
export type RouteReadiness = Pick<Readiness, "papers" | "papers_with_pdf" | "experiment_notes"> & {
  latex_projects: number;
  /** The study's papers (title matching: a paper the user names). */
  paperTitles?: { id: string; title: string }[];
  /** Slides in the deck given by `deck_id` (0 = none / empty template). */
  deckPages?: number;
};

export type RouteInput = {
  /** The user's own words (Brief `user_words`): the only source of kinds and modes. */
  words: string[];
  /** The assistant's request (a deliverable fallback when the user's words name none; never a mode). */
  paraphrase?: string | null;
  /** The Brief's deliverable when already fixed (a goal stage, a later Brief version). */
  kind?: BriefKind | null;
  /** The assistant's / caller's playbook (a proposal). */
  hint?: string | null;
  /** A playbook the user chose (a redirect they accepted, a choice card): kept while it delivers the Brief's kind. */
  pinned?: string | null;
  inputs?: { paper_id?: unknown; paper_ids?: unknown; deck_id?: unknown; project_id?: unknown; note_ids?: unknown; mode?: unknown; materials?: unknown };
  /** A paper given with the run (inputs / page context at creation), not a fallback pick. */
  explicitPaper?: boolean;
  /** The Brief's requirements (planning). */
  requirements?: Pick<Requirement, "type" | "params" | "source">[];
  ready?: RouteReadiness | null;
};

export type RouteAsk = "deliverable" | "batch" | "producer";
export type Route = {
  kind: BriefKind;
  /** The finer deliverable the words name (paper vs section, topic note, experiment report…), when they name one. */
  deliverable: DeliverableKind | null;
  playbook: string;
  /** Slides: which deck (`edit` = the given deck itself). */
  deck?: DeckRoute;
  /** Slides `edit`: revise (same pages) or expand (new outline). */
  edit?: EditKind;
  /** Slides `edit`: what may change — `notes` = only the speaker notes (the slide bodies stay byte for byte). */
  scope?: "notes";
  /** One run per paper (the user's own words asked for it). */
  batch: boolean;
  /** The router could not decide alone: ask ONE card (engine planPhase). */
  ask?: RouteAsk;
  /** Why (log line + `state.route.reason`). */
  reason: string;
  /** Decided with the study's readiness (false: the study was not known yet — playbooks route again once they resolve it). */
  informed: boolean;
  /** The assistant's proposal and what happened to it. */
  hint?: { playbook: string; accepted: boolean };
};

const joined = (words: string[]) => words.join("\n");
/** The run carries the user's own material (`inputs.materials`, material.ts). */
const hasMaterial = (inp: { materials?: unknown }) => Array.isArray(inp.materials) && inp.materials.length > 0;
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
const has = (id: string) => !!getWorkflowPlaybook(id);
const label = (id: string) => getWorkflowPlaybook(id)?.title ?? id;

const EXPERIMENT_RE = /實驗報告|實驗結果|實驗紀錄|實驗數據|消融|ablation|experiment(?:al)? (?:results?|report)/i;
const MEETING_WORDS_RE = /會議準備|議程|agenda|meeting prep|組會準備|準備.*會議/i;
const OUTLINE_WORDS_RE = /(?:論文|paper).{0,6}大綱|大綱.{0,6}(?:論文|paper)|paper outline/i;

/**
 * Must-have input of a playbook against what the run has (null readiness = unknown → assume yes; planning routes again).
 * Returns the reason it does not fit, or null.
 */
function misfit(playbook: string, text: string, d: DeliverableKind | null, inp: NonNullable<RouteInput["inputs"]>, ready: RouteReadiness | null | undefined, named: boolean): string | null {
  const paper = typeof inp.paper_id === "string" || named;
  switch (playbook) {
    case "reading_note":
      return !paper && isTopicRequest(text, inp as Record<string, unknown>) ? "沒有指定論文、而且是主題調研的問法" : null;
    case "experiment_report":
      if (EXPERIMENT_RE.test(text) || d === "experiment_report") return null;
      return d || (ready && !ready.experiment_notes) ? "你的話不是要整理實驗結果（只提到指標名稱不算）" : null;
    case "latex_section":
      return typeof inp.project_id !== "string" && ready && !ready.latex_projects ? "研究還沒有 LaTeX 專案" : null;
    case "topic_research":
      // An online survey instead of the material the user handed over (production 301b6e1a).
      return hasMaterial(inp) && !paper && !ASKS_SEARCH_RE.test(text) ? "你提供了資料，要整理的是它，不是線上調研" : null;
    default:
      return null;
  }
}

/** The note-family producer the words call for (no hint, or a hint that does not fit). */
function notePlaybook(d: DeliverableKind | null, text: string, inp: NonNullable<RouteInput["inputs"]>, named: boolean): { id: string; why: string } {
  const paper = typeof inp.paper_id === "string" || named;
  // The user's own material (an attached file, pasted notes) is the source: written up from it, never an online survey
  // instead — unless the words ask for a search too.
  if (hasMaterial(inp) && !paper && d !== "lit_review" && d !== "reading_note" && !ASKS_SEARCH_RE.test(text) && !EXPERIMENT_RE.test(text) && !OUTLINE_WORDS_RE.test(text) && !MEETING_WORDS_RE.test(text)) return { id: "generic", why: "整理你提供的資料" };
  const topic = !paper && isTopicRequest(text, inp as Record<string, unknown>);
  const research = { id: has("topic_research") ? "topic_research" : "generic", why: "主題調研的問法（有哪些做法、調研、survey…），沒有指定單篇論文" };
  if (d === "reading_note") return topic ? research : { id: "reading_note", why: "一篇論文的閱讀筆記" };
  if (d === "lit_review") return { id: "lit_review", why: "比較文獻庫的論文（文獻回顧）" };
  if (d === "topic_note" || topic) return research;
  if (paper && /筆記|note/i.test(text)) return { id: "reading_note", why: "指定了一篇論文的筆記" };
  if (d === "outline" || OUTLINE_WORDS_RE.test(text)) return { id: "paper_outline", why: "論文大綱" };
  if (d === "meeting_agenda" || MEETING_WORDS_RE.test(text)) return { id: "meeting_prep", why: "會議準備／議程" };
  // Metric names alone (CER、WER) are not an experiment report: only 實驗結果／實驗報告 words are.
  if (d === "experiment_report" || EXPERIMENT_RE.test(text)) return { id: "experiment_report", why: "整理實驗結果" };
  return { id: "generic", why: "一般筆記（沒有更專門的流程）" };
}

/** The producer of a kind when the words name nothing finer. */
function producerOf(kind: BriefKind, d: DeliverableKind | null, text: string, inp: NonNullable<RouteInput["inputs"]>, named: boolean): { id: string; why: string } | null {
  switch (kind) {
    case "deck": return { id: "slides", why: "簡報" };
    case "latex": {
      const section = d === "paper_section" || (typeof inp.project_id === "string" && d !== "paper");
      return section ? { id: "latex_section", why: "既有 LaTeX 專案的一個章節" } : { id: "paper_draft", why: "一篇新的 LaTeX 論文" };
    }
    case "lit_review": return { id: "lit_review", why: "文獻回顧" };
    case "reading_note":
    case "note": return notePlaybook(kind === "reading_note" ? "reading_note" : d, text, inp, named);
    default: return null;
  }
}

/**
 * Decides once: the deliverable (the Brief's, else the user's words, else the assistant's request, else the hint's product),
 * the playbook that executes it, the deck mode / edit kind (slides), batch, and what to ask when it cannot decide.
 */
export function route(input: RouteInput): Route {
  const words = input.words.filter((w) => w.trim());
  const text = joined(words);
  const inp = input.inputs ?? {};
  const ready = input.ready ?? null;
  const hint = input.hint && has(input.hint) ? input.hint : null;
  const namedWords = deliverableFromWords(words);
  const named = namedWords ?? (input.paraphrase ? deliverableFromWords([input.paraphrase]) : null);
  const paperNamed = !!ready?.paperTitles?.length && !!matchPaperTitle(text, ready.paperTitles);
  const reasons: string[] = [];
  // 1. The deliverable (hard): fixed by the Brief, else named by the user, else the assistant, else the hint's product.
  let kind: BriefKind;
  if (input.kind) kind = input.kind;
  else if (named) {
    kind = briefKindOf(named);
    reasons.push(`${namedWords ? "你的話" : "助理的任務說明"}要的是${DELIVERABLE_LABEL[named]}`);
  } else if (!hint && typeof inp.project_id === "string") kind = "latex";
  // A given deck and words about one of its parts (講稿、speaker notes、某一頁…): that deck, whatever playbook a keyword
  // suggested (scenario n81: 「speaker notes」 made the hint a note playbook).
  else if (typeof inp.deck_id === "string" && (!hint || DECK_PART_RE.test(text))) kind = "deck";
  else kind = playbookKind(hint ?? detectPlaybook(text || input.paraphrase || "", inp as Record<string, unknown>));
  const d = named && sameDeliverable(briefKindOf(named), kind) ? named : null;
  // 2. The playbook: the user's pinned choice, else the hint when it delivers the kind and fits, else the kind's producer.
  let playbook: string | null = null;
  let hintOut: Route["hint"];
  if (input.pinned && has(input.pinned) && sameDeliverable(playbookKind(input.pinned), kind)) {
    playbook = input.pinned;
    reasons.push(`沿用你選的「${label(playbook)}」`);
  }
  if (!playbook && hint) {
    const sameKind = sameDeliverable(playbookKind(hint), kind);
    // A hint into a more specific flavour than the words ask for is fine (lit_review for 「筆記」); the reverse is
    // not (a reading note for a topic survey, generic for a deck).
    const bad = !sameKind ? `它產生${BRIEF_KIND_LABEL[playbookKind(hint)]}，你要的是${BRIEF_KIND_LABEL[kind]}` : misfit(hint, text, d, inp, ready, paperNamed) ?? (hint === "generic" && d && d !== "note" ? `你的話指定了${DELIVERABLE_LABEL[d]}` : null);
    hintOut = { playbook: hint, accepted: !bad };
    if (!bad) {
      playbook = hint;
      reasons.push(`採用助理建議的「${label(hint)}」`);
    } else reasons.push(`助理建議「${label(hint)}」不採用：${bad}`);
  }
  if (!playbook) {
    const p = producerOf(kind, d, text, inp, paperNamed);
    if (p && has(p.id) && sameDeliverable(playbookKind(p.id), kind)) {
      playbook = p.id;
      reasons.push(`由「${label(p.id)}」執行：${p.why}`);
    }
  }
  if (!playbook) {
    // A kind no built-in producer covers (a module playbook, kind "other"): the best-scoring producer of that kind, else ask.
    const candidates = listWorkflowPlaybooks().filter((p) => sameDeliverable(playbookKind(p.id), kind) && capabilityOf(p.id));
    const best = candidates.map((p) => ({ id: p.id, s: p.detect(text, inp as Record<string, unknown>) })).sort((a, b) => b.s - a.s)[0];
    if (best) playbook = best.id;
    else {
      const fallback = hint ?? detectPlaybook(text, inp as Record<string, unknown>);
      return { kind, deliverable: d, playbook: fallback, batch: false, ask: "producer", reason: `沒有能產生${BRIEF_KIND_LABEL[kind]}的工作流程`, informed: !!ready, ...(hintOut ? { hint: hintOut } : {}) };
    }
  }
  const out: Route = { kind, deliverable: d, playbook, batch: false, reason: "", informed: !!ready, ...(hintOut ? { hint: hintOut } : {}) };
  // 3. Slides: the given deck itself, or which new deck.
  if (playbook === "slides") {
    const deckGiven = typeof inp.deck_id === "string" && (ready?.deckPages ?? 1) > 0;
    if (deckGiven && !inp.mode && (editAsked(text, input.requirements ?? []) || DECK_PART_RE.test(text)) && !newDeckAsked(text)) {
      out.deck = "edit";
      const notes = notesOnlyAsked(text);
      out.edit = notes ? "revise" : editKindOf(text, (input.requirements ?? []).filter((r) => r.source !== "standing"), ready?.deckPages ?? 0);
      if (notes) out.scope = "notes";
      reasons.push(`修改這份簡報（${notes ? "只改講稿：投影片本體不動" : out.edit === "expand" ? "擴充：重新規劃大綱" : "修訂：頁數與順序照舊"}）`);
    } else {
      const explicit = !!input.explicitPaper || paperNamed || /\b\d{4}\.\d{4,5}\b|\b10\.\d{4,9}\//.test(text);
      out.deck = deckModeOf(text, { inputMode: typeof inp.mode === "string" ? inp.mode : undefined, explicitPaper: explicit, progressAsked: PROGRESS_RE.test(text), material: hasMaterial(inp) });
      reasons.push(out.deck === "paper_report" ? "單篇論文報告" : out.deck === "topic" ? "主題簡報（用文獻庫）" : out.deck === "material" ? "用你提供的資料做簡報" : "進度報告");
    }
  }
  // 4. One run per paper only on the user's own words; 「這幾篇」 with several papers and no 「一份／每篇」 → ask.
  if (PER_PAPER_PLAYBOOKS.has(playbook) && out.deck !== "edit") {
    const paperIds = ids(inp.paper_ids);
    const each = EACH_PAPER_RE.test(text);
    const several = paperIds.length >= 2 || (typeof inp.paper_id !== "string" && (ready ? ready.papers >= 2 : true));
    if (each && several) {
      out.batch = true;
      reasons.push("你要每一篇各做一份");
    } else if (!each && paperIds.length >= 2 && PLURAL_PAPERS_RE.test(text) && !ONE_ARTIFACT_RE.test(text)) out.ask = "batch";
  }
  // An edit of the given deck is named for what it does (「修改簡報」), not 「從 0 到 1 建立簡報」.
  out.reason = out.deck === "edit" ? reasons.join("；").split(label("slides")).join(playbookLabel("slides", out)) : reasons.join("；");
  return out;
}

// ---------------------------------------------------------------- goals

/**
 * Stage kinds that serve a goal's deliverable: the deliverable itself plus the gathering / preparing kinds it builds on.
 * A re-plan may not add anything else (production: a Taiwanese-corpus paper goal grew 7 research stages and a goal for a
 * deck must not grow a LaTeX stage).
 */
const SERVES: Partial<Record<DeliverableKind, DeliverableKind[]>> = {
  paper: ["topic_note", "lit_review", "reading_note", "outline", "note"],
  paper_section: ["topic_note", "lit_review", "reading_note", "outline", "note"],
  outline: ["topic_note", "lit_review", "reading_note", "note"],
  lit_review: ["topic_note", "reading_note"],
  deck: ["topic_note", "lit_review", "reading_note", "experiment_report", "note"],
  topic_note: ["reading_note"],
  experiment_report: ["note"],
};
export function servesDeliverable(stage: DeliverableKind, goal: DeliverableKind): boolean {
  return stage === goal || (SERVES[goal] ?? []).includes(stage);
}

/**
 * A goal stage's playbook (planner templates, the LLM's stages, re-plans): the same router with the stage's own
 * deliverable fixed to what the proposed playbook produces — a proposal that does not fit (a reading note without a paper
 * for a topic, an experiment report without data) is replaced by the producer the router picks.
 */
export function routeStage(proposed: string, request: string, ready: RouteReadiness | null, inputs: Record<string, unknown> = {}): string {
  const cap = capabilityOf(proposed);
  if (!cap) return proposed;
  const r = route({ words: [request], kind: briefKindOf(cap.produces), hint: proposed, inputs, ready });
  // Within the note family keep the stage's own flavour unless the hint did not fit.
  return r.ask === "producer" ? proposed : r.playbook;
}

/** A request's deliverable as the goal layer names it (the user's words first). */
export const wantedDeliverable = (words: string[] | null | undefined, request: string): DeliverableKind | null =>
  (words?.length ? deliverableFromWords(words) : null) ?? deliverableOf(request);

/** Readiness → the router's view. */
export function routeReadiness(r: Readiness, extra: Partial<RouteReadiness> = {}): RouteReadiness | null {
  if (!r.study) return null;
  return { papers: r.papers, papers_with_pdf: r.papers_with_pdf, experiment_notes: r.experiment_notes, latex_projects: r.latex_projects.length, ...extra };
}

// ---------------------------------------------------------------- the run's recorded decision

/** `workflow_runs.state.route`: the decision, the Brief version it was made from, and what the creation knew. */
export type RouteState = Route & { brief_version: number; explicit_paper: boolean; hint_playbook: string | null; pinned?: string | null; at: string };

export const routeState = (r: Route, extra: { briefVersion: number; explicitPaper: boolean; hint: string | null; pinned?: string | null }): RouteState =>
  ({ ...r, brief_version: extra.briefVersion, explicit_paper: extra.explicitPaper, hint_playbook: extra.hint, ...(extra.pinned ? { pinned: extra.pinned } : {}), at: new Date().toISOString() });

/** One log line for the run (plan card log). */
export function routeNote(r: Route): string {
  const pb = playbookLabel(r.playbook, r);
  return `路由：要交付的是${BRIEF_KIND_LABEL[r.kind]}，由「${pb}」執行${r.reason ? `（${r.reason}）` : ""}。`;
}

const slidesIn = (text: string) => text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split(/^(?=## )/m).filter((p) => p.startsWith("## ")).length;

/**
 * Slides in a deck that can be revised: the body the workflow that wrote it kept, else its entry file once edited (an
 * untouched template 「草稿產生中」 is 0 — the normal plan fills it). A deck of another study is 0.
 */
export async function deckPagesOf(db: Queryable, deckId: string, studyId: string | null, excludeRun?: string): Promise<number> {
  const deck = (await db.query<{ study_id: string }>("SELECT study_id FROM decks WHERE id=$1", [deckId]).catch(() => ({ rows: [] as { study_id: string }[] }))).rows[0];
  if (!deck || (studyId && deck.study_id !== studyId)) return 0;
  const made = (await db.query<{ body: string | null }>(
    "SELECT state->'deck'->>'body' AS body FROM workflow_runs WHERE ($2::uuid IS NULL OR id<>$2) AND playbook='slides' AND artifacts @> $1::jsonb ORDER BY updated_at DESC LIMIT 1",
    [JSON.stringify([{ kind: "deck", id: deckId }]), excludeRun ?? null],
  )).rows[0]?.body;
  if (made && slidesIn(made)) return slidesIn(made);
  const tree = (await db.query<{ entry: string; revision: number }>("SELECT entry, revision FROM deck_source_trees WHERE deck_id=$1", [deckId])).rows[0];
  if (!tree || tree.revision <= 1) return 0;
  const entry = (await db.query<{ content: string | null }>("SELECT content FROM deck_sources WHERE deck_id=$1 AND path=$2", [deckId, tree.entry ?? "index.qmd"])).rows[0]?.content ?? "";
  return slidesIn(entry);
}

/** What the router needs from the database: the study's readiness + paper titles, and the given deck's slides. */
export async function routeContext(db: Queryable, studyId: string | null, deckId?: unknown, excludeRun?: string): Promise<RouteReadiness | null> {
  if (!studyId) return null;
  const r = await readinessOf(db, studyId);
  const paperTitles = (await db.query<{ id: string; title: string }>("SELECT p.id, p.title FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 LIMIT 500", [studyId])).rows;
  const deckPages = typeof deckId === "string" && /^[0-9a-f-]{36}$/i.test(deckId) ? await deckPagesOf(db, deckId, studyId, excludeRun) : undefined;
  return routeReadiness(r, { paperTitles, ...(deckPages !== undefined ? { deckPages } : {}) });
}

/** The router's input for a run at planning: the current Brief, the creation's hint / explicit paper, the study's readiness. */
export async function routeInputOf(env: WorkflowEnv): Promise<RouteInput | null> {
  const b = env.brief();
  if (!b) return null;
  const prev = env.route();
  return {
    words: b.user_words, paraphrase: b.paraphrase, kind: b.deliverable.kind,
    // The assistant's / caller's playbook stays a hint; a run from before routing takes its playbook as the hint.
    hint: prev ? prev.hint_playbook : env.run.playbook, pinned: prev?.pinned ?? null,
    inputs: env.run.inputs, explicitPaper: prev?.explicit_paper ?? !!env.run.inputs.paper_id,
    requirements: b.requirements, ready: await routeContext(env.db, env.run.study_id, env.run.inputs.deck_id, env.run.id),
  };
}

/** Records a decision for the run (keeping what the creation knew). */
export async function saveRoute(env: WorkflowEnv, r: Route): Promise<RouteState> {
  const prev = env.route();
  const state = routeState(r, { briefVersion: env.brief()?.version ?? 0, explicitPaper: prev?.explicit_paper ?? !!env.run.inputs.paper_id, hint: prev ? prev.hint_playbook : env.run.playbook, pinned: prev?.pinned ?? null });
  await env.setState({ route: state });
  return state;
}

/**
 * The run's decision once its playbook resolved the study (the decision made without readiness could not see the study's
 * papers): the same router again, within the playbook already chosen. Playbooks call it instead of detecting anything.
 */
export async function currentRoute(env: WorkflowEnv): Promise<RouteState | null> {
  const cur = env.route();
  if (cur?.informed || !env.run.study_id) return cur;
  const input = await routeInputOf(env);
  if (!input) return cur;
  const r = route({ ...input, pinned: env.run.playbook });
  return saveRoute(env, { ...r, playbook: env.run.playbook });
}

/**
 * 「每一篇文獻」 whose study (or papers) were only known at planning: creates the per-paper batch creation would have made
 * (the same router decides inside `insertWorkflows`). Returns the report line for this run (which then ends `skipped`), or
 * null when there are fewer than 2 papers (one run).
 */
export async function splitBatch(env: WorkflowEnv, playbook: string): Promise<string | null> {
  const { batchPapers } = await import("./context.js");
  const items = await batchPapers(env.db, { studyId: env.run.study_id, paperId: env.run.inputs.paper_id as string | undefined, paperIds: env.run.inputs.paper_ids as string[] | undefined });
  if (!items) return null;
  const b = env.brief();
  const { insertWorkflows, announceRuns } = await import("./service.js");
  const { transaction } = await import("../db.js");
  const out = await transaction(env.db, (c) => insertWorkflows(c, env.user, {
    request: env.run.request, playbook, inputs: { ...(env.run.inputs as Record<string, unknown>), study: env.run.study_id ?? undefined } as never,
    conversationId: env.run.conversation_id, autopilot: env.run.autopilot, userWords: b ? b.user_words.slice(0, b.base) : null,
  }));
  if (!out.batchId) return null;
  await announceRuns(env.db, out.runs);
  return `已拆成 ${out.runs.length} 個工作流程（每篇論文各一份），請在批次卡片查看進度。`;
}
