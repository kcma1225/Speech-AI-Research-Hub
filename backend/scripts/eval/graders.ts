/**
 * Deterministic graders of the agent eval (pure, unit-tested in test/eval-graders.test.ts). Deliberately independent
 * of the workflow code (src/workflows/checks.ts, requirements.ts): the eval must not inherit the bugs of what it grades.
 */

export type Grade = { id: string; ok: boolean; detail: string };
export const grade = (id: string, ok: boolean, detail: string): Grade => ({ id, ok, detail });

// ---------------------------------------------------------------- text

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠]/gu;
const HAN = /\p{Script=Han}/gu;
const LATIN_WORD = /[A-Za-z][A-Za-z'-]*/g;
export const cjkCount = (s: string) => (s.match(CJK) ?? []).length;
export const hanCount = (s: string) => (s.match(HAN) ?? []).length;
export const latinWords = (s: string) => (s.match(LATIN_WORD) ?? []).length;

/** What a reader sees: comments, link / image targets, attributes, fence and div lines removed; 〈quoted titles〉 dropped. */
export function visible(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\((?:[^()]|\([^)]*\))*\)/g, "]")
    .replace(/\{[.#][^}\n]*\}/g, " ")
    .replace(/^:::+.*$/gm, " ")
    .replace(/^\s*```.*$/gm, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/〈[^〉\n]{1,80}〉|《[^》\n]{1,80}》/g, " ");
}

// ---------------------------------------------------------------- decks

export type Slide = { n: number; title: string; body: string; notes: string };
export type Deck = { title: string; subtitle: string; slides: Slide[] };

const unquote = (v: string) => {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      // fall through
    }
  }
  return t.replace(/^(['"])([\s\S]*)\1$/, "$2");
};

/** Quarto deck: YAML cover + one slide per `#` / `##` heading outside code fences; notes = `::: notes` / `{.notes}` divs. */
export function parseDeck(qmd: string): Deck {
  const text = qmd.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let title = "";
  let subtitle = "";
  for (const line of fm?.[1]?.split("\n") ?? []) {
    const m = /^(title|subtitle):\s*(.*)$/.exec(line);
    if (m?.[1] === "title") title = unquote(m[2]!);
    if (m?.[1] === "subtitle") subtitle = unquote(m[2]!);
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const slides: Slide[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (!cur) return;
    const raw = cur.lines.join("\n");
    const notesRe = /^:::+\s*\{?\.?notes\}?\s*\n([\s\S]*?)^:::+\s*$/gm;
    let notes = "";
    for (const m of raw.matchAll(notesRe)) notes += `${m[1]}\n`;
    slides.push({ n: slides.length + 1, title: cur.title, body: raw.replace(notesRe, "").trim(), notes: notes.trim() });
  };
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,2}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      cur = { title: h[1]!.replace(/\{[^}]*\}\s*$/, "").trim(), lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  flush();
  return { title, subtitle, slides };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export const sameTitle = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

export function pageCount(deck: Deck, want: number, tolerance = 0): Grade {
  const n = deck.slides.length;
  return grade("page_count", Math.abs(n - want) <= tolerance, `${n} 頁（要求 ${want}${tolerance ? ` ±${tolerance}` : ""}）`);
}

/** Every title of `before` (except `except`) is still a slide title, in the same relative order. */
export function titlesKept(deck: Deck, before: string[], except: RegExp | null = null): Grade {
  const titles = deck.slides.map((s) => s.title);
  const want = before.filter((t) => !(except && except.test(t)));
  let at = 0;
  const lost: string[] = [];
  for (const t of want) {
    const i = titles.findIndex((x, k) => k >= at && sameTitle(t, x));
    if (i < 0) lost.push(t);
    else at = i + 1;
  }
  return grade("titles_kept", !lost.length, lost.length ? `少了或順序變了：${lost.join("、")}` : `原本的 ${want.length} 頁都在`);
}

export const noSlideTitled = (deck: Deck, re: RegExp): Grade => {
  const hit = deck.slides.filter((s) => re.test(s.title));
  return grade("removed", !hit.length, hit.length ? `還在：${hit.map((s) => `p${s.n}「${s.title}」`).join("、")}` : "已移除");
};

export type LangReport = { ok: boolean; cjk: number; han: number; words: number; where: string[] };

/**
 * English: no CJK letter / full-width punctuation in the cover (title, subtitle), slide titles, bodies (incl. diagram /
 * chart / table labels) and speaker notes (〈quoted titles〉 allowed). 繁中: the cover title has Han characters, Han
 * dominates the visible text, and no slide body or notes is written entirely in English (≥ 30 words, no Han).
 */
export function deckLanguage(deck: Deck, lang: "en" | "zh"): LangReport {
  const where: string[] = [];
  let cjk = 0;
  let han = 0;
  let words = 0;
  const parts: [string, string][] = [["封面", `${deck.title}\n${deck.subtitle}`], ...deck.slides.flatMap((s) => [[`p${s.n} 標題`, s.title], [`p${s.n} 內文`, s.body], [`p${s.n} 講稿`, s.notes]] as [string, string][])];
  for (const [label, raw] of parts) {
    const v = visible(raw);
    const c = cjkCount(v);
    const h = hanCount(v);
    const w = latinWords(v.replace(/\$[^$\n]+\$/g, " "));
    cjk += c;
    han += h;
    words += w;
    if (lang === "en" && c > 0) where.push(label);
    if (lang === "zh" && !label.endsWith("標題") && label !== "封面" && w >= 30 && h === 0) where.push(label);
  }
  if (lang === "zh" && !hanCount(deck.title)) where.unshift("封面（沒有中文）");
  const ok = lang === "en" ? cjk === 0 : !where.length && han >= words;
  return { ok, cjk, han, words, where };
}

export function languageGrade(rep: LangReport, lang: "en" | "zh"): Grade {
  const label = lang === "en" ? "English" : "繁體中文";
  const detail = rep.ok ? `${label}（漢字 ${rep.han}、英文字 ${rep.words}）` : `不是全${label}：${rep.where.slice(0, 6).join("、")}${rep.where.length > 6 ? `…共 ${rep.where.length} 處` : ""}（CJK ${rep.cjk}、英文字 ${rep.words}）`;
  return grade(`language_${lang}`, rep.ok, detail);
}

/** Documents (notes, LaTeX): English = ≤ 0.5 % CJK among letters; 繁中 = Han ≥ English words. */
export function docLanguage(text: string, lang: "en" | "zh"): Grade {
  const v = visible(text.replace(/```[\s\S]*?```/g, " ").replace(/\\(?:cite|ref|label|input|includegraphics)\{[^}]*\}/g, " "));
  const c = cjkCount(v);
  const h = hanCount(v);
  const w = latinWords(v);
  const ok = h + w > 0 && (lang === "en" ? c <= Math.max(2, 0.005 * (w * 5)) : h >= w);
  return grade(`language_${lang}`, ok, `漢字 ${h}、CJK ${c}、英文字 ${w}`);
}

/** Pages that carry every field (each field = alternatives, matched case-insensitively in the visible body). */
export function perItemFields(deck: Deck, fields: string[][], minPages: number): Grade {
  const has = (s: Slide, alts: string[]) => alts.some((a) => visible(s.body).toLowerCase().includes(a.toLowerCase()));
  const full = deck.slides.filter((s) => fields.every((f) => has(s, f)));
  const partial = deck.slides.filter((s) => !full.includes(s) && fields.some((f) => has(s, f)));
  return grade("per_item_fields", full.length >= minPages, `${full.length} 頁有全部欄位（${fields.map((f) => f[0]).join("／")}），${partial.length} 頁只有部分；要求 ≥ ${minPages}`);
}

export function hasVisualTable(deck: Deck): Grade {
  const hit = deck.slides.filter((s) => /^\s*\|.*\|\s*$/m.test(s.body));
  return grade("table", hit.length > 0, hit.length ? `表格在 ${hit.map((s) => `p${s.n}`).join("、")}` : "沒有表格");
}

/** A slide with a table that names every item (each item = alternatives, case-insensitive). */
export function tableMentioning(deck: Deck, items: string[][]): Grade {
  const tables = deck.slides.filter((s) => /^\s*\|.*\|\s*$/m.test(s.body));
  const hit = tables.find((s) => {
    const rows = s.body.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).join("\n").toLowerCase();
    return items.every((alts) => alts.some((a) => rows.includes(a.toLowerCase())));
  });
  return grade("comparison_table", !!hit, hit ? `p${hit.n}「${hit.title}」的表格比較了 ${items.map((i) => i[0]).join("、")}` : `沒有一個表格同時比較 ${items.map((i) => i[0]).join("、")}（有表格的頁：${tables.map((s) => `p${s.n}`).join("、") || "無"}）`);
}

// ---------------------------------------------------------------- documents

export function sectionsPresent(md: string, wanted: { label: string; re: RegExp }[]): Grade {
  const heads = [...md.matchAll(/^#{1,4}\s+(.+)$/gm), ...md.matchAll(/\\(?:sub)*section\*?\{([^}]+)\}/g)].map((m) => m[1]!);
  const missing = wanted.filter((w) => !heads.some((h) => w.re.test(h)));
  return grade("sections", !missing.length, missing.length ? `缺少段落：${missing.map((w) => w.label).join("、")}（有：${heads.slice(0, 10).join("／")}）` : `${wanted.length} 個必要段落都在`);
}

/** Citation keys: Pandoc `[@a; @b]` / `@a` inside brackets and LaTeX `\cite{a,b}` (all variants). */
export function citationKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\[[^\]\n]*@[^\]\n]*\]/g)) for (const k of m[0].matchAll(/@([\w:.\-]+[\w])/g)) keys.add(k[1]!);
  for (const m of text.matchAll(/\\\w*cite\w*\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)) for (const k of m[1]!.split(",")) if (k.trim()) keys.add(k.trim());
  return [...keys];
}

