/**
 * Workflow invariants (docs/research/agent-invariants.md): every rule a run must satisfy, as PURE functions over what is
 * stored — the `workflow_runs` row (brief, route, state.asks, plan, criteria, report, status), its `workflow_events`, its
 * steps and the conversation's messages. No model calls, no database access: callers load a `RunBundle`
 * (scripts/audit/load.ts for the production auditor, scripts/eval/scenarios for the planning-only scenario matrix) and
 * get `Finding`s with the evidence each rule extracted.
 *
 * The detectors are deliberately independent of the workflow code (brief.ts, requirements.ts, route.ts …): they re-read
 * the stored shapes with their own small parsers, so a bug in the system under test is not inherited by its checker.
 * Stored shapes are typed loosely (every field optional) so older runs and newer fields both load.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// ---------------------------------------------------------------- stored shapes (loose)

export type StoredOption = { label: string; value?: string; description?: string };
export type StoredQuestion = { id?: string; type?: string; prompt?: string; options?: StoredOption[] };
export type StoredAsk = { id: string; title?: string; intro?: string; questions?: StoredQuestion[]; purpose?: string; step_key?: string | null; asked_at?: string; answers?: unknown[]; answered_at?: string; ai_filled?: boolean };
export type StoredRequirement = { id?: string; type?: string; text?: string; quote?: string; source?: string; params?: { language?: string; part?: string; exact?: number; min?: number; max?: number; [k: string]: unknown } };
export type StoredBrief = { version?: number; deliverable?: { kind?: string }; user_words?: string[]; base?: number; requirements?: StoredRequirement[]; unspecified?: string[]; source?: string };
export type StoredRun = {
  id: string; status: string; playbook?: string; title?: string; request?: string; objective?: string;
  study_id?: string | null; conversation_id?: string | null;
  inputs?: Record<string, unknown> | null; context?: Record<string, unknown> | null; state?: Record<string, unknown> | null;
  plan?: { summary?: string; writes?: { kind?: string; label?: string; effect?: string }[]; notes?: string; outline?: { title?: string }[]; edit_kind?: string; front_title?: string; requirements?: StoredRequirement[] } | null;
  criteria?: { id: string; text?: string; kind?: string; status?: string; reason?: string; evidence?: string }[] | null;
  report?: { summary_md?: string; issues?: string[]; done?: string[] } | null;
  brief?: StoredBrief | null;
  guidance?: { at?: string; text?: string; system?: boolean; setup?: boolean }[] | null;
  artifacts?: { kind?: string; id?: string; title?: string; role?: string }[] | null;
  autopilot?: boolean; stop_reason?: string | null; question?: string | null; goal_id?: string | null;
  created_at?: string; updated_at?: string; started_at?: string | null; finished_at?: string | null;
};
export type StoredEvent = { seq?: number; type: string; data: Record<string, unknown>; created_at: string };
export type StoredStep = { key: string; kind?: string; role?: string; status?: string; round?: number; title?: string; conv?: { rounds?: { round: number; failures?: string[] }[]; stop?: string } | null; output_text?: string | null };
export type StoredMessage = { seq: number; role: string; text?: string | null; content?: unknown; created_at?: string; page_context?: Record<string, unknown> | null };
export type LibraryPaper = { title: string; year?: number | null; venue?: string | null; cite_key?: string | null; arxiv_id?: string | null; has_pdf?: boolean | null };

/** Everything one run's invariants read. Only `run` is required; a rule whose input is missing is skipped (never guessed). */
export type RunBundle = {
  run: StoredRun;
  events?: StoredEvent[];
  steps?: StoredStep[];
  conversation?: { id: string; study_id?: string | null; context?: Record<string, unknown> | null } | null;
  /** The conversation's current-branch messages, oldest first. */
  messages?: StoredMessage[];
  /** Other runs of the same conversation. */
  siblings?: StoredRun[];
  /** Input artifact id (deck / note / LaTeX project) → its study. */
  artifactStudies?: Record<string, string | null>;
  /** The owner's studies (for 「which study」 questions). */
  studies?: { id: string; title: string }[];
  /** The run's study library (bibliographic fields). */
  library?: LibraryPaper[];
  /** ISO time the bundle was read (staleness rules); default: now. */
  now?: string;
};
export type ConversationBundle = { conversation: { id: string; study_id?: string | null }; messages: StoredMessage[]; runs?: StoredRun[] };

export type Finding = { invariant: string; severity: Severity; run_id: string | null; conversation_id: string | null; message: string; evidence: Record<string, unknown> };
type Hit = { message: string; evidence: Record<string, unknown>; severity?: Severity };

export type Invariant = {
  id: string; category: "route" | "deliverable" | "requirements" | "context" | "questions" | "repair" | "outcome" | "assistant" | "grounding";
  severity: Severity; title: string;
  /** What the rule reads, for the catalogue. */
  reads: string;
} & ({ scope: "run"; check: (b: RunBundle) => Hit[] } | { scope: "conversation"; check: (b: ConversationBundle) => Hit[] });

// ---------------------------------------------------------------- text helpers

const DELEGATE_PREFIX = /^（交給 Agent）/;
const PUNCT = /[\s\p{P}\p{S}]+/gu;
export const norm = (s: string | null | undefined) => (s ?? "").replace(DELEGATE_PREFIX, "").toLowerCase().replace(PUNCT, "");
/** Character bigrams of the normalised text (works for CJK and Latin alike). */
export function grams(s: string | null | undefined): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
/** Share of `a`'s bigrams found in `b` (0–1). */
export function containment(a: string | null | undefined, b: string | null | undefined): number {
  const ga = grams(a);
  if (!ga.size) return 0;
  const gb = grams(b);
  let n = 0;
  for (const g of ga) if (gb.has(g)) n++;
  return n / ga.size;
}
const clip = (s: string | null | undefined, n = 120) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

/**
 * Splits the user's words into clauses — also spoken-style requests with no punctuation (ASR transcripts): clause
 * boundaries are punctuation plus the connectors people use to start a new ask (並且, 還有, 然後, 那請你, 我要, 當然…).
 */
const CONNECTOR = /(並且|而且|還有|然後|另外|此外|同時|以及|那請你|那麼|那你|我要你|我想要你|我想要|我希望|我要|請你|請幫我|記得|也要|當然|你應該要|應該要|這個講稿|這個簡報|這份簡報|這份報告|and also|additionally|also|and then|make sure|please|plus,)/gi;
export function clauses(text: string): string[] {
  const t = (text ?? "").replace(DELEGATE_PREFIX, "");
  const parts = t.split(/[。！？!?；;：\n]+|(?<=[a-z0-9)])\.\s+|，|,\s*(?=and |also |please |make sure )/i);
  const out: string[] = [];
  for (const p of parts) {
    const marked = p.replace(CONNECTOR, "\u0000$1");
    for (const c of marked.split("\u0000")) {
      const s = c.trim();
      if (s) out.push(s);
    }
  }
  // Glue fragments too short to be an ask onto the next clause (「那」「並且」 alone).
  // English lists of asks joined by commas (「Make a deck…, use our library…, give the pros…」): split at commas whose both
  // sides have ≥ 4 words, so 「shallow fusion, CLAS and contextual adapters」 stays whole.
  const split: string[] = [];
  for (const c of out) {
    const pieces = c.split(/,\s+/);
    if (pieces.length > 1 && /[a-z]/i.test(c) && !/[\u4e00-\u9fff]/.test(c)) {
      let cur = pieces[0]!;
      let last = cur;
      for (const p of pieces.slice(1)) {
        if (last.trim().split(/\s+/).length >= 4 && p.trim().split(/\s+/).length >= 4 && /^[a-z]/.test(p.trim())) {
          split.push(cur);
          cur = p;
        } else cur = `${cur}, ${p}`;
        last = p;
      }
      split.push(cur);
    } else split.push(c);
  }
  out.length = 0;
  out.push(...split);
  const merged: string[] = [];
  for (const c of out) {
    const prev = merged.at(-1);
    if (prev !== undefined && norm(prev).length < 4) merged[merged.length - 1] = `${prev}${c}`;
    else merged.push(c);
  }
  return merged;
}

const FILLER = /^(有個東西|有件事|那個|就是|然後|ok|okay|好|好的|嗯|謝謝|thanks?|thank you|對|是的|yes|no)$/i;
const DELIVERABLE_NOUN = /簡報|投影片|筆記|報告|論文|講稿|章節|section|deck|slides?|presentation|note|paper|report|latex/i;
const CREATE_VERB = /做|幫我做|建立|產生|生成|寫|整理|make|create|write|build|prepare|draft/i;
const EDIT_VERB = /改|修改|翻譯|調整|edit|revise|translate|change/i;
/**
 * A content clause asks for something (a demand), not filler. The bare 「幫我做一個簡報」/「幫我改」 is the core ask
 * (the deliverable / the edit itself), carried by the Brief's deliverable and the route, not by a requirement.
 */
