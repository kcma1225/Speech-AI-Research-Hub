/**
 * Requirement ledger (docs/architecture.md "Workflows" → Requirements). The user's explicit requirements — from the
 * request, guidance, recent chat turns and the artifact's standing preferences — become typed constraints at plan time:
 * shown on the plan card (「你的要求」, editable), turned into criteria (`req_<id>`: a deterministic check where possible,
 * else judged) and injected into EVERY sub-agent prompt (`requirementsBlock`, env.ts), so no later step (notes pass,
 * visual fix, render fix, integrator) can silently regress them. Checks run on the whole artifact (for decks the full
 * Quarto source incl. the cover's front matter: `data.full`). Pure helpers are unit-tested; `prepareRequirements` /
 * `persistStanding` touch the DB.
 */
import { createHash } from "node:crypto";
import { CHECKS, parseSlides, runChecks } from "./checks.js";
import { dataBlock, parseJson, wordsBlock } from "./llm.js";
import type { WorkflowEnv } from "./env.js";
import { baseWords, userGuidance, type Brief } from "./brief.js";
import { MATERIAL_REF_RE } from "./material.js";
import type { Criterion, Requirement, RequirementTerm, RequirementType, StepRow } from "./types.js";

export type ArtifactKind = "deck" | "doc" | "latex";
/** Requirement types that are properties of the artifact: persisted on it and inherited by later edits (「沿用」). */
export const STANDING_TYPES: RequirementType[] = ["language", "audience", "tone"];
export const REQUIREMENT_TYPES: RequirementType[] = ["language", "page_count", "include_topics", "exclude", "per_item_fields", "audience", "tone", "length", "format", "other"];

export const artifactKindOf = (playbook: string): ArtifactKind => (playbook === "slides" ? "deck" : playbook === "latex_section" || playbook === "paper_draft" ? "latex" : "doc");

export const LANGUAGE_LABEL = { en: "English", zh: "繁體中文" } as const;

// ---------------------------------------------------------------- text helpers

/** Chinese / Japanese / Korean letters and full-width punctuation (what an English deck must not show). */
const CJK_G = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-～]/gu;
const HAN_G = /\p{Script=Han}/gu;
const hasCjk = (s: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-～]/u.test(s);
export const cjkCount = (s: string) => (s.match(CJK_G) ?? []).length;
const latinWords = (s: string) => (s.match(/[A-Za-z][A-Za-z'-]+/g) ?? []).length;

/** What a reader sees of Markdown / Quarto source: comments, link targets, attributes and fence lines removed. */
export function visibleText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\((?:[^()]|\([^)]*\))*\)/g, "]")
    .replace(/\{[.#][^}\n]*\}/g, " ")
    .replace(/^:::+.*$/gm, " ")
    .replace(/^\s*```.*$/gm, " ")
    .replace(/^\s*%%\{.*$/gm, " ");
}

/** Text a requirement may keep in the original language: 〈quoted titles〉, 《…》 and the allow-list. */
function stripAllowed(text: string, allow: string[] = []): string {
  let t = text.replace(/〈[^〉\n]{1,80}〉|《[^》\n]{1,80}》/g, " ");
  for (const a of allow) if (a.trim()) t = t.split(a.trim()).join(" ");
  return t;
}

const yamlValue = (v: string) => {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      // not JSON-quoted: fall through
    }
  }
  return t.replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/''/g, "'");
};

/** Front matter title / subtitle of a Quarto source (the cover); null when there is none. */
export function frontMatter(text: string): { title?: string; subtitle?: string } | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const out: { title?: string; subtitle?: string } = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(title|subtitle):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as "title" | "subtitle"] = yamlValue(kv[2]!);
  }
  return out;
}

type Unit = { page: number; title: string; body: string; notes: string };
/** Slides (`## `) of a deck, or the heading sections of a document (page = section number; 0 = before the first heading). */
export function unitsOf(text: string, doc = false): { units: Unit[]; slides: boolean } {
  const src = text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const slides = doc ? [] : parseSlides(src);
  if (slides.length) return { units: slides.map((s) => ({ page: s.index, title: s.title, body: s.body, notes: s.notes })), slides: true };
  const units: Unit[] = [];
  let cur: Unit = { page: 0, title: "", body: "", notes: "" };
  let n = 0;
  for (const line of src.split("\n")) {
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      if (cur.title || cur.body.trim()) units.push(cur);
      cur = { page: ++n, title: h[1]!.trim(), body: "", notes: "" };
    } else cur.body += `${line}\n`;
  }
  if (cur.title || cur.body.trim()) units.push(cur);
  return { units, slides: false };
}

const snippetOf = (text: string) => {
  const line = text.split("\n").find((l) => hasCjk(l)) ?? text;
  const i = Math.max(0, line.search(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-～]/u));
  return line.slice(Math.max(0, i - 12), i + 28).replace(/\s+/g, " ").trim();
};

export type Violation = { page: number; title: string; part: "front" | "title" | "body" | "notes"; snippet: string };

/**
 * Where the artifact breaks the language requirement. `en`: any CJK letter / full-width punctuation in visible text —
 * the cover (front matter title / subtitle; author and date are names, not checked), slide or section titles, bullets,
 * tables, diagram / chart labels, captions, speaker notes — except 〈quoted titles〉 and the allow-list. `zh` (lenient):
 * only a unit written entirely in English (≥ 30 words, no Han character outside code).
 */
export function languageViolations(text: string, language: "en" | "zh", allow: string[] = [], doc = false, part?: "slides" | "notes"): Violation[] {
  const out = languageViolationsAll(text, language, allow, doc, part === "notes");
  if (!part || doc) return out;
  return out.filter((v) => (part === "notes" ? v.part === "notes" : v.part !== "notes"));
}

/** A speaker note in 繁體中文 (with English technical terms): mostly Han text — fewer Han characters than English words fails. */
const mostlyEnglish = (vis: string) => latinWords(vis) >= 8 && (vis.match(HAN_G) ?? []).length < latinWords(vis);

function languageViolationsAll(text: string, language: "en" | "zh", allow: string[], doc: boolean, strictNotes: boolean): Violation[] {
  const out: Violation[] = [];
  const { units, slides } = unitsOf(text, doc);
  if (language === "en") {
    const front = frontMatter(text);
    for (const k of ["title", "subtitle"] as const) {
      const v = front?.[k];
      if (v && hasCjk(stripAllowed(v, allow))) out.push({ page: 0, title: k === "title" ? "封面標題" : "封面副標題", part: "front", snippet: snippetOf(v) });
    }
    for (const u of units) {
      for (const [part, raw] of [["title", u.title], ["body", u.body], ["notes", u.notes]] as const) {
        const vis = stripAllowed(visibleText(raw), allow);
        if (hasCjk(vis)) out.push({ page: u.page, title: u.title, part, snippet: snippetOf(vis) });
      }
    }
    return out;
  }
  for (const u of units) {
    for (const [part, raw] of [["body", u.body], ["notes", u.notes]] as const) {
      const vis = visibleText(raw.replace(/```[\s\S]*?```/g, " ").replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, " "));
      if (part === "notes" && strictNotes ? mostlyEnglish(vis) : latinWords(vis) >= 30 && !(vis.match(HAN_G) ?? []).length) out.push({ page: u.page, title: u.title, part, snippet: vis.trim().slice(0, 40) });
    }
  }
  void slides;
  return out;
}

const PART_LABEL: Record<Violation["part"], string> = { front: "", title: "標題", body: "內文", notes: "講稿" };
export const whereOf = (v: Violation, slides = true) =>
  v.part === "front" ? v.title : v.page === 0 ? "開頭" : `${slides ? `第 ${v.page} 頁` : `第 ${v.page} 段`}「${v.title}」${PART_LABEL[v.part]}`;

/** Pages (slide numbers) a language problem sits on; 0 = the cover. */
export const violationPages = (vs: Violation[]) => [...new Set(vs.map((v) => v.page))].sort((a, b) => a - b);

/** Mostly-English content (an English deck or note): used to infer a standing language for artifacts without preferences. */
export function inferLanguage(text: string): "en" | null {
  const vis = visibleText(text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/```[\s\S]*?```/g, " "));
  const words = latinWords(vis);
  const han = (vis.match(HAN_G) ?? []).length;
  return words >= 40 && han <= Math.max(6, words * 0.04) ? "en" : null;
}

const normTerm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_/·・.]+/g, "");
const termHit = (hay: string, t: RequirementTerm) => [t.name, ...(t.aliases ?? [])].some((a) => normTerm(a).length >= 2 && hay.includes(normTerm(a)));

// ---------------------------------------------------------------- deterministic detection

/** Output language the user explicitly asks for (「整份改成英文」「我整個簡報要用英文」「in English」); null = not said. */
const LANG_ZH_RE = /(?:用|改成|改為|改回|換成|換回|轉成|翻成|翻譯成|翻譯為|譯成|寫成|做成|全部|整份|都(?:要)?用?)\s*(?:繁體|正體)?中文|(?:translate|翻譯|翻)\s*(?:成|為|to|into)\s*(?:繁體|正體)?(?:中文|chinese)|(?:繁體|正體)?中文(?:版|簡報|投影片|報告|筆記)|\b(?:in|into|to) (?:traditional )?chinese\b|chinese version/i;
const LANG_EN_RE = /(?:用|改成|改為|換成|轉成|翻成|翻譯成|翻譯為|譯成|寫成|做成|全部|整份|整個|都(?:要)?用?|純|全)\s*英文|(?:translate|翻譯|翻)\s*(?:成|為|to|into)\s*(?:英文|english)|英文(?:版|簡報|投影片|報告|筆記|論文)|\b(?:in|into|to) (?:(?:clear|plain|academic|fluent|formal|natural|proper|simple)\s+)*english\b|\benglish (?:(?:research|academic|technical)\s+)?(?:version|deck|slides|slide deck|presentation|talk|report|note|paper)\b|\ball[- ]english\b/i;
export function detectLanguage(text: string): "en" | "zh" | null {
  const z = LANG_ZH_RE.test(text);
  const e = LANG_EN_RE.test(text);
  if (e && !z) return "en";
  if (z && !e) return "zh";
  return null;
}

export type LanguagePart = "slides" | "notes";
const NOTES_WORD = "(?:講稿|逐字稿|口稿|講詞|演講稿|speaker\\s*notes?|notes)";
const SLIDES_WORD = "(?:投影片(?:本體|本身|內容|上的字|上面的字|文字)?|頁面(?:內容|文字)?|簡報(?:本體|本身|內容|上的字|上面的字|頁面)|slides?(?:\\s*text)?|slide\\s*content)";
const LANG_WORD = "(?:(?:繁體|正體)?中文|英文|english|chinese)";
const partRe = (part: string) => new RegExp(`${part}[^。，,；;！？!?\\n]{0,12}?(?:要是|要用|都用|都是|全部用|全用|請用|改成|改為|換成|轉成|翻成|翻譯成|寫成|維持|保持|保留|還是|用|是|stay in|stays in|remain in|keep in|in|into|to)\\s*(?:一樣用\\s*)?${LANG_WORD}`, "gi");
const PART_RES: [LanguagePart, RegExp][] = [["notes", partRe(NOTES_WORD)], ["slides", partRe(SLIDES_WORD)]];
const langOf = (s: string): "en" | "zh" => (/英文|english/i.test(s) ? "en" : "zh");

/**
 * Per-part language (「講稿要是中文的」「投影片用英文、講稿用中文」「speaker notes in Chinese」): one entry per part the
 * words set, with the matched span (removed before the whole-artifact detection, so 「講稿用中文」 is not 「全部中文」).
 */
export function detectPartLanguages(text: string): { part: LanguagePart; language: "en" | "zh"; span: string }[] {
  const out: { part: LanguagePart; language: "en" | "zh"; span: string }[] = [];
  for (const [part, re] of PART_RES) {
    for (const m of text.matchAll(re)) {
      if (out.some((o) => o.part === part)) break;
      if (part === "slides" && (out.some((o) => o.span.includes(m[0]) || m[0].includes(o.span)) || new RegExp(NOTES_WORD, "i").test(m[0]))) continue;
      out.push({ part, language: langOf(m[0]), span: m[0] });
    }
  }
  return out;
}

