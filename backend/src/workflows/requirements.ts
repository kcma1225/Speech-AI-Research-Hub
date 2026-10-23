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
import { dataBlock, parseJson } from "./llm.js";
import type { WorkflowEnv } from "./env.js";
import { baseWords, userGuidance, type Brief } from "./brief.js";
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
export function languageViolations(text: string, language: "en" | "zh", allow: string[] = [], doc = false): Violation[] {
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
      if (latinWords(vis) >= 30 && !(vis.match(HAN_G) ?? []).length) out.push({ page: u.page, title: u.title, part, snippet: vis.trim().slice(0, 40) });
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
const LANG_ZH_RE = /(?:用|改成|改為|改回|換成|換回|轉成|翻成|翻譯成|寫成|做成|全部|整份|都(?:要)?用?)\s*(?:繁體|正體)?中文|(?:繁體|正體)?中文(?:版|簡報|投影片|報告|筆記)|\b(?:in|into|to) (?:traditional )?chinese\b|chinese version/i;
const LANG_EN_RE = /(?:用|改成|改為|換成|轉成|翻成|翻譯成|寫成|做成|全部|整份|整個|都(?:要)?用?|純|全)\s*英文|英文(?:版|簡報|投影片|報告|筆記|論文)|\b(?:in|into|to) (?:(?:clear|plain|academic|fluent|formal|natural|proper|simple)\s+)*english\b|\benglish (?:(?:research|academic|technical)\s+)?(?:version|deck|slides|slide deck|presentation|talk|report|note|paper)\b|\ball[- ]english\b/i;
export function detectLanguage(text: string): "en" | "zh" | null {
  const z = LANG_ZH_RE.test(text);
  const e = LANG_EN_RE.test(text);
  if (e && !z) return "en";
  if (z && !e) return "zh";
  return null;
}

/** The clause of `text` around the first match of `re` (≤ 120 chars): the user's own words a requirement quotes. */
export function clauseOf(text: string, re: RegExp | null): string | undefined {
  const m = re ? new RegExp(re.source, re.flags.replace("g", "")).exec(text) : null;
  if (!m) return undefined;
  const stop = /[。！？!?\n；;]/;
  let a = m.index;
  let b = m.index + m[0].length;
  while (a > 0 && !stop.test(text[a - 1]!) && m.index - a < 50) a--;
  while (b < text.length && !stop.test(text[b]!) && b - (m.index + m[0].length) < 50) b++;
  return text.slice(a, b).replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
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
  const exact = /(?:做成|做|共|總共|剛好|正好|改成|變成|擴充到|擴充成|擴到|增加到|縮成|縮減到|精簡到|控制在|大約|約|一份|exactly|about|around|into|to)\s*(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)|(?<![第\d])(\d{1,2})\s*(?:頁(?:的|簡報|投影片|左右)|-?(?:page|slide)\b(?: deck| presentation)?|\s(?:pages|slides)\b)/i.exec(text);
  if (exact) {
    const n = +(exact[1] ?? exact[2])!;
    if (n >= 1 && n <= 60) return { exact: n };
  }
  return null;
}

const FIELD_ALIASES: [RegExp, string[]][] = [
  [/^(?:pros?|優點|優勢|advantages?|strengths?)$/i, ["Pros", "Pro", "Advantages", "Advantage", "Strengths", "優點", "優勢"]],
  [/^(?:cons?|缺點|劣勢|disadvantages?|limitations?|weakness(?:es)?|drawbacks?)$/i, ["Cons", "Con", "Disadvantages", "Limitations", "Limitation", "Weaknesses", "Drawbacks", "缺點", "限制", "劣勢"]],
  [/架構|architecture|structure/i, ["Architecture", "架構", "Structure", "Model structure"]],
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

/** 「每個方法要有架構、Pros/Cons」「for each method include architecture, pros and cons」. */
export function detectPerItemFields(text: string): Requirement["params"] | null {
  const zh = /(?:每|各)(?:一)?(?:個|種|篇|項)?\s*([^\s，。,；;、\n]{1,10}?)\s*(?:都)?(?:要|需要|必須|得|請)?(?:有|包含|包括|列出|寫出|說明|附上|附|加上)\s*([^。；;\n]{2,80})/.exec(text);
  const en = /\b(?:for )?(?:each|every)\s+(method|approach|model|paper|technique|system)\b[^.\n]{0,40}?\b(?:include|includes|cover|covers|with|should have|must have|has|have|:)\s*([^.\n]{2,120})/i.exec(text);
  const m = zh ?? en;
  let kind = m?.[1]?.trim() ?? "";
  let list = m?.[2] ?? "";
  if (!m && /pros\s*(?:\/|and|&|、)\s*cons|優缺點|優點(?:和|與|跟|、)缺點/i.test(text) && /每|各|each|every/i.test(text)) {
    kind = /方法|method|approach/i.test(text) ? "方法" : "項目";
    list = "Pros、Cons";
  }
  if (!kind || !list) return null;
  const fields = list
    .replace(/優缺點/g, "優點、缺點")
    .split(/[、,，/／]|\s+(?:and|&)\s+|和|及|與|跟|以及/)
    .map((f) => f.replace(/^(?:the|its|their)\s+/i, "").replace(/[「」"'.]/g, "").replace(/(?:等|等等|之類)$/, "").trim())
    .filter((f) => f.length >= 2 && f.length <= 24);
  if (!fields.length) return null;
  return { item_kind: kind.replace(/^(?:個|種)/, ""), fields: fields.slice(0, 8).map((f) => fieldTerm(f)) };
}

/** 「刪掉第 3 頁」「拿掉「卡住」這頁」「remove the slide "Blocked"」. */
export function detectExclude(text: string): Requirement["params"] | null {
  const pages = [...text.matchAll(/(?:刪掉|刪除|拿掉|去掉|移除|不要)\s*第\s*(\d{1,2})\s*頁/g)].map((m) => +m[1]!);
  const titles = [...text.matchAll(/(?:刪掉|刪除|拿掉|去掉|移除|不要)\s*[「『"]([^」』"]{1,60})[」』"](?:\s*(?:這|那)?一?頁)?/g), ...text.matchAll(/\b(?:remove|delete|drop)\s+(?:the\s+)?(?:slide|page|section)\s+["“']([^"”']{1,60})["”']/gi)].map((m) => m[1]!.trim());
  if (!pages.length && !titles.length) return null;
  return { scope: "page", ...(pages.length ? { pages } : {}), terms: titles.map((t) => ({ name: t })) };
}

/** Deterministic requirements of one text (the request, a guidance line, or an edited requirement). */
export function detectRequirements(text: string, opts: { pages?: unknown; kind?: ArtifactKind } = {}): Omit<Requirement, "id" | "source">[] {
  const out: Omit<Requirement, "id" | "source">[] = [];
  const q = (re: RegExp) => { const c = clauseOf(text, re); return c ? { quote: c } : {}; };
  const lang = detectLanguage(text);
  if (lang) out.push({ type: "language", text: `成果全部用${LANGUAGE_LABEL[lang]}${lang === "en" ? "（封面、標題、內文、圖表標籤與講稿都不留中文）" : ""}`, params: { language: lang }, ...q(lang === "en" ? LANG_EN_RE : LANG_ZH_RE) });
  if (opts.kind !== "doc" && opts.kind !== "latex") {
    const pc = detectPageCount(text, opts.pages);
    if (pc) out.push({ type: "page_count", text: pageText(pc), params: pc, ...q(PAGE_PHRASE_RE) });
  }
  const fields = detectPerItemFields(text);
  if (fields) out.push({ type: "per_item_fields", text: `每個${fields.item_kind}都要有：${fields.fields!.map((f) => f.name).join("、")}`, params: fields, ...q(/每|各|each|every/i) });
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
    if (Array.isArray(p.allow)) params.allow = p.allow.map((a) => str(a, 80)).filter(Boolean).slice(0, 12);
  } else if (type === "page_count") {
    for (const k of ["exact", "min", "max"] as const) if (typeof p[k] === "number" && (p[k] as number) > 0 && (p[k] as number) <= 80) params[k] = Math.round(p[k] as number);
    if (!params.exact && !params.min && !params.max) Object.assign(params, detectPageCount(text) ?? (/(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text) ? { exact: +/(\d{1,2})\s*(?:頁|張|pages?\b|slides?\b)/i.exec(text)![1]! } : {}));
    if (!params.exact && !params.min && !params.max) return text ? { type: "other", text, source } : null;
    if (kind !== "deck") type = "length";
  } else if (type === "include_topics") {
    params.topics = terms(p.topics);
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
  for (const list of lists) {
    for (const r of list) {
      if (SINGLE.includes(r.type) && out.some((o) => o.type === r.type)) continue;
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
    if (r.type === "language" && p.language) return { id, kind: "check", text, check: { id: "req_language", params: { language: p.language, allow: [...(p.allow ?? []), ...allow], ...doc } } };
    if (r.type === "page_count" && kind === "deck") return { id, kind: "check", text, check: { id: "req_pages", params: { exact: p.exact, min: p.min, max: p.max } } };
    if (r.type === "include_topics" && p.topics?.length) return { id, kind: "check", text, check: { id: "req_include", params: { topics: p.topics, judge_fallback: true, ...doc } } };
    if (r.type === "exclude" && p.terms?.length) return { id, kind: "check", text, check: { id: "req_exclude", params: { terms: p.terms, scope: kind === "deck" ? p.scope ?? "page" : "content", ...doc } } };
    if (r.type === "per_item_fields" && p.fields?.length && p.items?.length) return { id, kind: "check", text, check: { id: "req_fields", params: { items: p.items, fields: p.fields, judge_fallback: true, ...doc } } };
    return { id, kind: "judge", text };
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
    const vs = languageViolations(src, lang, Array.isArray(params.allow) ? (params.allow as string[]) : [], !!params.doc);
    if (!vs.length) return { ok: true, detail: `全部是${LANGUAGE_LABEL[lang]}` };
    const slides = unitsOf(src, !!params.doc).slides;
    return { ok: false, detail: `語言要求（${LANGUAGE_LABEL[lang]}）未達成，這些地方${lang === "en" ? "還有中文" : "整段是英文"}：${vs.slice(0, 10).map((v) => `${whereOf(v, slides)}：「${v.snippet}」`).join("；")}${vs.length > 10 ? `；另外還有 ${vs.length - 10} 處` : ""}。請改成${LANGUAGE_LABEL[lang]}（專有名詞與〈論文原標題〉可保留原文）。` };
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
    if (r.type === "language" && p.language === "en") return "- 成果語言：English。讀者看得到的所有文字（封面與文件標題、副標題、頁面／段落標題、條列、表格、圖表與流程圖的標籤、圖說、講稿、標註）一律用英文；專有名詞與〈論文原標題〉照原文。不要輸出任何中文字或全形標點。Write every visible word of the output in English.";
    if (r.type === "language") return "- 成果語言：繁體中文（台灣用語），專有名詞保留英文。";
    if (r.type === "page_count") return `- 頁數：${pageText(p)}。`;
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
export const targetLanguage = (reqs: Requirement[] | undefined): "en" | "zh" | null => (reqs ?? []).find((r) => r.type === "language")?.params?.language ?? null;

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

type Ctx = { request: string; guidance: string[]; recent: string[]; standing: Omit<Requirement, "id">[]; kind: ArtifactKind; pages?: unknown; userWords?: string[] };

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
  "只收使用者明確說出的要求（這次的要求、補充指示、最近幾輪對話中關於這份成果的要求）；不要加入一般性的品質期望，也不要替使用者決定研究方向或時程。",
  "type：language（成果語言；只在明確要求時）、page_count（明確的頁數或範圍）、include_topics（一定要涵蓋的主題，topics 每個附 aliases：中英文說法與縮寫）、exclude（要刪掉的頁面或內容，terms 附 aliases；刪頁面 scope=page）、per_item_fields（每個方法／模型要有的欄位，fields 附 aliases；使用者有列出項目時填 items）、audience（對象）、tone（語氣）、length（篇幅）、format（成果形式，例如 LaTeX、表格）、other。",
  "text 用繁體中文寫一句可以驗收的要求。quote 逐字複製使用者說出這個要求的原話（找不到原話就不要列）。主題、欄位、要刪的內容只能用使用者自己提到的詞（可以補上同義的中英文 aliases），不要自己細分出使用者沒說的欄位或主題。沒有要求就回 {\"requirements\":[]}。",
  '格式：{"requirements":[{"type":"include_topics","text":"聚焦在動態熱詞（dynamic hotwording）","quote":"我想要 focus 在動態熱詞","params":{"topics":[{"name":"dynamic hotwording","aliases":["動態熱詞","contextual biasing"]}]}}]}',
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
  const guidance = brief ? userGuidance(env.run) : (env.run.guidance ?? []).map((g) => g.text);
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
  const ctx: Ctx = { request: startText, guidance, recent, standing: standing.list, kind, pages, userWords: [...start, ...guidance] };
  const det = [
    ...start.flatMap((t) => detectRequirements(t, { pages, kind })).map((r) => ({ ...r, source: "request" as const })),
    ...guidance.flatMap((g) => detectRequirements(g, { kind }).map((r) => ({ ...r, source: "guidance" as const }))),
  ];
  // Guidance is newer than the request: its single-valued statements win.
  det.sort((a, b) => (a.source === b.source ? 0 : a.source === "guidance" ? -1 : 1));
  const fromChat = recent.slice(0, -1).reverse().flatMap((t) => detectRequirements(t, { kind }).filter((r) => r.type === "language").map((r) => ({ ...r, source: "conversation" as const })));
  const llm = await extractWithModel(env, ctx).catch(() => [] as Omit<Requirement, "id">[]);
  const removed = new Set(env.state<string[]>("requirements_removed") ?? []);
  const userEdits = (prev ?? []).filter((r) => r.source === "user").map(({ id: _id, ...r }) => r);
  // Last resort for the language (after the artifact's own): the user wrote the request in English → English.
  const fromMessage = messageLanguage(start);
  const merged = mergeRequirements(userEdits, det, llm, fromChat, standing.list, fromMessage).filter((r) => !removed.has(keyOf(r)));
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
  return [{ type: "language", text: "成果用 English（你用英文提出這個要求）", params: { language: "en" }, source: "request", ...(quote ? { quote } : {}) }];
}

async function extractWithModel(env: WorkflowEnv, ctx: Ctx): Promise<Omit<Requirement, "id">[]> {
  const user = [
    `成果類型：${ctx.kind === "deck" ? "簡報" : ctx.kind === "latex" ? "LaTeX 論文" : "筆記／文件"}`,
    dataBlock("user_words", ctx.request.slice(0, 4000)),
    ctx.guidance.length ? dataBlock("guidance", ctx.guidance.join("\n").slice(0, 3000)) : "",
    ctx.recent.length ? dataBlock("recent_turns", ctx.recent.map((t) => `- ${t}`).join("\n").slice(0, 5000)) : "",
    ctx.standing.length ? `這份成果先前確認過的設定（沒有被這次的要求推翻就沿用，不必重複列出）：${ctx.standing.map((s) => s.text).join("；")}` : "",
  ].filter(Boolean).join("\n\n");
  // One call, no retry: the deterministic detection already covers language, page count, per-item fields and removals.
  const res = await env.call({ purpose: "requirements", role: "planner", messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: user }], maxTokens: 2500 });
  const v = parseJson<{ requirements?: unknown[] }>(res.text);
  const list = Array.isArray(v?.requirements) ? v!.requirements : [];
  // Grounding: the user's own words (not the assistant's paraphrase) when the request is a paraphrase.
  const words = (ctx.userWords ?? [ctx.request, ...ctx.guidance, ...ctx.recent]).join("\n");
  // The model may not change what the user's words settle deterministically (language / page count come from the text).
  return list
    .filter((r) => groundedInWords(r, words))
    .map((r) => {
      const c = cleanRequirement(r, "request", ctx.kind);
      return c ? ({ ...c, quote: str((r as { quote?: unknown }).quote, 200) } as Omit<Requirement, "id">) : null;
    })
    .filter((r): r is Omit<Requirement, "id"> => !!r && r.type !== "language" && r.type !== "page_count")
    .map((r) => anchorTerms(r, words));
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