export function contentClauses(text: string): { clause: string; core: boolean }[] {
  return clauses(text)
    .filter((c) => norm(c).length >= 4 && !FILLER.test(norm(c)))
    .map((c) => {
      const rest = norm(c.replace(/〈[^〉]*〉|「[^」]*」|“[^”]*”|"[^"]*"/g, "")).replace(/我要你|我想要你|我想要|幫我|一個|一份|一篇|請你|這個|這份/g, "");
      return { clause: c, core: ((DELIVERABLE_NOUN.test(c) && CREATE_VERB.test(c)) || EDIT_VERB.test(c)) && rest.replace(DELIVERABLE_NOUN, "").length <= 6 };
    });
}

// ---------------------------------------------------------------- language / dimension claims in the user's words

const NOTES_RE = /講稿|逐字稿|講者備註|備忘稿|speaker ?notes?|\bnotes\b/i;
const SLIDES_RE = /投影片|頁面(?:內容|文字)?|簡報(?:上|裡)?的?(?:內容|文字)|內文|slides?(?! notes)|slide text|on the slides/i;
const TERMS_RE = /專有名詞|專用名詞|術語|technical terms?|terminology|jargon|名詞(?:保留|用)/i;
const LANG_ZH = /中文|繁中|繁體|國語|華語|chinese|mandarin|zh-?tw/i;
const LANG_EN = /英文|英語|english/i;
/** A deck part the user named with a language: notes, slides or the whole artifact. */
export type LanguageClaim = { part: "notes" | "slides" | "all"; lang: "zh" | "en"; clause: string };
export function languageClaims(text: string): LanguageClaim[] {
  const out: LanguageClaim[] = [];
  // A clause naming both languages (「Slides in English, speaker notes in Chinese」) is split further.
  const parts = clauses(text).flatMap((c) => (LANG_ZH.test(c) && LANG_EN.test(c) ? c.split(/,\s*|，|、|\band\b|以及|而且?/).map((x) => x.trim()).filter(Boolean) : [c]));
  for (const c of parts) {
    if (TERMS_RE.test(c) && !/講稿|notes?/i.test(c.replace(TERMS_RE, ""))) continue;
    // 「多用一點英文的專用名詞」 is about terms, not the language of the part.
    const body = c.replace(/[^，。]{0,12}(?:專有名詞|專用名詞|術語|technical terms?|terminology)/gi, "");
    const zh = LANG_ZH.test(body);
    const en = LANG_EN.test(body);
    if (zh === en) continue;
    const lang = zh ? "zh" : "en";
    const part = NOTES_RE.test(body) ? "notes" : SLIDES_RE.test(body) ? "slides" : "all";
    out.push({ part, lang, clause: c });
  }
  return out;
}
const PAGES_RE = /(\d{1,3})\s*(?:頁|張|pages?\b|slides?\b)/i;
export function pageClaim(text: string): number | null {
  const m = PAGES_RE.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- run accessors

type RouteLike = { deck?: string; edit?: string; kind?: string; deliverable?: string; playbook?: string; informed?: boolean; reason?: string };
export const routeOf = (r: StoredRun): RouteLike | null => ((r.state?.route as RouteLike | undefined) ?? null);
export const asksOf = (r: StoredRun): StoredAsk[] => Object.values(((r.state?.asks as Record<string, StoredAsk> | undefined) ?? {}));
export const requirementsOf = (r: StoredRun): StoredRequirement[] => {
  const s = (r.state?.requirements as StoredRequirement[] | undefined) ?? [];
  const b = r.brief?.requirements ?? [];
  const seen = new Set<string>();
  return [...b, ...s].filter((q) => {
    const k = `${q.id}|${q.type}|${q.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
/** Whether the run edits a given artifact (a deck revise / expand, a note edit). */
export function isEditRun(r: StoredRun): boolean {
  const rt = routeOf(r);
  return rt?.deck === "edit" || !!rt?.edit || !!r.plan?.edit_kind;
}
const askText = (a: StoredAsk) => [a.title, a.intro, ...(a.questions ?? []).map((q) => q.prompt)].filter(Boolean).join("\n");
const optionsOf = (a: StoredAsk) => (a.questions ?? []).flatMap((q) => (q.options ?? []).map((o) => ({ ...o, question: q.id ?? "" })));
const userGuidance = (r: StoredRun) => (r.guidance ?? []).filter((g) => !g.system && g.text);
/** The 「修」 button sends 「請修正這幾項：…」 — the system's own list, not new content from the user. */
const FIX_GUIDANCE_RE = /^請修正這幾項|^please fix these/i;

export const STUDY_Q_RE = /哪個研究|哪一個研究|放在哪個研究|哪個 ?study|which study|研究名稱/i;
export const PAPER_Q_RE = /哪一篇|哪篇論文|which paper|論文標題/i;
const SETUP_Q_RE = new RegExp(`${STUDY_Q_RE.source}|${PAPER_Q_RE.source}|哪個(?:專案|LaTeX)|哪份簡報|which (?:project|deck)`, "i");
const REFER_BACK_RE = /剛剛|剛才|方才|同一個|同個|一樣的|上一個|上一份|前面那個|之前那個|原本那個|那個研究|這個研究|same (?:one|study|deck)|that (?:one|study)|the previous|the last one/i;
const DELEGATE_RE = /你決定|你選|隨便|都可以|you decide|up to you|your choice/i;

/** Every question the run asked: plan-phase questions (status snapshots / `state.plan_question`) and cards. */
export type AskedQuestion = { at: string | null; text: string; source: string; options: StoredOption[] };
export function questionsAsked(b: RunBundle): AskedQuestion[] {
  const out: AskedQuestion[] = [];
  let last = "";
  for (const e of b.events ?? []) {
    if (e.type !== "workflow") continue;
    const w = e.data.workflow as { status?: string; question?: string | null } | undefined;
    if (w?.status === "awaiting_input" && w.question) {
      if (w.question !== last) out.push({ at: e.created_at, text: w.question, source: "status", options: [] });
      last = w.question;
    } else if (w?.status && w.status !== "awaiting_input") last = "";
  }
  const pq = b.run.state?.plan_question as string | undefined;
  if (pq && !out.some((q) => q.text === pq)) out.push({ at: null, text: pq, source: "plan_question", options: [] });
  for (const a of asksOf(b.run)) out.push({ at: a.asked_at ?? null, text: askText(a), source: `card:${a.id}`, options: optionsOf(a) });
  return out;
}
/** The user's answers in time order (guidance lines and card answers). */
export function answersGiven(r: StoredRun): { at: string; text: string; source: string }[] {
  const out: { at: string; text: string; source: string }[] = [];
  for (const g of userGuidance(r)) if (g.at) out.push({ at: g.at, text: g.text!, source: "guidance" });
  for (const a of asksOf(r)) if (a.answered_at && !a.ai_filled) out.push({ at: a.answered_at, text: JSON.stringify(a.answers ?? []), source: `card:${a.id}` });
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** Names offered in 〈…〉 inside a question (the studies / papers a text question lists). */
const offeredNames = (text: string) => [...text.matchAll(/〈([^〉]{2,120})〉/g)].map((m) => m[1]!);

/** Answers to a setup question (which study / paper): inputs, not the user's words. */
export function setupAnswers(b: RunBundle): string[] {
  const asked = questionsAsked(b).filter((q) => SETUP_Q_RE.test(q.text));
  const names = [...asked.flatMap((q) => offeredNames(q.text)), ...(b.studies ?? []).map((s) => s.title)];
  const out = new Set<string>();
  for (const g of userGuidance(b.run)) {
    const t = g.text!.trim();
    if (g.setup) {
      out.add(t);
      continue;
    }
    if (!asked.length || t.length > 60 || FIX_GUIDANCE_RE.test(t)) continue;
    if (names.some((n) => containment(n, t) >= 0.8 || containment(t, n) >= 0.8) || REFER_BACK_RE.test(t) || DELEGATE_RE.test(t)) out.add(t);
  }
  for (const w of [...(b.run.brief?.user_words ?? []), ...userGuidance(b.run).map((g) => g.text!)]) {
    const a = answerLine(w);
    if (a?.setup && a.answer) out.add(a.answer);
  }
  return [...out];
}

// ---------------------------------------------------------------- conversation: the task's turns

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string };
const blocksOf = (m: StoredMessage): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : []);
const toolUses = (m: StoredMessage) => blocksOf(m).filter((x) => x.type === "tool_use");
const msgText = (m: StoredMessage) => (m.text ?? blocksOf(m).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n")).replace(DELEGATE_PREFIX, "");

/** Index of the assistant message whose start_workflow / start_goal call created this run (by its tool result naming the id). */
export function startIndex(messages: StoredMessage[], runId: string): number {
  const callIds = new Set<string>();
  for (const m of messages) for (const x of blocksOf(m)) if (x.type === "tool_result" && JSON.stringify(x.content ?? "").includes(runId) && x.tool_use_id) callIds.add(x.tool_use_id);
  return messages.findIndex((m) => m.role === "assistant" && toolUses(m).some((u) => u.id && callIds.has(u.id)));
}
/**
 * The user turns that asked for this task: the user message(s) right before the start call, walking back over
 * consecutive user messages and over assistant turns that were clarifying questions (ask_user / ending with a question
 * mark); an assistant answer ends the task (earlier turns were another exchange).
 */
export function taskTurns(messages: StoredMessage[], runId: string): { turns: StoredMessage[]; earlier: StoredMessage[] } | null {
  const i = startIndex(messages, runId);
  if (i < 0) return null;
  const turns: StoredMessage[] = [];
  let j = i - 1;
  for (; j >= 0; j--) {
    const m = messages[j]!;
    if (m.role === "user") {
      turns.unshift(m);
      continue;
    }
    if (m.role === "tool" || m.role === "notice") continue;
    if (m.role === "assistant") {
      if (!turns.length) continue; // the same agent turn's preamble (text before the tool call)
      const asks = toolUses(m).some((u) => u.name === "ask_user") || /[？?]\s*$/.test(msgText(m).trim());
      if (asks) continue;
      break;
    }
  }
  const earlier = messages.slice(0, Math.max(0, j + 1)).filter((m) => m.role === "user");
  return { turns, earlier };
}

/** 「（回答「<question>」）<answer>」: a clarifying answer joined to the user's words (brief.ts clarifyOnce, blocked cards). */
const ANSWER_LINE = /^（回答「([^」]*)」）\s*([\s\S]*)$/;
export const answerLine = (w: string) => {
  const m = ANSWER_LINE.exec(w.trim());
  return m ? { question: m[1]!, answer: m[2]!.trim(), setup: SETUP_Q_RE.test(m[1]!) } : null;
};

/** The user's words for this task: in-scope start turns (or the brief's base words) + their own guidance, minus setup answers and 「修」 lists. */
export function taskWords(b: RunBundle): string[] {
  const brief = b.run.brief;
  const setup = new Set(setupAnswers(b).map(norm));
  let base = brief ? (brief.user_words ?? []).slice(0, brief.base ?? brief.user_words?.length ?? 0) : [b.run.request ?? ""];
  const scope = b.messages ? taskTurns(b.messages, b.run.id) : null;
  if (scope?.turns.length) base = scope.turns.map(msgText);
  const guidance = userGuidance(b.run).map((g) => g.text!).filter((t) => !setup.has(norm(t)) && !FIX_GUIDANCE_RE.test(t));
  const answers = (brief?.user_words ?? []).map(answerLine).filter((a): a is NonNullable<ReturnType<typeof answerLine>> => !!a && !a.setup).map((a) => a.answer);
  return [...base.map((w) => (answerLine(w) ? (answerLine(w)!.setup ? "" : answerLine(w)!.answer) : w)), ...guidance.map((w) => answerLine(w)?.answer ?? w), ...answers]
    .filter((t, i, all) => norm(t).length > 0 && all.findIndex((x) => norm(x) === norm(t)) === i);
}

// ---------------------------------------------------------------- kinds

const BRIEF_FAMILY: Record<string, string> = { deck: "deck", note: "note", lit_review: "note", reading_note: "note", latex: "latex", other: "other" };
const writeFamily = (k: string | undefined) => (!k ? null : /deck|slide/.test(k) ? "deck" : /latex/.test(k) ? "latex" : /note/.test(k) ? "note" : null);

// ---------------------------------------------------------------- patterns

/** Card / option wording that creates a NEW artifact or switches the deliverable. */
const NEW_ARTIFACT_OPTION = /仍做簡報：用研究的文獻庫|主題簡報|新簡報|另做一份|重新做一份|從 ?0 ?到 ?1|new (?:deck|presentation)|from scratch/i;
const SWITCH_KIND_OPTION = /改做(?:筆記|簡報|LaTeX|論文|閱讀筆記|文獻回顧)|改用「一般任務」|switch to (?:a )?(?:note|deck)/i;
/** The draft copy a revision of a user-edited deck is written to (「新簡報「…（Agent 草稿）」（不會動到原本的簡報…）」). */
const DRAFT_COPY = /Agent 草稿|Agent draft|不會動到原本/i;
/** Wording of a from-zero creation (wrong on an edit route). */
const NEW_WORDING = /從 ?0 ?到 ?1|建立(?:一份)?(?:新)?簡報|新簡報|主題簡報|new (?:deck|presentation)|from scratch/i;
const INTERNAL_JARGON = /approved_outline|<\/?sources>|\breq_[a-z0-9_]+\b|\bwrite_\d+\b|\bstep_[a-z0-9_]+\b|\bP\d+…|\bcriteri(?:on|a)\b|\bchecklist\b|\bledger\b|\bbudget_[a-z]+\b|\bjudge\b/i;
const STRUCTURAL_REASON = /缺少|未呈現完整|未列出|不完整|沒有涵蓋|未涵蓋|少了|涵蓋不足|只讀了|missing|not covered|incomplete|lacks?\b|找不到對應來源|沒有來源|無來源|not (?:found )?in the sources|no source/i;
const UNLOCATED_REASON = /此數字|這個數字|該數字|這些數字|此數據|this number|the number|these numbers/i;
const MISSING_VENUE = /(?:venue|會議或期刊|期刊或會議|發表(?:場合|處))[^。\n]{0,50}?(?:未提供|沒有提供|未知|不明|無法得知|not (?:provided|available|given|known)|unknown|missing)|venues? (?:are|is|was|were) not (?:provided|available|given)|(?:未提供|沒有提供)[^。\n]{0,12}(?:venue|會議|期刊)/i;
const MISSING_YEAR = /(?:year|年份|發表年)[^。\n]{0,30}?(?:未提供|沒有提供|未知|not (?:provided|available)|unknown)/i;
const CONTENT_READ_TOOLS = /^(get_deck|get_deck_pages|get_deck_source|read_deck\w*|get_slides?\w*|get_note|get_note_history|read_note\w*|read_paper|view_paper_pages|get_paper|latex_read_file|latex_\w*read\w*|get_meeting|review_deck_layout|review_latex_layout|get_latex\w*)$/;
const ARTIFACT_REF = /簡報|投影片|講稿|筆記|草稿|論文|這份|這個|deck|slides?|presentation|note|draft|paper/i;
const CONTENT_QUESTION = /偏向|涵蓋|有沒有|有哪些|內容|講了|提到|是什麼|哪一類|裡面|包含|what|which|does it|cover|mention|include/i;
const CONTENT_CLAIM = /涵蓋|包括|包含|內容|提到|列出|整體|偏向|covers?|includes?|contains?|mentions?/i;
const TOPIC_CLAUSE = /描述|關於|有關|主題|介紹|探討|講(?:解)?(?:一下)?(?:目前|現在)|about|on the topic|covering|overview of/i;
const LIBRARY_ASK = /文獻庫|我們的文獻|研究的文獻|library|our papers|study papers/i;

// ---------------------------------------------------------------- the invariants

const LOOSE_LANG: Record<string, "zh" | "en"> = { zh: "zh", "zh-tw": "zh", en: "en" };
const reqLang = (q: StoredRequirement) => (q.type === "language" ? (LOOSE_LANG[String(q.params?.language ?? "").toLowerCase()] ?? null) : null);
const reqPart = (q: StoredRequirement): "notes" | "slides" | "all" => (q.params?.part === "notes" ? "notes" : q.params?.part === "slides" ? "slides" : "all");
const partsOverlap = (a: string, b: string) => a === "all" || b === "all" || a === b;

/** Newest claim per deck part, from the task words in order (newer turns override older ones). */
function newestLanguageClaims(words: string[]): LanguageClaim[] {
  const by = new Map<string, LanguageClaim>();
  for (const w of words) {
    for (const c of languageClaims(w)) {
      if (c.part === "all") by.clear();
      by.set(c.part, c);
    }
  }
  return [...by.values()];
}

const PART_ONLY = /^(?:[^，。]{0,6})(?:包含|包括|連同|含|也要|including|incl\.?)?\s*(?:the\s+)?(?:封面|標題|講稿|圖表|cover|title|speaker notes|notes|diagrams?)[、和與及跟,\s&and]*(?:the\s+)?(?:封面|標題|講稿|圖表|cover|title|speaker notes|notes|diagrams?)?\s*(?:也要|都要|一起)?[。.]?$/i;
/** Whether requirement `q` accounts for clause `c` (its quote is that clause, or its typed parameters are about it). */
function covers(q: StoredRequirement, c: string): boolean {
  if (q.source === "standing") return false;
  const quote = q.quote ?? "";
  const inQuote = quote ? containment(c, quote) : 0;
  const tight = quote ? grams(quote).size <= 2.5 * Math.max(4, grams(c).size) : false;
  const typed =
    q.type === "language" ? LANG_ZH.test(c) || LANG_EN.test(c)
    : q.type === "page_count" ? PAGES_RE.test(c) || /頁數/.test(c)
    : q.type === "exclude" ? /刪|拿掉|去掉|移除|不要|不需要|remove|delete|drop|without|exclude/i.test(c)
    : q.type === "per_item_fields" ? /每(?:一)?(?:個|種|篇|項)|各|for each|each|every/i.test(c)
    : false;
  if (inQuote >= 0.6 && (tight || typed)) return true;
  // Per-item fields named in the clause (「都要有 architecture、Pros/Cons」 ↔ fields architecture / pros / cons).
  if (q.type === "per_item_fields") {
    const fields = ((q.params?.fields as { name?: string; aliases?: string[] }[] | undefined) ?? []).flatMap((f) => [f.name ?? "", ...(f.aliases ?? [])]).filter((x) => x.length >= 2);
    if (fields.filter((f) => c.toLowerCase().includes(f.toLowerCase())).length >= Math.min(2, fields.length) && fields.length) return true;
  }
  // 「包含封面和講稿」: which parts a whole-artifact language requirement reaches — it already covers every part.
  if (q.type === "language" && !q.params?.part && PART_ONLY.test(c) && !LANG_ZH.test(c) && !LANG_EN.test(c)) return true;
  // An untyped requirement quoting a short passage (≤ 3 clauses) covers every clause inside it; a typed one (language,
  // page count…) only the clause about its own dimension.
  // A per-item requirement enumerates several asks (「每種方法：優缺點、架構圖、論文、venue」): its quote may span up to 6.
  const untyped = !["language", "page_count", "exclude"].includes(q.type ?? "");
  if (untyped && inQuote >= 0.9 && clauses(quote).length <= (q.type === "per_item_fields" ? 6 : 3)) return true;
  // The requirement's own text restates the clause.
  const text = `${q.text ?? ""} ${quote}`;
  return containment(c, text) >= 0.6 && grams(c).size >= 4 && (tight || typed || containment(c, q.text ?? "") >= 0.5);
}

export const INVARIANTS: Invariant[] = [
  // ------------------------------------------------------------ route
  {
    id: "route.no_new_artifact_option", category: "route", scope: "run", severity: "critical",
    title: "編輯既有成果的路由不會提供「新建成果」或「改做別種成果」的選項",
    reads: "state.route, state.asks[].questions[].options",
    check: (b) => {
      if (!isEditRun(b.run)) return [];
      const hits: Hit[] = [];
      for (const a of asksOf(b.run)) {
        for (const o of optionsOf(a)) {
          const text = `${o.label} ${o.description ?? ""}`;
          if (NEW_ARTIFACT_OPTION.test(text) || SWITCH_KIND_OPTION.test(text) || o.value === "topic" || o.value === "switch")
            hits.push({ message: `修改既有成果的流程，卡片「${clip(a.title, 40)}」卻提供「${o.label}」`, evidence: { card: a.id, option: o.label, value: o.value ?? null, description: clip(o.description, 120), route: routeOf(b.run) } });
        }
      }
      return hits;
    },
  },
  {
    id: "route.wording", category: "route", scope: "run", severity: "high",
    title: "卡片、通知、紀錄、計畫的用詞與路由一致（修改不說「從 0 到 1／新簡報」）",
    reads: "state.route, state.asks, question, state.plan_question, log events, notices, plan.summary/writes, title",
    check: (b) => {
      if (!isEditRun(b.run)) return [];
      const sources: { where: string; text: string }[] = [
        ...asksOf(b.run).map((a) => ({ where: `card:${a.id}`, text: askText(a) })),
        { where: "question", text: b.run.question ?? "" },
        { where: "plan_question", text: (b.run.state?.plan_question as string | undefined) ?? "" },
        { where: "plan.summary", text: b.run.plan?.summary ?? "" },
        ...(b.run.plan?.writes ?? []).map((w) => ({ where: "plan.writes", text: w.label ?? "" })),
        { where: "title", text: b.run.title ?? "" },
        ...(b.events ?? []).filter((e) => e.type === "log").map((e) => ({ where: `log@${e.created_at}`, text: String(e.data.text ?? "") })),
        ...(b.messages ?? []).filter((m) => m.role === "notice" && JSON.stringify(m.content ?? "").includes(b.run.id)).map((m) => ({ where: `notice#${m.seq}`, text: msgText(m) })),
      ];
      const bad = sources.filter((s) => s.text && NEW_WORDING.test(s.text) && !(s.where === "plan.writes" && DRAFT_COPY.test(s.text)));
      if (!bad.length) return [];
      // What the user reads (cards, questions, notices, the plan) is high; a log line alone is medium.
      const seen = bad.some((s) => !s.where.startsWith("log@"));
      return [{ message: `修改既有成果，但 ${bad.length} 處用詞是「新建」（例如「${clip(NEW_WORDING.exec(bad[0]!.text)?.[0], 20)}」）`, evidence: { route: routeOf(b.run), places: bad.slice(0, 8).map((s) => ({ where: s.where, text: clip(s.text, 160) })) }, ...(seen ? {} : { severity: "medium" as const }) }];
    },
  },
  {
    id: "route.plan_matches", category: "route", scope: "run", severity: "high",
    title: "計畫的寫入方式與修改種類和路由一致",
    reads: "state.route, plan.writes[].effect, plan.edit_kind, inputs",
    check: (b) => {
      const rt = routeOf(b.run);
      const plan = b.run.plan;
      if (!rt || !plan) return [];
      const hits: Hit[] = [];
      const edit = isEditRun(b.run);
      // A user-edited deck is never overwritten: its revision goes to an 「Agent 草稿」 copy (slides.ts plannedDeckWrite) — by design.
      const newDeck = (plan.writes ?? []).filter((w) => writeFamily(w.kind) === "deck" && w.effect === "new" && !DRAFT_COPY.test(w.label ?? ""));
      if (edit && newDeck.length) hits.push({ message: "路由是修改既有簡報，計畫卻寫入一份新簡報", evidence: { route: rt, writes: newDeck } });
      const overwrite = (plan.writes ?? []).filter((w) => w.effect === "overwrite");
      if (!edit && overwrite.length && rt.deck && rt.deck !== "edit") hits.push({ message: "路由是新建，計畫卻覆蓋既有內容", evidence: { route: rt, writes: overwrite } });
      if (rt.edit && plan.edit_kind && rt.edit !== plan.edit_kind) hits.push({ message: `路由的修改種類是 ${rt.edit}，計畫是 ${plan.edit_kind}`, evidence: { route_edit: rt.edit, plan_edit: plan.edit_kind } });
      return hits;
    },
  },
  // ------------------------------------------------------------ deliverable
  {
    id: "deliverable.consistent", category: "deliverable", scope: "run", severity: "critical",
    title: "Brief 的交付物 = 路由 = 計畫寫入 = 實際成果",
    reads: "brief.deliverable.kind, state.route.kind, plan.writes[].kind, artifacts[].kind",
    check: (b) => {
      const kind = b.run.brief?.deliverable?.kind;
      if (!kind) return [];
      const want = BRIEF_FAMILY[kind] ?? kind;
      if (want === "other") return [];
      const rt = routeOf(b.run);
      const got: { where: string; kind: string }[] = [];
      if (rt?.kind) got.push({ where: "route", kind: BRIEF_FAMILY[rt.kind] ?? rt.kind });
      for (const w of b.run.plan?.writes ?? []) {
        const f = writeFamily(w.kind);
        if (f) got.push({ where: `plan.writes「${clip(w.label, 40)}」`, kind: f });
      }
      // A goal's stage may write an intermediate kind; a plain run may not.
      if (!b.run.goal_id) for (const a of b.run.artifacts ?? []) {
        const f = writeFamily(a.kind);
        if (f) got.push({ where: `artifact「${clip(a.title, 40)}」`, kind: f });
      }
      const wrong = got.filter((g) => g.kind !== want);
      return wrong.length ? [{ message: `交付物是 ${kind}，但 ${wrong.map((w) => `${w.where}=${w.kind}`).join("、")}`, evidence: { brief: kind, mismatches: wrong } }] : [];
    },
  },
  // ------------------------------------------------------------ requirements
  {
    id: "req.clause_coverage", category: "requirements", scope: "run", severity: "high",
    title: "使用者每一句有內容的要求都對應到一條要求，或被明確列為不採用",
    reads: "brief.user_words (task turns), guidance, brief/state.requirements[].quote, state.requirements_dropped, topic text",
    check: (b) => {
      const brief = b.run.brief;
      if (!brief || (brief.version ?? 0) < 1) return [];
      const reqs = requirementsOf(b.run);
      const dropped = (b.run.state?.requirements_dropped as { clause?: string; reason?: string }[] | undefined) ?? [];
      // A new artifact's topic / focus clause (「這個簡報裡面詳細描述…」) is carried by the plan's topic; an edit has none.
      const topic = isEditRun(b.run) ? "" : topicFields(b.run).filter((t) => t.where !== "title" || norm(t.text) !== norm(b.run.request)).map((t) => t.text).join(" ");
      const hits: Hit[] = [];
      for (const w of taskWords(b)) {
        const cs = contentClauses(w);
        const subject = cs.find((c) => !c.core)?.clause;
        for (const { clause, core } of cs) {
          if (core) continue;
          if (reqs.some((q) => covers(q, clause))) continue;
          if (dropped.some((d) => d.clause && (containment(clause, d.clause) >= 0.6 || containment(d.clause, clause) >= 0.8))) continue;
          // The topic / focus clause is carried by the plan's topic, not a requirement.
          if (topic && TOPIC_CLAUSE.test(clause) && salientOverlap(clause, topic) >= 2) continue;
          // The first content clause is often the subject itself (「整理…評估指標」): a missing topic list is weaker than a lost ask.
          hits.push({ message: `這句話沒有對應的要求：「${clip(clause, 60)}」`, evidence: { clause, requirements: reqs.map((q) => ({ id: q.id, type: q.type, source: q.source, quote: clip(q.quote, 60) })) }, ...(clause === subject && cs.indexOf(cs.find((c) => c.clause === clause)!) <= 1 ? { severity: "medium" as const } : {}) });
        }
      }
      return hits;
    },
  },
  {
    id: "req.contradicts_newest", category: "requirements", scope: "run", severity: "critical",
    title: "要求不違反使用者最新的話（語言分投影片／講稿、頁數）",
    reads: "task words (newest last), requirements (language part, page_count)",
    check: (b) => {
      const reqs = requirementsOf(b.run);
      if (!reqs.length) return [];
      const words = taskWords(b);
      const hits: Hit[] = [];
      for (const c of newestLanguageClaims(words)) {
        for (const q of reqs) {
          const l = reqLang(q);
          if (!l || l === c.lang || !partsOverlap(reqPart(q), c.part)) continue;
          hits.push({ message: `你說${c.part === "notes" ? "講稿" : c.part === "slides" ? "投影片" : "整份"}要${c.lang === "zh" ? "中文" : "英文"}，要求卻是${reqPart(q) === "all" ? "整份" : reqPart(q) === "notes" ? "講稿" : "投影片"}${l === "zh" ? "中文" : "英文"}`, evidence: { claim: c, requirement: { id: q.id, text: q.text, source: q.source, params: q.params } } });
        }
      }
      const newest = [...words].reverse().map(pageClaim).find((n) => n != null) ?? null;
      for (const q of reqs) {
        if (q.type !== "page_count" || newest == null) continue;
        const ex = q.params?.exact;
        if (typeof ex === "number" && ex !== newest) hits.push({ message: `你說 ${newest} 頁，要求是 ${ex} 頁`, evidence: { claim: newest, requirement: q } });
      }
      return hits;
    },
  },
  {
    id: "req.standing_not_override", category: "requirements", scope: "run", severity: "high",
    title: "沿用的設定（standing）不會蓋過使用者這次在同一維度說的話",
    reads: "requirements[].source = standing, task words",
    check: (b) => {
      const reqs = requirementsOf(b.run);
      const standing = reqs.filter((q) => q.source === "standing");
      if (!standing.length) return [];
      const claims = newestLanguageClaims(taskWords(b));
      const hits: Hit[] = [];
      for (const s of standing) {
        if (s.type === "language") {
          for (const c of claims) {
            if (!partsOverlap(reqPart(s), c.part)) continue;
            const own = reqs.some((q) => q.source !== "standing" && q.type === "language" && partsOverlap(reqPart(q), c.part));
            if (!own) hits.push({ message: `使用者這次講了${c.part === "notes" ? "講稿" : c.part === "slides" ? "投影片" : ""}語言，卻只有沿用的語言設定「${clip(s.text, 40)}」`, evidence: { standing: s, user_clause: c.clause } });
          }
        }
        if (s.type === "page_count" && taskWords(b).some((w) => pageClaim(w) != null) && !reqs.some((q) => q.source !== "standing" && q.type === "page_count"))
          hits.push({ message: "使用者講了頁數，卻只有沿用的頁數設定", evidence: { standing: s } });
      }
      return hits;
    },
  },
  {
    id: "req.setup_not_content", category: "requirements", scope: "run", severity: "high",
    title: "設定問題的回答（哪個研究、哪篇論文）不會變成要求、原話或主題",
    reads: "guidance (setup answers to which-study / which-paper questions), brief.user_words, requirements, state.topic_title/topic, title, plan.front_title",
    check: (b) => {
      const answers = setupAnswers(b);
      if (!answers.length) return [];
      const words = taskWords(b).join("\n");
      const hits: Hit[] = [];
      const progress = routeOf(b.run)?.deck === "progress";
      for (const a of answers) {
        if (norm(a).length < 4 || REFER_BACK_RE.test(a) || DELEGATE_RE.test(a)) continue;
        const inWords = containment(a, words) >= 0.7;
        for (const q of requirementsOf(b.run)) {
          if (q.quote && containment(a, q.quote) >= 0.8) hits.push({ message: `設定回答「${clip(a, 30)}」變成了要求`, evidence: { answer: a, requirement: q } });
        }
        if ((b.run.brief?.user_words ?? []).some((w) => norm(w) === norm(a))) hits.push({ message: `設定回答「${clip(a, 30)}」被當成使用者的原話`, evidence: { answer: a, user_words: b.run.brief?.user_words }, severity: "medium" });
        if (!progress && !inWords) {
          for (const t of topicFields(b.run)) {
            if (t.text && containment(a, t.text) >= 0.8) hits.push({ message: `設定回答「${clip(a, 30)}」變成了主題（${t.where}：「${clip(t.text, 50)}」）`, evidence: { answer: a, where: t.where, text: t.text } });
          }
        }
      }
      return hits;
    },
  },
  {
    id: "req.user_words_scope", category: "requirements", scope: "run", severity: "high",
    title: "Brief 的原話只有這個任務的話（不含之前另一段對話、「ok」）",
    reads: "brief.user_words (base), conversation messages around the start call",
    check: (b) => {
      const brief = b.run.brief;
      if (!brief || !b.messages?.length) return [];
      const scope = taskTurns(b.messages, b.run.id);
      if (!scope) return [];
      const inScope = [...scope.turns.map(msgText), ...userGuidance(b.run).map((g) => g.text!)];
      const hits: Hit[] = [];
      for (const w of (brief.user_words ?? []).slice(0, brief.base ?? brief.user_words?.length ?? 0)) {
        if (answerLine(w) || inScope.some((t) => containment(w, t) >= 0.8)) continue;
        const from = scope.earlier.find((m) => containment(w, msgText(m)) >= 0.8);
        hits.push({ message: `原話含有不屬於這個任務的話：「${clip(w, 50)}」`, evidence: { word: w, from_message: from?.seq ?? null, task_turns: scope.turns.map((m) => m.seq) } });
      }
      return hits;
    },
  },
  // ------------------------------------------------------------ context
  {
    id: "ctx.input_artifact_study", category: "context", scope: "run", severity: "critical",
    title: "有輸入成果（簡報、筆記、LaTeX）的流程就在那個成果的研究裡",
    reads: "inputs.deck_id / note_id / note_ids / project_id → artifact study; run.study_id",
    check: (b) => {
      const map = b.artifactStudies ?? {};
      const ids = inputArtifacts(b.run);
      const hits: Hit[] = [];
      for (const { key, id } of ids) {
        if (!(id in map)) continue;
        const s = map[id] ?? null;
        if (s && b.run.study_id !== s) hits.push({ message: `輸入的${key}在研究 ${s.slice(0, 8)}，流程的研究是 ${b.run.study_id?.slice(0, 8) ?? "（沒有）"}`, evidence: { input: key, artifact: id, artifact_study: s, run_study: b.run.study_id ?? null, status: b.run.status } });
      }
      return hits;
    },
  },
  {
    id: "ctx.no_derivable_study_question", category: "context", scope: "run", severity: "critical",
    title: "能推得出研究時（輸入成果、對話、頁面、前一個流程），不問「放在哪個研究」",
    reads: "questions asked, artifact studies, conversation study/context, message page_context, earlier runs of the conversation",
    check: (b) => {
      const asked = questionsAsked(b).filter((q) => STUDY_Q_RE.test(q.text));
      if (!asked.length) return [];
      const why: { from: string; study: string }[] = [];
      for (const { key, id } of inputArtifacts(b.run)) {
        const s = b.artifactStudies?.[id];
        if (s) why.push({ from: `輸入的${key}`, study: s });
      }
      if (b.conversation?.study_id) why.push({ from: "對話的研究", study: b.conversation.study_id });
      const ctxStudy = (b.conversation?.context?.studyId ?? b.run.context?.studyId) as string | undefined;
      if (ctxStudy) why.push({ from: "頁面", study: ctxStudy });
      for (const m of b.messages ?? []) if (m.role === "user" && typeof m.page_context?.studyId === "string") why.push({ from: `訊息 #${m.seq} 的頁面`, study: m.page_context.studyId as string });
      const created = b.run.created_at ? Date.parse(b.run.created_at) : Infinity;
      for (const s of b.siblings ?? []) if (s.study_id && s.id !== b.run.id && s.created_at && Date.parse(s.created_at) < created) why.push({ from: `同一個對話的前一個流程 ${s.id.slice(0, 8)}`, study: s.study_id });
      if (!why.length) return [];
      return [{ message: `問了「放在哪個研究」，但研究推得出來（${[...new Set(why.map((w) => w.from))].slice(0, 3).join("、")}）`, evidence: { questions: asked.map((q) => clip(q.text, 100)), derivable: why.slice(0, 6) } }];
    },
  },
  // ------------------------------------------------------------ questions
  {
    id: "q.not_repeated", category: "questions", scope: "run", severity: "high",
    title: "同一個問題回答過後不會再問一次",
    reads: "status snapshots (awaiting_input + question), state.plan_question, state.asks, guidance / card answers",
    check: (b) => {
      const qs = questionsAsked(b).filter((q) => q.at);
      const answers = answersGiven(b.run);
      const hits: Hit[] = [];
      for (let i = 0; i < qs.length; i++) {
        for (let j = i + 1; j < qs.length; j++) {
          const a = qs[i]!;
          const c = qs[j]!;
          const between = answers.filter((x) => Date.parse(x.at) > Date.parse(a.at!) && Date.parse(x.at) <= Date.parse(c.at!));
          if (!between.length) continue;
          if (containment(a.text, c.text) >= 0.6 || containment(c.text, a.text) >= 0.6)
            hits.push({ message: `回答「${clip(between.at(-1)!.text, 30)}」之後又問了同一個問題`, evidence: { first: { at: a.at, source: a.source, text: clip(a.text, 120) }, again: { at: c.at, source: c.source, text: clip(c.text, 160) }, answer: between.map((x) => clip(x.text, 80)) } });
        }
      }
      return dedupe(hits, (h) => `${(h.evidence.again as { source: string }).source}`);
    },
  },
  {
    id: "q.options_match", category: "questions", scope: "run", severity: "high",
    title: "選項回答的是卡片問的問題（問研究就列研究、問論文就列論文）",
    reads: "state.asks[].intro/title/prompt vs options, the owner's studies, the library",
    check: (b) => {
      const hits: Hit[] = [];
      const studyTitles = (b.studies ?? []).map((s) => s.title);
      const paperTitles = (b.library ?? []).map((p) => p.title);
      for (const a of asksOf(b.run)) {
        const text = askText(a);
        const opts = optionsOf(a);
        const choice = (a.questions ?? []).some((q) => (q.options ?? []).length > 0);
        const free = (a.questions ?? []).some((q) => /text/.test(q.type ?? ""));
        if (!choice) continue;
        const names = offeredNames(text);
        const labels = opts.map((o) => `${o.label} ${o.value ?? ""}`);
        const matches = (pool: string[]) => labels.some((l) => pool.some((n) => containment(n, l) >= 0.7 || containment(l, n) >= 0.7));
        if (STUDY_Q_RE.test(text) && !matches([...studyTitles, ...names])) hits.push({ message: `卡片「${clip(a.title, 30)}」問研究，選項卻沒有任何研究`, evidence: { card: a.id, asks: clip(text, 160), options: opts.map((o) => o.label) } });
        else if (PAPER_Q_RE.test(text) && !matches([...paperTitles, ...names]) && !labels.some((l) => /不指定|主題簡報|no paper/i.test(l))) hits.push({ message: `卡片「${clip(a.title, 30)}」問論文，選項卻沒有任何論文`, evidence: { card: a.id, asks: clip(text, 160), options: opts.map((o) => o.label) } });
        if (/請在補充指示寫|請寫下|請輸入|write (?:the|its) name/i.test(text) && !free && !(a.questions ?? []).some((q) => q.type === "single_choice" && opts.some((o) => /其他/.test(o.label))))
          hits.push({ message: `卡片「${clip(a.title, 30)}」要使用者寫文字，卻只有選項`, evidence: { card: a.id, options: opts.map((o) => o.label) }, severity: "medium" });
      }
      return hits;
    },
  },
  {
    id: "q.options_route", category: "questions", scope: "run", severity: "high",
    title: "每個選項都和路由、交付物一致",
    reads: "state.asks options, brief.deliverable, state.route",
    check: (b) => {
      const kind = b.run.brief?.deliverable?.kind;
      const hits: Hit[] = [];
      const fam = kind ? BRIEF_FAMILY[kind] ?? kind : null;
      for (const a of asksOf(b.run)) {
        const kindCard = /^deliverable_|^clarify_deliverable/.test(a.id);
        for (const o of optionsOf(a)) {
          const text = `${o.label} ${o.description ?? ""}`;
          // Changing the deliverable is only offered by the deliverable cards (and never on an edit: route.no_new_artifact_option).
          if (!kindCard && SWITCH_KIND_OPTION.test(text)) hits.push({ message: `卡片「${clip(a.title, 30)}」不是交付物卡片，卻提供改變交付物的「${o.label}」`, evidence: { card: a.id, option: o.label } });
          // 「仍做<kind>」 must name the Brief's kind.
          const keep = /仍做|繼續做|still (?:make|do)/.exec(text) ? writeFamily(/簡報|deck/.test(text) ? "deck" : /筆記|note/.test(text) ? "note" : /latex|論文/i.test(text) ? "latex" : undefined) : null;
          if (keep && fam && keep !== fam) hits.push({ message: `選項「${o.label}」說仍做 ${keep}，交付物是 ${kind}`, evidence: { card: a.id, option: o.label, brief: kind } });
        }
      }
      return hits;
    },
  },
  // ------------------------------------------------------------ repair
  {
    id: "repair.same_failures", category: "repair", scope: "run", severity: "high",
    title: "修正輪重複同樣的失敗會被標出（步驟與最終驗收）",
    reads: "workflow_steps.inputs.conv.rounds, workflow snapshots (finished criteria), state.final_ledger",
    check: (b) => {
      const hits: Hit[] = [];
      for (const s of b.steps ?? []) {
        const rounds = s.conv?.rounds ?? [];
        for (let i = 0; i + 2 < rounds.length; i++) {
          const f0 = (rounds[i]!.failures ?? []).join("|");
          if (f0 && f0 === (rounds[i + 1]!.failures ?? []).join("|")) {
            hits.push({ message: `步驟「${clip(s.title ?? s.key, 40)}」第 ${rounds[i]!.round}、${rounds[i + 1]!.round} 輪失敗相同，仍繼續修第 ${rounds[i + 2]!.round} 輪`, evidence: { step: s.key, failures: rounds[i]!.failures, rounds: rounds.map((r) => r.round) } });
            break;
          }
        }
      }
      const finals = finishedSnapshots(b);
      for (let i = 0; i + 1 < finals.length; i++) {
        const a = finals[i]!;
        const c = finals[i + 1]!;
        const same = a.failed.filter((id) => c.failed.includes(id));
        if (same.length) hits.push({ message: `修正後同樣的驗收項目又失敗：${same.join("、")}`, evidence: { first: { at: a.at, failed: a.failed }, again: { at: c.at, failed: c.failed }, reasons: same.map((id) => ({ id, before: clip(a.reasons[id], 100), after: clip(c.reasons[id], 100) })) } });
      }
      return hits;
    },
  },
  {
    id: "repair.structural_not_rewrite", category: "repair", scope: "run", severity: "high",
    title: "結構性的失敗（缺來源、涵蓋不足）不送去重寫",
    reads: "failed criteria reasons, the repair that followed (writer re-runs in logs / steps), the next verdict",
    check: (b) => {
      const finals = finishedSnapshots(b);
      if (!finals.length) {
        const failed = (b.run.criteria ?? []).filter((c) => c.status === "fail" && STRUCTURAL_REASON.test(c.reason ?? ""));
        return b.run.status === "partial" && failed.length ? [{ message: `結構性的驗收失敗被當成可重寫：${failed.map((c) => c.id).join("、")}`, evidence: { criteria: failed.map((c) => ({ id: c.id, reason: clip(c.reason, 140) })) }, severity: "medium" }] : [];
      }
      const hits: Hit[] = [];
      const logs = (b.events ?? []).filter((e) => e.type === "log");
      for (let i = 0; i < finals.length; i++) {
        const f = finals[i]!;
        const structural = f.failed.filter((id) => STRUCTURAL_REASON.test(f.reasons[id] ?? ""));
        if (!structural.length) continue;
        const next = finals[i + 1];
        const rewrites = logs.filter((e) => Date.parse(e.created_at) > Date.parse(f.at) && (!next || Date.parse(e.created_at) < Date.parse(next.at)) && /派出子任務：撰寫|撰寫第 \d+ 頁|rewrite/i.test(String(e.data.text ?? "")));
        if (next && rewrites.length && structural.some((id) => next.failed.includes(id)))
          hits.push({ message: `結構性的失敗（${structural.join("、")}）被送去重寫頁面，修完仍失敗`, evidence: { reasons: structural.map((id) => ({ id, reason: clip(f.reasons[id], 140) })), rewrites: rewrites.slice(0, 4).map((e) => clip(String(e.data.text), 100)) } });
        else if (!next && b.run.status === "partial" && !hits.length)
          hits.push({ message: `結構性的失敗（${structural.join("、")}）只提供「修」（重寫），沒有說需要補來源／重新規劃`, evidence: { reasons: structural.map((id) => ({ id, reason: clip(f.reasons[id], 140) })) }, severity: "medium" });
      }
      return hits;
    },
  },
  {
    id: "repair.actionable_reason", category: "repair", scope: "run", severity: "medium",
    title: "失敗理由指得出位置（哪個數字、哪一頁），修正才有目標",
    reads: "failed criteria reasons / evidence",
    check: (b) =>
      (b.run.criteria ?? [])
        .filter((c) => c.status === "fail" && UNLOCATED_REASON.test(c.reason ?? "") && !/\d/.test((c.reason ?? "").replace(/P\d+/g, "")) && !/第\s*\d+\s*頁|page\s*\d+/i.test(c.reason ?? ""))
        .map((c) => ({ message: `「${c.id}」的失敗理由沒有指出是哪個數字、哪一頁`, evidence: { id: c.id, reason: clip(c.reason, 160), evidence: clip(c.evidence, 160) } })),
  },
  // ------------------------------------------------------------ outcome
  {
    id: "outcome.partial_explained", category: "outcome", scope: "run", severity: "high",
    title: "部分完成用使用者聽得懂的話說明原因",
    reads: "status, report.issues/summary_md, stop_reason, notices",
    check: (b) => {
      if (b.run.status !== "partial") return [];
      const issues = b.run.report?.issues ?? [];
      const hits: Hit[] = [];
      if (!issues.length && !(b.run.report?.summary_md ?? "").trim()) hits.push({ message: "部分完成，卻沒有說明原因", evidence: { stop_reason: b.run.stop_reason ?? null } });
      const jargon = issues.filter((t) => INTERNAL_JARGON.test(t));
      if (jargon.length) hits.push({ message: `部分完成的說明含有內部用語（${[...new Set(jargon.map((t) => INTERNAL_JARGON.exec(t)![0]))].join("、")}）`, evidence: { issues: jargon.map((t) => clip(t, 160)) } });
      if (/^budget_/.test(b.run.stop_reason ?? "") && !issues.some((t) => /預算|上限|時間|次數|budget|limit/i.test(t))) hits.push({ message: "因預算用完而停止，說明卻沒有講", evidence: { stop_reason: b.run.stop_reason } });
      return hits;
    },
  },
  {
    id: "outcome.not_stuck_awaiting", category: "outcome", scope: "run", severity: "high",
    title: "使用者回答後，流程不會停在「等待你回答」超過 10 分鐘",
    reads: "status, guidance / card answer times, status snapshots after the answer",
    check: (b) => {
      if (b.run.status !== "awaiting_input") return [];
      const answers = answersGiven(b.run);
      const last = answers.at(-1);
      if (!last) return [];
      const now = b.now ?? new Date().toISOString();
      const mins = minutesBetween(last.at, now);
      if (mins <= 10) return [];
      const progressed = (b.events ?? []).some((e) => e.type === "workflow" && Date.parse(e.created_at) > Date.parse(last.at) && ["awaiting_plan_approval", "running", "verifying"].includes(String((e.data.workflow as { status?: string } | undefined)?.status)));
      if (progressed) return [];
      return [{ message: `使用者 ${Math.round(mins)} 分鐘前回答了，流程仍在等待回答`, evidence: { answered_at: last.at, answer: clip(last.text, 80), question: clip(b.run.question, 100), now } }];
    },
  },
  // ------------------------------------------------------------ assistant (conversation scope)
  {
    id: "assistant.read_before_claim", category: "assistant", scope: "conversation", severity: "high",
    title: "助理談成果內容之前，先用工具讀過那份內容",
    reads: "conversation messages: user question about an artifact, the assistant's tool calls in that turn, its answer",
    check: (b) => {
      const hits: Hit[] = [];
      const ms = b.messages;
      for (let i = 0; i < ms.length; i++) {
        const u = ms[i]!;
        if (u.role !== "user") continue;
        const q = msgText(u);
        if (!ARTIFACT_REF.test(q) || !CONTENT_QUESTION.test(q)) continue;
        const turn: StoredMessage[] = [];
        for (let j = i + 1; j < ms.length && ms[j]!.role !== "user"; j++) turn.push(ms[j]!);
        const tools = turn.flatMap((m) => toolUses(m).map((t) => t.name ?? ""));
        if (tools.some((t) => /^start_(workflow|goal)$/.test(t))) continue; // delegated, not answered
        const answer = turn.filter((m) => m.role === "assistant").map(msgText).join("\n");
        const claims = CONTENT_CLAIM.test(answer) && (answer.match(/^\s*(?:\d+\.|[-*・])\s+/gm)?.length ?? 0) >= 2;
        if (!claims) continue;
        if (tools.some((t) => CONTENT_READ_TOOLS.test(t))) continue;
        hits.push({ message: `回答「${clip(q, 40)}」時談了成果內容，卻沒有讀那份內容（只用了 ${tools.join("、") || "沒有工具"}）`, evidence: { user_message: u.seq, tools, answer: clip(answer, 200) } });
      }
      return hits;
    },
  },
  {
    id: "assistant.target_grounded", category: "assistant", scope: "conversation", severity: "critical",
    title: "助理只對這個對話的成果（或使用者說出標題的那份）動手，不對搜尋挑出來的成果動手",
    reads: "assistant tool calls with deck_id / note_id(s) / project_id; earlier page contexts, workflow artifacts / inputs, create_* results, search / list results",
    check: (b) => {
      const hits: Hit[] = [];
      const ms = b.messages;
      const names = new Map<string, string>();
      for (const m of ms) for (const u of toolUses(m)) if (u.id && u.name) names.set(u.id, u.name);
      const ACT = /^(?:start_workflow|start_goal|suggest_deck_edit|delete_|remove_|update_deck|suggest_note_edit|latex_)/;
      const SEARCH = /^(?:search|list_|find_)/;
      for (let i = 0; i < ms.length; i++) {
        for (const u of toolUses(ms[i]!)) {
          if (!u.name || !ACT.test(u.name)) continue;
          const input = (u.input ?? {}) as Record<string, unknown>;
          const ids = [input.deck_id, input.note_id, input.project_id, ...(Array.isArray(input.note_ids) ? input.note_ids : [])].filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x));
          for (const id of ids) {
            const before = ms.slice(0, i);
            const onPage = before.some((m) => m.role === "user" && Object.values(m.page_context ?? {}).includes(id));
            const ownRun = (b.runs ?? []).some((r) => JSON.stringify(r.inputs ?? {}).includes(id) || JSON.stringify((r as { artifacts?: unknown }).artifacts ?? []).includes(id));
            const results = before.flatMap((m) => blocksOf(m).filter((x) => x.type === "tool_result" && JSON.stringify(x.content ?? "").includes(id)).map((x) => names.get(x.tool_use_id ?? "") ?? ""));
            const created = results.some((n) => /^create_|^start_workflow$/.test(n));
            const named = before.some((m) => m.role === "user" && msgText(m).includes(id));
            if (onPage || ownRun || created || named) continue;
            if (results.some((n) => SEARCH.test(n))) hits.push({ message: `助理對一份只在搜尋／列表結果裡出現的成果呼叫 ${u.name}（不是這個對話的成果，使用者也沒指定）`, evidence: { tool: u.name, id, found_by: [...new Set(results)].slice(0, 4) } });
          }
        }
      }
      return hits;
    },
  },
  // ------------------------------------------------------------ grounding
  {
    id: "grounding.library_fields", category: "grounding", scope: "run", severity: "high",
    title: "文獻庫有的書目欄位（venue、year）不會被說成「未提供」",
    reads: "the study library (venue, year), step outputs, topic picks, report, criteria reasons",
    check: (b) => {
      const lib = b.library ?? [];
      if (!lib.length) return [];
      const withVenue = lib.filter((p) => (p.venue ?? "").trim()).length;
      const withYear = lib.filter((p) => p.year).length;
      const texts: { where: string; text: string }[] = [
        ...(b.steps ?? []).map((s) => ({ where: `step:${s.key}`, text: s.output_text ?? "" })),
        ...(((b.run.state?.topic as { picks?: { title?: string; reason?: string }[] } | undefined)?.picks) ?? []).map((p) => ({ where: `topic.pick「${clip(p.title, 30)}」`, text: p.reason ?? "" })),
        { where: "report", text: `${b.run.report?.summary_md ?? ""}\n${(b.run.report?.issues ?? []).join("\n")}` },
        ...(b.run.criteria ?? []).map((c) => ({ where: `criterion:${c.id}`, text: c.reason ?? "" })),
      ];
      const hits: Hit[] = [];
      const venueHits = withVenue >= Math.max(1, lib.length / 2) ? texts.filter((t) => MISSING_VENUE.test(t.text)) : [];
      // A few claims may be about the papers that really lack a venue; more claims than such papers cannot be.
      if (venueHits.length > lib.length - withVenue) hits.push({ message: `文獻庫 ${withVenue}/${lib.length} 篇有 venue，卻有 ${venueHits.length} 處說 venue 未提供`, evidence: { library_with_venue: withVenue, library: lib.length, places: venueHits.slice(0, 6).map((t) => ({ where: t.where, text: clip(MISSING_VENUE.exec(t.text)?.[0] ?? t.text, 140) })) } });
      const yearHits = withYear >= Math.max(1, lib.length / 2) ? texts.filter((t) => MISSING_YEAR.test(t.text)) : [];
      if (yearHits.length) hits.push({ message: `文獻庫 ${withYear}/${lib.length} 篇有年份，卻有 ${yearHits.length} 處說年份未提供`, evidence: { places: yearHits.slice(0, 6).map((t) => ({ where: t.where, text: clip(t.text, 140) })) } });
      return hits;
    },
  },
  {
    id: "grounding.library_coverage", category: "grounding", scope: "run", severity: "medium",
    title: "要求用文獻庫整理時，小文獻庫（≤ 12 篇有 PDF）大多都讀到",
    reads: "task words (文獻庫), the library (has_pdf), state.topic.picks",
    check: (b) => {
      const lib = (b.library ?? []).filter((p) => p.has_pdf);
      const picks = ((b.run.state?.topic as { picks?: unknown[] } | undefined)?.picks ?? []).length;
      if (!picks || !lib.length || lib.length > 12) return [];
      if (!taskWords(b).some((w) => LIBRARY_ASK.test(w))) return [];
      return picks < Math.ceil(lib.length * 0.6) ? [{ message: `你要用文獻庫整理，文獻庫有 ${lib.length} 篇有 PDF，只讀了 ${picks} 篇`, evidence: { picks, library_with_pdf: lib.length } }] : [];
    },
  },
];