export function citationsResolve(text: string, known: string[], min = 1): Grade {
  const keys = citationKeys(text);
  const set = new Set(known.map((k) => k.toLowerCase()));
  const unknown = keys.filter((k) => !set.has(k.toLowerCase()));
  const ok = keys.length >= min && !unknown.length;
  return grade("citations", ok, `${keys.length} 個引用鍵${unknown.length ? `，${unknown.length} 個不在研究文獻庫：${unknown.slice(0, 5).join(", ")}` : "，都在研究文獻庫"}${keys.length < min ? `（至少要 ${min} 個）` : ""}`);
}

export type PaperRef = { key: string; title: string; author?: string; year?: number | null };

/** Library papers the text refers to: cite key, a distinctive title fragment, or 「Author et al. / (year)」. */
export function papersMentioned(text: string, papers: PaperRef[]): PaperRef[] {
  const low = text.toLowerCase();
  const flat = norm(text);
  return papers.filter((p) => {
    if (low.includes(p.key.toLowerCase())) return true;
    const head = norm(p.title.split(/[:：]/)[0]!);
    if (head.length >= 8 && flat.includes(head)) return true;
    return !!p.author && p.author.length >= 3 && new RegExp(`\\b${p.author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^\\n]{0,20}(?:et al\\.?|\\(?${p.year ?? ""})`, "i").test(text);
  });
}

