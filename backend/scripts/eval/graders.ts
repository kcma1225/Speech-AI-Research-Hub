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
/**
 * Original pages still there, in order, one deck page each: the same title first, else a title that contains only this
 * original (「Shallow fusion: architecture」) — 「Shallow fusion vs. CLAS vs. contextual adapters」 stands for none of them.
 */
export function titlesKept(deck: Deck, before: string[], except: RegExp | null = null): Grade {
  const titles = deck.slides.map((s) => s.title);
  const want = before.filter((t) => !(except && except.test(t)));
  const used = new Set<number>();
  let at = 0;
  const lost: string[] = [];
  for (const t of want) {
    let i = titles.findIndex((x, k) => k >= at && !used.has(k) && !!norm(t) && norm(t) === norm(x));
    if (i < 0) i = titles.findIndex((x, k) => k >= at && !used.has(k) && sameTitle(t, x) && !want.some((o) => o !== t && sameTitle(o, x)));
    if (i < 0) lost.push(t);
    else (used.add(i), (at = i + 1));
  }
  return grade("titles_kept", !lost.length, lost.length ? `少了或順序變了：${lost.join("、")}` : `原本的 ${want.length} 頁都在`);
}

/** No page twice: the same title, or the same slide body (≥ 120 characters) under two titles. */
export function noDuplicatePages(deck: Deck): Grade {
  const dups: string[] = [];
  const titles = new Map<string, number>();
  const bodies = new Map<string, number>();
  for (const s of deck.slides) {
    const t = norm(s.title);
    if (t && titles.has(t)) dups.push(`p${titles.get(t)} 與 p${s.n}「${s.title}」同標題`);
    else if (t) titles.set(t, s.n);
    const b = s.body.replace(/\s+/g, "");
    if (b.length >= 120 && bodies.has(b)) dups.push(`p${bodies.get(b)} 與 p${s.n} 內容相同`);
    else if (b.length >= 120) bodies.set(b, s.n);
  }
  return grade("no_duplicates", !dups.length, dups.length ? `重複的頁面：${dups.slice(0, 6).join("、")}` : "沒有重複的頁面");
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

/** Lab-Hub paper-report pages the student writes (templates.ts: pages 7, 12, 13): their own words, not graded. */
const STUDENT_PAGE = /^\s*(?:Trace one example|My assessment|Takeaways for my work)\s*$/i;

/**
 * The professor's Lab-Hub paper-report template (backend/src/lib/slides/templates.ts) mandates English slides and 繁中
 * speaker notes: titles + bodies have no CJK (〈quoted titles〉 allowed), no page's notes are written entirely in English
 * (≥ 30 words, no Han) and Han dominates the notes overall. The cover (the paper's own title) and the student's own pages
 * are not graded.
 */
export function paperReportLanguage(deck: Deck): Grade {
  const where: string[] = [];
  let han = 0;
  let words = 0;
  for (const s of deck.slides) {
    if (STUDENT_PAGE.test(s.title)) continue;
    if (cjkCount(visible(`${s.title}\n${s.body}`)) > 0) where.push(`p${s.n} 投影片有中文`);
    const notes = visible(s.notes);
    const h = hanCount(notes);
    const w = latinWords(notes.replace(/\$[^$\n]+\$/g, " "));
    han += h;
    words += w;
    if (w >= 30 && h === 0) where.push(`p${s.n} 講稿是英文`);
  }
  const ok = !where.length && han > 0 && han >= words;
  return grade("language_template", ok, ok ? `Lab-Hub 論文報告：投影片英文、講稿繁中（講稿漢字 ${han}、英文字 ${words}）` : `不符合 Lab-Hub 論文報告的語言（投影片英文、講稿繁中）：${where.slice(0, 6).join("、") || "講稿不是以中文為主"}${where.length > 6 ? `…共 ${where.length} 處` : ""}（講稿漢字 ${han}、英文字 ${words}）`);
}

/** A language the request names explicitly (overrides a template's own language rule); null when it names none. */
export function explicitLanguage(request: string): "en" | "zh" | null {
  if (/全英文|用英文|英文(?:版|簡報|投影片|講稿)|in English|English (?:slides|deck|notes)/i.test(request)) return "en";
  if (/全中文|用中文|中文(?:版|簡報|投影片|講稿)|繁體中文|in (?:Traditional )?Chinese/i.test(request)) return "zh";
  return null;
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
    // A long title cut at a word boundary (topic decks' source lines keep ≤ 56 characters): a ≥ 30-letter word prefix.
    const words = p.title.split(/[:：]/)[0]!.trim().split(/\s+/);
    for (let k = words.length - 1; k >= 3; k--) {
      const pre = norm(words.slice(0, k).join(" "));
      if (pre.length < 30) break;
      if (flat.includes(pre)) return true;
    }
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

// ---------------------------------------------------------------- production conversation 79ab0678

/**
 * Slides English, every speaker note 繁中 with English terms (「講稿要是中文的…多用一點英文的專用名詞」): the cover and every
 * slide's title / body have no CJK; each note has Han characters and at least as many Han characters as English words.
 */
/** A notes-only edit: every slide's title and body (outside the speaker notes) as in the fixture, whitespace aside. */
export function bodiesKept(deck: Deck, fixture: string): Grade {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const before = fixture.split(/^(?=## )/m).filter((p) => p.startsWith("## ")).map((p) => {
    const nl = p.indexOf("\n");
    return { title: squash(p.slice(3, nl < 0 ? undefined : nl)), body: squash((nl < 0 ? "" : p.slice(nl + 1)).replace(/^:::+\s*\{?\.?notes\}?\s*\n[\s\S]*?^:::+\s*$/gm, "")) };
  });
  const changed = before.map((b, i) => {
    const s = deck.slides[i];
    return s && squash(s.title) === b.title && squash(s.body) === b.body ? null : `p${i + 1}`;
  }).filter(Boolean);
  if (deck.slides.length !== before.length) changed.push(`頁數 ${deck.slides.length}／${before.length}`);
  return grade("bodies_kept", !changed.length, changed.length ? `投影片本體被改：${changed.join("、")}` : "每頁投影片本體都和原本一樣");
}

export function slidesEnNotesZh(deck: Deck): Grade {
  const where: string[] = [];
  if (cjkCount(deck.title)) where.push("封面有中文");
  for (const s of deck.slides) {
    if (cjkCount(visible(`${s.title}\n${s.body}`)) > 0) where.push(`p${s.n} 投影片有中文`);
    const notes = visible(s.notes);
    const h = hanCount(notes);
    const w = latinWords(notes.replace(/\$[^$\n]+\$/g, " "));
    if (!notes.trim()) where.push(`p${s.n} 沒有講稿`);
    else if (!h || h < w) where.push(`p${s.n} 講稿不是中文為主（漢字 ${h}、英文字 ${w}）`);
  }
  return grade("slides_en_notes_zh", !where.length && deck.slides.length > 0, where.length ? where.slice(0, 6).join("、") + (where.length > 6 ? `…共 ${where.length} 處` : "") : `${deck.slides.length} 頁：投影片英文、講稿繁中`);
}

const VENUE_RE = /Interspeech|ICASSP|ASRU|\bSLT\b|\bACL\b|EMNLP|NAACL|NeurIPS|ICML|ICLR|AAAI|TASLP|Transactions|\bIEEE\b|Journal|Proceedings|Proc\.|Conference|arXiv|preprint|會議|期刊/i;
const CITES_PAPER_RE = /et al\.?|\b(?:19|20)\d{2}\b/;
/** Every slide that names a paper (author et al. / a year) also names its venue (「會議或是期刊是哪一個」); ≥ `minShare`. */
export function venuePerMethod(deck: Deck, minShare = 0.8): Grade {
  const cited = deck.slides.slice(1).filter((s) => CITES_PAPER_RE.test(visible(`${s.title}\n${s.body}`)));
  const with_ = cited.filter((s) => VENUE_RE.test(visible(`${s.body}\n${s.notes}`)));
  const ok = cited.length >= 2 && with_.length / cited.length >= minShare;
  const missing = cited.filter((s) => !with_.includes(s)).map((s) => `p${s.n}`);
  return grade("venue_per_method", ok, `${with_.length}/${cited.length} 頁提到論文也寫了會議／期刊${missing.length ? `（沒有：${missing.slice(0, 6).join("、")}）` : ""}${/not (?:been )?provided|未提供/i.test(deck.slides.map((s) => s.body + s.notes).join("\n")) ? "；有「未提供」字樣" : ""}`);
}

/** The deck's cover and slide titles never drift to words the user never asked for (0668a3d7: 「efficiency」 from the study name). */
export function noTopicDrift(deck: Deck, banned: RegExp, request: string): Grade {
  const hits = [deck.title, ...deck.slides.map((s) => s.title)].filter((t) => banned.test(t) && !banned.test(request));
  return grade("no_topic_drift", !hits.length, hits.length ? `標題出現使用者沒說的主題：${hits.slice(0, 4).map((h) => `「${h}」`).join("、")}` : `封面「${deck.title}」`);
}

/** The Brief holds the user's words only: a setup answer (the study's name) is not one of them and no requirement quotes it. */
export function briefWithout(brief: BriefLike, text: string): Grade {
  const inWords = (brief?.user_words ?? []).some((w) => w.includes(text));
  const inReqs = (brief?.requirements ?? []).some((r) => `${r.text ?? ""}${r.quote ?? ""}`.includes(text));
  return grade("answer_not_words", !inWords && !inReqs, inWords ? "研究名稱進了使用者的原話" : inReqs ? "有要求引用了研究名稱" : "研究名稱只當作設定，沒有進原話或要求");
}

/** The cover (front matter title) is not repeated by the first page (production 301b6e1a: pages 1 and 2 had the same title). */
export function coverNotRepeated(deck: Deck): Grade {
  const first = deck.slides[0];
  const dup = !!first && !!norm(deck.title) && norm(first.title) === norm(deck.title);
  return grade("cover_not_repeated", !dup, dup ? `第 1 頁「${first!.title}」和封面同標題` : `封面「${deck.title}」，第 1 頁「${first?.title ?? "（無）"}」`);
}

const bigramSet = (s: string) => {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};
/** Every listed part has a page whose title names it (contains it, or ≥ 60 % of its character bigrams). */
export function sectionPages(deck: Deck, parts: string[]): Grade {
  const hit = (title: string, part: string) => {
    if (norm(title).includes(norm(part))) return true;
    const g = bigramSet(part);
    const h = bigramSet(title);
    let n = 0;
    for (const x of g) if (h.has(x)) n++;
    return g.size > 0 && n / g.size >= 0.6;
  };
  const missing = parts.filter((p) => !deck.slides.some((s) => hit(s.title, p)));
  return grade("section_pages", !missing.length, missing.length ? `沒有自己頁面的部分：${missing.join("、")}` : `${parts.length} 個部分都有自己的頁面`);
}

/** The deck uses the attached material: at least `min` of its unique tokens (each a list of spellings) appear. */
export function materialUsed(text: string, tokens: string[][], min: number): Grade {
  const found = tokens.filter((alts) => alts.some((t) => text.includes(t)));
  return grade("material_used", found.length >= min, `資料特有的詞出現 ${found.length}/${tokens.length}（≥ ${min}）：${found.map((a) => a[0]).join("、") || "無"}`);
}
