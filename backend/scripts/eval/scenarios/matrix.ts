/**
 * Planning-only scenario matrix (docs/research/agent-invariants.md → Scenario matrix). Crosses the dimensions that broke
 * production runs — where the chat starts, what the conversation already holds, how the request is phrased (incl.
 * spoken run-on ASR text), the intent, the per-part language, follow-up anaphora and the answer to a clarifying
 * question — into ≥ 60 cases. Each case runs on staging only up to the plan card or the first question (run.ts), the
 * invariants are checked on the stored run, and the run is cancelled: no writing phase, cheap.
 *
 * The generator is deterministic: a base grid (every intent × every entry) with the other dimensions rotated so every
 * value of every dimension appears and pairs spread, plus targeted blocks for anaphora, clarifying answers, per-part
 * language and the two production requests verbatim.
 */

export const ENTRIES = ["home", "study", "deck"] as const;
export const HISTORIES = ["none", "artifact", "unrelated"] as const;
export const STYLES = ["typed", "spoken", "english", "mixed"] as const;
export const INTENTS = ["new_progress", "new_paper_report", "new_topic", "revise_notes_lang", "revise_slides_lang", "expand_method", "add_page", "remove_page", "translate", "note_topic", "lit_review", "latex_section"] as const;
export const LANGS = ["slides_en_notes_zh", "all_zh", "all_en", "unstated"] as const;
export const ANAPHORA = ["none", "剛剛那個", "同一個簡報", "繼續"] as const;
export const ANSWERS = ["study_name", "delegate", "free_text"] as const;
export const STARTS = ["delegate", "chat"] as const;

export type Entry = (typeof ENTRIES)[number];
export type History = (typeof HISTORIES)[number];
export type Style = (typeof STYLES)[number];
export type Intent = (typeof INTENTS)[number];
export type Lang = (typeof LANGS)[number];
export type Anaphora = (typeof ANAPHORA)[number];
export type Answer = (typeof ANSWERS)[number];
export type Start = (typeof STARTS)[number];

/** Which fixture deck an edit intent works on (eval fixtures: ZH = 6-page 繁中 deck, EN = 6-page English deck with notes). */
export const DECK_FOR: Partial<Record<Intent, "zh" | "en">> = {
  revise_notes_lang: "en", revise_slides_lang: "zh", expand_method: "zh", add_page: "en", remove_page: "zh", translate: "zh",
};
export const EDIT_INTENTS = new Set<Intent>(Object.keys(DECK_FOR) as Intent[]);
export const KIND_FOR: Record<Intent, "deck" | "note" | "latex"> = {
  new_progress: "deck", new_paper_report: "deck", new_topic: "deck", revise_notes_lang: "deck", revise_slides_lang: "deck", expand_method: "deck", add_page: "deck",
  remove_page: "deck", translate: "deck", note_topic: "note", lit_review: "note", latex_section: "latex",
};
/** Per-part language each edit intent states by itself (the `lang` dimension applies to creation intents). */
const EDIT_LANG: Partial<Record<Intent, Lang>> = { revise_notes_lang: "slides_en_notes_zh", revise_slides_lang: "slides_en_notes_zh", translate: "all_en" };

export type Scenario = {
  id: string; entry: Entry; history: History; style: Style; intent: Intent; lang: Lang; anaphora: Anaphora; answer: Answer; start: Start;
  /** The user's words of the case's turn. */
  request: string;
  /** What must come out of planning (scenario oracles, oracles.ts). */
  expect: {
    kind: "deck" | "note" | "latex";
    /** The deck the case edits is resolvable (deck page / earlier run / anaphora) → an edit route on that deck. */
    editDeck: boolean;
    editKind?: "revise" | "expand";
    /** The study is derivable (study / deck page, earlier run): no which-study question, run.study_id = the fixture study. */
    studyDerivable: boolean;
    /** Languages the user stated per part. */
    parts: { slides?: "zh" | "en"; notes?: "zh" | "en"; all?: "zh" | "en" };
  };
  /** A production request reproduced verbatim. */
  production?: string;
  /** Chat turns sent (and answered by the assistant) before the case's turn, after the seeded history. */
  extraTurns?: string[];
};

// ---------------------------------------------------------------- wording