/** 「多用一點英文的專用名詞」「專有名詞保留英文」: English technical terms inside a Chinese text. */
/** 「參考我們的文獻庫…統計有哪幾種方法」「survey our library」: the user asks to cover the study's library. */
export const LIBRARY_SURVEY_RE = /(?:參考|根據|依據|用|整理|統計|涵蓋|看)(?:一下)?(?:我們|我|實驗室|研究)?的?文獻庫|文獻庫(?:裡|中|內|的)(?:所有|全部|每一?篇|有哪些|的方法|的論文)|(?:統計|列出|整理)[^。，,；;\n]{0,8}(?:有哪幾種|有哪些|所有|全部)(?:方法|做法|methods?)|(?:all|every) (?:the )?papers in (?:our|the|my) (?:study )?library|(?:survey|cover|tally) (?:our|the|my) (?:study )?(?:library|collection)|(?:use|using) our (?:study )?library[^.\n]{0,40}(?:count|which methods)/i;
export const TERMS_EN_RE = /英文的?(?:專用|專有)?(?:名詞|術語|用語)|(?:專用|專有)名詞[^。，,；;\n]{0,6}英文|術語[^。，,；;\n]{0,6}英文|technical terms?[^。，,；;\n]{0,8}(?:英文|english)|english (?:technical )?terms|(?:keep|leave) (?:the )?(?:technical )?terms in english/i;
/** 「講稿要我能夠一比一的念出來不會有違和」「可以直接照念」「read aloud verbatim」: notes written to be read out as they are. */
export const READ_ALOUD_RE = /一比一的?(?:照著?)?(?:念|唸|讀)|一字一句|照(?:著)?(?:稿)?(?:念|唸|讀)|直接(?:念|唸|讀)|(?:念|唸|讀)出來[^。，,；;\n]{0,8}(?:不會|沒有|不)(?:有)?(?:違和|卡|奇怪|不順)|(?:念|唸)起來(?:要)?(?:順|自然|通順)|口語化|read (?:it )?(?:aloud|out loud)|verbatim/i;

export const languageText = (language: "en" | "zh", part?: LanguagePart, termsEn = false) =>
  part === "notes" ? `講稿用${LANGUAGE_LABEL[language]}${language === "zh" && termsEn ? "（專有名詞多用英文）" : ""}`
    : part === "slides" ? `投影片（封面、標題、內文、圖表標籤）用${LANGUAGE_LABEL[language]}`
      : `成果全部用${LANGUAGE_LABEL[language]}${language === "en" ? "（封面、標題、內文、圖表標籤與講稿都不留中文）" : termsEn ? "（專有名詞多用英文）" : ""}`;

/** Spoken connectors that start a new ask in a run-on (ASR) request: 「並且」「還有」「然後」「那請你」「我要」… */
const CONNECTOR_RE = /(?=並且|而且|還有|然後|另外|此外|同時|以及|再來|接著|當然|那請你|那你|(?<!那)請你|(?<!那)我要你|(?<![那你])我要|我想要|我希望|也要|還要|最後)/g;

/**
 * The clauses of the user's words (production 0668a3d7: an ASR-transcribed request with no punctuation hid 5 of 6
 * asks): split at punctuation, at the pauses ASR writes as spaces between Chinese words, and before spoken connectors.
 * Each clause is one candidate ask; requirement extraction must account for every content clause.
 */
export function segmentClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.replace(/\r\n/g, "\n").split(/[。！？!?；;\n]+|[，,]\s*|(?<=[\p{Script=Han}）」])\s+(?=[\p{Script=Han}（「])/u)) {
    for (const part of sentence.split(CONNECTOR_RE)) {
      const t = part.replace(/\s+/g, " ").trim();
      if (!t) continue;
      // A connector alone or a two-character fragment joins the previous clause.
      if (t.replace(/[\s\p{P}]/gu, "").length < 4 && out.length) out[out.length - 1] = `${out[out.length - 1]}${/[A-Za-z0-9]$/.test(out[out.length - 1]!) || /^[A-Za-z0-9]/.test(t) ? " " : ""}${t}`;
      else out.push(t);
    }
  }
  return out;
}

/** The clause of `text` around the first match of `re` (≤ 160 chars): the user's own words a requirement quotes. */
export function clauseOf(text: string, re: RegExp | null): string | undefined {
  const m = re ? new RegExp(re.source, re.flags.replace("g", "")).exec(text) : null;
  if (!m) return undefined;
  // The clause (segmentClauses) holding the match; a match spanning clauses keeps them all.
  let pos = 0;
  const hit: string[] = [];
  for (const c of segmentClauses(text)) {
    const at = text.indexOf(c.slice(0, 12), pos);
    const start = at < 0 ? pos : at;
    const end = start + c.length;
    if (end > m.index && start < m.index + m[0].length) hit.push(c);
    pos = at < 0 ? pos : end;
  }
  const q = (hit.length ? hit.join(" ") : m[0]).replace(/\s+/g, " ").trim();
  return q.slice(0, 160) || undefined;
}

/** Explicit page counts: 「做成 20 頁」「15–20 頁」「至少 10 頁」「12 slides」; inputs.pages wins. */
/** Any page-count phrase (for the quote of a page requirement). */
const PAGE_PHRASE_RE = /\d{1,2}\s*(?:[-–~到至]|to)?\s*\d{0,2}\s*(?:頁|張|pages?\b|slides?\b)/i;

export function detectPageCount(text: string, pages?: unknown): Requirement["params"] | null {
  if (typeof pages === "number" && pages > 0) return { exact: Math.round(pages) };
  const range = /(\d{1,2})\s*(?:[-–~到至]|to)\s*(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text);
  if (range) return { min: Math.min(+range[1]!, +range[2]!), max: Math.max(+range[1]!, +range[2]!) };
  const min = /(?:至少|最少|不少於|at least)\s*(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text);
  if (min) return { min: +min[1]! };
  const max = /(?:最多|不超過|以內|at most|no more than)\s*(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)|(\d{1,2})\s*頁以內/i.exec(text);
  if (max) return { max: +(max[1] ?? max[2])! };
  const exact = /(?:做成|做|共|總共|剛好|正好|改成|變成|擴充到|擴充成|擴到|增加到|縮成|縮減到|精簡到|控制在|大約|大概|差不多|約|一份|exactly|about|around|roughly|approximately|into|to)\s*(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)|(?<![第\d])(\d{1,2})\s*(?:頁(?:的|簡報|投影片|左右)|-?(?:page|slide)\b(?: deck| presentation)?|\s(?:pages|slides)\b)/i.exec(text);
  if (exact) {
    const n = +(exact[1] ?? exact[2])!;
    if (n >= 1 && n <= 60) return { exact: n };
  }
  // A bare 「…，8 頁」 at the end of a clause (eval deck_study_answer_topic: 「用我們的文獻庫，8 頁」 got the default 10).
  const bare = /(?:^|[，,、；;\s])(\d{1,2})\s*(?:頁|張投影片)\s*(?:$|[，,。.！!；;])/.exec(text);
  if (bare && !/第\s*$/.test(text.slice(0, bare.index + 1))) {
    const n = +bare[1]!;
    if (n >= 1 && n <= 60) return { exact: n };
  }
  return null;
}

const VENUE_ALIASES = ["Venue", "Conference", "Journal", "Proceedings", "Proc.", "Interspeech", "ICASSP", "ASRU", "SLT", "ACL", "EMNLP", "NAACL", "NeurIPS", "ICML", "ICLR", "AAAI", "TASLP", "Transactions", "IEEE", "arXiv", "preprint", "會議", "期刊"];
const FIELD_ALIASES: [RegExp, string[]][] = [
  [/^(?:pros?|優點|優勢|好處|benefits?|advantages?|strengths?)$/i, ["Pros", "Pro", "Advantages", "Advantage", "Benefits", "Strengths", "優點", "優勢", "好處"]],
  [/^(?:cons?|缺點|劣勢|壞處|disadvantages?|limitations?|weakness(?:es)?|drawbacks?)$/i, ["Cons", "Con", "Disadvantages", "Limitations", "Limitation", "Weaknesses", "Drawbacks", "Trade-off", "缺點", "限制", "劣勢", "壞處"]],
  [/架構圖|architecture diagram|diagram|示意圖|流程圖/i, ["Architecture", "架構", "Diagram", "```diagram", "```mermaid", "paper-fig", "架構圖"]],
  [/架構|architecture|structure/i, ["Architecture", "架構", "Structure", "Model structure"]],
  [/會議|期刊|venue|conference|journal|發表/i, VENUE_ALIASES],
  [/論文|paper|出處|reference|citation/i, ["Paper", "論文", "et al", "[@"]],
  [/運作|原理|怎麼做|做法|how it works|mechanism|how/i, ["How it works", "How It Works", "Mechanism", "運作方式", "運作", "原理", "Works by"]],
  [/結果|results?|performance|效果/i, ["Results", "Result", "Performance", "結果", "效果", "WER", "CER"]],
  [/公式|equation|formula/i, ["Equation", "Formula", "公式", "$"]],
];

/** A field name with its usual aliases in both languages (Pros ⇄ 優點 / Advantages …). */
export function fieldTerm(name: string, aliases: string[] = []): RequirementTerm {
  const n = name.trim();
  const known = FIELD_ALIASES.find(([re]) => re.test(n))?.[1] ?? [];
  return { name: n, aliases: [...new Set([...aliases, ...known].filter((a) => a && a !== n))] };
}

/** A spoken field phrase → its usual name (「好處」→ 優點, 「模型的架構圖」→ 架構圖, 「他們的會議或是期刊是哪一個」→ 發表會議／期刊). */
export function canonicalField(phrase: string): string {
  if (!/\p{Script=Han}/u.test(phrase)) return phrase.trim();
  const f = phrase.replace(/^(?:要|有|都有|都要|一個|一張|是|這一?篇|他們的|它的|它們的|模型的|方法的|論文的)\s*/g, "").replace(/(?:是哪一?(?:篇|個|種)|來更好的?演示|來(?:更好地?)?(?:說明|呈現|演示)|來演示|等等?|之類)$/g, "").trim();
  if (/好處|優點|優勢/.test(f)) return "優點";
  if (/壞處|缺點|劣勢/.test(f)) return "缺點";
  if (/架構圖|示意圖/.test(f)) return "架構圖";
  if (/會議|期刊/.test(f)) return "發表會議／期刊";
  if (/論文/.test(f) && f.length <= 12) return "論文";
  return f;
}