// ---------------------------------------------------------------- shared extractors

/** Where a run states its topic. */
function topicFields(r: StoredRun): { where: string; text: string }[] {
  const t = r.state?.topic as { topic?: string } | undefined;
  return [
    { where: "state.topic_title", text: (r.state?.topic_title as string | undefined) ?? "" },
    { where: "state.topic.topic", text: t?.topic ?? "" },
    { where: "title", text: r.title ?? "" },
    { where: "plan.front_title", text: r.plan?.front_title ?? "" },
    { where: "state.front_title", text: (r.state?.front_title as string | undefined) ?? "" },
  ].filter((x) => x.text);
}
/** Shared salient tokens: Latin words ≥ 3 letters and CJK bigrams. */
function salientOverlap(a: string, b: string): number {
  const toks = (s: string) => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) out.add(w.replace(/-/g, ""));
    for (const run of s.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    return out;
  };
  const tb = toks(b);
  let n = 0;
  for (const t of toks(a)) if (tb.has(t)) n++;
  return n;
}
function inputArtifacts(r: StoredRun): { key: string; id: string }[] {
  const i = r.inputs ?? {};
  const out: { key: string; id: string }[] = [];
  const add = (key: string, v: unknown) => {
    if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) out.push({ key, id: v });
  };
  add("簡報", i.deck_id);
  add("筆記", i.note_id);
  add("LaTeX 專案", i.project_id);
  if (Array.isArray(i.note_ids)) for (const n of i.note_ids) add("筆記", n);
  return out;
}
/** Status snapshots where the run finished (done / partial) with their failing criteria. */
function finishedSnapshots(b: RunBundle): { at: string; failed: string[]; reasons: Record<string, string> }[] {
  const out: { at: string; failed: string[]; reasons: Record<string, string> }[] = [];
  for (const e of b.events ?? []) {
    if (e.type !== "workflow") continue;
    const w = e.data.workflow as { status?: string; criteria?: { id: string; status?: string; reason?: string }[] } | undefined;
    if (!w || !["partial", "done"].includes(w.status ?? "")) continue;
    const failed = (w.criteria ?? []).filter((c) => c.status === "fail");
    const prev = out.at(-1);
    const ids = failed.map((c) => c.id);
    if (prev && Math.abs(Date.parse(prev.at) - Date.parse(e.created_at)) < 120_000 && prev.failed.join() === ids.join()) continue;
    out.push({ at: e.created_at, failed: ids, reasons: Object.fromEntries(failed.map((c) => [c.id, c.reason ?? ""])) });
  }
  return out;
}
function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- running