const PAPER = "Contextual Adapters for Personalized Speech Recognition in Neural Transducers";
type Clauses = { zh: string[]; en: string[]; mixed?: string[] };
const BASE: Record<Intent, Clauses> = {
  new_progress: { zh: ["幫我做一份這週的研究進度報告簡報", "大概 8 頁"], en: ["Make a progress report deck for this week's research", "about 8 slides"], mixed: ["幫我做一份 weekly progress report 的簡報", "大概 8 頁"] },
  new_paper_report: { zh: [`幫我做一份論文報告簡報，報告〈${PAPER}〉`, "下週 journal club 要用"], en: [`Make a paper-report deck on "${PAPER}"`, "for next week's journal club"], mixed: [`幫我做 paper report 的 slides，報告〈${PAPER}〉`] },
  new_topic: {
    zh: ["幫我做一份簡報，介紹 Zipformer 和 RNN-T 架構下的熱詞偏置方法", "參考我們的文獻庫，統計有哪幾種方法", "每種方法都要寫優點和缺點", "提到方法時要註明是哪一篇論文和它的會議或期刊"],
    en: ["Make a deck on hotword biasing methods for Zipformer and RNN-T ASR", "use our study library and count which methods exist", "give the pros and cons of each method", "for each method name the paper and its venue"],
    mixed: ["幫我做一份 deck 介紹 Zipformer 跟 RNN-T 的 contextual biasing 方法", "用我們的 library 統計有哪幾種 methods", "每個 method 都要有 Pros/Cons", "要寫是哪篇 paper 跟 venue"],
  },
  revise_notes_lang: {
    zh: ["幫我改這個簡報的講稿，講稿要是中文的", "專有名詞保留英文", "講稿要能一比一照著念"],
    en: ["Rewrite the speaker notes of this deck in Chinese", "keep technical terms in English", "the notes should read naturally out loud"],
    mixed: ["這個 deck 的 speaker notes 改成中文", "technical terms 保留英文", "要能直接照著念"],
  },
  revise_slides_lang: { zh: ["把這個簡報的投影片內容改成英文", "講稿維持中文"], en: ["Change the slide text of this deck to English", "keep the speaker notes in Chinese"], mixed: ["這個簡報的 slides 改成英文", "speaker notes 維持中文"] },
  expand_method: { zh: ["把這個簡報裡「動態熱詞的做法」那頁展開", "每個方法一頁", "每頁都要有架構、優點、缺點"], en: ['Expand the "動態熱詞的做法" slide of this deck', "one slide per method", "each with architecture, pros and cons"], mixed: ["把這個 deck 的「動態熱詞的做法」展開", "每個 method 一頁", "都要有 architecture、Pros/Cons"] },
  add_page: { zh: ["在這個簡報加一頁比較表", "比較 shallow fusion、CLAS 和 contextual adapters"], en: ["Add a comparison-table slide to this deck", "comparing shallow fusion, CLAS and contextual adapters"], mixed: ["這個 deck 加一頁 comparison table", "比較 shallow fusion、CLAS 和 contextual adapters"] },
  remove_page: { zh: ["把這個簡報裡「卡住」這頁刪掉"], en: ['Remove the "卡住" slide from this deck'], mixed: ["這個 deck 的「卡住」那頁 delete 掉"] },
  translate: { zh: ["把這個簡報整份翻成英文", "包含封面和講稿"], en: ["Translate this whole deck into English", "including the cover and the speaker notes"], mixed: ["這個 deck 整份 translate 成英文", "cover 跟 speaker notes 也要"] },
  note_topic: { zh: ["幫我整理一份筆記", "說明串流 ASR 熱詞偏置有哪些做法", "用我們文獻庫的論文"], en: ["Write me a note", "on which hotword-biasing approaches exist for streaming ASR", "using the papers in our library"], mixed: ["幫我寫一份 note", "整理 streaming ASR 的 hotword biasing 有哪些 approaches", "用我們 library 的 papers"] },
  lit_review: { zh: ["幫我寫一份文獻回顧筆記", "比較文獻庫裡的 contextual biasing 論文", "要有一個比較表"], en: ["Write a literature review note", "comparing the contextual biasing papers in our library", "with a comparison table"], mixed: ["幫我寫 literature review 的筆記", "比較 library 裡 contextual biasing 的 papers", "要有 comparison table"] },
  latex_section: { zh: ["幫我寫論文的 Related Work 章節（LaTeX）", "整理文獻庫裡的熱詞偏置方法"], en: ["Write the Related Work section of my paper in LaTeX", "covering the hotword-biasing methods in our library"], mixed: ["幫我寫 paper 的 Related Work section（LaTeX）", "整理 library 裡的 hotword biasing methods"] },
};
const LANG_CLAUSE: Record<Exclude<Lang, "unstated">, { zh: string; en: string; spoken: string; mixed: string }> = {
  slides_en_notes_zh: { zh: "投影片用英文，講稿用中文", en: "slides in English and speaker notes in Chinese", spoken: "投影片要用英文的講稿要用中文的", mixed: "slides 用英文、speaker notes 用中文" },
  all_zh: { zh: "全部用中文", en: "write everything in Traditional Chinese", spoken: "全部都要用中文的", mixed: "全部用中文寫" },
  all_en: { zh: "整份用英文", en: "everything in English", spoken: "我要這份是用英文的", mixed: "整份用 English" },
};
const SPOKEN_JOIN = ["", " 那", " 並且", " 還有", " 然後"];

