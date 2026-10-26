/**
 * The fixed agent eval set: ~20 real tasks drawn from production failures (docs/research/agent-planning-redesign.md
 * §3, the R5 audit). Each task names how it starts (`api` = 「交給 Agent」 POST /workflows in a fresh autopilot
 * conversation, `chat` = a chat message the assistant must route, `goal` = POST /goals), the deliverable it must
 * produce (or the stop it must make), and its deterministic graders. Tags select subsets (`--tags quick`).
 * Requests are fixed: change one only together with a note in docs/research/agent-eval.md (results stop being comparable).
 */
import * as G from "./graders.js";
import { EN_DECK, EN_DECK_TITLE, EN_DECK_TITLES, MAIN_TITLE, NO_PDF_TITLE, ZH_DECK, ZH_DECK_TITLE, ZH_DECK_TITLES, createDeck, type Fixtures } from "./fixtures.js";

/** Production conversation 79ab0678 (2026-10-25): the user's exact, ASR-transcribed words. */
const SPOKEN_SURVEY = "我要你幫我做一個簡報這個簡報裡面詳細描述了目前時數界是怎麼在Zipformer和RNNT的架構下做熱詞機制的\n我要你參考我們的文獻庫 那請你詳細統計一下有哪幾種方法並且詳細敘述每一種方法的好處跟壞處 我要這份報告簡報是用英文的 並且在講解方法的時候要搭配模型的架構圖來更好的演示 並且在提到方法的時候要講到這一篇論文是哪一篇還有他們的會議或是期刊是哪一個";
const NOTES_ZH = "有個東西我想要你幫我改這個簡報裡面的講稿要是中文的當然你應該要多用一點英文的專用名詞這個講稿要我能夠一比一的念出來不會有違和";
const HOME_TOPIC = "幫我做一份簡報，介紹串流 ASR 的 contextual biasing 有哪些做法，用我們的文獻庫，8 頁";
import type { Hub } from "./client.js";
import { DEEP_RESEARCH_MD, MATERIAL_FILE, MATERIAL_REQUEST, MATERIAL_SECTIONS, MATERIAL_TOKENS } from "./material-fixture.js";

export type Kind = "deck" | "note" | "latex";
/** What was collected after the task's run(s) ended (see run.ts `collect`). */
export type Outcome = {
  status: string;
  deck?: { id: string; qmd: string; parsed: G.Deck; kind: string | null; paperId: string | null; paperTitle: string | null };
  note?: { id: string; md: string };
  latex?: { id: string; text: string; compile: string | null };
  /** The main study's cite keys after the run (papers a workflow imported into the study count as its library). */
  studyKeys?: string[];
  kinds: Kind[];
  brief: G.BriefLike;
  asks: { id: string; title?: string; pending?: boolean }[];
  playbook: string | null;
};
export type Prep = { inputs?: Record<string, unknown>; before?: { titles: string[]; pages: number } };
export type Ctx = { hub: Hub; fx: Fixtures; tag: string; prev: (id: string) => { conversationId: string | null; deckId: string | null } | null };

export type Task = {
  id: string;
  title: string;
  tags: string[];
  mode: "api" | "chat" | "goal";
  study: "main" | "single";
  request: string;
  playbook?: string;
  /** Another task this one continues (same conversation, its deck). */
  after?: string;
  /** Edit tasks: start from a fresh copy of this fixture deck. */
  deck?: "zh" | "en";
  prepare?: (ctx: Ctx) => Promise<Prep>;
  /** The deliverable that must come out, or the stop the run must make instead. */
  expect: { kind: Kind } | { stop: "needs_pdf" } | { kindOrAsk: Kind; never: Kind[] };
  grade: (o: Outcome, ctx: Ctx, prep: Prep) => G.Grade[];
  /** Rubric focus for the quality judge (no judge when absent). */
  judge?: string;
  timeoutMin?: number;
  /** Started from a home-page chat: no study in the conversation, the page context or the inputs (the run must find it). */
  home?: boolean;
  /** A file uploaded into the task's conversation and attached to the start (「交給 Agent」 with the chip). */
  upload?: { name: string; content: string | Buffer };
  /** Answers a question card (the runner otherwise never answers): null leaves it unanswered. */
  answer?: (card: { id: string; title?: string }) => { id: string; value?: unknown; other?: string }[] | null;
};

