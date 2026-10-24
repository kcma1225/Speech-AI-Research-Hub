/**
 * Section-file scope for generated papers (lib/latex/section-scope.ts + paper.ts sanitizeSection / paperOverlap): the
 * failure shapes of the eval task latex_paper_goal — a section that is a whole mini-paper, a section with its own
 * \documentclass and a recursive \input, \cite keys outside the library, paragraphs repeated across sections.
 */
import { describe, expect, it } from "vitest";
import { citeKeys, dropRepeatedParagraphs, dropUnknownCites, keepOwnSection, scopeIssues, sectionOverlap, stripPreamble, unknownCites } from "../src/lib/latex/section-scope.js";
import { CHECKS } from "../src/workflows/checks.js";
import { paperHeadings, paperOverlap, parseOutline, sanitizeSection } from "../src/workflows/playbooks/paper.js";

const titles = ["緒論", "背景：串流 RNN-T", "方法分類架構", "串流偏置方法", "結論"];
const scope = (index: number) => ({ index, titles, command: "section" as const });
// Distinct filler per seed (paragraph overlap is measured on the text, so test paragraphs must not share sentences).
const para = (seed: string) => Array.from({ length: 4 }, (_, k) => `${seed}的第${"一二三四"[k]}個面向${[...seed].reverse().join("")}${k}`).join("，") + "。";