export const invariantById = (id: string) => INVARIANTS.find((i) => i.id === id);

/** Runs every run-scope invariant on one bundle. A rule that throws is reported as a finding of its own (never hidden). */
export function checkRun(b: RunBundle, only?: string[]): Finding[] {
  const out: Finding[] = [];
  for (const inv of INVARIANTS) {
    if (inv.scope !== "run" || (only && !only.includes(inv.id))) continue;
    try {
      for (const h of inv.check(b)) out.push({ invariant: inv.id, severity: h.severity ?? inv.severity, run_id: b.run.id, conversation_id: b.run.conversation_id ?? null, message: h.message, evidence: h.evidence });
    } catch (e) {
      out.push({ invariant: inv.id, severity: "low", run_id: b.run.id, conversation_id: b.run.conversation_id ?? null, message: `檢查程式出錯：${e instanceof Error ? e.message : String(e)}`, evidence: { error: true } });
    }
  }
  return out;
}
export function checkConversation(b: ConversationBundle, only?: string[]): Finding[] {
  const out: Finding[] = [];
  for (const inv of INVARIANTS) {
    if (inv.scope !== "conversation" || (only && !only.includes(inv.id))) continue;
    try {
      for (const h of inv.check(b)) out.push({ invariant: inv.id, severity: h.severity ?? inv.severity, run_id: null, conversation_id: b.conversation.id, message: h.message, evidence: h.evidence });
    } catch (e) {
      out.push({ invariant: inv.id, severity: "low", run_id: null, conversation_id: b.conversation.id, message: `檢查程式出錯：${e instanceof Error ? e.message : String(e)}`, evidence: { error: true } });
    }
  }
  return out;
}