/** The fixture deck an edit task starts from (a fresh copy per run) and what it looked like before. */
export const FIXTURE_DECKS = {
  zh: { title: ZH_DECK_TITLE, body: ZH_DECK, before: { titles: ZH_DECK_TITLES, pages: ZH_DECK_TITLES.length } },
  en: { title: EN_DECK_TITLE, body: EN_DECK, before: { titles: EN_DECK_TITLES, pages: EN_DECK_TITLES.length } },
} as const;
export async function fixtureDeck(ctx: Ctx, task: Task): Promise<Prep> {
  const f = FIXTURE_DECKS[task.deck!];
  return { inputs: { deck_id: await createDeck(ctx.hub, ctx.fx.main.id, `${f.title}〔eval ${task.id} ${ctx.tag}〕`, f.body) }, before: f.before };
}
const paper = (ctx: Ctx, re: RegExp) => {
  const p = ctx.fx.main.papers.find((x) => re.test(x.title));
  if (!p) throw new Error(`fixture paper ${re} missing`);
  return p;
};

const deckOf = (o: Outcome) => o.deck?.parsed ?? { title: "", subtitle: "", slides: [] };
const lang = (o: Outcome, l: "en" | "zh") => (o.deck ? G.languageGrade(G.deckLanguage(o.deck.parsed, l), l) : G.grade(`language_${l}`, false, "沒有簡報"));
/** Paper-report decks follow the Lab-Hub template (English slides, 繁中 notes) unless the request names a language. */
const paperLang = (o: Outcome, request: string) => {
  const l = G.explicitLanguage(request);
  if (l) return lang(o, l);
  return o.deck ? G.paperReportLanguage(o.deck.parsed) : G.grade("language_template", false, "沒有簡報");
};
const noteText = (o: Outcome) => o.note?.md ?? "";
const PAPER_REPORT_REQUEST = "幫我做一份論文報告簡報：Contextual Adapters for Personalized Speech Recognition in Neural Transducers";
const keys = (ctx: Ctx, o?: Outcome) => [...new Set([...ctx.fx.main.keys, ...(o?.studyKeys ?? [])])];
const progressDeck = (o: Outcome) => G.grade("deck_mode", !!o.deck && o.deck.kind !== "paper_report" && !o.deck.paperId, o.deck ? `kind=${o.deck.kind ?? "?"}，paper=${o.deck.paperId ?? "無"}` : "沒有簡報");

