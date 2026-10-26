/**
 * Deterministic verification checks (pure; unit-tested). Each check gets the step/artifact text, its params and the
 * step's structured output data, and returns {ok, detail} with a 繁中 detail the fixer can act on.
 */
import type { CheckResult, CheckSpec } from "./types.js";
import { chartBlocks, lintMermaid, mermaidBlocks } from "../lib/slides/deck-visuals.js";
import { lintDiagrams } from "../lib/slides/diagram/index.js";
import { chartIssues, diagramIssues, figureIssues, formatIssues, nameIssues, type ContentRefs, type LintSlide } from "../lib/slides/content-lint.js";

export type Slide = { title: string; body: string; notes: string; index: number };

/** Splits a Quarto body into `## ` slides; notes = `::: notes` / `::: {.notes}` blocks. */
export function parseSlides(text: string): Slide[] {
  const parts = text.replace(/\r\n/g, "\n").split(/^(?=## )/m).filter((p) => p.startsWith("## "));
  return parts.map((p, i) => {
    const nl = p.indexOf("\n");
    const title = (nl < 0 ? p.slice(3) : p.slice(3, nl)).replace(/\{[^}]*\}\s*$/, "").trim();
    const rest = nl < 0 ? "" : p.slice(nl + 1);
    const notesRe = /^:::+\s*\{?\.?notes\}?\s*\n([\s\S]*?)^:::+\s*$/gm;
    let notes = "";
    let m: RegExpExecArray | null;
    while ((m = notesRe.exec(rest))) notes += m[1]!;
    const body = rest.replace(notesRe, "").trim();
    return { title, body, notes: notes.trim(), index: i + 1 };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export const titleMatches = (want: string, got: string) => {
  const a = norm(want);
  const b = norm(got);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

// ---------------------------------------------------------------- original pages preserved (revise / expand)

/** An original page of a deck being edited that must survive the edit: its 1-based number, title and slide text. */
export type OriginalPage = { n: number; title: string; text: string };
/** An outline page as the matcher sees it; `from` = the original page it claims to rewrite / expand. */
export type PlannedPage = { title: string; points?: string[]; from?: number };
export type PageMatch = { at: (number | null)[]; by: ("title" | "from" | "content" | "position" | null)[]; split: boolean[] };

/** Content signature: Han bigrams + Latin words (≥ 3 letters), lower-cased. */
export function contentTokens(text: string): Set<string> {
  const t = text.toLowerCase().replace(/```[^\n]*\n/g, " ").replace(/:::[^\n]*/g, " ");
  const out = new Set<string>();
  for (const w of t.match(/[a-z][a-z0-9+-]{2,}/g) ?? []) out.add(w);
  for (const run of t.match(/[\u3400-\u9fff]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}
/** Share of the original page's signature found in the planned page. */
export function contentOverlap(original: string, page: string): number {
  const a = contentTokens(original);
  if (!a.size) return 0;
  const b = contentTokens(page);
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}

/**
 * Which planned page carries each original page (one page per original): the same title, the page's own `from` claim
 * (backed by its title or content unless the edit is a translation), a containing title, then a clear content match;
 * a translation with the same page count falls back to position. `split` = more than one page claims that original.
 */
export function matchOriginals(originals: OriginalPage[], pages: PlannedPage[], opts: { translate?: boolean } = {}): PageMatch {
  const used = new Set<number>();
  const at: (number | null)[] = originals.map(() => null);
  const by: PageMatch["by"] = originals.map(() => null);
  const text = (p: PlannedPage) => `${p.title}\n${(p.points ?? []).join("\n")}`;
  const take = (i: number, j: number, how: NonNullable<PageMatch["by"][number]>) => ((at[i] = j), (by[i] = how), used.add(j));
  const pass = (how: NonNullable<PageMatch["by"][number]>, pick: (o: OriginalPage) => number) =>
    originals.forEach((o, i) => {
      if (at[i] !== null) return;
      const j = pick(o);
      if (j >= 0) take(i, j, how);
    });
  const free = (f: (p: PlannedPage, j: number) => boolean) => pages.findIndex((p, j) => !used.has(j) && f(p, j));
  pass("title", (o) => free((p) => !!norm(o.title) && norm(o.title) === norm(p.title)));
  pass("from", (o) => free((p) => p.from === o.n && (!!opts.translate || titleMatches(o.title, p.title) || contentOverlap(o.text, text(p)) >= 0.1 || pages.filter((x) => x.from === o.n).length > 1)));
  pass("title", (o) => free((p) => titleMatches(o.title, p.title)));
  if (!opts.translate) {
    pass("content", (o) => {
      let best = -1;
      let score = 0.35;
      pages.forEach((p, j) => {
        const s = used.has(j) ? 0 : contentOverlap(o.text, text(p));
        if (s >= score) (best = j), (score = s);
      });
      return best;
    });
  } else if (pages.length === originals.length) {
    pass("position", (o) => {
      const i = originals.indexOf(o);
      return used.has(i) ? -1 : i;
    });
  }
  const split = originals.map((o) => pages.filter((p) => p.from === o.n).length > 1);
  return { at, by, split };
}

/**
 * Problems with the originals in a plan: missing, out of order (`ordered`), or — when `keepTitles` (an expansion that
 * only enriches the page) — retitled although the page was not split into several.
 */
export function keptIssues(originals: OriginalPage[], pages: PlannedPage[], match: PageMatch, opts: { ordered?: boolean; keepTitles?: boolean } = {}): string[] {
  const issues: string[] = [];
  const missing = originals.filter((_, i) => match.at[i] === null);
  if (missing.length) issues.push(`原本的這些頁面不見了：${missing.map((o) => `第 ${o.n} 頁「${o.title}」`).join("、")}。使用者沒有要求刪掉或合併，請保留（可以在前後插入新頁、把內容寫得更具體）`);
  const placed = match.at.map((j, i) => ({ j, o: originals[i]! })).filter((x): x is { j: number; o: OriginalPage } => x.j !== null);
  if (opts.ordered && placed.some((x, k) => k > 0 && x.j < placed[k - 1]!.j)) issues.push(`原本頁面的順序被改了（應為 ${placed.map((x) => `「${x.o.title}」`).join(" → ")}）。使用者沒有要求調整順序，請照原本的順序`);
  if (opts.keepTitles) {
    const renamed = placed.filter((x) => {
      const i = originals.indexOf(x.o);
      return match.by[i] !== "title" && !match.split[i] && !titleMatches(x.o.title, pages[x.j]!.title);
    });
    if (renamed.length) issues.push(`這些原本的頁面被改了標題：${renamed.map((x) => `「${x.o.title}」→「${pages[x.j]!.title}」`).join("、")}。使用者沒有要求修改這些頁，標題請照原文`);
  }
  return issues;
}

/**
 * One-to-one title assignment (got index per wanted title, -1 when missing): the same normalized title first, then a
 * containing / contained title that names no other wanted title. 「Shallow fusion vs. CLAS vs. contextual adapters」 is
 * never 「Shallow fusion」 — the loose `titleMatches` let one comparison page stand for three pages (eval deck_add_page).
 */
export function assignTitles(want: string[], got: string[]): number[] {
  const used = new Set<number>();
  const at = want.map(() => -1);
  want.forEach((w, i) => {
    const j = got.findIndex((g, k) => !used.has(k) && !!norm(w) && norm(w) === norm(g));
    if (j >= 0) (at[i] = j), used.add(j);
  });
  want.forEach((w, i) => {
    if (at[i]! >= 0) return;
    const j = got.findIndex((g, k) => !used.has(k) && titleMatches(w, g) && !want.some((x, m) => m !== i && norm(x) !== norm(w) && titleMatches(x, g)));
    if (j >= 0) (at[i] = j), used.add(j);
  });
  return at;
}

/** The item whose title is this title: the same normalized title, else the one unambiguous containing / contained one. */
export function findByTitle<T>(items: T[], title: string, titleOf: (x: T) => string): T | undefined {
  const t = norm(title);
  if (!t) return undefined;
  const exact = items.find((x) => norm(titleOf(x)) === t);
  if (exact) return exact;
  const loose = items.filter((x) => titleMatches(titleOf(x), title));
  return loose.length === 1 ? loose[0] : undefined;
}

/** Pages that appear twice: the same title more often than the outline has it, or the same slide body (≥ 120 chars). */
/** The deck's cover title (front matter `title:`) of a full source. */
export function coverTitleOf(full: unknown): string | null {
  if (typeof full !== "string") return null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(full.trimStart());
  const t = fm ? /^title:\s*(.+)$/m.exec(fm[1]!)?.[1] : undefined;
  return t ? t.trim().replace(/^["']|["']$/g, "") : null;
}
/** 「第 1 頁和封面同一個標題」: the first page repeats the cover (front matter title), or two neighbouring pages share a title. */
export function coverRepeat(slides: Slide[], full: unknown): string | null {
  const cover = coverTitleOf(full);
  const first = slides[0];
  if (cover && first && norm(first.title) && norm(first.title) === norm(cover)) return `第 1 頁「${first.title}」和封面的標題一樣（封面由系統產生，不要再做一頁題目頁）。`;
  for (let i = 1; i < slides.length; i++) if (norm(slides[i]!.title) && norm(slides[i]!.title) === norm(slides[i - 1]!.title)) return `第 ${i} 頁和第 ${i + 1} 頁的標題都是「${slides[i]!.title}」。`;
  return null;
}

export function duplicatePages(slides: Slide[], want: string[] = []): string[] {
  const out: string[] = [];
  const count = (xs: string[], t: string) => xs.filter((x) => norm(x) === t).length;
  const seen = new Set<string>();
  for (const s of slides) {
    const t = norm(s.title);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const n = count(slides.map((x) => x.title), t);
    if (n > Math.max(1, count(want, t))) out.push(`「${s.title}」出現 ${n} 次`);
  }
  const bodies = new Map<string, Slide>();
  for (const s of slides) {
    const b = s.body.replace(/\s+/g, "");
    if (b.length < 120) continue;
    const first = bodies.get(b);
    if (first && norm(first.title) !== norm(s.title)) out.push(`第 ${first.index} 頁「${first.title}」與第 ${s.index} 頁「${s.title}」內容完全相同`);
    else if (!first) bodies.set(b, s);
  }
  return out;
}

/** Outline titles vs. the deck: missing (one-to-one), duplicated, out of order (`ordered`). */
export function outlineIssues(want: string[], slides: Slide[], ordered = true): string[] {
  const got = slides.map((s) => s.title);
  const at = assignTitles(want, got);
  const issues: string[] = [];
  const missing = want.filter((_, i) => at[i]! < 0);
  if (missing.length) issues.push(`缺少這些頁面：${missing.map((m) => `「${m}」`).join("、")}`);
  const placed = at.filter((j) => j >= 0);
  if (ordered && placed.some((j, k) => k > 0 && j < placed[k - 1]!)) issues.push("頁面順序和大綱不一致");
  const dups = duplicatePages(slides, want);
  if (dups.length) issues.push(`有重複的頁面：${dups.join("、")}`);
  return issues;
}

export const PLACEHOLDER_RE = /〔\s*　*\s*〕|待補|待填|待完成|\bTODO\b|\bTBD\b|lorem ipsum|\bXXX\b|\?\?\?|〔[^〕]{0,6}〕|\[(?:插入|在此|placeholder)[^\]]*\]|（此處[^）]{0,20}）/i;

/**
 * Last-resort cleanup of placeholders the writers left after their fix rounds (e.g. the template's 「距上次新數字：〔N〕 週」):
 * on every page except the student's own, a slide line (or the `｜` segment of it, or the table row) holding a placeholder
 * is dropped and so is a speaker-note sentence; code fences stay as they are. Empty divs left behind are removed.
 */
export function scrubPlaceholders(body: string, ownedTitles: string[] = []): { body: string; removed: number; pages: string[] } {
  let removed = 0;
  const pages: string[] = [];
  const parts = body.replace(/\r\n/g, "\n").split(/^(?=## )/m);
  const out = parts.map((part) => {
    if (!part.startsWith("## ")) return part;
    const title = part.slice(3, part.indexOf("\n") < 0 ? undefined : part.indexOf("\n")).replace(/\{[^}]*\}\s*$/, "").trim();
    if (ownedTitles.some((t) => titleMatches(t, title)) || !PLACEHOLDER_RE.test(part.replace(/```[\s\S]*?```/g, ""))) return part;
    let fence = false;
    let notes = false;
    const before = removed;
    const lines = part.split("\n").flatMap((line, i) => {
      if (i === 0) return [line];
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence || /^\s*```/.test(line)) return [line];
      if (/^:::+\s*\{?\.?notes\}?\s*$/.test(line)) { notes = true; return [line]; }
      if (notes && /^:::+\s*$/.test(line)) { notes = false; return [line]; }
      if (!PLACEHOLDER_RE.test(line)) return [line];
      removed++;
      if (notes) {
        const kept = line.split(/(?<=[。！？!?])/).filter((s) => !PLACEHOLDER_RE.test(s)).join("").trim();
        return kept ? [kept] : [];
      }
      if (/^\s*\|/.test(line)) return [];
      if (/｜/.test(line)) {
        const segs = line.split("｜").filter((s) => !PLACEHOLDER_RE.test(s));
        return segs.length && segs.join("").trim() ? [segs.join("｜").trim()] : [];
      }
      return [];
    });
    if (removed > before) pages.push(title);
    return lines.join("\n").replace(/^:::+\s*\{[^}]*\}\s*\n(?:\s*\n)*:::+\s*$\n?/gm, "");
  });
  return { body: out.join(""), removed, pages };
}