const FIELD_SPLIT_RE = /[、,，/／]|\s+(?:and|&)\s+|還有|以及|和|及|與|跟(?![隨著])|並且|而且/;
const NOT_FIELD_RE = /english|chinese|英文|中文|everything|整份|全部|slides?|deck|簡報|投影片/i;
const fieldList = (list: string) => list.replace(/優缺點/g, "優點、缺點").replace(/好壞處/g, "好處、壞處").split(FIELD_SPLIT_RE)
  .map((f) => canonicalField(f.replace(/^(?:the|its|their|each)\s+/i, "").replace(/[「」"'.]/g, "").replace(/(?:等|等等|之類)$/, "").trim()))
  .filter((f) => !NOT_FIELD_RE.test(f))
  .filter((f) => f.length >= 2 && f.length <= (/[A-Za-z]/.test(f) ? 24 : 10));

/**
 * 「每個方法要有架構、Pros/Cons」「for each method include architecture, pros and cons」, and the spoken forms of the
 * same ask spread over a run-on request (production 0668a3d7): 「詳細敘述每一種方法的好處跟壞處」, 「在講解方法的時候要搭配
 * 模型的架構圖」, 「在提到方法的時候要講到這一篇論文是哪一篇還有他們的會議或是期刊是哪一個」 → one per-item requirement
 * (方法: 優點、缺點、架構圖、論文、發表會議／期刊).
 */
export function detectPerItemFields(text: string): Requirement["params"] | null {
  const KIND = "(方法|模型|做法|作法|技術|論文|系統)";
  let kind = "";
  const fields: string[] = [];
  const add = (k: string, list: string) => {
    const got = fieldList(list);
    if (!got.length) return;
    kind ||= k.replace(/^(?:個|種)/, "");
    for (const f of got) if (!fields.includes(f)) fields.push(f);
  };
  // 「每個方法(都)要有 X、Y」
  for (const m of text.matchAll(/(?:每|各)(?:一)?(?:個|種|篇|項)?\s*([^\s，。,；;、\n]{1,10}?)\s*(?:都)?(?:要|需要|必須|得|請)?(?:有|包含|包括|列出|寫出|寫|說明|附上|附|加上|標出|標明|註明)\s*([^。；;，,\n]{2,80})/g)) add(m[1]!, m[2]!);
  // 「(敘述／說明)每一種方法的好處跟壞處」
  for (const m of text.matchAll(new RegExp(`(?:每|各)(?:一)?(?:個|種|篇|項)?\\s*${KIND}的\\s*([^。，,；;\\s]{2,30})`, "g"))) add(m[1]!, m[2]!);
  // 「在講解／提到方法的時候要搭配／講到 X」
  for (const m of text.matchAll(new RegExp(`(?:講解|介紹|提到|說明|描述|講到|呈現|談到)(?:每一?(?:個|種))?${KIND}(?:的)?(?:時候|時)?[^。，,；;\\n]{0,6}?(?:要|需要|都要|請|得)(?:搭配|講到|講出|附上|說明|包含|寫出|寫明|寫|列出|列|標出|標明|標註|註明|指出|提到|給出|放上|附|有|加上)([^。；;，,\\s]{2,60})`, "g"))) add(m[1]!, m[2]!);
  for (const en of text.matchAll(/\b(?:for )?(?:each|every)\s+(method|approach|model|paper|technique|system)\b[^.\n]{0,40}?\b(?:include|includes|cover|covers|with|should have|must have|has|have|name|names|give|list|show|state|cite|:)\s*([^.\n]{2,120})/gi)) add(en[1]!, en[2]!);
  // 「give the pros and cons of each method」
  for (const en of text.matchAll(/\b(?:give|include|list|show|state|with|add)\s+(?:the\s+)?([a-z][a-z ,/&-]{2,60}?)\s+(?:of|for)\s+(?:each|every)\s+(method|approach|model|paper|technique)\b/gi)) add(en[2]!, en[1]!);
  // A continuation of a per-item ask without 「每」: 「要寫是哪篇 paper 跟 venue」「註明論文和會議或期刊」.
  if (kind) for (const m of text.matchAll(/(?:要|請|都要)?(?:寫|註明|標明|標出|列出|附上|寫出)\s*(?:是)?([^。，,；;\n]{0,4}(?:論文|paper|會議|期刊|venue)[^。，,；;\n]{0,24})/gi)) add(kind, m[1]!.replace(/哪(?:一)?篇\s*/g, ""));
  if (!fields.length && /pros\s*(?:\/|and|&|、)\s*cons|優缺點|優點(?:和|與|跟|、)缺點|好處(?:和|與|跟|、)壞處/i.test(text) && /每|各|each|every/i.test(text)) add(/方法|method|approach/i.test(text) ? "方法" : "項目", "Pros、Cons");
  if (!kind || !fields.length) return null;
  return { item_kind: kind, fields: fields.slice(0, 8).map((f) => fieldTerm(f)) };
}

const ZH_DIGIT: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「9」「九」「十二」「二十」 → the number (1–99), else null. */
export function pageNumber(s: string): number | null {
  if (/^\d{1,2}$/.test(s)) return +s || null;
  const m = /^([一二兩三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(s);
  if (!m || !s) return null;
  if (!m[2]) return m[1] && !m[3] ? ZH_DIGIT[m[1]]! : null;
  return (m[1] ? ZH_DIGIT[m[1]]! : 1) * 10 + (m[3] ? ZH_DIGIT[m[3]]! : 0);
}

const NUM = "(?:\\d{1,2}|[一二兩三四五六七八九十]{1,3})";
/** 「第九頁」「第 3、5 頁」「第3到5頁」「page 9」「slides 3 and 4」 (as the user counts: the player's page numbers). */
export const PAGE_REF_RE = new RegExp(`第\\s*${NUM}(?:\\s*(?:[、,，和跟與及]|到|至|~|-|–)\\s*(?:第\\s*)?${NUM})*\\s*[頁張]|\\b(?:pages?|slides?)\\s+\\d{1,2}(?:\\s*(?:,|and|&|to|-|–)\\s*\\d{1,2})*\\b`, "gi");

/** The page numbers a reference names (ranges expanded). */
export function pageRefs(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PAGE_REF_RE)) {
    const parts = [...m[0].matchAll(new RegExp(`(到|至|~|-|–|\\bto\\b)?\\s*(?:第\\s*)?(${NUM})`, "gi"))];
    for (const p of parts) {
      const n = pageNumber(p[2]!);
      if (!n) continue;
      const prev = out.at(-1);
      if (p[1] && prev && n > prev && n - prev <= 30) for (let k = prev + 1; k <= n; k++) out.push(k);
      else out.push(n);
    }
  }
  return [...new Set(out)];
}

const RM = "(?:刪掉|刪除|刪去|刪了|拿掉|拿走|去掉|移除|不要了|整頁不要|不需要了)";
/** Between a page reference and its removal verb: a quoted title, 「這一頁」, adverbs — never 「的」 (「第九頁的圖刪掉」 removes a part). */
const GAP = `((?:\\s*(?:[「『"][^」』"]{1,80}[」』"]|這一?頁|那一?頁|整頁|整個|完整|全部|直接|也|都|給我|請|就|先|要)\\s*)*)`;

/** 「刪掉第 3 頁」「把第九頁刪掉」「拿掉「卡住」這頁」「第九頁「X」完整刪除」「remove the slide "Blocked"」「delete slide 9」. */
export function detectExclude(text: string): Requirement["params"] | null {
  const pages: number[] = [];
  const titles: string[] = [];
  for (const m of text.matchAll(new RegExp(`(?:刪掉|刪除|拿掉|去掉|移除|不要)\\s*(${PAGE_REF_RE.source})`, "gi"))) pages.push(...pageRefs(m[1]!));
  for (const m of text.matchAll(new RegExp(`(${PAGE_REF_RE.source})${GAP}\\s*${RM}`, "gi"))) {
    // A page named by number and quoted title: the title decides (the user's count may or may not include the cover).
    const quoted = /[「『"]([^」』"]{1,80})[」』"]/.exec(m[2] ?? "")?.[1]?.trim();
    if (quoted) titles.push(quoted);
    else pages.push(...pageRefs(m[1]!));
  }
  for (const m of text.matchAll(/\b(?:remove|delete|drop|cut)\s+(?:the\s+)?((?:pages?|slides?)\s+\d{1,2}(?:\s*(?:,|and|&|to|-|–)\s*\d{1,2})*)\b|\b((?:page|slide)\s+\d{1,2})\s+(?:should\s+be\s+|needs\s+to\s+be\s+)?(?:removed|deleted|dropped)\b/gi)) pages.push(...pageRefs(m[1] ?? m[2]!));
  titles.push(...[...text.matchAll(/(?:刪掉|刪除|拿掉|去掉|移除|不要)\s*[「『"]([^」』"]{1,60})[」』"](?:\s*(?:這|那)?一?頁)?/g), ...text.matchAll(/[「『"]([^」』"]{1,60})[」』"]\s*(?:這|那)?一?頁\s*(?:要|請)?(?:刪掉|刪除|拿掉|去掉|移除)/g), ...text.matchAll(/\b(?:remove|delete|drop)\s+(?:the\s+)?(?:slide|page|section)\s+["“']([^"”']{1,60})["”']/gi)].map((m) => m[1]!.trim()));
  const uniq = [...new Set(pages)];
  const names = [...new Set(titles)];
  if (!uniq.length && !names.length) return null;
  return { scope: "page", ...(uniq.length ? { pages: uniq } : {}), terms: names.map((t) => ({ name: t })) };
}

// ---------------------------------------------------------------- listed parts, distinctions, material

/** A list item that only names a part of the deck (「包含封面和講稿」 extends a language requirement, not a section list). */
const PART_ITEM_RE = /^(?:封面|講稿|標題|圖表|頁碼|cover|notes|speaker notes|titles?)$/i;
const SECTION_VERB_RE = /(?<![每各])(?:呈現|包含|包括|涵蓋|需要有|必須有|應該有|要有|分成|分為|列出|整理出)\s*(?:出|了)?(?:以下|下列)?(?:的)?(?:幾|[一二三四五六七八九十兩\d]+)?個?(?:部分|部份|面向|段落|主題)?\s*[:：]?\s*/g;
const cleanItem = (x: string) => x.replace(/^[「『"“\s]+|[」』"”\s]+$/g, "").replace(/(?:等等|等|…+|\.\.\.)$/, "").replace(/(?:這|那)?(?:幾|些|[二三四五六七八九十兩]+)個?(?:部分|部份|面向|段落|主題)$/, "").replace(/的(?:部分|部份|內容)$/, "").trim();
/**
 * 「呈現研究背景、既有資源與限制、候選研究方向…與需要教授決策的問題」「包含 A、B」「要有 A 和 B」: the parts the user listed
 * (≥ 2), each of which must get its own page / section (production 301b6e1a: none of six listed parts appeared). Items are
 * split at 、／，; the last one also at 與／和／及／以及 when both sides are ≥ 4 characters (「既有資源與限制」 stays one).
 * Per-item asks (「每個方法都要有…」) and language extensions (「包含封面和講稿」) are not part lists. Pure.
 */
export function detectSections(text: string): { items: string[]; quote: string }[] {
  const out: { items: string[]; quote: string }[] = [];
  for (const sentence of text.replace(/\r\n/g, "\n").split(/[。！？!?；;\n]+/)) {
    for (const m of sentence.matchAll(SECTION_VERB_RE)) {
      // 「每個方法都要有架構、優點、缺點」 is a per-item ask (detectPerItemFields), not a list of parts.
      if (/(?:[每各](?:一)?(?:個|種|篇|項)?|each|every)[^，,。]{0,12}$/i.test(sentence.slice(0, m.index))) continue;
      const rest = sentence.slice(m.index! + m[0].length);
      // The list: 、-separated up to the next comma (「要有一個比較表，整份用英文」 is two asks, not a list), or two parts
      // joined by 與／和 (split below).
      const list = rest.split(/[，,]/)[0]!;
      let items = list.split(/、/).map((x) => x.trim()).filter(Boolean);
      if (items.length) {
        const last = items.pop()!;
        const parts = last.split(/以及|與|和|及|跟|還有/);
        if (parts.length === 2 && parts.every((x) => cleanItem(x).replace(/[\s\p{P}]/gu, "").length >= 4)) items.push(...parts);
        else items.push(last);
      }
      items = items.map(cleanItem).filter((x) => x.replace(/[\s\p{P}]/gu, "").length >= 2 && x.length <= 40);
      if (items.length < 2 || items.every((x) => PART_ITEM_RE.test(x)) || items.some((x) => /^(?:英文|中文|english|chinese)$/i.test(x))) continue;
      // Latin-only lists (「包含 shallow fusion、CLAS」) are the topics rule's (compare / cover).
      if (items.every((x) => /^[A-Za-z0-9 .+\-/]+$/.test(x))) continue;
      const quote = `${m[0]}${list}`.trim().slice(0, 200);
      out.push({ items: items.slice(0, 10), quote });
      break;
    }
  }
  return out;
}

/** 「清楚區分已知事實、合理推論與待驗證構想」「分清楚事實和推測」: a distinction the content must keep (judged). */
const DISTINGUISH_RE = /(?:清楚)?(?:區分|區別|分清楚?|分開|標明|標示|標出)(?:出)?\s*[:：]?\s*([^。！？!?；;\n，,]{4,80})|distinguish (?:between )?([^.;\n]{4,80})/i;
export function detectDistinction(text: string): { items: string[]; quote: string } | null {
  const m = DISTINGUISH_RE.exec(text);
  if (!m) return null;
  const list = (m[1] ?? m[2] ?? "").split(/[，,]/)[0]!;
  const items = list.split(/、|與|和|及|以及|跟|還有|\band\b|,/).map((x) => cleanItem(x).replace(/^(?:哪些是|什麼是)/, "")).filter((x) => x.length >= 2 && x.length <= 20);
  if (items.length < 2) return null;
  return { items, quote: clauseOf(text, DISTINGUISH_RE) ?? m[0] };
}

/** 「像教授報告的簡報」「要給教授看」「report to my advisor」: the audience is the professor. */
const PROFESSOR_RE = /(?:向|給|跟|對|像)?(?:指導)?教授(?:報告|看|簡報|討論|決策)|(?:report|present|presenting)(?: it)? to (?:my |the )?(?:advisor|professor|supervisor)|for (?:my |the )?(?:advisor|professor|supervisor)/i;
/** A clause that only names the subject: 〈title〉 (a # chip) or 「關於這個部分」. */
const SUBJECT_CLAUSE_RE = /^(?:(?:關於|有關|針對)\s*)?(?:〈[^〉]{2,80}〉|「[^」]{2,80}」)\s*(?:(?:關於|有關|針對)?\s*的?(?:這個|這|那個)?(?:部分|部份|主題|研究))?$|^(?:關於|有關|針對)?\s*(?:這|那)(?:個|一)?(?:部分|部份|主題|題目|研究)$/;

/** Deterministic requirements of one text (the request, a guidance line, or an edited requirement). */
const NOTES_WORD_RE = /講稿|逐字稿|口稿|講者備註|備註|speaker notes?|\bnotes\b|\bscript\b/i;
const NOTES_ACTION_RE = /拿掉|拿走|去掉|刪掉|刪除|移除|不要|別再|加上|加入|補上|改成|改為|改寫|重寫|精簡|縮短|\bremove\b|\bdelete\b|\bdrop\b|\btake\b[^.\n]{0,60}\bout\b|get rid of|\bno longer\b|\bdon'?t\b|\badd\b|\brewrite\b|\bshorten\b/i;

export function detectRequirements(text: string, opts: { pages?: unknown; kind?: ArtifactKind } = {}): Omit<Requirement, "id" | "source">[] {
  const out: Omit<Requirement, "id" | "source">[] = [];
  const q = (re: RegExp) => { const c = clauseOf(text, re); return c ? { quote: c } : {}; };
  const termsEn = TERMS_EN_RE.test(text);
  const parts = opts.kind === "doc" || opts.kind === "latex" ? [] : detectPartLanguages(text);
  for (const pl of parts) out.push({ type: "language", text: languageText(pl.language, pl.part, termsEn), params: { language: pl.language, part: pl.part }, ...q(new RegExp(pl.span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) });
  // The rest of the text (part statements removed) for a whole-artifact language (or the other part's).
  const rest = parts.reduce((t, pl) => t.split(pl.span).join(" "), text);
  const lang = parts.length === 2 ? null : detectLanguage(rest);
  const other: LanguagePart | undefined = parts.length ? (parts[0]!.part === "notes" ? "slides" : "notes") : undefined;
  if (lang) out.push({ type: "language", text: languageText(lang, other, termsEn), params: { language: lang, ...(other ? { part: other } : {}) }, ...q(lang === "en" ? LANG_EN_RE : LANG_ZH_RE) });
  // Clauses that only extend a stated language (「包含封面和講稿」「cover 跟 speaker notes 也要」) or keep terms in English
  // (「專有名詞保留英文」) belong to the language requirement's quote — every clause of the user's is accounted for.
  const cl = segmentClauses(text);
  const extend = (pred: (c: string) => boolean, r: Omit<Requirement, "id" | "source"> | undefined) => {
    const extra = cl.filter((c) => pred(c) && !(r?.quote ?? "").includes(c));
    if (r && extra.length) r.quote = [r.quote, ...extra].filter(Boolean).join(" ").slice(0, 300);
    return extra;
  };
  const langs = out.filter((r) => r.type === "language");
  const whole = langs.find((r) => !r.params?.part);
  extend((c) => /(?:封面|cover|講稿|speaker notes?|notes|標題|圖表|titles?)[^。！？\n]{0,16}(?:也要|也是|一起|都要|都)|^(?:包含|包括|including|incl\.)/i.test(c) && !detectPartLanguages(c).length && !detectLanguage(c), whole);
  const termsTarget = langs.find((r) => r.params?.language === "zh") ?? langs[0];
  const termClauses = cl.filter((c) => TERMS_EN_RE.test(c));
  if (termClauses.length && termsTarget) extend((c) => TERMS_EN_RE.test(c), termsTarget);
  else if (termClauses.length) out.push({ type: "other", text: "專有名詞與技術術語保留英文", quote: termClauses.join(" ").slice(0, 200) });
  // 「參考我們的文獻庫，統計有哪幾種方法」: the sources and the tally the user asked for (judged; the topic deck reads the library).
  const lib = cl.filter((c) => LIBRARY_SURVEY_RE.test(c) || /文獻庫|library/i.test(c) && /參考|根據|用|統計|整理|比較|use|using|based|in our|from our|compar/i.test(c));
  // 「要有比較表」「with a comparison table」: the form the user asked for.
  const table = cl.filter((c) => /(?:要有|加|附|附上|包含|做|需要|with|include|add)\s*(?:一個|一張|a|an)?\s*(?:比較表|對照表|comparison table|表格|table)/i.test(c) && !/加一頁/.test(c));
  if (table.length) out.push({ type: "format", text: "要有比較表（表格）", quote: table.join(" ").slice(0, 200) });
  // 「比較 shallow fusion、CLAS 和 contextual adapters」「compare A, B and C」: what must be covered.
  for (const c of cl) {
    const m = /(?:比較|涵蓋|包含|compare|comparing|cover)\s+([^。！？\n]{3,120})/i.exec(c);
    const items = m ? m[1]!.split(/、|，|,|\s+(?:and|&)\s+|和|跟|與|及/).map((x) => x.trim().replace(/^(?:the)\s+/i, "")).filter((x) => /[A-Za-z]{2}/.test(x) && x.length <= 40 && !/library|文獻庫|papers?$/i.test(x)) : [];
    if (items.length >= 2) { out.push({ type: "include_topics", text: `要涵蓋：${items.join("、")}`, params: { topics: items.map((name) => ({ name })) }, quote: c.slice(0, 200) }); break; }
  }
  // 「加一頁 comparison table」「把「動態熱詞的做法」那頁展開」: the edit itself, checked by the judge (the router plans it).
  if (opts.kind !== "doc" && opts.kind !== "latex") {
    const edits = cl.filter((c) => /加(?:一|兩|三|\d)\s*頁|新增(?:一|\d)?\s*頁|add (?:a|one|\d+) (?:new )?(?:slide|page)|[」』"]\s*(?:那|這)?頁\s*展開|展開\s*[「『"]|\bexpand the\b/i.test(c) && !out.some((r) => (r.quote ?? "").includes(c)));
    if (edits.length) out.push({ type: "other", text: `照你說的修改：${edits.join("；").slice(0, 120)}`, quote: edits.join(" ").slice(0, 200) });
    // 「從講稿中拿掉引用論文的部分」「take the citations out of the speaker notes」: an instruction on the speaker notes is a
    // checked requirement on them (scenario n80: it had none, so nothing verified the notes changed as asked).
    const notesAsks = cl.filter((c) => NOTES_WORD_RE.test(c) && NOTES_ACTION_RE.test(c) && !out.some((r) => (r.quote ?? "").includes(c)) && !detectPartLanguages(c).length && !detectLanguage(c));
    if (notesAsks.length) out.push({ type: "other", text: `講稿照你說的修改：${notesAsks.join("；").slice(0, 120)}`, params: { part: "notes" }, quote: notesAsks.join(" ").slice(0, 300) });
  }
  // 「每個方法一頁」「one slide per method」
  const perPage = cl.filter((c) => /(?:每|各)(?:一)?(?:個|種|篇)\s*[^\s，。,]{1,8}?\s*(?:都)?(?:要)?(?:獨立)?(?:一頁|各一頁|一張)|one (?:slide|page) (?:per|for each)/i.test(c));
  if (perPage.length) out.push({ type: "format", text: "每個項目獨立一頁", quote: perPage.join(" ").slice(0, 200) });
  if (lib.length) out.push({ type: "other", text: `以研究文獻庫的論文為來源${lib.some((c) => /統計|有哪(?:幾|些)種|count|tally/i.test(c)) ? "，統計並列出有哪幾種方法（每一類都有代表論文）" : ""}`, quote: lib.join(" ").slice(0, 300) });
  if (opts.kind !== "doc" && opts.kind !== "latex" && READ_ALOUD_RE.test(text)) {
    out.push({ type: "tone", text: "講稿寫成可以一字一句照念的自然口語：句子通順、像真的在講話，專有名詞用英文，不生硬、沒有違和感", params: { part: "notes" }, ...q(READ_ALOUD_RE) });
  }
  if (opts.kind !== "doc" && opts.kind !== "latex") {
    const pc = detectPageCount(text, opts.pages);
    if (pc) out.push({ type: "page_count", text: pageText(pc), params: pc, ...q(PAGE_PHRASE_RE) });
  }
  const fields = detectPerItemFields(text);
  if (fields) {
    // The quote: every clause that adds a field (「…好處跟壞處」「…架構圖」「…論文是哪一篇」「還有…會議或是期刊」).
    const cl = segmentClauses(text);
    const own = cl.filter((c, i) => detectPerItemFields(c) || (i > 0 && /^(?:還有|以及|和|跟)/.test(c) && !!detectPerItemFields(`${cl[i - 1]}${c}`)));
    out.push({ type: "per_item_fields", text: `每個${fields.item_kind}都要有：${fields.fields!.map((f) => f.name).join("、")}`, params: fields, ...(own.length ? { quote: own.join(" ").slice(0, 300) } : q(/每|各|each|every/i)) });
  }
  // The parts the user listed (「呈現 A、B、C」): each gets its own page / section (checked page by page).
  for (const sec of detectSections(text)) {
    if (out.some((r) => r.type === "include_topics" && (r.quote ?? "").includes(sec.quote.slice(0, 20)))) continue;
    out.push({ type: "include_topics", text: `要呈現這些部分（每個部分有自己的${opts.kind === "deck" || !opts.kind ? "頁面" : "段落"}）：${sec.items.join("、")}`, params: { topics: sec.items.map((name) => ({ name })), sections: true }, quote: sec.quote });
  }
  // 「清楚區分已知事實、合理推論與待驗證構想」: judged on the whole artifact.
  const dist = detectDistinction(text);
  if (dist) out.push({ type: "other", text: `清楚區分${dist.items.map((x) => `「${x}」`).join("、")}：每個重點都看得出屬於哪一類（例如用標籤或分欄標明），不把推論或構想寫成已知事實`, quote: dist.quote });
  // 「我已經有一個 deep research 的結果，幫我以此做成…」: the user's own material is the main source (material.ts).
  const mat = cl.filter((c) => MATERIAL_REF_RE.test(c));
  if (mat.length) out.push({ type: "other", text: "以你提供的資料為主要材料：結構、重點、名稱與數字都來自它（不改成線上搜尋或其他論文）", quote: mat.join(" ").slice(0, 200) });
  // 「〈台灣中文與台語語音語料蒐集〉 關於這個部分」: the subject the user named (judged: the artifact is about it).
  const subj = cl.filter((c) => SUBJECT_CLAUSE_RE.test(c.trim()));
  const named = subj.map((c) => /〈([^〉]+)〉|「([^」]+)」/.exec(c)).find((m) => m)?.slice(1).find(Boolean);
  if (subj.length && named) out.push({ type: "other", text: `主題是〈${named}〉`, quote: subj.join(" ").slice(0, 200) });
  if (PROFESSOR_RE.test(text) && !out.some((r) => r.type === "audience")) out.push({ type: "audience", text: "對象是教授：像向教授報告一樣，重點與證據清楚，能拿來討論與做決定", quote: clauseOf(text, PROFESSOR_RE) });
  const ex = detectExclude(text);
  if (ex) out.push({ type: "exclude", text: `刪掉：${[...(ex.pages ?? []).map((p) => `第 ${p} 頁`), ...(ex.terms ?? []).map((t) => `「${t.name}」`)].join("、")}`, params: ex, ...q(/刪掉|刪除|拿掉|去掉|移除|不要|remove|delete|drop/i) });
  return out;
}

const pageText = (p: NonNullable<Requirement["params"]>) => (p.exact ? `正好 ${p.exact} 頁` : p.min && p.max ? `${p.min}–${p.max} 頁` : p.min ? `至少 ${p.min} 頁` : `最多 ${p.max} 頁`);

// ---------------------------------------------------------------- sanitising model output

const str = (v: unknown, n = 200) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const terms = (v: unknown): RequirementTerm[] =>
  (Array.isArray(v) ? v : [])
    .map((t) => (typeof t === "string" ? { name: t } : t && typeof t === "object" ? { name: str((t as RequirementTerm).name, 80), aliases: (Array.isArray((t as RequirementTerm).aliases) ? (t as RequirementTerm).aliases! : []).map((a) => str(a, 80)).filter(Boolean).slice(0, 8) } : null))
    .filter((t): t is RequirementTerm => !!t && t.name.length >= 2)
    .slice(0, 12);

/** A requirement from the model or the plan card, with params cleaned for its type; null when unusable. */
export function cleanRequirement(raw: unknown, source: Requirement["source"], kind: ArtifactKind = "doc"): Omit<Requirement, "id"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { type?: string; text?: string; params?: Record<string, unknown> };
  let type = (REQUIREMENT_TYPES as string[]).includes(r.type ?? "") ? (r.type as RequirementType) : "other";
  const text = str(r.text, 300);
  const p = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
  const params: NonNullable<Requirement["params"]> = {};
  if (type === "language") {
    const l = p.language === "en" || p.language === "zh" ? p.language : detectLanguage(text) ?? (/english|英文/i.test(text) ? "en" : /中文|chinese/i.test(text) ? "zh" : null);
    if (!l) return text ? { type: "other", text, source } : null;
    params.language = l;
    if (p.part === "slides" || p.part === "notes") params.part = p.part;
    if (Array.isArray(p.allow)) params.allow = p.allow.map((a) => str(a, 80)).filter(Boolean).slice(0, 12);
  } else if (type === "page_count") {
    for (const k of ["exact", "min", "max"] as const) if (typeof p[k] === "number" && (p[k] as number) > 0 && (p[k] as number) <= 80) params[k] = Math.round(p[k] as number);
    if (!params.exact && !params.min && !params.max) Object.assign(params, detectPageCount(text) ?? (/(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text) ? { exact: +/(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text)![1]! } : {}));
    if (!params.exact && !params.min && !params.max) return text ? { type: "other", text, source } : null;
    if (kind !== "deck") type = "length";
  } else if (type === "include_topics") {
    params.topics = terms(p.topics);
    if (p.sections === true) params.sections = true;
    if (!params.topics.length) return text ? { type: "other", text, source } : null;
  } else if (type === "exclude") {
    params.terms = terms(p.terms);
    params.scope = p.scope === "content" ? "content" : "page";
    if (Array.isArray(p.pages)) params.pages = p.pages.filter((n): n is number => typeof n === "number" && n > 0).slice(0, 20);
    if (!params.terms.length && !params.pages?.length) return text ? { type: "other", text, source } : null;
  } else if (type === "per_item_fields") {
    // 「Pros/Cons」「優缺點」 are two fields (each checked on its own), not one literal heading.
    params.fields = terms(p.fields).flatMap((f) => {
      const parts = f.name.replace(/優缺點/g, "優點/缺點").split(/\s*(?:[/／、]|\band\b|&)\s*/i).filter((x) => x.length >= 2);
      return parts.length > 1 ? parts.map((x) => fieldTerm(x)) : [fieldTerm(f.name, f.aliases)];
    });
    params.items = (Array.isArray(p.items) ? p.items : []).map((x) => str(x, 80)).filter((x) => x.length >= 2).slice(0, 16);
    params.item_kind = str(p.item_kind, 20) || "項目";
    if (!params.fields.length) return text ? { type: "other", text, source } : null;
  }
  if (type === "tone" && (p.part === "notes" || p.part === "slides")) params.part = p.part;
  if (!text && type !== "language" && type !== "page_count") return null;
  return { type, text: text || (type === "language" ? `成果全部用${LANGUAGE_LABEL[params.language!]}` : pageText(params)), ...(Object.keys(params).length ? { params } : {}), source };
}

const keyOf = (r: Pick<Requirement, "type" | "text">) => `${r.type}:${normTerm(r.text)}`;
/** Only one of these per run: a newer statement replaces the older one. */
const SINGLE: RequirementType[] = ["language", "page_count", "audience", "tone", "length", "format"];

/**
 * Merges requirement sources in priority order (first wins for single-valued types; lists are unioned by text):
 * user edits → deterministic (request, guidance) → model extraction → recent chat → standing preferences.
 */
export function mergeRequirements(...lists: Omit<Requirement, "id">[][]): Requirement[] {
  const out: Omit<Requirement, "id">[] = [];
  // Language is per part (slides / notes): a newer statement about one part overrides only that part of an older one
  // (production e6d552fc: 「講稿要是中文的」 vs the deck's standing 「全部 English」 → notes 繁中, slides stay English).
  const claimed = new Set<LanguagePart>();
  for (const list of lists) {
    for (const r of list) {
      if (r.type === "language" && r.params?.language) {
        const parts: LanguagePart[] = r.params.part ? [r.params.part] : ["slides", "notes"];
        const left = parts.filter((x) => !claimed.has(x));
        if (!left.length) continue;
        left.forEach((x) => claimed.add(x));
        if (left.length === parts.length) out.push({ ...r, params: JSON.parse(JSON.stringify(r.params)) });
        else {
          const kept = r.text.match(/（沿用[^）]*）$/)?.[0] ?? "";
          out.push({ ...r, text: `${languageText(r.params.language, left[0])}${kept}`, params: { ...JSON.parse(JSON.stringify(r.params)), part: left[0] } });
        }
        continue;
      }
      if (r.type === "tone" && r.params?.part) {
        if (out.some((o) => o.type === "tone" && o.params?.part === r.params!.part)) continue;
        out.push({ ...r, params: { ...r.params } });
        continue;
      }
      if (SINGLE.includes(r.type) && out.some((o) => o.type === r.type && !o.params?.part)) continue;
      if (r.type === "per_item_fields") {
        const prev = out.find((o) => o.type === "per_item_fields");
        if (prev) {
          // Same item list: union the fields and items (the model may name the methods the request did not).
          const fields = [...(prev.params?.fields ?? [])];
          for (const f of r.params?.fields ?? []) if (!fields.some((x) => termHit(normTerm([x.name, ...(x.aliases ?? [])].join(" ")), f) || normTerm(x.name) === normTerm(f.name))) fields.push(f);
          prev.params = { ...prev.params, fields, items: [...new Set([...(prev.params?.items ?? []), ...(r.params?.items ?? [])])] };
          continue;
        }
      }
      if (out.some((o) => keyOf(o) === keyOf(r))) continue;
      out.push({ ...r, ...(r.params ? { params: JSON.parse(JSON.stringify(r.params)) } : {}) });
    }
  }
  return out.slice(0, 12).map((r, i) => ({ id: `r${i + 1}`, ...r }));
}

// ---------------------------------------------------------------- criteria + checks

/** Each requirement becomes a criterion: a deterministic check where one exists (some with a judged fallback), else judged. */
export function requirementCriteria(reqs: Requirement[], kind: ArtifactKind, allow: string[] = []): Omit<Criterion, "status">[] {
  // Notes and LaTeX are sections (`## ` is a heading there, not a slide).
  const doc = kind === "deck" ? {} : kind === "latex" ? { doc: true, latex: true } : { doc: true };
  return reqs.map((r) => {
    const id = `req_${r.id}`;
    const text = `你的要求：${r.text}`;
    const p = r.params ?? {};
    if (r.type === "language" && p.language) return { id, kind: "check", text, check: { id: "req_language", params: { language: p.language, allow: [...(p.allow ?? []), ...allow], ...(p.part && kind === "deck" ? { part: p.part } : {}), ...doc } } };
    if (r.type === "page_count" && kind === "deck") return { id, kind: "check", text, check: { id: "req_pages", params: { exact: p.exact, min: p.min, max: p.max } } };
    if (r.type === "include_topics" && p.topics?.length && p.sections) return { id, kind: "check", text, check: { id: "req_sections", params: { topics: p.topics, judge_fallback: true, ...doc } } };
    if (r.type === "include_topics" && p.topics?.length) return { id, kind: "check", text, check: { id: "req_include", params: { topics: p.topics, judge_fallback: true, ...doc } } };
    if (r.type === "exclude" && p.terms?.length) return { id, kind: "check", text, check: { id: "req_exclude", params: { terms: p.terms, scope: kind === "deck" ? p.scope ?? "page" : "content", ...doc } } };
    if (r.type === "per_item_fields" && p.fields?.length && p.items?.length) return { id, kind: "check", text, check: { id: "req_fields", params: { items: p.items, fields: p.fields, judge_fallback: true, ...doc } } };
    return { id, kind: "judge", text };
  });
}

const bigrams = (s: string) => {
  const t = normTerm(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};
/** A page / section title that names a listed part: contains it (or an alias), or ≥ 60 % of the part's bigrams. */
export function sectionTitleHit(title: string, t: RequirementTerm): boolean {
  const hay = normTerm(title);
  if (!hay) return false;
  if (termHit(hay, t)) return true;
  return [t.name, ...(t.aliases ?? [])].some((a) => {
    const g = bigrams(a);
    if (g.size < 2) return false;
    const h = bigrams(title);
    let n = 0;
    for (const x of g) if (h.has(x)) n++;
    return n / g.size >= 0.6;
  });
}

const fullOf = (text: string, data: unknown) => {
  const full = (data as { full?: unknown } | null)?.full;
  return typeof full === "string" && full.trim() ? full : text;
};
const tlist = (v: unknown) => terms(v);

/** Registered into CHECKS (they read the full artifact from `data.full` when the playbook provides it). */
const REQUIREMENT_CHECKS: typeof CHECKS = {
  /** A step that checked the requirements itself (`data.requirements.failed`: what still fails). */
  req_ok(_text, { data }) {
    const failed = (data as { requirements?: { failed?: unknown } } | null)?.requirements?.failed;
    const list = Array.isArray(failed) ? failed.filter((x): x is string => typeof x === "string") : [];
    return list.length ? { ok: false, detail: `你的要求還沒有全部達成：${list.slice(0, 4).join("；")}` } : { ok: true, detail: "你的要求都符合" };
  },
  req_language(text, { params, data }) {
    const lang = params.language === "zh" ? "zh" : "en";
    // LaTeX: comments are not visible (\% is a percent sign, not a comment).
    const src = params.latex ? fullOf(text, data).replace(/(?<!\\)%.*$/gm, "") : fullOf(text, data);
    const part = params.part === "slides" || params.part === "notes" ? params.part : undefined;
    const vs = languageViolations(src, lang, Array.isArray(params.allow) ? (params.allow as string[]) : [], !!params.doc, part);
    const what = part === "notes" ? "講稿" : part === "slides" ? "投影片" : "";
    if (!vs.length) return { ok: true, detail: `${what}全部是${LANGUAGE_LABEL[lang]}` };
    const slides = unitsOf(src, !!params.doc).slides;
    return { ok: false, detail: `語言要求（${what}${LANGUAGE_LABEL[lang]}）未達成，這些地方${lang === "en" ? "還有中文" : part === "notes" ? "主要是英文" : "整段是英文"}：${vs.slice(0, 10).map((v) => `${whereOf(v, slides)}：「${v.snippet}」`).join("；")}${vs.length > 10 ? `；另外還有 ${vs.length - 10} 處` : ""}。請改成${LANGUAGE_LABEL[lang]}（專有名詞與〈論文原標題〉可保留原文）。` };
  },
  req_pages(text, { params, data }) {
    const n = parseSlides(fullOf(text, data)).length;
    const ex = typeof params.exact === "number" ? params.exact : null;
    const min = typeof params.min === "number" ? params.min : null;
    const max = typeof params.max === "number" ? params.max : null;
    const ok = ex !== null ? n === ex : (min === null || n >= min) && (max === null || n <= max);
    return ok ? { ok: true, detail: `共 ${n} 頁` } : { ok: false, detail: `頁數要求（${pageText({ ...(ex ? { exact: ex } : {}), ...(min ? { min } : {}), ...(max ? { max } : {}) })}）未達成：實際 ${n} 頁。` };
  },
  req_include(text, { params, data }) {
    const { units } = unitsOf(fullOf(text, data), !!params.doc);
    const hay = normTerm(units.map((u) => `${u.title}\n${visibleText(u.body)}\n${u.notes}`).join("\n"));
    const missing = tlist(params.topics).filter((t) => !termHit(hay, t));
    return missing.length ? { ok: false, detail: `沒有找到這些要求涵蓋的主題：${missing.map((t) => `「${t.name}」`).join("、")}。` } : { ok: true, detail: "要求的主題都有涵蓋" };
  },
  /** Every listed part has its own page / section: a unit whose title names it (or ≥ 60 % of its character bigrams). */
  req_sections(text, { params, data }) {
    const { units, slides } = unitsOf(fullOf(text, data), !!params.doc);
    const missing = tlist(params.topics).filter((t) => !units.some((u) => sectionTitleHit(u.title, t)));
    return missing.length
      ? { ok: false, detail: `這些部分沒有自己的${slides ? "頁面" : "段落"}（標題要包含它的名稱）：${missing.map((t) => `「${t.name}」`).join("、")}。` }
      : { ok: true, detail: `每個要呈現的部分都有自己的${slides ? "頁面" : "段落"}` };
  },
  req_exclude(text, { params, data }) {
    const { units, slides } = unitsOf(fullOf(text, data), !!params.doc);
    const hits: string[] = [];
    for (const t of tlist(params.terms)) {
      for (const u of units) {
        const hay = normTerm(params.scope === "content" ? `${u.title}\n${visibleText(u.body)}` : u.title);
        if (termHit(hay, t)) hits.push(`${slides ? `第 ${u.page} 頁` : `第 ${u.page} 段`}「${u.title}」（${t.name}）`);
      }
    }
    return hits.length ? { ok: false, detail: `要求刪掉的內容還在：${hits.slice(0, 8).join("、")}。` } : { ok: true, detail: "要求刪掉的內容都已刪掉" };
  },
  req_fields(text, { params, data }) {
    const { units, slides } = unitsOf(fullOf(text, data), !!params.doc);
    const items = Array.isArray(params.items) ? (params.items as string[]) : [];
    const fields = tlist(params.fields);
    const problems: string[] = [];
    for (const item of items) {
      const own = units.filter((u) => normTerm(u.title).includes(normTerm(item)));
      if (!own.length) {
        problems.push(`找不到「${item}」的${slides ? "頁面" : "段落"}`);
        continue;
      }
      const hay = normTerm(own.map((u) => `${u.title}\n${visibleText(u.body)}`).join("\n"));
      const miss = fields.filter((f) => !termHit(hay, f));
      if (miss.length) problems.push(`「${item}」（${own.map((u) => `${slides ? "第" : "第"} ${u.page} ${slides ? "頁" : "段"}`).join("、")}）缺少：${miss.map((f) => f.name).join("、")}`);
    }
    return problems.length ? { ok: false, detail: `每項要有的內容不完整：${problems.slice(0, 8).join("；")}。` } : { ok: true, detail: "每一項都有要求的內容" };
  },
};
Object.assign(CHECKS, REQUIREMENT_CHECKS);

/** Deterministic requirement criteria of a run (the ones the guard and the targeted repair can re-check). */
export const checkedCriteria = (criteria: Pick<Criterion, "id" | "kind" | "check">[]) => criteria.filter((c) => c.id.startsWith("req_") && c.kind === "check" && c.check);

/** Results of the deterministic requirement checks on an artifact (id → ok/detail). */
export function requirementResults(criteria: Pick<Criterion, "id" | "kind" | "check">[], text: string, full?: string) {
  const list = checkedCriteria(criteria);
  const res = runChecks(list.map((c) => c.check!), text, { full: full ?? text });
  return list.map((c, i) => ({ id: c.id, ok: res[i]!.ok, detail: res[i]!.detail, check: c.check! }));
}

/** Requirements that passed on `before` and fail on `after` (a step regressed them). */
export function regressions(criteria: Pick<Criterion, "id" | "kind" | "check">[], before: string, after: string) {
  const a = requirementResults(criteria, before);
  const b = requirementResults(criteria, after);
  return b.filter((r) => !r.ok && a.find((x) => x.id === r.id)?.ok);
}

// ---------------------------------------------------------------- prompts

/** The block every sub-agent gets (env.ts): producers must follow it; verifiers treat a violation as high severity. */
export function requirementsBlock(reqs: Requirement[], audience: "producer" | "verifier"): string {
  if (!reqs.length) return "";
  const lines = reqs.map((r) => {
    const p = r.params ?? {};
    if (r.type === "language" && p.part === "notes") return p.language === "en" ? "- 講稿（::: {.notes}）語言：English。Write the speaker notes in English." : `- 講稿（::: {.notes}）語言：繁體中文（台灣用語）的口語句子${/專有名詞/.test(r.text) ? "，專有名詞與技術術語用英文（例如 RNN-T、contextual biasing、beam search）" : "，專有名詞保留英文"}。投影片本體的語言照另一條要求，不要改。`;
    if (r.type === "language" && p.part === "slides") return p.language === "en" ? "- 投影片本體（封面、頁面標題、條列、表格、圖表與流程圖標籤、圖說）語言：English，不要有中文字或全形標點；講稿的語言照另一條要求。" : "- 投影片本體語言：繁體中文（台灣用語），專有名詞保留英文；講稿的語言照另一條要求。";
    if (r.type === "language" && p.language === "en") return "- 成果語言：English。讀者看得到的所有文字（封面與文件標題、副標題、頁面／段落標題、條列、表格、圖表與流程圖的標籤、圖說、講稿、標註）一律用英文；專有名詞與〈論文原標題〉照原文。不要輸出任何中文字或全形標點。Write every visible word of the output in English.";
    if (r.type === "language") return "- 成果語言：繁體中文（台灣用語），專有名詞保留英文。";
    if (r.type === "page_count") return `- 頁數：${pageText(p)}。`;
    if (r.type === "include_topics" && p.sections) return `- 要呈現這幾個部分，每個部分至少一${(r.text.includes("段落") ? "個段落" : "頁")}，標題包含該部分的名稱：${(p.topics ?? []).map((t) => `「${t.name}」`).join("、")}。`;
    if (r.type === "include_topics") return `- 一定要涵蓋：${(p.topics ?? []).map((t) => t.name).join("、")}（${r.text}）。`;
    if (r.type === "exclude") return `- 要刪掉／不要出現：${[...(p.pages ?? []).map((n) => `原本第 ${n} 頁`), ...(p.terms ?? []).map((t) => `「${t.name}」`)].join("、") || r.text}。`;
    if (r.type === "per_item_fields") return `- 每個${p.item_kind ?? "項目"}${p.items?.length ? `（${p.items.join("、")}）` : ""}都要有，而且用清楚的小標或欄位標出：${(p.fields ?? []).map((f) => f.name).join("、")}。`;
    return `- ${r.text}`;
  });
  const head = audience === "producer"
    ? "使用者對成果的明確要求（你的產出必須遵守；這些要求優先於其他預設規則，包括預設用繁體中文；任何步驟都不能違反或改回去）："
    : "使用者對成果的明確要求（成果違反任何一條都是 high 問題；你自己的回覆照常用繁體中文）：";
  return `${head}\n${lines.join("\n")}`;
}

/** The target language of the run's artifact, when the user set one. */
export const targetLanguage = (reqs: Requirement[] | undefined): "en" | "zh" | null => (reqs ?? []).find((r) => r.type === "language" && r.params?.part !== "notes")?.params?.language ?? null;
/** The speaker notes' language (a notes-only requirement, else the artifact's). */
export const notesLanguage = (reqs: Requirement[] | undefined): "en" | "zh" | null => (reqs ?? []).find((r) => r.type === "language" && r.params?.part === "notes")?.params?.language ?? targetLanguage(reqs);

// ---------------------------------------------------------------- built-in labels in the artifact's language

export type Labels = { aiFilled: string; aiFilledNote: string; skipped: string; skippedNote: string; ownNote: string; myView: string; laterOwn: string; paperReport: string; abstractOnly: string; partialBanner: (unmet: string[]) => string; aiDraftBanner: string };
const LABELS: Record<"en" | "zh", Labels> = {
  zh: {
    aiFilled: "AI 代填，待你確認",
    aiFilledNote: "（AI 代填，待你確認：自動駕駛依研究資料草擬的建議，不是報告者確認過的看法；報告前請確認或改寫成自己的想法。）",
    skipped: "〔　這頁留給你自己寫：之後補上你的想法　〕",
    skippedNote: "（由報告者補充）",
    ownNote: "（報告者自己的看法，依報告者在工作流程中確認的回答整理）",
    myView: "我的想法",
    laterOwn: "（之後自己補上）",
    paperReport: "Paper report",
    abstractOnly: "Paper report（僅依摘要，沒有全文 PDF）",
    partialBanner: (unmet) => `> 這份筆記由工作流程產生，**尚未通過**這些驗收標準：${unmet.join("；")}`,
    aiDraftBanner: "以下是 AI 依研究資料草擬的建議，不是你確認過的看法。",
  },
  en: {
    aiFilled: "AI draft, please confirm",
    aiFilledNote: "(AI draft, please confirm: autopilot drafted this from the study data; it is not the presenter's confirmed view. Confirm or rewrite it before presenting.)",
    skipped: "[ Left for you to write: add your own thoughts here ]",
    skippedNote: "(To be added by the presenter.)",
    ownNote: "(The presenter's own view, summarised from the answers they confirmed in the workflow.)",
    myView: "My view",
    laterOwn: "(To be added later.)",
    paperReport: "Paper report",
    abstractOnly: "Paper report (abstract only, no full-text PDF)",
    partialBanner: (unmet) => `> This note was produced by a workflow and has **not yet passed** these checks: ${unmet.join("; ")}`,
    aiDraftBanner: "The following is an AI draft based on the study data, not your confirmed view.",
  },
};
/**
 * Built-in labels (AI-filled mark + note, skipped placeholder, 「由報告者補充」…) of one language replaced by the other's:
 * an existing deck's student pages carry them verbatim, and writers told to "keep everything but the language" copy them.
 */
export function localizeLabels(text: string, lang: "en" | "zh" | null | undefined): string {
  if (!lang) return text;
  const to = LABELS[lang];
  const from = LABELS[lang === "en" ? "zh" : "en"];
  let out = text;
  for (const k of ["aiFilledNote", "skipped", "skippedNote", "ownNote", "aiDraftBanner", "aiFilled", "myView", "laterOwn", "abstractOnly"] as const) out = out.split(from[k]).join(to[k]);
  // Older / hand-written variants: the AI-filled note with other wording, an empty 〔　〕 placeholder.
  if (lang === "en") out = out.replace(/（AI 代填，待你確認[：:][^）\n]*）/g, to.aiFilledNote).replace(/〔\s*　*\s*〕/g, "[ ]");
  return out;
}

export const labelsFor = (lang: "en" | "zh" | null | undefined): Labels => LABELS[lang === "en" ? "en" : "zh"];
export const runLabels = (env: Pick<WorkflowEnv, "run">) => labelsFor(targetLanguage(env.run.state?.requirements as Requirement[] | undefined));

// ---------------------------------------------------------------- plan time

type Ctx = { request: string; guidance: string[]; recent: string[]; standing: Omit<Requirement, "id">[]; kind: ArtifactKind; pages?: unknown; userWords?: string[]; clauses?: string[] };

/** The 「要我修這幾項嗎？」 button's guidance (請修正這幾項：…): a fix request for the listed items, not new requirements. */
export const FIX_REQUEST_RE = /^\s*(?:請修正這幾項|please fix these items|重新規劃)[:：]/i;

const FILLER_RE = /我要你|我想要你|我想要|我希望|我要|我想|請你|麻煩你|幫我|幫忙|有個東西|東西|那請你|那你|一下|一個|一份|一篇|一張|這個|這份|那個|寫成|做成|整理成|改成|做|改|弄|寫|你|的|了|吧|呢|啊|喔|哦|嗎|那|也|就|好|先|再|然後/g;
const DELIVERABLE_WORDS_RE = /簡報|投影片|報告|筆記|文件|論文|latex|deck|slides?|presentation|note|paper/gi;
/** A clause that only states the deliverable or is filler (「我要你幫我做一個簡報」「有個東西」): nothing to verify. */
export const trivialClause = (c: string) => {
  const rest = c.replace(DELIVERABLE_WORDS_RE, "").replace(FILLER_RE, "").replace(/[\s\p{P}\p{S}]/gu, "");
  // The task statement itself (「寫一份熱詞方法比較筆記」): the deliverable + a short subject, judged by the coverage criterion.
  return rest.length < 3 || (/簡報|投影片|報告|筆記|文件|論文|latex|deck|slides?|presentation|note|paper/i.test(c) && rest.length < 12);
};

const normClause = (t: string) => t.toLowerCase().replace(/[\s，,。.、；;：:「」『』（）()"'`*！!？?]/g, "");
/** Does a requirement's quote account for this clause (it contains it, or the clause contains the quote)? */
const quoteCovers = (quote: string | undefined, clause: string) => {
  if (!quote) return false;
  const q = normClause(quote);
  const c = normClause(clause);
  return q.length >= 2 && c.length >= 2 && (q.includes(c) || c.includes(q));
};

/**
 * Coverage of the user's words (pure, unit-tested): every content clause maps to a requirement (deterministic or the
 * model's, by its clause numbers or quote), is dropped by the model with a reason, or is trivial; the rest become judged
 * requirements in the user's own words (「照你說的：「…」」), so no ask is silently lost (production 0668a3d7: 1 of 6).
 */
export function uncoveredClauses(clauses: string[], reqs: Pick<Requirement, "quote">[], mapped: Set<number>, dropped: Set<number>, kind: ArtifactKind): string[] {
  // One content clause is the task itself (the deliverable + its subject): nothing more to account for.
  if (clauses.filter((c) => !trivialClause(c)).length <= 1) return [];
  return clauses.filter((c, i) => !mapped.has(i) && !dropped.has(i) && !trivialClause(c) && !detectRequirements(c, { kind }).length && !reqs.some((r) => quoteCovers(r.quote, c)));
}
const clipQuote = (c: string) => (c.length > 80 ? `${c.slice(0, 79)}…` : c);
export const clauseRequirement = (c: string): Omit<Requirement, "id"> => ({ type: "other", text: `照你說的：「${clipQuote(c)}」`, quote: c.slice(0, 200), source: "request" });

/**
 * The user's own words when the run's request was written by the assistant (a start_workflow call from a chat turn), else
 * null (the request is the user's: 「交給 Agent」, the API, a plan-card edit). The user's latest turns, newest first, + guidance.
 */
export function ownWords(env: Pick<WorkflowEnv, "run">, recent: string[], guidance: string[]): string[] | null {
  if (!env.run.tool_call_id || !recent.length) return null;
  const head = env.run.request.replace(/\s+/g, " ").slice(0, 60);
  if (recent.some((t) => t.replace(/\s+/g, " ").includes(head))) return null;
  return [...recent.slice(-3).reverse(), ...guidance];
}

const EXTRACT_SYSTEM = [
  "你從使用者的話裡整理出他對這次成果的「明確要求」，讓後續每一步都遵守、最後逐條驗收。只輸出 JSON。",
  "使用者的話常是語音輸入、沒有標點的長句，裡面通常有好幾個要求。下面會把它切成編號的子句（clauses）：每一個子句都要處理——列成要求（clauses 填它的編號；一個要求可以涵蓋多個子句），或放進 dropped 並寫原因（例如：只是在說要做簡報、寒暄、和成果無關）。不要漏掉任何子句。",
  "同一種「每個方法／每篇論文都要…」的欄位（優缺點、架構圖、出處論文、會議或期刊…）合成一個 per_item_fields；主題或聚焦範圍（例如在某些模型架構下）是 include_topics；要用哪些來源、要統計或列出什麼（例如參考文獻庫、統計有哪幾種方法）寫成 other。",
  "只收使用者明確說出的要求（這次的要求、補充指示、最近幾輪對話中關於這份成果的要求）；不要加入一般性的品質期望，也不要替使用者決定研究方向或時程。",
  "type：language（成果語言；只在明確要求時）、page_count（明確的頁數或範圍）、include_topics（一定要涵蓋的主題，topics 每個附 aliases：中英文說法與縮寫）、exclude（要刪掉的頁面或內容，terms 附 aliases；刪頁面 scope=page）、per_item_fields（每個方法／模型要有的欄位，fields 附 aliases；使用者有列出項目時填 items）、audience（對象）、tone（語氣）、length（篇幅）、format（成果形式，例如 LaTeX、表格）、other。",
  "text 用繁體中文寫一句可以驗收的要求。quote 逐字複製使用者說出這個要求的原話（找不到原話就不要列）。主題、欄位、要刪的內容只能用使用者自己提到的詞（可以補上同義的中英文 aliases），不要自己細分出使用者沒說的欄位或主題。沒有要求就回 {\"requirements\":[]}。",
  '格式：{"requirements":[{"type":"include_topics","text":"聚焦在動態熱詞（dynamic hotwording）","quote":"我想要 focus 在動態熱詞","clauses":[2],"params":{"topics":[{"name":"dynamic hotwording","aliases":["動態熱詞","contextual biasing"]}]}}],"dropped":[{"clause":1,"reason":"只是在說要做簡報"}]}',
].join("\n");

/** Recent user turns of the conversation that started the run (before it was created), newest last. */
async function recentTurns(env: WorkflowEnv): Promise<string[]> {
  if (!env.run.conversation_id) return [];
  const rows = (await env.db.query<{ text: string }>(
    "SELECT text FROM agent_messages WHERE conversation_id=$1 AND role='user' AND created_at <= $2 ORDER BY seq DESC LIMIT 6",
    [env.run.conversation_id, env.run.created_at],
  ).catch(() => ({ rows: [] as { text: string }[] }))).rows;
  return rows.map((r) => (r.text ?? "").replace(/^（交給 Agent）/, "").slice(0, 1200)).filter(Boolean).reverse();
}

type PrefRow = { agent_prefs: { requirements?: Omit<Requirement, "id">[] } | null; content?: string | null; title?: string };

/** The target artifact's standing preferences (persisted by an earlier run, else inferred: an English deck stays English). */
export async function standingOf(env: WorkflowEnv): Promise<{ list: Omit<Requirement, "id">[]; artifact: string | null }> {
  const i = env.run.inputs as Record<string, unknown>;
  const q = async (sql: string, id: unknown): Promise<PrefRow | null> => (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? (await env.db.query<PrefRow>(sql, [id]).catch(() => ({ rows: [] as PrefRow[] }))).rows[0] ?? null : null);
  let row: PrefRow | null = null;
  let artifact: string | null = null;
  if (i.deck_id) {
    row = await q(
      `SELECT d.agent_prefs, d.title, coalesce((SELECT state->'deck'->>'body' FROM workflow_runs w WHERE w.playbook='slides' AND w.artifacts @> jsonb_build_array(jsonb_build_object('kind','deck','id',d.id::text)) ORDER BY w.updated_at DESC LIMIT 1),
              (SELECT s.content FROM deck_sources s JOIN deck_source_trees t ON t.deck_id=s.deck_id AND s.path=t.entry WHERE s.deck_id=d.id)) AS content
         FROM decks d WHERE d.id=$1`, i.deck_id);
    artifact = "這份簡報";
  } else if (Array.isArray(i.note_ids) && i.note_ids.length) {
    row = await q("SELECT agent_prefs, title, content_md AS content FROM notes WHERE id=$1", i.note_ids[0]);
    artifact = "這份筆記";
  } else if (i.project_id) {
    row = await q("SELECT agent_prefs, title, NULL::text AS content FROM latex_projects WHERE id=$1", i.project_id);
    artifact = "這個 LaTeX 專案";
  }
  if (!row) return { list: [], artifact: null };
  const saved = (row.agent_prefs?.requirements ?? []).map((r) => cleanRequirement(r, "standing")).filter((r): r is Omit<Requirement, "id"> => !!r && STANDING_TYPES.includes(r.type));
  if (!saved.some((r) => r.type === "language") && row.content && inferLanguage(row.content) === "en") {
    saved.push({ type: "language", text: `成果全部用 English（沿用：${artifact}目前是英文）`, params: { language: "en" }, source: "standing" });
  }
  return { list: saved.map((r) => ({ ...r, text: r.text.startsWith("沿用") || r.text.includes("沿用") ? r.text : `${r.text}（沿用${artifact}的設定）` })), artifact };
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Plan time: the run's requirements (`state.requirements`). Deterministic detection on the request and guidance always
 * runs; one model call (`purpose requirements`) adds topics / per-item fields / audience…; the conversation's recent turns
 * and the artifact's standing preferences fill what the request did not say. Recomputed only when the request, the
 * guidance or the standing preferences changed; the user's own edits on the plan card are kept, removed ones stay removed.
 */
export async function prepareRequirements(env: WorkflowEnv, playbook: string, briefArg?: Brief | null): Promise<Requirement[]> {
  const kind = artifactKindOf(playbook);
  const brief = briefArg ?? env.run.brief ?? null;
  // The user's guidance only (the autopilot's own 繼續改 lines are not the user's words).
  // A 「請修正這幾項」 click is a fix request for listed items, not new requirements.
  const guidance = (brief ? userGuidance(env.run) : (env.run.guidance ?? []).map((g) => g.text)).filter((g) => !FIX_REQUEST_RE.test(g));
  const standing = await standingOf(env);
  // With a Brief its `user_words` are the conversation turns that asked; older runs read the recent turns themselves.
  const recent = brief ? [] : await recentTurns(env);
  // The request of a run the assistant started is ITS paraphrase (production: it added 「所有內容使用繁體中文」 and pages: 12
  // that the user never said): requirements come from the user's own words only, never from the paraphrase.
  const legacyOwn = brief ? null : ownWords(env, recent, guidance);
  const start: string[] = brief ? baseWords(brief) : legacyOwn ? legacyOwn.slice(0, legacyOwn.length - guidance.length) : [env.run.request];
  const paraphrase = brief ? !!brief.paraphrase : legacyOwn !== null;
  const key = hashOf(JSON.stringify([start, guidance, standing.list, kind]));
  const prev = env.state<Requirement[]>("requirements");
  if (prev && env.state<string>("requirements_key") === key) return prev;
  const startText = start.join("\n");
  const inputPages = (env.run.inputs as { pages?: unknown }).pages;
  // An assistant-given page count counts only when the user's words have one.
  const pages = paraphrase && !detectPageCount(startText) ? undefined : inputPages;
  // Every clause of the user's own words must be accounted for (segmentClauses → the model maps or drops each one).
  // (Not for a goal's stage: its words describe the whole goal, the stage delivers only a part of it.)
  const clauses = brief && !env.run.goal_id ? [...start, ...guidance].flatMap(segmentClauses).slice(0, 40) : [];
  const ctx: Ctx = { request: startText, guidance, recent, standing: standing.list, kind, pages, userWords: [...start, ...guidance], clauses };
  const det = [
    ...start.flatMap((t) => detectRequirements(t, { pages, kind })).map((r) => ({ ...r, source: "request" as const })),
    ...guidance.flatMap((g) => detectRequirements(g, { kind }).map((r) => ({ ...r, source: "guidance" as const }))),
  ];
  // Guidance is newer than the request: its single-valued statements win.
  det.sort((a, b) => (a.source === b.source ? 0 : a.source === "guidance" ? -1 : 1));
  const fromChat = recent.slice(0, -1).reverse().flatMap((t) => detectRequirements(t, { kind }).filter((r) => r.type === "language").map((r) => ({ ...r, source: "conversation" as const })));
  const extracted = await extractWithModel(env, ctx).catch(() => ({ list: [] as Omit<Requirement, "id">[], mapped: new Set<number>(), dropped: [] as { clause: string; reason: string }[] }));
  // A judged item the model restated from words a deterministic requirement already quotes (「講稿要能一字一句照念」 next to
  // the read-aloud tone) is a duplicate on the card and in the verdict: dropped.
  const llm = extracted.list.filter((r) => !(["other", "tone", "format", "audience", "include_topics"].includes(r.type) && r.quote && det.some((d) => d.quote && normClause(d.quote).includes(normClause(r.quote!)))));
  // Coverage: a content clause no requirement accounts for (and the model did not drop with a reason) becomes a judged
  // requirement in the user's words — a cheap model's miss can no longer lose an ask.
  const droppedIdx = new Set(extracted.dropped.map((d) => clauses.indexOf(d.clause)).filter((i) => i >= 0));
  const fromClauses = uncoveredClauses(clauses, [...det, ...llm], extracted.mapped, droppedIdx, kind).slice(0, 6).map(clauseRequirement);
  await env.setState({ requirements_dropped: extracted.dropped.slice(0, 12) });
  const removed = new Set(env.state<string[]>("requirements_removed") ?? []);
  const userEdits = (prev ?? []).filter((r) => r.source === "user").map(({ id: _id, ...r }) => r);
  // Last resort for the language (after the artifact's own): the user wrote the request in English → English.
  const fromMessage = messageLanguage(start);
  const merged = mergeRequirements(userEdits, det, llm, fromClauses, fromChat, standing.list, fromMessage).filter((r) => !removed.has(keyOf(r)));
  const reqs = merged.map((r, i) => ({ ...r, id: `r${i + 1}` }));
  await env.setState({ requirements: reqs, requirements_key: key });
  return reqs;
}

/**
 * The language of the user's own message when they set none (and the artifact has none): an English request (≥ 5 English
 * words, no Chinese) → English. A Chinese message sets nothing: 繁體中文 is the default anyway (「語言：未指定」).
 */
export function messageLanguage(words: string[]): Omit<Requirement, "id">[] {
  const text = words.join("\n").replace(/https?:\/\/\S+/g, " ").replace(/```[\s\S]*?```/g, " ");
  if ((text.match(HAN_G) ?? []).length || latinWords(text) < 5) return [];
  const quote = words.findLast((w) => latinWords(w) >= 3)?.replace(/\s+/g, " ").trim().slice(0, 80);
  return [{ type: "language", text: "成果用 English（你用英文提出這個要求）", params: { language: "en", inferred: true }, source: "request", ...(quote ? { quote } : {}) }];
}

const WRAPPER_REASON_RE = /標示為資料|是資料|資料區塊|不是指令|非指令|依指示忽略|一律忽略|data block|marked as data|not an? instruction|prompt injection/i;

async function extractWithModel(env: WorkflowEnv, ctx: Ctx): Promise<{ list: Omit<Requirement, "id">[]; mapped: Set<number>; dropped: { clause: string; reason: string }[] }> {
  const clauses = ctx.clauses ?? [];
  const user = [
    `成果類型：${ctx.kind === "deck" ? "簡報" : ctx.kind === "latex" ? "LaTeX 論文" : "筆記／文件"}`,
    wordsBlock("request", ctx.request.slice(0, 4000)),
    ctx.guidance.length ? wordsBlock("guidance", ctx.guidance.join("\n").slice(0, 3000)) : "",
    clauses.length ? wordsBlock("clauses", clauses.map((c, i) => `${i + 1}. ${c}`).join("\n")) : "",
    ctx.recent.length ? wordsBlock("recent_turns", ctx.recent.map((t) => `- ${t}`).join("\n").slice(0, 5000)) : "",
    ctx.standing.length ? `這份成果先前確認過的設定（沒有被這次的要求推翻就沿用，不必重複列出）：${ctx.standing.map((s) => s.text).join("；")}` : "",
  ].filter(Boolean).join("\n\n");
  // One call, no retry: the deterministic detection already covers language, page count, per-item fields and removals,
  // and the clause coverage below turns whatever this call misses into judged requirements.
  const res = await env.call({ purpose: "requirements", role: "planner", messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: user }], maxTokens: 3000 });
  const v = parseJson<{ requirements?: unknown[]; dropped?: unknown[] }>(res.text);
  const list = Array.isArray(v?.requirements) ? v!.requirements : [];
  // Grounding: the user's own words (not the assistant's paraphrase) when the request is a paraphrase.
  const words = (ctx.userWords ?? [ctx.request, ...ctx.guidance, ...ctx.recent]).join("\n");
  const idxOf = (raw: unknown) => (Array.isArray((raw as { clauses?: unknown })?.clauses) ? ((raw as { clauses: unknown[] }).clauses) : []).map((n) => (typeof n === "number" ? n - 1 : -1)).filter((n) => n >= 0 && n < clauses.length);
  const mapped = new Set<number>();
  // The model may not change what the user's words settle deterministically (language / page count come from the text).
  const out = list
    .map((r) => {
      const idx = idxOf(r);
      // A requirement on numbered clauses quotes them (verbatim by construction); otherwise its own quote must be the user's.
      const quote = idx.length ? idx.map((i) => clauses[i]).join(" ") : str((r as { quote?: unknown }).quote, 200);
      if (!idx.length && !groundedInWords(r, words)) return null;
      const c = cleanRequirement(r, "request", ctx.kind);
      // Only a kept item accounts for its clauses (a language / page item the model may not set leaves them to detection).
      if (!c || c.type === "language" || c.type === "page_count") return null;
      idx.forEach((i) => mapped.add(i));
      return { ...c, quote: quote.slice(0, 300) } as Omit<Requirement, "id">;
    })
    .filter((r): r is Omit<Requirement, "id"> => !!r)
    .map((r) => anchorTerms(r, words));
  const dropped = (Array.isArray(v?.dropped) ? v!.dropped : [])
    .map((d) => ({ n: typeof (d as { clause?: unknown })?.clause === "number" ? ((d as { clause: number }).clause - 1) : -1, reason: str((d as { reason?: unknown })?.reason, 120) }))
    // A clause set aside for being 「in a data block / not an instruction」 is the user's ask all the same: not a reason.
    .filter((d) => d.n >= 0 && d.n < clauses.length && d.reason && !mapped.has(d.n) && !WRAPPER_REASON_RE.test(d.reason))
    .map((d) => ({ clause: clauses[d.n]!, reason: d.reason }));
  return { list: out, mapped, dropped };
}

const squash = (t: string) => t.toLowerCase().replace(/[\s，,。.、；;：:「」『』（）()"'`*]/g, "");

/** A model-extracted requirement must quote the user's own words (production: it invented per-page field labels). */
export function groundedInWords(raw: unknown, words: string): boolean {
  const q = raw && typeof raw === "object" ? (raw as { quote?: unknown }).quote : undefined;
  if (typeof q !== "string" || !q.trim()) return false;
  const quote = squash(q);
  return quote.length >= 2 && squash(words).includes(quote.slice(0, 60));
}

/**
 * Hard (deterministic) types keep only the terms the user actually said (name or an alias in their words); when none
 * remain the requirement becomes a judged one (`other`), so an over-specific breakdown can never fail a run on its own.
 */
export function anchorTerms(r: Omit<Requirement, "id">, words: string): Omit<Requirement, "id"> {
  const said = (t: RequirementTerm) => [t.name, ...(t.aliases ?? [])].some((x) => x && squash(words).includes(squash(x)));
  const keep = (list?: RequirementTerm[]) => (list ?? []).filter(said);
  const p = r.params ?? {};
  if (r.type === "include_topics") {
    const topics = keep(p.topics);
    return topics.length ? { ...r, params: { ...p, topics } } : { type: "other", text: r.text, source: r.source, ...(r.quote ? { quote: r.quote } : {}) };
  }
  if (r.type === "per_item_fields") {
    const fields = keep(p.fields);
    return fields.length ? { ...r, params: { ...p, fields } } : { type: "other", text: r.text, source: r.source, ...(r.quote ? { quote: r.quote } : {}) };
  }
  if (r.type === "exclude" && !p.pages?.length) {
    const t = keep(p.terms);
    return t.length ? { ...r, params: { ...p, terms: t } } : { type: "other", text: r.text, source: r.source, ...(r.quote ? { quote: r.quote } : {}) };
  }
  return r;
}

/** Requirements edited on the plan card: typed from their text when the type is unknown or the text changed. */
export function editedRequirements(prev: Requirement[], edits: { id?: string; type?: string; text: string; params?: Record<string, unknown> }[], kind: ArtifactKind): { list: Requirement[]; removed: string[] } {
  const list: Omit<Requirement, "id">[] = [];
  for (const e of edits.slice(0, 12)) {
    const text = e.text.trim().slice(0, 300);
    if (!text) continue;
    const old = e.id ? prev.find((p) => p.id === e.id) : undefined;
    if (old && old.text === text) {
      list.push({ type: old.type, text: old.text, ...(old.params ? { params: old.params } : {}), source: old.source });
      continue;
    }
    // New or reworded: detect the type from the words (「全部英文」 → language), else keep the given / old type.
    const det = detectRequirements(text, { kind })[0];
    const cleaned = det ? { ...det, text, source: "user" as const } : cleanRequirement({ type: e.type ?? old?.type ?? "other", text, params: e.params ?? (old?.type === (e.type ?? old?.type) ? old?.params : undefined) }, "user", kind);
    if (cleaned) list.push(cleaned);
  }
  const kept = new Set(list.map(keyOf));
  const removed = prev.filter((p) => !kept.has(keyOf(p)) && !edits.some((e) => e.id === p.id)).map(keyOf);
  return { list: mergeRequirements(list), removed };
}

/** Criteria with the requirement criteria replaced (approval edits, re-plans). */
export const withRequirementCriteria = <C extends Omit<Criterion, "status">>(criteria: C[], reqs: Requirement[], kind: ArtifactKind, status?: Criterion["status"], allow: string[] = []): C[] => [
  ...criteria.filter((c) => !c.id.startsWith("req_")),
  ...(requirementCriteria(reqs, kind, allow).map((c) => (status ? { ...c, status } : c)) as C[]),
];

/**
 * A note's fixed section headings (the playbook's `state.sections`, 參考文獻…): the language check lets them pass and
 * the commit puts them in the note's language (`localizeHeadings`), so they never force a content rewrite.
 */
export const fixedHeadings = (env: Pick<WorkflowEnv, "run">): string[] => {
  const sections = env.run.state?.sections;
  return [...(Array.isArray(sections) ? sections.filter((x): x is string => typeof x === "string") : []), "參考文獻", "搜尋紀錄", "我的想法", "論文題目", "主要貢獻", "章節規劃"].filter((x) => hasCjk(x));
};

/**
 * A title in the run's target language: an English artifact whose base title (deck name, paper title, 「閱讀筆記：…」) has
 * Chinese gets it translated once (`purpose title_translate`, cached in `state.front_titles`); a reply that still has CJK
 * is asked once more, then the Latin part (or `fallback`) is used.
 */
export async function translateTitle(env: WorkflowEnv, base: string, fallback = "Untitled"): Promise<string> {
  if (targetLanguage(env.requirements()) !== "en" || !cjkCount(base)) return base;
  const cache = env.state<Record<string, string>>("front_titles") ?? {};
  if (cache[base]) return cache[base]!;
  let title = "";
  for (let i = 0; i < 2 && (!title || cjkCount(title)); i++) {
    const res = await env.call({
      purpose: "title_translate", role: "writer",
      messages: [
        { role: "system", content: "You translate titles of academic presentations and notes into concise academic English. Output only the title, one line, no quotes, no Chinese characters." },
        { role: "user", content: `${dataBlock("title", base)}${i ? "\n\nThe previous answer still contained Chinese characters. Output English only." : ""}` },
      ],
      maxTokens: 400,
    });
    title = res.text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^["'「『]|["'」』]$/g, "").slice(0, 150) ?? "";
  }
  if (!title || cjkCount(title)) title = base.replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[-–—:|\s]+|[-–—:|\s]+$/g, "") || fallback;
  await env.setState({ front_titles: { ...(env.state<Record<string, string>>("front_titles") ?? {}), [base]: title } });
  return title;
}

/** The fixed Chinese section headings of an English note, translated (one call, cached in `state.heading_map`). */
export async function localizeHeadings(env: WorkflowEnv, doc: string): Promise<string> {
  if (targetLanguage(env.requirements()) !== "en") return doc;
  const fixed = fixedHeadings(env).filter((h) => new RegExp(`^#{1,6}\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(doc));
  if (!fixed.length) return doc;
  const map = { ...(env.state<Record<string, string>>("heading_map") ?? {}) };
  const todo = fixed.filter((h) => !map[h]);
  if (todo.length) {
    const res = await env.call({ purpose: "title_translate", role: "writer", messages: [{ role: "system", content: "Translate each heading into concise English. Output only JSON: {\"<original>\": \"<English>\"}." }, { role: "user", content: JSON.stringify(todo) }], maxTokens: 800 }).catch(() => null);
    const got = parseJson<Record<string, unknown>>(res?.text ?? "") ?? {};
    for (const h of todo) {
      const v = typeof got[h] === "string" ? (got[h] as string).trim() : "";
      if (v && !cjkCount(v)) map[h] = v.slice(0, 120);
    }
    await env.setState({ heading_map: map });
  }
  return doc.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (line, hashes: string, h: string) => (map[h] ? `${hashes} ${map[h]}` : line));
}

// ---------------------------------------------------------------- targeted repair + standing preferences

/**
 * Generic final repair of failing requirement criteria (playbooks without their own handling, e.g. notes): every task step
 * whose own output fails the check is reopened with the check's detail; judged ones go to the writers (≤ 5).
 */
export function requirementRepair(failing: Criterion[], steps: StepRow[]): { key: string; issues: string[] }[] {
  const out = new Map<string, string[]>();
  const writers = steps.filter((s) => s.kind === "task" && (s.role === "writer" || s.role === "integrator") && s.output?.text);
  for (const c of failing) {
    if (!c.id.startsWith("req_")) continue;
    const issue = `${c.text}：${c.reason ?? "未達成"}`;
    let hit = false;
    if (c.kind === "check" && c.check) {
      for (const s of writers) {
        const [r] = runChecks([{ id: c.check.id, params: { ...(c.check.params ?? {}), judge_fallback: false } }], s.output!.text!, null);
        if (r && !r.ok) {
          out.set(s.key, [...(out.get(s.key) ?? []), `${c.text}：${r.detail}`]);
          hit = true;
        }
      }
    }
    if (!hit && writers.length <= 5) for (const s of writers) out.set(s.key, [...(out.get(s.key) ?? []), issue]);
  }
  return [...out.entries()].map(([key, issues]) => ({ key, issues }));
}

/** Persists the run's standing requirements on the artifacts it wrote (decks, notes, LaTeX projects): later edits inherit them. */
export async function persistStanding(env: WorkflowEnv) {
  const reqs = (env.run.state?.requirements as Requirement[] | undefined) ?? [];
  const standing = reqs.filter((r) => STANDING_TYPES.includes(r.type)).map(({ id: _id, ...r }) => ({ ...r, text: r.text.replace(/（沿用[^）]*）$/, ""), source: "standing" }));
  const prefs = JSON.stringify({ requirements: standing, run_id: env.run.id, updated_at: new Date().toISOString() });
  for (const a of env.run.artifacts ?? []) {
    const table = a.kind === "deck" ? "decks" : a.kind === "note" ? "notes" : a.kind === "latex_project" ? "latex_projects" : null;
    if (!table || !/^[0-9a-f-]{36}$/i.test(a.id)) continue;
    await env.db.query(`UPDATE ${table} SET agent_prefs=$2::jsonb WHERE id=$1`, [a.id, prefs]);
  }
}