export const TASKS: Task[] = [
  {
    id: "deck_translate_en", title: "中文簡報整份翻成英文（含封面）", tags: ["deck", "edit", "lang", "core"], mode: "api", study: "main",
    request: "全英文翻譯", deck: "zh", expect: { kind: "deck" },
    grade: (o, _c, p) => [G.noDuplicatePages(deckOf(o)), lang(o, "en"), G.pageCount(deckOf(o), p.before!.pages), G.grade("cover_en", !!o.deck && !G.cjkCount(o.deck.parsed.title) && /[A-Za-z]/.test(o.deck.parsed.title), `封面：「${o.deck?.parsed.title ?? ""}」`)],
    judge: "faithful, natural English translation of every page incl. cover, diagram labels and speaker notes; no content lost",
  },
  {
    id: "deck_followup_expand", title: "接著上一個：再詳細一點、每個方法要有架構與 Pros/Cons（不重說語言）", tags: ["deck", "edit", "lang", "chain", "core"], mode: "api", study: "main",
    after: "deck_translate_en", request: "還不夠細，再詳細一點，focus 在動態熱詞，每個方法要有架構、Pros/Cons", expect: { kind: "deck" },
    grade: (o, _c, p) => [G.noDuplicatePages(deckOf(o)), lang(o, "en"), G.perItemFields(deckOf(o), [["architecture", "架構"], ["pros", "advantage", "優點"], ["cons", "disadvantage", "limitation", "缺點"]], 2), G.grade("expanded", deckOf(o).slides.length >= (p.before?.pages ?? 6), `${deckOf(o).slides.length} 頁（原本 ${p.before?.pages ?? 6}）`)],
    judge: "each hotword-biasing method gets architecture, pros and cons; more detailed than a 6-page overview; still English",
  },
  {
    id: "deck_expand_fields_zh", title: "展開：每個方法一頁，每頁要有架構、優點、缺點", tags: ["deck", "edit"], mode: "api", study: "main",
    request: "把「動態熱詞的做法」展開：每個方法一頁，每頁都要有架構、優點、缺點", deck: "zh", expect: { kind: "deck" },
    grade: (o) => [G.noDuplicatePages(deckOf(o)), lang(o, "zh"), G.perItemFields(deckOf(o), [["架構", "architecture"], ["優點", "pros"], ["缺點", "cons", "限制"]], 2), G.titlesKept(deckOf(o), ZH_DECK_TITLES, /動態熱詞的做法/)],
    judge: "one page per method with architecture, pros and cons; the other pages unchanged",
  },
  {
    id: "deck_add_page", title: "英文簡報加一頁比較表（中文指令，簡報維持英文）", tags: ["deck", "edit", "lang", "quick", "core"], mode: "api", study: "main",
    request: "加一頁比較表，比較 shallow fusion、CLAS 和 contextual adapters", deck: "en", expect: { kind: "deck" },
    grade: (o, _c, p) => [G.noDuplicatePages(deckOf(o)), G.pageCount(deckOf(o), p.before!.pages + 1), G.titlesKept(deckOf(o), p.before!.titles), G.tableMentioning(deckOf(o), [["shallow"], ["CLAS", "deep context"], ["adapter"]]), lang(o, "en")],
  },
  {
    id: "deck_exact_pages", title: "剛好 8 頁的進度報告", tags: ["deck", "create", "core"], mode: "api", study: "main",
    request: "幫我做一份 8 頁的研究進度報告簡報", expect: { kind: "deck" },
    grade: (o) => [G.pageCount(deckOf(o), 8), lang(o, "zh"), progressDeck(o), G.noPlaceholder(o.deck?.qmd ?? "")],
    judge: "a progress report grounded in the study's notes, tasks and milestones",
  },
  {
    id: "deck_remove_page", title: "刪掉一頁", tags: ["deck", "edit", "quick", "core"], mode: "api", study: "main",
    request: "刪掉「卡住」這頁", deck: "zh", expect: { kind: "deck" },
    grade: (o, _c, p) => [G.noDuplicatePages(deckOf(o)), G.pageCount(deckOf(o), p.before!.pages - 1), G.noSlideTitled(deckOf(o), /^卡住$/), G.titlesKept(deckOf(o), p.before!.titles, /^卡住$/), lang(o, "zh")],
  },
  {
    id: "deck_topic_paper_title", title: "從文獻做主題簡報（英文、「paper title」說法）", tags: ["deck", "create", "topic", "lang", "slow", "core"], mode: "api", study: "main",
    request: 'Make an English presentation on dynamic hotword biasing (contextual biasing) for streaming Zipformer / RNN-T ASR. Paper title: "Contextual Biasing for Streaming Transducers: A Survey". Cover the methods in our study library.',
    expect: { kind: "deck" }, timeoutMin: 120,
    grade: (o, c) => [lang(o, "en"), progressDeck(o), G.mentionsPapers(o.deck?.qmd ?? "", c.fx.main.papers, 4), G.grade("pages", deckOf(o).slides.length >= 6, `${deckOf(o).slides.length} 頁（≥ 6）`)],
    judge: "a survey deck: taxonomy, one page per method with where the bias is injected, a comparison, a synthesis; grounded in the library papers",
  },
  {
    id: "deck_paper_report", title: "論文報告簡報（有 PDF）", tags: ["deck", "create", "paper", "core"], mode: "api", study: "main",
    request: PAPER_REPORT_REQUEST,
    prepare: async (c) => ({ inputs: { paper_id: paper(c, /^Contextual Adapters/).id } }), expect: { kind: "deck" }, timeoutMin: 90,
    grade: (o, c) => [G.grade("paper_report", o.deck?.kind === "paper_report" && (o.deck.paperId === paper(c, /^Contextual Adapters/).id || /^Contextual Adapters/i.test(o.deck.paperTitle ?? "")), `kind=${o.deck?.kind ?? "?"}，paper=${o.deck?.paperTitle ?? o.deck?.paperId ?? "無"}`), paperLang(o, PAPER_REPORT_REQUEST), G.grade("pages", deckOf(o).slides.length >= 8, `${deckOf(o).slides.length} 頁（≥ 8）`)],
    judge: "a journal-club report of this one paper: problem, method (architecture), experiments with the paper's numbers, assessment",
  },
  {
    id: "note_topic_research", title: "主題調研筆記", tags: ["note", "research", "slow"], mode: "api", study: "main",
    request: "調研：在 Zipformer + RNN-T 串流辨識下，有哪些 dynamic hotwording（contextual biasing）做法？整理成研究筆記", expect: { kind: "note" }, timeoutMin: 120,
    grade: (o, c) => [G.docLanguage(noteText(o), "zh"), G.mentionsPapers(noteText(o), c.fx.main.papers, 4), G.citationsResolve(noteText(o), keys(c, o), 3), G.minLength(noteText(o), 1500)],
    judge: "a research note: taxonomy of methods, where each injects bias, trade-offs, open questions; every claim tied to a library paper",
  },
  {
    id: "note_lit_review", title: "文獻回顧（要有比較表）", tags: ["note", "research"], mode: "api", study: "main",
    request: "幫我寫一份 contextual biasing（熱詞偏置）的文獻回顧，要有比較表", expect: { kind: "note" }, timeoutMin: 90,
    grade: (o, c) => [G.docLanguage(noteText(o), "zh"), G.tableRows(noteText(o), 5), G.citationsResolve(noteText(o), keys(c, o), 5)],
    judge: "a literature review with a comparison table and a synthesis, faithful to the papers",
  },
  {
    id: "note_reading", title: "單篇閱讀筆記", tags: ["note", "paper", "quick"], mode: "api", study: "main",
    request: "幫我寫〈Deep context: end-to-end contextual speech recognition〉的閱讀筆記", expect: { kind: "note" },
    grade: (o) => [G.docLanguage(noteText(o), "zh"), G.grade("about_paper", /CLAS|deep context/i.test(noteText(o)), "提到 CLAS / Deep context"), G.minLength(noteText(o), 800)],
    judge: "a reading note of this paper: problem, method, results with numbers, limitations",
  },
  {
    id: "latex_paper_goal", title: "從零寫 LaTeX 論文（目標）", tags: ["latex", "goal", "slow"], mode: "goal", study: "main",
    request: "寫一篇 LaTeX 論文初稿：串流 RNN-T 動態熱詞偏置方法綜述，用研究文獻庫的論文", expect: { kind: "latex" }, timeoutMin: 240,
    grade: (o, c) => [G.grade("compiles", o.latex?.compile === "success", `最後編譯：${o.latex?.compile ?? "無"}`), G.grade("sections", ((o.latex?.text ?? "").match(/\\section\*?\{/g) ?? []).length >= 4, `${((o.latex?.text ?? "").match(/\\section\*?\{/g) ?? []).length} 個 \\section（≥ 4）`), G.citationsResolve(o.latex?.text ?? "", keys(c, o), 5)],
    judge: "a coherent survey paper draft: introduction, method taxonomy, comparison, discussion; citations used correctly",
  },
  {
    id: "deck_progress_single_paper", title: "只有一篇論文的研究做進度簡報（不能變論文報告）", tags: ["deck", "create", "quick"], mode: "api", study: "single",
    request: "幫我做一份這個研究的進度簡報，下週組會要用", expect: { kind: "deck" },
    grade: (o) => [progressDeck(o), lang(o, "zh"), G.grade("progress_content", /18\.2|SpecAugment|微調/.test(o.deck?.qmd ?? ""), "用到研究的進度資料（CER 18.2%／SpecAugment／微調）")],
  },
  {
    id: "deck_progress_en", title: "英文指令的進度簡報", tags: ["deck", "create", "lang"], mode: "api", study: "main",
    request: "Make a progress report deck for this study for next week's group meeting.", expect: { kind: "deck" },
    grade: (o) => [lang(o, "en"), progressDeck(o), G.grade("cover_en", !!o.deck && !G.cjkCount(o.deck.parsed.title), `封面：「${o.deck?.parsed.title ?? ""}」`)],
  },
  {
    id: "note_en_compare", title: "英文筆記：比較兩類做法", tags: ["note", "lang"], mode: "api", study: "main",
    request: "Write a note comparing shallow fusion and neural contextual biasing for streaming RNN-T, based on the papers in this study.", expect: { kind: "note" },
    grade: (o, c) => [G.docLanguage(noteText(o), "en"), G.mentionsPapers(noteText(o), c.fx.main.papers, 3), G.minLength(noteText(o), 1500)],
    judge: "a clear English comparison grounded in the study's papers",
  },
  {
    id: "deck_translate_zh", title: "英文簡報整份翻成繁中", tags: ["deck", "edit", "lang"], mode: "api", study: "main",
    request: "整份翻成繁體中文", deck: "en", expect: { kind: "deck" },
    grade: (o, _c, p) => [G.noDuplicatePages(deckOf(o)), lang(o, "zh"), G.pageCount(deckOf(o), p.before!.pages)],
  },
  {
    id: "chat_paraphrase", title: "聊天交辦：助理改寫不能新增要求", tags: ["chat", "deck", "brief", "core"], mode: "chat", study: "main",
    request: "幫我做一份這個研究的進度簡報，下週組會要用", expect: { kind: "deck" },
    grade: (o) => [G.briefGrounded(o.brief), progressDeck(o), lang(o, "zh")],
  },
  {
    id: "deck_missing_pdf", title: "論文沒有 PDF：要停下來要 PDF，不能換成別的", tags: ["deck", "stop", "quick", "core"], mode: "api", study: "main",
    request: `幫我做一份論文報告簡報：${NO_PDF_TITLE}`, prepare: async (c) => ({ inputs: { paper_id: c.fx.main.noPdfId } }), expect: { stop: "needs_pdf" },
    grade: (o) => [G.grade("no_substitute", !o.kinds.length, o.kinds.length ? `寫了 ${o.kinds.join("、")}` : "沒有寫出替代成果")],
  },
  {
    id: "kind_conflict", title: "交付物衝突：指定閱讀筆記流程，卻要簡報", tags: ["stop", "brief", "quick", "core"], mode: "api", study: "main", playbook: "reading_note",
    request: "把〈Deep context: end-to-end contextual speech recognition〉做成簡報", prepare: async (c) => ({ inputs: { paper_id: paper(c, /^Deep context/).id } }),
    expect: { kindOrAsk: "deck", never: ["note"] },
    grade: (o) => [G.grade("brief_deck", o.brief?.deliverable?.kind === "deck", `Brief 交付物：${o.brief?.deliverable?.kind ?? "無"}`)],
  },
  {
    id: "note_generic_metrics", title: "一般筆記：評估指標與計算方式", tags: ["note", "generic"], mode: "api", study: "main",
    request: "整理串流語音辨識常用的評估指標（CER、罕見詞 recall、誤觸發率、延遲）與計算方式，寫成一份筆記", expect: { kind: "note" },
    grade: (o) => [G.docLanguage(noteText(o), "zh"), G.grade("covers_metrics", ["CER", "recall", "誤觸發", "延遲"].every((t) => noteText(o).toLowerCase().includes(t.toLowerCase())), "四個指標都有寫到"), G.minLength(noteText(o), 800)],
    judge: "correct definitions and formulas of each metric; streaming-specific notes",
  },
  {
    id: "deck_spoken_survey", title: "語音輸入的長句主題簡報：統計文獻庫的方法、每個方法的優缺點／架構圖／論文與會議期刊（79ab0678）", tags: ["deck", "create", "topic", "lang", "spoken", "79ab", "slow"], mode: "api", study: "main",
    request: SPOKEN_SURVEY, expect: { kind: "deck" }, timeoutMin: 120,
    grade: (o, c) => [
      lang(o, "en"),
      G.venuePerMethod(deckOf(o)),
      // The fixture library (10 papers) is a part of the study's library (other runs import more): most of it must be covered.
      G.mentionsPapers(o.deck?.qmd ?? "", c.fx.main.papers, 6),
      G.noTopicDrift(deckOf(o), /efficien|效率|評估集|evaluation set/i, SPOKEN_SURVEY),
      G.perItemFields(deckOf(o), [["pros", "advantage", "benefit", "strength"], ["cons", "limitation", "drawback", "weakness", "trade-off"]], 3),
      // Diagrams are materialized as SVG images in the shipped source (`.hub-diagram`), or still ```diagram blocks.
      G.grade("diagrams", ((o.deck?.qmd ?? "").match(/^```diagram|\{\.hub-diagram/gm) ?? []).length >= 3, `${((o.deck?.qmd ?? "").match(/^```diagram|\{\.hub-diagram/gm) ?? []).length} 張架構圖（≥ 3）`),
    ],
    judge: "an English survey of hotword / contextual-biasing mechanisms under Zipformer and RNN-T that tallies the library's method families; every method with pros, cons, an architecture diagram, its paper and venue",
  },
  {
    id: "deck_notes_zh_home", title: "首頁聊天：把英文簡報的講稿改成中文（研究從簡報得知、投影片維持英文、不問問題）（79ab0678）", tags: ["deck", "edit", "lang", "79ab", "quick"], mode: "api", study: "main", home: true,
    request: NOTES_ZH, deck: "en", expect: { kind: "deck" },
    grade: (o, _c, p) => [
      G.slidesEnNotesZh(deckOf(o)),
      G.pageCount(deckOf(o), p.before!.pages),
      G.titlesKept(deckOf(o), p.before!.titles),
      G.grade("no_question", !o.asks.length, o.asks.length ? `問了：${o.asks.map((a) => a.title ?? a.id).join("、")}` : "沒有問問題"),
      G.grade("brief_notes_zh", (o.brief?.requirements ?? []).some((r) => r.type === "language" && /講稿用繁體中文/.test(r.text ?? "")), (o.brief?.requirements ?? []).map((r) => r.text).join("；") || "沒有要求"),
    ],
    judge: "speaker notes in natural spoken Traditional Chinese with English technical terms, readable aloud verbatim; slide text unchanged and English",
  },
  {
    id: "deck_material_report", title: "附件的 deep research 結果做成給教授的報告簡報：以附件為主要材料、列出的部分各一頁、區分事實／推論／待驗證（301b6e1a）", tags: ["deck", "create", "material", "301b", "core"], mode: "api", study: "main",
    request: MATERIAL_REQUEST, upload: { name: MATERIAL_FILE, content: DEEP_RESEARCH_MD }, expect: { kind: "deck" }, timeoutMin: 120,
    grade: (o, c) => [
      G.materialUsed(o.deck?.qmd ?? "", MATERIAL_TOKENS, 4),
      G.sectionPages(deckOf(o), MATERIAL_SECTIONS),
      G.coverNotRepeated(deckOf(o)),
      G.noDuplicatePages(deckOf(o)),
      G.grade("labels", /已知事實|【?事實】?/.test(o.deck?.qmd ?? "") && /推論/.test(o.deck?.qmd ?? "") && /待驗證/.test(o.deck?.qmd ?? ""), "看得出事實／推論／待驗證的區分"),
      // Material first: nothing imported into the study's library (no online survey instead of the attachment).
      G.grade("no_imports", (o.studyKeys ?? []).every((k) => keys(c).includes(k)), `研究文獻庫多了：${(o.studyKeys ?? []).filter((k) => !keys(c).includes(k)).join("、") || "無"}`),
      G.grade("brief_sections", (o.brief?.requirements ?? []).some((r) => r.type === "include_topics" && /研究背景/.test(r.text ?? "")), (o.brief?.requirements ?? []).map((r) => r.text).join("；") || "沒有要求"),
      lang(o, "zh"),
    ],
    judge: "a report to the professor built from the attached deep-research file: background, existing resources and limits, candidate directions, priorities, the MVP design and the open decisions each on their own page; facts, inferences and ideas to verify clearly labelled; names and numbers from the file",
  },
  {
    id: "deck_study_answer_topic", title: "首頁聊天、沒有研究：回答「放在哪個研究」不會變成主題（79ab0678）", tags: ["deck", "create", "topic", "brief", "79ab"], mode: "api", study: "main", home: true,
    request: HOME_TOPIC, expect: { kind: "deck" }, timeoutMin: 90,
    answer: (card) => (card.id.startsWith("study_") ? [{ id: "study", other: MAIN_TITLE }] : null),
    grade: (o) => [
      G.grade("asked_study", o.asks.some((a) => a.id.startsWith("study_")), `問題卡：${o.asks.map((a) => a.id).join("、") || "無"}`),
      G.briefWithout(o.brief, MAIN_TITLE),
      G.noTopicDrift(deckOf(o), /評估集|evaluation set|eval(?:uation)? (?:suite|fixture)/i, HOME_TOPIC),
      lang(o, "zh"),
      G.pageCount(deckOf(o), 8),
    ],
  },
];