/** Renders the clauses in a style; spoken = ASR-like run-on text: no punctuation, connectors, 我要你幫我… */
export function render(intent: Intent, style: Style, lang: Lang, anaphora: Anaphora): string {
  const c = BASE[intent];
  const kindHasLang = lang !== "unstated" && !EDIT_INTENTS.has(intent) && !(lang === "slides_en_notes_zh" && KIND_FOR[intent] !== "deck");
  let parts = style === "english" ? [...c.en] : style === "mixed" ? [...(c.mixed ?? c.zh)] : [...c.zh];
  if (kindHasLang) parts.push(style === "english" ? LANG_CLAUSE[lang as Exclude<Lang, "unstated">].en : style === "mixed" ? LANG_CLAUSE[lang as Exclude<Lang, "unstated">].mixed : style === "spoken" ? LANG_CLAUSE[lang as Exclude<Lang, "unstated">].spoken : LANG_CLAUSE[lang as Exclude<Lang, "unstated">].zh);
  if (anaphora !== "none") {
    const ref = style === "english" ? (anaphora === "同一個簡報" ? "the same deck" : "the deck from before") : anaphora === "同一個簡報" ? "同一個簡報" : anaphora === "剛剛那個" ? "剛剛那個簡報" : "那個簡報";
    parts = parts.map((p) => p.replace(/這個簡報|這個 deck|this deck/g, ref));
    if (anaphora === "繼續") parts.unshift(style === "english" ? "Continue with the previous one" : "繼續剛剛的");
  }
  if (style === "spoken") {
    const s = parts.map((p, i) => `${i === 0 ? (p.startsWith("幫我") ? "我要你" : "我要你幫我") : SPOKEN_JOIN[i % SPOKEN_JOIN.length]!.trim() + (i % 2 ? "請你" : "")}${p.replace(/[，。、「」〈〉]/g, (m) => (m === "，" || m === "、" ? " " : m === "。" ? "" : m))}`);
    return s.join(" ").replace(/\s+/g, " ").replace(/我要你幫我幫我/g, "我要你幫我").trim();
  }
  if (style === "english") return `${parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(", ")}.`;
  return `${parts.join("，")}。`;
}

const partsOf = (intent: Intent, lang: Lang): Scenario["expect"]["parts"] => {
  const l = EDIT_LANG[intent] ?? (EDIT_INTENTS.has(intent) ? "unstated" : lang);
  if (intent === "revise_notes_lang") return { notes: "zh" };
  if (intent === "revise_slides_lang") return { slides: "en", notes: "zh" };
  if (l === "slides_en_notes_zh") return KIND_FOR[intent] === "deck" ? { slides: "en", notes: "zh" } : {};
  if (l === "all_zh") return { all: "zh" };
  if (l === "all_en") return { all: "en" };
  return {};
};

function scenario(id: string, d: Omit<Scenario, "id" | "request" | "expect" | "production" | "extraTurns">, production?: string, extraTurns?: string[]): Scenario {
  const deckKnown = EDIT_INTENTS.has(d.intent) && (d.entry === "deck" || d.history === "artifact");
  return {
    id, ...d,
    request: production ?? render(d.intent, d.style, d.lang, d.anaphora),
    expect: {
      kind: KIND_FOR[d.intent],
      editDeck: deckKnown,
      editKind: deckKnown ? (d.intent === "expand_method" ? "expand" : ["revise_notes_lang", "revise_slides_lang", "translate"].includes(d.intent) ? "revise" : undefined) : undefined,
      studyDerivable: d.entry !== "home" || d.history === "artifact",
      parts: partsOf(d.intent, d.lang),
    },
    ...(production ? { production } : {}),
    ...(extraTurns ? { extraTurns } : {}),
  };
}

const RUN_A_WORDS = "我要你幫我做一個簡報這個簡報裡面詳細描述了目前時數界是怎麼在Zipformer和RNNT的架構下做熱詞機制的 我要你參考我們的文獻庫 那請你詳細統計一下有哪幾種方法並且詳細敘述每一種方法的好處跟壞處 我要這份報告簡報是用英文的 並且在講解方法的時候要搭配模型的架構圖來更好的演示 並且在提到方法的時候要講到這一篇論文是哪一篇還有他們的會議或是期刊是哪一個";
const RUN_B_WORDS = "有個東西我想要你幫我改這個簡報裡面的講稿要是中文的當然你應該要多用一點英文的專用名詞這個講稿要我能夠一比一的念出來不會有違和";

