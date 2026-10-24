/**
 * Section-file scope for generated papers (docs/architecture.md "Workflows" → Goals → 撰寫 LaTeX 論文): a section file is
 * \input by a code-generated main.tex, so it may hold only its own heading and body. Pure helpers: strip what belongs to
 * the main file (preamble, \begin{document}, title block, abstract, bibliography, \input), keep only the section's own
 * top-level block, list scope violations, filter \cite keys to the study library, and find content one section repeats
 * from another (repeated paragraphs / headings). No model is involved; the playbooks decide what to do with the result.
 */

export type HeadingCommand = "chapter" | "section";

const normTitle = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
/** Same title, or one contains the other (「背景」 vs 「背景：串流 RNN-T」). */
export const sameTitle = (a: string, b: string) => {
  const x = normTitle(a);
  const y = normTitle(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))));
};

/** Index just past a balanced `{…}` (or `[…]`) group starting at `i` (which must be the opening bracket); -1 if unbalanced. */
function groupEnd(tex: string, i: number): number {
  const open = tex[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < tex.length; j++) {
    const c = tex[j];
    if (c === "\\") { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return -1;
}

/** Removes every `\name[opt]{arg}…` (up to `args` brace groups, optional groups skipped) — plus the line if nothing else is on it. */
function removeCommand(tex: string, name: string, args: number): { text: string; n: number } {
  const re = new RegExp(`\\\\${name}\\*?(?![A-Za-z@])`, "g");
  let out = "";
  let last = 0;
  let n = 0;
  for (let m = re.exec(tex); m; m = re.exec(tex)) {
    let j = m.index + m[0].length;
    let ok = true;
    for (let a = 0; a < args; ) {
      while (tex[j] === " " || tex[j] === "\t") j++;
      if (tex[j] === "[") { const e = groupEnd(tex, j); if (e < 0) { ok = false; break; } j = e; continue; }
      if (tex[j] !== "{") break;
      const e = groupEnd(tex, j);
      if (e < 0) { ok = false; break; }
      j = e;
      a++;
    }
    if (!ok) continue;
    out += tex.slice(last, m.index);
    last = j;
    re.lastIndex = j;
    n++;
  }
  return { text: n ? out + tex.slice(last) : tex, n };
}

/** Removes `\begin{env}…\end{env}` blocks (non-nested envs only). */
function removeEnv(tex: string, env: string): { text: string; n: number } {
  let n = 0;
  const text = tex.replace(new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?(?:\\\\end\\{${env}\\}|$)`, "g"), () => (n++, ""));
  return { text, n };
}

/** Commands that belong to main.tex (or a document of its own), with their brace-argument counts. */
const MAIN_ONLY: [string, number, string][] = [
  ["documentclass", 1, "\\documentclass"], ["usepackage", 1, "\\usepackage"], ["RequirePackage", 1, "\\usepackage"],
  ["geometry", 1, "版面設定"], ["hypersetup", 1, "版面設定"], ["setCJKmainfont", 1, "字型設定"], ["setmainfont", 1, "字型設定"],
  ["title", 1, "\\title"], ["author", 1, "\\author"], ["date", 1, "\\date"], ["maketitle", 0, "\\maketitle"], ["tableofcontents", 0, "目錄"],
  ["bibliographystyle", 1, "參考文獻設定"], ["bibliography", 1, "參考文獻設定"], ["addbibresource", 1, "參考文獻設定"], ["printbibliography", 0, "參考文獻設定"],
  ["input", 1, "\\input"], ["include", 1, "\\input"],
];
/** Environments a section file never has: the document itself, the paper's abstract / keywords and its own bibliography. */
const MAIN_ENVS: [string, string][] = [["thebibliography", "自己的參考文獻清單"], ["abstract", "摘要"], ["IEEEkeywords", "關鍵字"]];

/**
 * Strips everything that belongs to main.tex from a section file: preamble commands, `\begin{document}` / `\end{document}`
 * (and CJK wrappers), title / author / \maketitle, abstract and keywords, a bibliography of its own, \input / \include, and a
 * title block (centered title, comments) before the first heading. Returns what was removed (deduplicated labels).
 */
export function stripPreamble(tex: string, opts: { keepAbstract?: boolean } = {}): { text: string; removed: string[] } {
  const removed = new Set<string>();
  let t = tex.replace(/\r\n/g, "\n");
  for (const [env, label] of MAIN_ENVS) {
    if (opts.keepAbstract && env !== "thebibliography") continue;
    const r = removeEnv(t, env);
    if (r.n) removed.add(label);
    t = r.text;
  }
  t = t.replace(/\\(?:begin|end)\{document\}/g, () => (removed.add("\\begin{document}"), ""));
  t = t.replace(/\\begin\{CJK\*?\}(?:\{[^}]*\}){0,2}|\\end\{CJK\*?\}/g, () => (removed.add("CJK 環境"), ""));
  for (const [name, args, label] of MAIN_ONLY) {
    const r = removeCommand(t, name, args);
    if (r.n) removed.add(label);
    t = r.text;
  }
  t = t.replace(/^\s*\\keywords?\{[^}]*\}\s*$/gm, () => (removed.add("關鍵字"), ""));
  t = t.replace(/^\s*\\bibitem(?:\[[^\]]*\])?\{[^}]*\}.*$/gm, () => (removed.add("自己的參考文獻清單"), ""));
  // A title block before the first heading (centered title, \vspace, comments) is the paper's front matter.
  const first = /\\(?:chapter|section)\*?\{/.exec(t);
  if (first && first.index > 0) {
    const head = t.slice(0, first.index);
    const prose = head.replace(/^\s*%.*$/gm, "").replace(/\\begin\{center\}[\s\S]*?\\end\{center\}/g, "").replace(/\\(?:vspace|noindent|bigskip|medskip|newpage|clearpage)\*?(?:\{[^}]*\})?/g, "").trim();
    if (!prose || (head.includes("\\begin{center}") && !/\\(?:sub)+section|\\begin\{(?:table|figure|tabular)/.test(head))) {
      if (/\S/.test(head.replace(/^\s*%.*$/gm, ""))) removed.add("標題區塊");
      t = t.slice(first.index);
    }
  }
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: t, removed: [...removed] };
}

/** Top-level heading blocks of a text (`\section{…}` / `\chapter{…}` → the text up to the next one); the head before the first is index -1. */
export function headingBlocks(tex: string, command: HeadingCommand): { title: string; start: number; end: number }[] {
  const re = new RegExp(`\\\\${command}\\*?\\{`, "g");
  const out: { title: string; start: number; end: number }[] = [];
  for (let m = re.exec(tex); m; m = re.exec(tex)) {
    const open = m.index + m[0].length - 1;
    const e = groupEnd(tex, open);
    const title = e > 0 ? tex.slice(open + 1, e - 1).trim() : "";
    if (out.length) out.at(-1)!.end = m.index;
    out.push({ title, start: m.index, end: tex.length });
  }
  return out;
}

/**
 * Keeps only the section's own top-level block: blocks headed by ANOTHER planned section are dropped (the writer wrote its
 * neighbour's part); other extra top-level headings are demoted to \subsection (\section for a thesis chapter).
 */
export function keepOwnSection(tex: string, opts: { index: number; titles: string[]; command: HeadingCommand }): { text: string; dropped: string[]; demoted: string[] } {
  const blocks = headingBlocks(tex, opts.command);
  if (blocks.length <= 1) return { text: tex, dropped: [], demoted: [] };
  const own = opts.titles[opts.index] ?? "";
  const others = opts.titles.filter((_, j) => j !== opts.index);
  let ownAt = blocks.findIndex((b) => sameTitle(b.title, own) && !others.some((o) => normTitle(o) === normTitle(b.title)));
  if (ownAt < 0) ownAt = blocks.findIndex((b) => !others.some((o) => sameTitle(b.title, o)));
  if (ownAt < 0) ownAt = 0;
  const lower = opts.command === "chapter" ? "section" : "subsection";
  const dropped: string[] = [];
  const demoted: string[] = [];
  let out = tex.slice(0, blocks[0]!.start);
  blocks.forEach((b, j) => {
    const body = tex.slice(b.start, b.end);
    if (j === ownAt) { out += body; return; }
    if (others.some((o) => sameTitle(b.title, o))) { dropped.push(b.title); return; }
    demoted.push(b.title);
    out += body.replace(new RegExp(`^\\\\${opts.command}\\*?\\{`), `\\${lower}{`);
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), dropped, demoted };
}

const INTRO_RE = /intro|緒論|前言|引言|導論/i;
const CONCLUSION_RE = /conclu|結論|總結|結語|summary/i;
/** Headings only the paper's front / back matter has. */
const FRONT_HEADING_RE = /^(?:摘要|abstract|關鍵字|keywords?)$/i;
const BACK_HEADING_RE = /^(?:參考文獻|references|bibliography|致謝|acknowledg(?:e)?ments?)$/i;
/** Whole-paper framing: an introduction's roadmap ("the rest of this paper…", 「本文其餘章節安排如下」). */
const ROADMAP_RE = /\b(?:the\s+)?(?:rest|remainder)\s+of\s+(?:this|the)\s+(?:paper|survey|article|review)\b|\bthis\s+(?:paper|survey|article|review)\s+is\s+(?:organi[sz]ed|structured)\b|本(?:文|論文|綜述)(?:其餘|其他|後續)?(?:的)?(?:章節|各節|內容)?(?:組織|安排|架構|結構)如下|本(?:文|論文|綜述)(?:其餘|其他|後續)(?:章節|各節)/i;
/** Whole-paper framing: stating what the whole paper does (fine in the introduction and the conclusion only). */
const PAPER_FRAME_RE = /\b(?:in|throughout)\s+this\s+(?:paper|survey|article|review|work),?\s+we\b|\bthis\s+(?:paper|survey|article|review)\s+(?:presents|proposes|reviews|surveys|summari[sz]es|introduces)\b|本(?:文|論文|綜述)(?:旨在|提出了?|將依|整理並比較|綜述了|回顧了|以[^，。]{1,20}為核心)/i;

/** What `stripPreamble` should have removed, as listed in an issue. */
const MAIN_LEFTOVERS: [RegExp, string][] = [
  [/\\documentclass/, "\\documentclass"], [/\\begin\{document\}/, "\\begin{document}"], [/\\usepackage/, "\\usepackage"], [/\\maketitle|\\title\{/, "\\title／\\maketitle"],
  [/\\begin\{thebibliography\}|\\bibitem/, "thebibliography"], [/\\begin\{abstract\}/, "abstract"], [/\\(?:input|include)\{/, "\\input"],
];

const clipQ = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Scope violations of a section file (after stripping, these are what the stripper could not fix): anything that belongs
 * to main.tex, a second top-level heading or a heading of another planned section, front / back matter headings, and
 * whole-paper framing outside the introduction (a roadmap) or outside the introduction and conclusion (paper summary).
 */
export function scopeIssues(tex: string, opts: { index: number; titles: string[]; command: HeadingCommand }): string[] {
  const issues: string[] = [];
  const own = opts.titles[opts.index] ?? "";
  const intro = INTRO_RE.test(own) || (opts.index === 0 && !CONCLUSION_RE.test(own));
  const conclusion = CONCLUSION_RE.test(own) || (opts.index === opts.titles.length - 1 && opts.titles.length > 1 && !intro);
  const main = MAIN_LEFTOVERS.filter(([re]) => re.test(tex)).map(([, label]) => label);
  if (main.length) issues.push(`章節檔不能有屬於主檔的內容（${main.join("、")}）：前言、摘要、參考文獻都由主檔產生，只寫這一節的內文。`);
  const tops = headingBlocks(tex, opts.command);
  if (tops.length > 1) issues.push(`這個檔案只能有一個 \\${opts.command}（「${clipQ(own)}」），卻有 ${tops.length} 個：${tops.map((b) => `「${clipQ(b.title, 20)}」`).join("、")}；小節請用 \\${opts.command === "chapter" ? "section" : "subsection"}。`);
  const subs = [...tex.matchAll(/\\(?:chapter|(?:sub)*section)\*?\{([^}]*)\}/g)].map((m) => m[1]!.trim());
  const others = opts.titles.filter((_, j) => j !== opts.index);
  const foreign = subs.filter((h) => !sameTitle(h, own) && others.some((o) => normTitle(o) === normTitle(h)));
  if (foreign.length) issues.push(`寫到了其他節的標題：${foreign.map((h) => `「${clipQ(h, 20)}」`).join("、")}；那些內容由其他節負責。`);
  const matter = subs.filter((h) => FRONT_HEADING_RE.test(h.trim()) || BACK_HEADING_RE.test(h.trim()) || (!intro && INTRO_RE.test(h) && !sameTitle(h, own)) || (!conclusion && /^(?:結論|conclusions?)$/i.test(h.trim())));
  if (matter.length) issues.push(`這一節不該有自己的${matter.map((h) => `「${clipQ(h, 20)}」`).join("、")}：摘要、緒論、結論與參考文獻各自由對應的節或主檔負責。`);
  const plain = tex.replace(/^\s*%.*$/gm, "");
  if (!intro) {
    const road = ROADMAP_RE.exec(plain);
    if (road) issues.push(`只有緒論可以介紹整篇論文的章節安排（「${clipQ(road[0])}」）；這一節只寫本節內容。`);
    const frame = !conclusion ? PAPER_FRAME_RE.exec(plain) : null;
    if (frame) issues.push(`這一節不該重新介紹整篇論文（「${clipQ(frame[0])}」）；從本節主題直接開始。`);
  }
  return issues;
}

// ---------------------------------------------------------------- citations

const CITE_RE = /\\(?:no)?cite(?:[pt]|author|year|alp|alt)?\*?((?:\s*\[[^\]]*\])*)\s*\{([^}]*)\}/g;

/** Every \cite key of a text, in order of first use. */
export function citeKeys(tex: string): string[] {
  const out: string[] = [];
  for (const m of tex.matchAll(CITE_RE)) for (const k of m[2]!.split(",")) { const key = k.trim(); if (key && !out.includes(key)) out.push(key); }
  return out;
}

export const unknownCites = (tex: string, keys: readonly string[]) => citeKeys(tex).filter((k) => !keys.includes(k));

/** Drops \cite keys that are not in `keys`; a \cite left empty is removed with the space / tie before it. */
export function dropUnknownCites(tex: string, keys: readonly string[]): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const text = tex.replace(new RegExp(`(~|[ \\t]*)${CITE_RE.source}`, "g"), (all, lead: string, opt: string, list: string) => {
    const parts = list.split(",").map((k) => k.trim()).filter(Boolean);
    const kept = parts.filter((k) => keys.includes(k));
    for (const k of parts) if (!kept.includes(k) && !dropped.includes(k)) dropped.push(k);
    if (kept.length === parts.length) return all;
    if (!kept.length) return "";
    const cmd = all.slice(lead.length, all.indexOf(opt ? opt : "{", lead.length));
    return `${lead}${cmd}${opt}{${kept.join(",")}}`;
  });
  return { text, dropped };
}

// ---------------------------------------------------------------- overlap across sections

/** Plain text of a LaTeX paragraph for comparison: commands, math, braces, whitespace and punctuation removed. */
function plainOf(par: string): string {
  return par
    .replace(/^\s*%.*$/gm, "")
    .replace(/\\(?:cite[pt]?|ref|eqref|label)\*?\{[^}]*\}/g, "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/\\[A-Za-z@]+\*?/g, "")
    .normalize("NFKC").toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

const shingles = (s: string, n = 6) => {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
};

/** Generic sub-headings two sections may share without repeating each other. */
const GENERIC_HEADING_RE = /^(?:小結|本節小結|小節|總結|摘要|summary|overview|概述|討論|discussion|例子|範例|examples?|定義|definitions?)$/i;

export type Overlap = { later: number; earlier: number; kind: "heading" | "paragraph"; sample: string };

/**
 * Content a later section repeats from an earlier one: a sub-heading with the same title as an earlier section's heading
 * or sub-heading (generic ones like 小結 excepted), or a paragraph (≥ `minChars` of plain text) whose 6-gram shingles are
 * ≥ `threshold` contained in an earlier paragraph. Section `i` = `texts[i]`; empty texts are skipped.
 */
export function sectionOverlap(texts: string[], opts: { minChars?: number; threshold?: number } = {}): Overlap[] {
  const minChars = opts.minChars ?? 60;
  const threshold = opts.threshold ?? 0.6;
  const out: Overlap[] = [];
  const heads = texts.map((t) => [...t.matchAll(/\\(?:chapter|(?:sub)*section)\*?\{([^}]*)\}/g)].map((m) => m[1]!.trim()).filter((h) => h && !GENERIC_HEADING_RE.test(h.trim())));
  const pars = texts.map((t) => t.split(/\n\s*\n/).map((p) => ({ raw: p.trim(), plain: plainOf(p) })).filter((p) => p.plain.length >= minChars).map((p) => ({ ...p, sh: shingles(p.plain) })));
  for (let i = 1; i < texts.length; i++) {
    for (let j = 0; j < i; j++) {
      // Sub-headings of i (its own top heading excluded: a distinct planned title) that repeat any heading of j.
      for (const h of heads[i]!.slice(1)) if (heads[j]!.some((x) => normTitle(x) === normTitle(h))) out.push({ later: i, earlier: j, kind: "heading", sample: h });
      for (const p of pars[i]!) {
        const hit = pars[j]!.find((q) => {
          let common = 0;
          for (const s of p.sh) if (q.sh.has(s)) common++;
          return common / Math.max(1, Math.min(p.sh.size, q.sh.size)) >= threshold;
        });
        if (hit) out.push({ later: i, earlier: j, kind: "paragraph", sample: clipQ(p.raw.replace(/\s+/g, " "), 80) });
      }
    }
  }
  return out;
}

/** Removes the paragraphs of a section that `sectionOverlap` reported as repeated (the deterministic fallback of a rewrite). */
export function dropRepeatedParagraphs(text: string, earlier: string[], opts: { minChars?: number; threshold?: number } = {}): { text: string; dropped: number } {
  const blocks = text.split(/\n\s*\n/);
  let dropped = 0;
  const kept = blocks.filter((b, idx) => {
    if (idx === 0 && /^\s*\\(?:chapter|section)\*?\{/.test(b) && plainOf(b.replace(/^\s*\\(?:chapter|section)\*?\{[^}]*\}(?:\\label\{[^}]*\})?/, "")).length < (opts.minChars ?? 60)) return true;
    const rep = sectionOverlap([...earlier, b], opts).some((o) => o.kind === "paragraph" && o.later === earlier.length);
    if (rep) dropped++;
    return !rep;
  });
  return { text: kept.join("\n\n"), dropped };
}