// s04.tex of the baseline: a whole document of its own, with a recursive \input and its own bibliography.
const fullDoc = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{CJKutf8}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\hypersetup{colorlinks=true, linkcolor=black}
\\title{串流 RNN-T 動態熱詞偏置方法綜述（初稿）}
\\author{（作者資料未提供）}
\\date{\\today}
\\begin{document}
\\begin{CJK}{UTF8}{bsmi}
\\maketitle
\\begin{abstract}
本文綜述串流偏置。
\\end{abstract}
\\section{串流偏置方法}
${para("KMP 匹配")}\\cite{wang2023contextual}
\\input{sections/s04.tex}
\\begin{thebibliography}{9}
\\bibitem{wang2023contextual} Wang, 2023.
\\end{thebibliography}
\\end{CJK}
\\end{document}`;

// s01.tex of the baseline: comments, a centered title block, an abstract, then every section of the paper.
const miniPaper = `% sections/s01.tex
% 本檔案為論文主體
\\begin{center}
{\\Large\\textbf{串流 RNN-T 動態熱詞偏置方法綜述}}
\\end{center}
\\vspace{0.5em}
\\begin{abstract}
摘要內容。
\\end{abstract}
\\section{緒論}\\label{sec:intro}
${para("熱詞偏置")}\\cite{pundak2018deep}
本文其餘章節組織如下：第 2 節介紹背景。
\\section{背景：串流 RNN-T 與情境偏置問題}
${para("RNN-T 架構")}
\\section{結論}
${para("總結")}\\cite{graves2012sequence}`;

describe("stripPreamble", () => {
  it("removes everything that belongs to main.tex from a whole document, keeping the section", () => {
    const r = stripPreamble(fullDoc);
    for (const bad of ["\\documentclass", "\\usepackage", "\\begin{document}", "\\end{document}", "\\maketitle", "\\title", "\\author", "\\begin{abstract}", "thebibliography", "\\bibitem", "\\input", "CJK", "\\geometry", "\\hypersetup"]) expect(r.text).not.toContain(bad);
    expect(r.text).toMatch(/^\\section\{串流偏置方法\}/);
    expect(r.text).toContain("\\cite{wang2023contextual}");
    expect(r.removed).toEqual(expect.arrayContaining(["\\documentclass", "\\begin{document}", "摘要", "自己的參考文獻清單", "\\input"]));
  });
  it("drops a title block before the first heading but keeps real content and plain sections untouched", () => {
    expect(stripPreamble(miniPaper).text).toMatch(/^\\section\{緒論\}/);
    const plain = `\\section{方法}\n${para("方法")}\n\\subsection{細節}\n內容 \\cite{a2020}`;
    expect(stripPreamble(plain)).toEqual({ text: plain, removed: [] });
    // Content before the heading that is not a title block stays.
    const lead = `${para("前導")}\n\\section{方法}\n內容`;
    expect(stripPreamble(lead).text).toBe(lead);
  });
  it("keeps an abstract environment when asked (an abstract section edited in a project)", () => {
    expect(stripPreamble("\\begin{abstract}\n摘要\n\\end{abstract}", { keepAbstract: true }).text).toContain("\\begin{abstract}");
  });
});

describe("keepOwnSection / scopeIssues", () => {
  it("keeps the section's own block, drops other planned sections and demotes unplanned headings", () => {
    const r = keepOwnSection(stripPreamble(miniPaper).text, scope(0));
    expect(r.text).toMatch(/^\\section\{緒論\}/);
    expect(r.text).not.toContain("RNN-T 架構");
    expect(r.dropped).toEqual(["背景：串流 RNN-T 與情境偏置問題", "結論"]);
    const extra = keepOwnSection(`\\section{方法分類架構}\n內容\n\\section{三個軸向}\n更多`, scope(2));
    expect(extra.text).toContain("\\subsection{三個軸向}");
    expect(extra.demoted).toEqual(["三個軸向"]);
  });
  it("flags main-file content, extra top-level headings, front/back matter and whole-paper framing outside the intro", () => {
    expect(scopeIssues(fullDoc, scope(3)).join("\n")).toMatch(/\\documentclass[\s\S]*\\begin\{document\}/);
    expect(scopeIssues(miniPaper, scope(0)).join("\n")).toMatch(/只能有一個 \\section/);
    const body = `\\section{方法分類架構}\n${para("分類")}\n\\subsection{結論}\n本文其餘章節安排如下：……\nIn this paper, we review biasing.`;
    const issues = scopeIssues(body, scope(2)).join("\n");
    expect(issues).toMatch(/「結論」/);
    expect(issues).toMatch(/只有緒論可以介紹整篇論文的章節安排/);
    expect(issues).toMatch(/不該重新介紹整篇論文/);
    // The introduction may outline the paper; the conclusion may summarise it; a clean body section passes.
    expect(scopeIssues(`\\section{緒論}\n本文其餘章節組織如下：第 2 節介紹背景。In this paper, we survey methods.`, scope(0))).toEqual([]);
    expect(scopeIssues(`\\section{結論}\n本文綜述了串流偏置方法。`, scope(4))).toEqual([]);
    expect(scopeIssues(`\\section{方法分類架構}\n${para("分類")}\n\\subsection{三個軸向}\n內容`, scope(2))).toEqual([]);
  });
  it("the latex_section_scope check reports the same issues", () => {
    const r = CHECKS.latex_section_scope!(fullDoc, { params: scope(3), data: null });
    expect(r.ok).toBe(false);
    expect(CHECKS.latex_section_scope!(`\\section{串流偏置方法}\n${para("x")}`, { params: scope(3), data: null }).ok).toBe(true);
  });
});

describe("citations", () => {
  it("lists keys and drops only the ones outside the library, removing an emptied \\cite", () => {
    const tex = "A \\cite{a2020,graves2012sequence} B~\\cite{rao2017streaming}. C \\citep[p.~3]{b2021}.";
    expect(citeKeys(tex)).toEqual(["a2020", "graves2012sequence", "rao2017streaming", "b2021"]);
    expect(unknownCites(tex, ["a2020", "b2021"])).toEqual(["graves2012sequence", "rao2017streaming"]);
    const r = dropUnknownCites(tex, ["a2020", "b2021"]);
    expect(r.text).toBe("A \\cite{a2020} B. C \\citep[p.~3]{b2021}.");
    expect(r.dropped).toEqual(["graves2012sequence", "rao2017streaming"]);
    expect(dropUnknownCites("x \\cite{k}", []).text).toBe("x");
  });
});

describe("overlap across sections", () => {
  const s1 = `\\section{緒論}\n${para("熱詞偏置")}\n\n\\subsection{研究範圍}\n${para("動態詞表")}`;
  const s2 = `\\section{背景：串流 RNN-T}\n${para("RNN-T 架構")}\n\n\\subsection{研究範圍}\n${para("動態詞表")}`;
  it("finds a repeated paragraph and sub-heading in the later section only; generic sub-headings are allowed", () => {
    const found = sectionOverlap([s1, s2]);
    expect(found.map((o) => `${o.later}<${o.earlier}:${o.kind}`)).toEqual(["1<0:heading", "1<0:paragraph"]);
    expect(sectionOverlap([`${s1}\n\n\\subsection{小結}\n甲`, `\\section{背景}\n${para("其他")}\n\n\\subsection{小結}\n乙`])).toEqual([]);
  });
  it("drops repeated paragraphs (deterministic fallback) and checks the assembled paper", () => {
    const d = dropRepeatedParagraphs(s2, [s1]);
    expect(d.dropped).toBe(1);
    expect(d.text).toContain("RNN-T 架構");
    expect(d.text).not.toContain("動態詞表");
    const paper = `\\begin{abstract}摘要\\end{abstract}\n\n${s1}\n\n${s2}`;
    expect(paperOverlap(paper, "section").issues[0]).toMatch(/「背景：串流 RNN-T」重複了小節標題「研究範圍」（已在「緒論」）/);
    expect(CHECKS.latex_no_overlap!(paper, { params: { command: "section" }, data: null }).ok).toBe(false);
    expect(CHECKS.latex_no_overlap!(`${s1}\n\n${d.text}`, { params: { command: "section" }, data: null }).ok).toBe(true);
  });
});

describe("sanitizeSection", () => {
  it("turns the baseline's failure shapes into clean section files", () => {
    const s04 = sanitizeSection(fullDoc, { ...scope(3), keys: ["wang2023contextual"] });
    expect(s04.text).toMatch(/^\\section\{串流偏置方法\}/);
    expect(scopeIssues(s04.text, scope(3))).toEqual([]);
    const s01 = sanitizeSection(miniPaper, { ...scope(0), keys: ["pundak2018deep"] });
    expect(s01.text).toMatch(/^\\section\{緒論\}/);
    expect(s01.text).not.toMatch(/graves2012sequence|\\section\{結論\}|abstract/);
    expect(s01.notes.join("；")).toMatch(/屬於主檔的內容[\s\S]*其他節/);
    expect(scopeIssues(s01.text, scope(0))).toEqual([]);
    // Without a heading the planned one is added.
    expect(sanitizeSection(para("x"), scope(2)).text).toMatch(/^\\section\{方法分類架構\}\\label\{sec:s3\}/);
  });
  it("an outline's 摘要 / 參考文獻 entries are not sections", () => {
    const o = parseOutline("## 論文題目\nT\n## 章節規劃\n### 摘要\n- a\n### 1. 緒論\n- b\n### 2. 方法\n- c\n### 參考文獻\n- d\n");
    expect(o!.sections.map((s) => s.title)).toEqual(["緒論", "方法"]);
  });
});

describe("paperHeadings", () => {
  it("maps top-level headings to ## and lower ones to ###, and the overlap check reads either form", () => {
    expect(paperHeadings("\\section{A}\\label{sec:s1}\n文\n\\subsection{B}\n文")).toBe("## A\n文\n### B\n文");
    expect(paperHeadings("\\chapter{A}\n\\section{B}", "chapter")).toBe("## A\n### B");
    const s1 = `\\section{緒論}\n${para("熱詞偏置")}\n\n\\subsection{研究範圍}\n${para("動態詞表")}`;
    const s2 = `\\section{背景}\n${para("RNN-T 架構")}\n\n\\subsection{研究範圍}\n${para("動態詞表")}`;
    expect(paperOverlap(paperHeadings(`${s1}\n\n${s2}`), "section").overlaps.length).toBe(2);
  });
});