export function mentionsPapers(text: string, papers: PaperRef[], min: number): Grade {
  const hit = papersMentioned(text, papers);
  return grade("library_papers", hit.length >= min, `提到文獻庫 ${hit.length} 篇（要求 ≥ ${min}）${hit.length ? `：${hit.slice(0, 6).map((p) => p.key).join(", ")}` : ""}`);
}

/** Largest Markdown table (data rows) or LaTeX tabular (\\ rows). */
export function maxTableRows(text: string): number {
  let best = 0;
  let run = 0;
  for (const line of text.split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) run++;
    } else {
      best = Math.max(best, run - 1);
      run = 0;
    }
  }
  best = Math.max(best, run - 1);
  for (const m of text.matchAll(/\\begin\{tabular\*?\}[\s\S]*?\\end\{tabular\*?\}/g)) best = Math.max(best, (m[0].match(/\\\\/g) ?? []).length - 1);
  return Math.max(0, best);
}

export const tableRows = (text: string, min: number): Grade => {
  const n = maxTableRows(text);
  return grade("table_rows", n >= min, `最大表格 ${n} 列（要求 ≥ ${min}）`);
};

const PLACEHOLDER = /〔\s*　*\s*〕|待補|待填|\bTODO\b|\bTBD\b|lorem ipsum|\bXXX\b|\?\?\?/i;
export function noPlaceholder(text: string): Grade {
  const m = PLACEHOLDER.exec(text.replace(/這頁留給你自己寫/g, ""));
  return grade("no_placeholder", !m, m ? `有佔位文字「${text.slice(Math.max(0, m.index - 10), m.index + 20).replace(/\s+/g, " ")}」` : "沒有佔位文字");
}