/** Missing-data markers that must not be shown on a slide (they are fine in speaker notes). */
export const SLIDE_MISSING_RE = /資料未提供|摘要未提供|論文未提供|未提供數據|未報告|\bN\/A\b|\bn\/a\b|not (?:reported|provided|available)/i;

type Ctx = { params: Record<string, unknown>; data: unknown };
type CheckFn = (text: string, ctx: Ctx) => { ok: boolean; detail: string };

/** Content refs of a step output (`data.refs`, see lib/slides/content-lint.ts); empty when the run has none. */
const refsOf = (data: unknown): ContentRefs => ((data as { refs?: ContentRefs } | null)?.refs ?? {});
/**
 * Slides of a deck body; a document (`params.doc`, or no `## ` slides) is checked as one unit. `allow_titles` =
 * student-owned pages: their content is the student's own answer (or study data), not the paper's.
 */
const unitsOf = (text: string, params: Record<string, unknown>): LintSlide[] => {
  const slides = params.doc ? [] : parseSlides(text);
  if (!slides.length) return [{ title: "", body: text, notes: "", index: 0 }];
  const allow = strs(params.allow_titles);
  return slides.filter((s) => !allow.some((a) => titleMatches(a, s.title)));
};
const contentResult = (issues: string[], okText: string, lead: string) =>
  issues.length ? { ok: false, detail: `${lead}${issues.slice(0, 8).join("；")}。` } : { ok: true, detail: okText };

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Unclosed structures of a text (code fences, ::: blocks, \begin/\end, $$): the deterministic truncation signal. */
export function unbalanced(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  const fences = lines.filter((l) => /^\s*```/.test(l)).length;
  if (fences % 2) out.push("程式碼區塊（```）沒有關閉");
  let depth = 0;
  for (const l of lines) {
    // A closing fence is colons only (`:::`, `::::` for nested columns); an opening one has attributes or a class after
    // the colons. `[^:\s]` keeps `::::` from matching as "`:::` + text" by backtracking.
    if (/^:{3,}\s*[^:\s]/.test(l)) depth++;
    else if (/^:{3,}\s*$/.test(l)) depth = Math.max(0, depth - 1);
  }
  if (depth > 0) out.push("::: 區塊沒有關閉");
  const begins = (text.match(/\\begin\{/g) ?? []).length;
  const ends = (text.match(/\\end\{/g) ?? []).length;
  if (begins !== ends) out.push(`\\begin 與 \\end 數量不一致（${begins} / ${ends}）`);
  const dollars = (text.replace(/\\\$/g, "").match(/\$\$/g) ?? []).length;
  if (dollars % 2) out.push("$$ 公式沒有關閉");
  return out;
}

export const CHECKS: Record<string, CheckFn> = {
  min_length(text, { params }) {
    const min = num(params.chars, 200);
    return text.trim().length >= min ? { ok: true, detail: `長度 ${text.trim().length} 字` } : { ok: false, detail: `內容太短：${text.trim().length} 字，至少需要 ${min} 字。` };
  },
  source_refs(text, { params }) {
    const min = num(params.min, 3);
    const n = (text.match(/§\s*\d|p\.\s*\d|頁\s*\d|第\s*\d+\s*頁|Table\s*\d|表\s*\d|Fig(?:ure|\.)\s*\d|圖\s*\d|〈[^〉]{2,}〉/g) ?? []).length;
    return n >= min ? { ok: true, detail: `標註了 ${n} 處出處` } : { ok: false, detail: `出處標註不足：只有 ${n} 處，至少需要 ${min} 處（例如（§3.2，p. 4）、表 2、〈筆記名稱〉）。` };
  },
  /** Page count; with `titles` (the outline) also every outline page there once, in order, and no page twice. */
  slide_count(text, { params, data }) {
    const want = num(params.expected, 0);
    const slides = parseSlides(text);
    const got = slides.length;
    if (got !== want) return { ok: false, detail: `頁數不符：應為 ${want} 頁，實際 ${got} 頁（每頁以「## 標題」開頭）。` };
    // A new deck: the cover is the front matter; a first page with the same title repeats it (production 301b6e1a).
    const cover = params.no_cover_repeat ? coverRepeat(slides, (data as { full?: unknown } | null)?.full) : null;
    if (cover) return { ok: false, detail: cover };
    const titles = strs(params.titles);
    const issues = titles.length ? outlineIssues(titles, slides) : [];
    return issues.length ? { ok: false, detail: `頁數對，但頁面和大綱不一致：${issues.join("；")}。` } : { ok: true, detail: `共 ${got} 頁${titles.length ? "，與大綱一致" : ""}` };
  },
  slide_titles(text, { params }) {
    const issues = outlineIssues(strs(params.titles), parseSlides(text), params.ordered === true);
    return issues.length ? { ok: false, detail: `${issues.join("；")}。` } : { ok: true, detail: "頁面標題與大綱一致" };
  },
  speaker_notes(text, { params }) {
    const min = num(params.min_chars, 30);
    const allow = strs(params.allow_titles);
    const bad = parseSlides(text).filter((s) => s.notes.replace(/\s+/g, "").length < min && !allow.some((a) => titleMatches(a, s.title)));
    return bad.length ? { ok: false, detail: `這些頁面沒有講稿或講稿太短（< ${min} 字）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。` } : { ok: true, detail: "每頁都有講稿" };
  },
  no_placeholder(text, { params }) {
    const allow = strs(params.allow_titles);
    const slides = parseSlides(text);
    if (slides.length) {
      const bad = slides.filter((s) => !allow.some((a) => titleMatches(a, s.title)) && PLACEHOLDER_RE.test(`${s.body}\n${s.notes}`));
      if (bad.length) return { ok: false, detail: `這些頁面還有佔位文字（〔　〕、待補、TODO…）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請填入依據資料的內容；資料裡真的沒有就明寫「資料未提供」。` };
      // Decks (`on_slide: true`): 「資料未提供」 is fine in the notes, never on the slide itself (an empty table cell or
      // bullet the audience reads). The writer drops that row / column / bullet instead.
      const missing = params.on_slide ? slides.filter((s) => !allow.some((a) => titleMatches(a, s.title)) && SLIDE_MISSING_RE.test(s.body)) : [];
      if (missing.length) return { ok: false, detail: `這些頁面的投影片上寫了「資料未提供／N/A」：${missing.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。投影片上不要出現沒有資料的格子或條列：刪掉那一列、那一欄或那一條（或改放有數字的比較），說明可以寫在講稿。` };
      return { ok: true, detail: "沒有佔位文字" };
    }
    const m = PLACEHOLDER_RE.exec(text);
    return m ? { ok: false, detail: `內容還有佔位文字「${m[0]}」。` } : { ok: true, detail: "沒有佔位文字" };
  },
  not_truncated(text) {
    const t = text.trimEnd();
    const problems = unbalanced(t);
    if (!t) problems.push("內容是空的");
    const slides = parseSlides(t);
    const last = slides.at(-1);
    if (last && !last.body && !last.notes) problems.push(`最後一頁「${last.title}」是空的，可能被截斷`);
    return problems.length ? { ok: false, detail: `輸出不完整：${problems.join("；")}。` } : { ok: true, detail: "輸出完整" };
  },
  slide_length(text, { params }) {
    const maxChars = num(params.max_chars, 1100);
    const maxBullets = num(params.max_bullets, 9);
    const bad = parseSlides(text).filter((s) => {
      // Diagram / chart / mermaid specs are not slide text (their size is checked by diagram_syntax): a diagram's JSON
      // counted here made most topic-deck method pages fail and take a fix round on staging.
      const visible = s.body.replace(/```[^\n]*\n[\s\S]*?```/g, "");
      return visible.length > maxChars || (visible.match(/^\s*[-*+] /gm) ?? []).length > maxBullets;
    });
    return bad.length ? { ok: false, detail: `這些頁面內容太多，投影片放不下（> ${maxChars} 字或 > ${maxBullets} 個條列）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請精簡或移到講稿。` } : { ok: true, detail: "每頁份量適中" };
  },
  /** Slide density: visible bullets and words per slide (code, charts, notes excluded; CJK chars count as ½ word). */
  slide_density(text, { params }) {
    const maxBullets = num(params.max_bullets, 6);
    const maxWords = num(params.max_words, 75);
    const allow = strs(params.allow_titles);
    const bad: string[] = [];
    for (const s of parseSlides(text)) {
      if (allow.some((a) => titleMatches(a, s.title))) continue;
      const w = visibleWords(s.body);
      const b = (s.body.replace(/^```[\s\S]*?^```/gm, "").match(/^\s*(?:[-*+]|\d+\.) /gm) ?? []).length;
      if (w > maxWords || b > maxBullets) bad.push(`第 ${s.index} 頁「${s.title}」（約 ${w} 字詞、${b} 個條列）`);
    }
    return bad.length ? { ok: false, detail: `這些頁面文字太多（上限約 ${maxWords} 字詞、${maxBullets} 個條列；中文 2 字算 1 詞）：${bad.join("、")}。保留一個重點，把細節移到講稿，改用圖、表或圖表呈現。` } : { ok: true, detail: "每頁文字量適中" };
  },
  /** Mermaid cells lint (```{mermaid}); a plain ```mermaid fence would show as raw code. */
  diagram_syntax(text) {
    const problems: string[] = [];
    if (/^```\s*mermaid\b/m.test(text)) problems.push("Mermaid 必須寫成 ```{mermaid}（加大括號），```mermaid 會直接顯示成程式碼");
    mermaidBlocks(text).forEach((code, i) => {
      for (const issue of lintMermaid(code)) problems.push(`第 ${i + 1} 張圖：${issue}`);
    });
    for (const c of chartBlocks(text)) if (!c.spec) problems.push(`有一個 \`\`\`chart 區塊不是有效的圖表 JSON：${c.source.slice(0, 80)}`);
    problems.push(...lintDiagrams(text));
    return problems.length ? { ok: false, detail: `圖表語法有問題：${problems.slice(0, 8).join("；")}。` } : { ok: true, detail: "圖與圖表語法正確" };
  },
  /** At least `min_ratio` of content slides carry a visual (diagram, chart, figure, image, table). */
  visual_ratio(text, { params }) {
    const ratio = num(params.min_ratio, 0.5);
    const allow = strs(params.allow_titles);
    const slides = parseSlides(text).filter((s) => !allow.some((a) => titleMatches(a, s.title)));
    if (!slides.length) return { ok: true, detail: "（沒有內容頁）" };
    const without = slides.filter((s) => !hasVisual(s.body));
    const have = slides.length - without.length;
    const need = Math.ceil(slides.length * ratio);
    return have >= need ? { ok: true, detail: `${have}/${slides.length} 頁有視覺元素` } : { ok: false, detail: `只有 ${have}/${slides.length} 頁有圖、表或圖表（至少需要 ${need} 頁）。這些頁面只有文字：${without.slice(0, 8).map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請改用 Mermaid 流程圖、\`\`\`chart 圖表、論文圖（paper-fig）或表格。` };
  },
  /**
   * Result of the slides playbook's screenshot QA (`data.visualQa`): fails only on hard defects (`failed`: overflow, raw
   * diagram code, text < 16 px, a defect on the screenshot); soft problems left (`soft`) are report notes.
   */
  visual_qa(_text, { data }) {
    const qa = (data as { visualQa?: { failed?: number[]; soft?: number[]; scored?: number; vision?: boolean; unseen?: boolean } } | null)?.visualQa;
    if (!qa) return { ok: false, detail: "還沒有做逐頁視覺檢查。" };
    if (qa.unseen) return { ok: false, detail: "最後一輪沒有擷取到投影片截圖，版面沒有真的檢查過；請重新編譯預覽後再檢查。" };
    const failed = qa.failed ?? [];
    const soft = qa.soft ?? [];
    if (failed.length) return { ok: false, detail: `這些頁面有版面硬傷（超出、原始碼外露、字太小或截圖上看到的缺陷）：${failed.map((n) => `第 ${n} 頁`).join("、")}。` };
    return { ok: true, detail: `${qa.scored ?? 0} 頁沒有版面硬傷（${qa.vision ? "截圖" : "版面量測"}檢查）${soft.length ? `；${soft.map((n) => `第 ${n} 頁`).join("、")}的版面建議列入報告` : ""}` };
  },
  sections_present(text, { params }) {
    const want = strs(params.sections);
    const heads = [...[...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1]!.trim()), ...[...text.matchAll(/\\(?:chapter|(?:sub)*section)\*?\{([^}]*)\}/g)].map((m) => m[1]!.trim())];
    const missing = want.filter((w) => !heads.some((h) => titleMatches(w, h)));
    return missing.length ? { ok: false, detail: `缺少這些段落標題：${missing.map((m) => `「${m}」`).join("、")}。` } : { ok: true, detail: `涵蓋 ${want.length} 個段落` };
  },
  citations(text, { params }) {
    const keys = new Set(strs(params.keys));
    const min = num(params.min, 0);
    const used = new Set<string>();
    for (const m of text.matchAll(/\[@([^\]\s;,]+)/g)) used.add(m[1]!);
    for (const m of text.matchAll(/@([A-Za-z][\w:.-]*\d{2,4}[\w:.-]*)/g)) if (keys.has(m[1]!)) used.add(m[1]!);
    for (const m of text.matchAll(/\\(?:no)?cite[pt]?\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) for (const k of m[1]!.split(",")) used.add(k.trim());
    const unknown = [...used].filter((k) => k && !keys.has(k));
    if (unknown.length) return { ok: false, detail: `這些引用鍵不在研究的文獻庫中：${unknown.slice(0, 10).join("、")}。只能使用：${[...keys].slice(0, 30).join("、") || "（文獻庫是空的）"}。` };
    if (used.size < min) return { ok: false, detail: `引用太少：用了 ${used.size} 個，至少需要 ${min} 個（可用：${[...keys].slice(0, 30).join("、")}）。` };
    return { ok: true, detail: `引用 ${used.size} 筆，皆在文獻庫中` };
  },
  equations(text, { params }) {
    const min = num(params.min, 1);
    const n = (text.match(/\$\$[\s\S]+?\$\$/g) ?? []).length + (text.match(/\\\[[\s\S]+?\\\]/g) ?? []).length + (text.match(/(?<![$\\])\$[^$\n]{2,}\$(?!\$)/g) ?? []).length;
    return n >= min ? { ok: true, detail: `${n} 個公式` } : { ok: false, detail: `公式不足：找到 ${n} 個，至少需要 ${min} 個（用 LaTeX：$…$ 或 $$…$$）。` };
  },
  table_rows(text, { params }) {
    const min = num(params.min, 2);
    const rows = text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l));
    const data = Math.max(0, rows.length - 1);
    return data >= min ? { ok: true, detail: `表格 ${data} 列` } : { ok: false, detail: `表格資料列不足：${data} 列，至少需要 ${min} 列（Markdown 表格）。` };
  },
  chart_blocks(text, { params }) {
    const min = num(params.min, 1);
    const blocks = [...text.matchAll(/```chart\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const bad = blocks.filter((b) => {
      try {
        const j = JSON.parse(b) as { labels?: unknown; series?: unknown };
        return !Array.isArray(j.series) || !(Array.isArray(j.labels) || (j as { type?: string }).type === "scatter");
      } catch {
        return true;
      }
    });
    if (bad.length) return { ok: false, detail: `${bad.length} 個 \`\`\`chart 區塊不是有效的 JSON（需要 labels 與 series）。` };
    return blocks.length >= min ? { ok: true, detail: `${blocks.length} 張圖表` } : { ok: false, detail: `需要至少 ${min} 張 \`\`\`chart 圖表，找到 ${blocks.length} 張。` };
  },
  numbers_from_source(text, { params }) {
    const source = String(params.source ?? "");
    const tables = text.split("\n").filter((l) => /^\s*\|/.test(l)).join("\n");
    const charts = [...text.matchAll(/```chart\s*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    const nums = [...`${tables}\n${charts}`.matchAll(/(?<![\w.])\d+\.\d+|(?<![\w.])\d{2,}(?![\w])/g)].map((m) => m[0]);
    const missing = [...new Set(nums)].filter((n) => !source.includes(n) && !source.includes(String(Number(n))));
    return missing.length ? { ok: false, detail: `表格或圖表中的這些數字在原始資料裡找不到：${missing.slice(0, 12).join("、")}。只能使用資料中的數字。` } : { ok: true, detail: `${nums.length} 個數字皆可在資料中找到` };
  },
  /** Model / dataset / method names that the sources (brief, paper, request) never mention (`data.refs.terms`). */
  grounded_names(text, { data, params }) {
    const terms = refsOf(data).terms;
    if (!terms?.length) return { ok: true, detail: "（沒有來源名稱表，略過）" };
    return contentResult(formatIssues(nameIssues(unitsOf(text, params), terms)), "提到的模型、資料集與方法名稱都在來源裡", "有來源找不到的名稱（可能是捏造）：");
  },
  /** paper-fig crops vs their Fig. N (the measured figure list, `data.refs.figures`) and figure numbers in text / notes. */
  figure_refs(text, { data, params }) {
    return contentResult(formatIssues(figureIssues(unitsOf(text, params), refsOf(data).figures ?? [])), "圖號與放的論文圖一致", "論文圖與圖號對不上：");
  },
  /** trainable / frozen markers vs the sources, parallel items drawn as a flow. */
  diagram_semantics(text, { data, params }) {
    return contentResult(formatIssues(diagramIssues(unitsOf(text, params), refsOf(data))), "流程圖的語意正確", "圖的語意有問題：");
  },
  /** One unit per axis, an axis label / unit on every chart, the same numbers charted once. */
  chart_semantics(text, { params }) {
    return contentResult(formatIssues(chartIssues(unitsOf(text, params))), "圖表的單位與資料正確", "圖表有問題：");
  },
  /**
   * Original pages of an edited deck kept (revise / expand). On the outline step (`originals` + `data.outline`): every
   * original matched to a planned page, in order, titles kept when `keep_titles`. On the deck (`titles`): the plan's
   * pages for those originals are all there, in order.
   */
  pages_kept(text, { params, data }) {
    const ordered = params.ordered !== false;
    const originals = (Array.isArray(params.originals) ? params.originals : []) as OriginalPage[];
    const outline = (data as { outline?: PlannedPage[] } | null)?.outline;
    if (originals.length && outline) {
      const issues = keptIssues(originals, outline, matchOriginals(originals, outline, { translate: !!params.translate }), { ordered, keepTitles: !!params.keep_titles });
      return issues.length ? { ok: false, detail: `${issues.join("；")}。` } : { ok: true, detail: `原本的 ${originals.length} 頁都保留${ordered ? "，順序不變" : ""}` };
    }
    const want = strs(params.titles);
    const at = assignTitles(want, parseSlides(text).map((s) => s.title));
    const lost: string[] = [];
    let last = -1;
    want.forEach((w, i) => {
      const j = at[i]!;
      if (j < 0 || (ordered && j < last)) lost.push(w);
      else last = j;
    });
    return lost.length ? { ok: false, detail: `原本的這些頁面不見了${ordered ? "或順序被改了" : ""}：${lost.map((t) => `「${t}」`).join("、")}。` } : { ok: true, detail: `原本的 ${want.length} 頁都保留${ordered ? "，順序不變" : ""}` };
  },
  render_ok(_text, { data }) {
    const err = (data as { renderError?: string | null; renderTimedOut?: boolean } | null) ?? null;
    if (err?.renderTimedOut) return { ok: false, detail: "預覽編譯逾時，無法確認能否編譯。" };
    return err?.renderError ? { ok: false, detail: `編譯失敗：${err.renderError.slice(-800)}` } : { ok: true, detail: "預覽編譯成功" };
  },
  compile_ok(_text, { data }) {
    const d = (data as { compile?: { status: string; errors: string[] } } | null)?.compile;
    if (!d) return { ok: true, detail: "（沒有編譯）" };
    return d.status === "success" || (d.status === "partial" && !d.errors.length) ? { ok: true, detail: "LaTeX 編譯成功" } : { ok: false, detail: `LaTeX 編譯有錯誤：${d.errors.slice(0, 5).join("；") || d.status}` };
  },
};

/** Visible words of a slide body: code/diagram/chart blocks, HTML tags, images and Markdown syntax removed. */
export function visibleWords(body: string): number {
  const t = body
    .replace(/^```[\s\S]*?^```/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[.#][^}]*\}/g, " ")
    .replace(/^:::.*$/gm, " ")
    .replace(/\$[^$]*\$/g, " x ");
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (t.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][\w'.%-]*/g) ?? []).length;
  return Math.round(latin + cjk / 2);
}

export const hasVisual = (body: string) => /^```\{?\.?(mermaid|chart|diagram|dot)\b|!\[[^\]]*\]\([^)]+\)|^\s*\|.*\|\s*$|<img\b|<svg\b|\.big-number/m.test(body);

export function runChecks(specs: CheckSpec[], text: string, data: unknown): CheckResult[] {
  return specs.map((s) => {
    const fn = CHECKS[s.id];
    if (!fn) return { id: s.id, ok: true, detail: "（未知的檢查，略過）" };
    try {
      const r = fn(text, { params: s.params ?? {}, data });
      return { id: s.id, ...r };
    } catch (e) {
      return { id: s.id, ok: false, detail: `檢查失敗：${(e as Error).message}` };
    }
  });
}