/** The deterministic case list. */
export function buildMatrix(): Scenario[] {
  const out: Scenario[] = [];
  let k = 0;
  // 1. Base grid: every intent × every entry; style / history / lang / start / answer rotated (Latin-square style).
  for (const [ii, intent] of INTENTS.entries()) {
    for (const [ei, entry] of ENTRIES.entries()) {
      const style = STYLES[(ii + ei) % STYLES.length]!;
      const history = HISTORIES[(ii * 2 + ei) % HISTORIES.length]!;
      const lang = LANGS[(ii + 2 * ei) % LANGS.length]!;
      const start = STARTS[(ii + ei) % 2]!;
      const answer = ANSWERS[(ii + ei) % ANSWERS.length]!;
      out.push(scenario(`g${String(++k).padStart(2, "0")}_${intent}_${entry}`, { entry, history, style, intent, lang, anaphora: "none", answer, start }));
    }
  }
  // 2. Follow-up anaphora after an earlier run created the deck (no deck page): every anaphora × four edit intents.
  const anaIntents: Intent[] = ["revise_notes_lang", "add_page", "translate", "expand_method"];
  for (const [ai, anaphora] of ANAPHORA.filter((a) => a !== "none").entries()) {
    for (const [ii, intent] of anaIntents.entries()) {
      out.push(scenario(`a${String(++k).padStart(2, "0")}_${intent}_${anaphora}`, { entry: (ai + ii) % 2 ? "study" : "home", history: "artifact", style: STYLES[(ai + ii) % 3 === 2 ? 1 : (ai + ii) % 2 ? 3 : 0]!, intent, lang: "unstated", anaphora, answer: "study_name", start: (ai + ii) % 2 ? "chat" : "delegate" }));
    }
  }
  // 3. Clarifying answers: home page, no history (the study is not derivable; the eval user has 4 studies).
  for (const answer of ANSWERS) {
    for (const [ii, intent] of (["new_topic", "new_progress", "note_topic"] as Intent[]).entries()) {
      out.push(scenario(`c${String(++k).padStart(2, "0")}_${intent}_${answer}`, { entry: "home", history: "none", style: STYLES[ii % 2 ? 1 : 0]!, intent, lang: ii === 0 ? "all_en" : "unstated", anaphora: "none", answer, start: "delegate" }));
    }
  }
  // 4. Per-part language on new decks (study page).
  for (const lang of ["slides_en_notes_zh", "all_zh", "all_en"] as Lang[]) {
    for (const [si, intent] of (["new_progress", "new_topic"] as Intent[]).entries()) {
      out.push(scenario(`l${String(++k).padStart(2, "0")}_${intent}_${lang}`, { entry: "study", history: "none", style: si ? "spoken" : "typed", intent, lang, anaphora: "none", answer: "study_name", start: "delegate" }));
    }
  }
  // 5. The two production requests verbatim (79ab0678): run A from the home page; run B after an earlier run created the deck.
  out.push(scenario(`p${String(++k).padStart(2, "0")}_prod_run_a`, { entry: "home", history: "none", style: "spoken", intent: "new_topic", lang: "all_en", anaphora: "none", answer: "study_name", start: "delegate" }, RUN_A_WORDS));
  // Run B exactly as it happened: the earlier run's deck, then an unrelated question about it and 「ok」, then the request in chat.
  out.push(scenario(`p${String(++k).padStart(2, "0")}_prod_run_b`, { entry: "home", history: "artifact", style: "spoken", intent: "revise_notes_lang", lang: "unstated", anaphora: "none", answer: "free_text", start: "chat" }, RUN_B_WORDS, ["我想要知道我們目前這個簡報它是偏向Hot Word還是Contextual Biasing", "ok"]));
  out.push(scenario(`p${String(++k).padStart(2, "0")}_prod_run_b_delegate`, { entry: "home", history: "artifact", style: "spoken", intent: "revise_notes_lang", lang: "unstated", anaphora: "none", answer: "free_text", start: "delegate" }, RUN_B_WORDS));
  return out;
}

if (process.argv[1]?.endsWith("matrix.ts")) {
  const m = buildMatrix();
  for (const s of m) console.log(`${s.id.padEnd(34)} ${s.entry.padEnd(5)} ${s.history.padEnd(9)} ${s.style.padEnd(7)} ${s.start.padEnd(8)} ${s.lang.padEnd(18)} ${s.anaphora.padEnd(5)} ${s.answer.padEnd(10)} │ ${s.request}`);
  const cover = (k: keyof Scenario, vals: readonly string[]) => vals.map((v) => `${v}:${m.filter((s) => s[k] === v).length}`).join(" ");
  console.log(`\n${m.length} cases\nentry ${cover("entry", ENTRIES)}\nhistory ${cover("history", HISTORIES)}\nstyle ${cover("style", STYLES)}\nintent ${cover("intent", INTENTS)}\nlang ${cover("lang", LANGS)}\nanaphora ${cover("anaphora", ANAPHORA)}\nanswer ${cover("answer", ANSWERS)}\nstart ${cover("start", STARTS)}`);
}