export function minLength(text: string, minChars: number): Grade {
  const n = visible(text).replace(/\s+/g, "").length;
  return grade("length", n >= minChars, `${n} 字元（要求 ≥ ${minChars}）`);
}

// ---------------------------------------------------------------- briefs

export type BriefLike = { deliverable?: { kind?: string } | null; user_words?: string[]; requirements?: { type?: string; text?: string; quote?: string; source?: string }[]; unspecified?: string[] } | null | undefined;

/** Every requirement quotes the user's own words; no language / page count unless the user's words contain one. */
export function briefGrounded(brief: BriefLike): Grade {
  if (!brief) return grade("brief_grounded", false, "沒有 Brief");
  const words = norm((brief.user_words ?? []).join("\n"));
  const bad: string[] = [];
  for (const r of brief.requirements ?? []) {
    if (r.source && r.source !== "request" && r.source !== "user" && r.source !== "guidance") continue;
    const q = norm(r.quote ?? "");
    if (!q || !words.includes(q)) bad.push(`${r.type}：「${(r.quote ?? r.text ?? "").slice(0, 30)}」不是原話`);
  }
  const raw = (brief.user_words ?? []).join("\n");
  const types = new Set((brief.requirements ?? []).map((r) => r.type));
  if (types.has("page_count") && !/\d+\s*(頁|張|pages?|slides?)|[一二三四五六七八九十兩]+\s*[頁張]/i.test(raw)) bad.push("原話沒有頁數卻有頁數要求");
  if (types.has("language") && !/英文|中文|english|chinese|翻譯|translate/i.test(raw) && latinWords(raw) < 5) bad.push("原話沒有語言卻有語言要求");
  return grade("brief_grounded", !bad.length, bad.length ? bad.join("；") : `${brief.requirements?.length ?? 0} 條要求都引用原話`);
}

// ---------------------------------------------------------------- run metrics

export type CriterionLike = { id: string; status: string };

/** Criteria that went pass → fail between successive snapshots of the run (workflow events), per criterion id. */
export function criteriaFlips(snapshots: CriterionLike[][]): string[] {
  const last = new Map<string, string>();
  const flips: string[] = [];
  for (const snap of snapshots) {
    for (const c of snap) {
      if (last.get(c.id) === "pass" && c.status === "fail") flips.push(c.id);
      if (c.status === "pass" || c.status === "fail") last.set(c.id, c.status);
    }
  }
  return flips;
}

/** Deterministic checks that passed in one round of a unit and failed in its next round (failure signatures `c:<id>:…`). */
export function checkFlips(rounds: { round: number; failures: string[] }[], checkIds: string[]): string[] {
  const out: string[] = [];
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  for (let i = 1; i < sorted.length; i++) {
    const failedBefore = new Set(sorted[i - 1]!.failures.filter((f) => f.startsWith("c:")).map((f) => f.split(":")[1]));
    const failedNow = new Set(sorted[i]!.failures.filter((f) => f.startsWith("c:")).map((f) => f.split(":")[1]));
    for (const id of failedNow) if (!failedBefore.has(id) && checkIds.includes(id!)) out.push(`${id}@r${sorted[i]!.round}`);
  }
  return out;
}
