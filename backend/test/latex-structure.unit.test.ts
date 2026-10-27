/**
 * The project's structure as the PDF reader sees it, and the user's words mapped onto it (lib/latex/structure.ts):
 * numbering in \input order including the root file, starred / appendix / per-chapter numbering, Chinese numerals and
 * verb-after removals, paragraphs, citations, and the byte-for-byte guard.
 */
import { describe, expect, it } from "vitest";
import { applySplices, auxNumbers, citeEdits, keepHeading, keepsSegments, keptSegments, numeral, paragraphsOf, projectStructure, resolveParts, type SourceFile } from "../src/lib/latex/structure.js";

const article: SourceFile[] = [
  {
    path: "main.tex",
    text: [
      "\\documentclass{article}",
      "\\section{Preamble trap}% not in the body",
      "\\begin{document}",
      "\\begin{abstract}",
      "We study things.",
      "\\end{abstract}",
      "\\section{Introduction}\\label{sec:intro}",
      "Intro para one \\cite{chen2020}.",
      "",
      "Intro para two.",
      "",
      "\\input{sections/related}",
      "% \\input{sections/disabled}",
      "\\input{sections/method}",
      "\\section*{Acknowledgements}",
      "Thanks.",
      "\\appendix",
      "\\section{Extra Proofs}",
      "Proof.",
      "\\section{Data}",
      "Data.",
      "\\bibliography{refs}",
      "\\end{document}",
      "",
    ].join("\n"),
  },
  {
    path: "sections/related.tex",
    text: [
      "\\section{Related Work}",
      "\\label{sec:related}",
      "",
      "First related paragraph \\cite{chen2020,lee2021}.",
      "",
      "Second related paragraph about RNN-T \\cite{lee2021}.",
      "",
      "\\begin{table}[t]",
      "  \\caption{Prior results}\\label{tab:prior}",
      "  \\begin{tabular}{l}x\\end{tabular}",
      "\\end{table}",
      "",
      "Third related paragraph.",
      "",
    ].join("\n"),
  },
  {
    path: "sections/method.tex",
    text: [
      "\\section{Method}",
      "Method intro.",
      "",
      "\\subsection{Encoder}",
      "Encoder text.",
      "",
      "\\begin{figure}",
      "\\caption{Architecture}",
      "\\end{figure}",
      "",
      "\\begin{table}",
      "\\caption{Main results}\\label{tab:main}",
      "\\end{table}",
      "",
      "\\subsection{Decoder}",
      "Decoder text.",
      "",
    ].join("\n"),
  },
  { path: "sections/disabled.tex", text: "\\section{Disabled}\nx\n" },
];

const thesis: SourceFile[] = [
  { path: "main.tex", text: "\\documentclass{book}\n\\begin{document}\n\\frontmatter\n\\input{sections/abstract-zh}\n\\input{sections/abstract-en}\n\\mainmatter\n\\input{sections/introduction}\n\\input{sections/method}\n\\appendix\n\\chapter{補充資料}\nA.\n\\backmatter\n\\end{document}\n" },
  { path: "sections/abstract-zh.tex", text: "\\chapter*{摘要}\n中文摘要。\n" },
  { path: "sections/abstract-en.tex", text: "\\chapter*{Abstract}\nEnglish.\n" },
  { path: "sections/introduction.tex", text: "\\chapter{緒論}\\label{chap:introduction}\n\n\\section{研究背景}\n背景。\n\n\\section{論文架構}\n架構。\n" },
  { path: "sections/method.tex", text: "\\chapter{研究方法}\\label{chap:method}\n\n\\section{模型架構}\n模型。\n\n\\begin{table}\n\\caption{參數}\n\\end{table}\n\n\\section{訓練}\n訓練。\n\n\\section{評估}\n評估。\n" },
];

const s = projectStructure(article, "main.tex");
const heads = s.blocks.filter((b) => b.kind === "heading");
const textOf = (files: SourceFile[], path: string) => files.find((f) => f.path === path)!.text;

describe("projectStructure", () => {
  it("reads the root body and its inputs in order, skipping comments and the preamble", () => {
    expect(heads.map((b) => `${b.number ?? "-"} ${b.title}`)).toEqual([
      "1 Introduction", "2 Related Work", "3 Method", "3.1 Encoder", "3.2 Decoder", "- Acknowledgements", "A Extra Proofs", "B Data",
    ]);
    expect(s.order).toEqual(["main.tex", "sections/related.tex", "sections/method.tex"]);
    expect(s.blocks.filter((b) => b.kind === "table").map((b) => [b.number, b.title])).toEqual([["1", "Prior results"], ["2", "Main results"]]);
    expect(s.blocks.find((b) => b.kind === "figure")?.number).toBe("1");
    expect(s.citeKeys.sort()).toEqual(["chen2020", "lee2021"]);
  });
  it("ends a section in the root file at the next \\input that leads to a section", () => {
    const intro = heads[0]!;
    const main = textOf(article, "main.tex");
    expect(main.slice(intro.start, intro.end)).toBe("\\section{Introduction}\\label{sec:intro}\nIntro para one \\cite{chen2020}.\n\nIntro para two.\n\n");
    const data = heads.find((b) => b.title === "Data")!;
    expect(main.slice(data.start, data.end)).toBe("\\section{Data}\nData.\n");
    const method = heads.find((b) => b.title === "Method")!;
    expect(method.end).toBe(textOf(article, "sections/method.tex").length);
    const enc = heads.find((b) => b.title === "Encoder")!;
    expect(textOf(article, "sections/method.tex").slice(enc.end)).toMatch(/^\\subsection\{Decoder\}/);
  });
  it("numbers a thesis per chapter: front matter unnumbered, appendix chapters lettered", () => {
    const t = projectStructure(thesis, "main.tex");
    expect(t.chapters).toBe(true);
    expect(t.blocks.filter((b) => b.kind === "heading").map((b) => `${b.number ?? "-"} ${b.title}`)).toEqual([
      "- 摘要", "- Abstract", "1 緒論", "1.1 研究背景", "1.2 論文架構", "2 研究方法", "2.1 模型架構", "2.2 訓練", "2.3 評估", "A 補充資料",
    ]);
    expect(t.blocks.find((b) => b.kind === "table")?.number).toBe("2.1");
  });
  it("takes the numbers of the last compile's .aux when given", () => {
    expect(auxNumbers("\\newlabel{tab:main}{{7}{3}{Main}{table.7}{}}").get("tab:main")).toBe("7");
    const a = projectStructure(article, "main.tex", "\\newlabel{tab:main}{{7}{3}{Main}{table.7}{}}");
    expect(a.blocks.find((b) => b.label === "tab:main")?.number).toBe("7");
  });
  it("reads Chinese numerals", () => {
    expect([numeral("三"), numeral("十"), numeral("十二"), numeral("二十一"), numeral("3"), numeral("３"), numeral("兩")]).toEqual([3, 10, 12, 21, 3, 3, 2]);
  });
});

describe("resolveParts", () => {
  const one = (words: string, files = article, st = s) => {
    const r = resolveParts(words, st, files);
    if (r.kind !== "parts") throw new Error(`${r.kind}: ${"question" in r ? r.question : r.why}`);
    return r.targets;
  };
  it("maps the PDF's names onto blocks (numbers, Chinese numerals, verb-after removals, English refs)", () => {
    expect(one("把第三節刪掉").map((t) => [t.ref, t.action])).toEqual([["3 Method", "remove"]]);
    expect(one("刪除第 2 節")[0]!.block?.title).toBe("Related Work");
    expect(one("Remove Section 3.1")[0]!.block?.title).toBe("Encoder");
    expect(one("把 Table 2 拿掉")[0]!.block?.title).toBe("Main results");
    expect(one("表一的標題改短一點").map((t) => [t.block?.title, t.action])).toEqual([["Prior results", "rewrite"]]);
    expect(one("Figure 1 的說明改清楚")[0]!.block?.kind).toBe("figure");
    expect(one("附錄 B 不需要了")[0]!.block?.title).toBe("Data");
    expect(one("把摘要改短")[0]!.block?.kind).toBe("abstract");
  });
  it("finds a paragraph of a section named by title (production: 「把 Related Work 第二段刪掉」)", () => {
    const [t] = one("把 Related Work 第二段刪掉");
    expect(t!.kind).toBe("paragraph");
    expect(t!.action).toBe("remove");
    const text = textOf(article, "sections/related.tex");
    expect(text.slice(t!.ranges[0]!.start, t!.ranges[0]!.end)).toBe("Second related paragraph about RNN-T \\cite{lee2021}.");
    // The table between paragraphs is not a paragraph: the third paragraph is the prose after it.
    const [last] = one("Related Work 最後一段改寫");
    expect(text.slice(last!.ranges[0]!.start, last!.ranges[0]!.end)).toBe("Third related paragraph.");
  });
  it("removes a citation key from \\cite commands only", () => {
    const [t] = one("把 chen2020 的引用拿掉");
    expect(t!.kind).toBe("citation");
    expect(t!.ranges.map((r) => [r.path, r.after])).toEqual([["main.tex", ""], ["sections/related.tex", "\\cite{lee2021}"]]);
  });
  it("asks rather than guessing (unknown part, ambiguous thesis section)", () => {
    expect(resolveParts("把第九節刪掉", s, article).kind).toBe("ask");
    const t = projectStructure(thesis, "main.tex");
    const r = resolveParts("把第二節刪掉", t, thesis);
    expect(r.kind).toBe("ask");
    expect(r.kind === "ask" && r.question).toContain("1.2 論文架構");
    expect(one("把第二章第三節刪掉", thesis, t)[0]!.block?.title).toBe("評估");
    expect(one("第一章改寫得更清楚", thesis, t)[0]!.block?.title).toBe("緒論");
    expect(one("把摘要改短", thesis, t)[0]!.block?.title).toBe("摘要");
    expect(one("附錄 A 刪掉", thesis, t)[0]!.block?.title).toBe("補充資料");
  });
  it("whole-paper words and words naming nothing are not part-scoped", () => {
    expect(resolveParts("整篇論文翻成英文", s, article).kind).toBe("none");
    expect(resolveParts("改得更學術一點", s, article).kind).toBe("none");
  });
});

describe("the byte-for-byte guard", () => {
  it("keeps everything outside the spliced ranges", () => {
    const text = "aaa\nBBB\nccc\nDDD\neee";
    const splices = [{ start: 4, end: 8, after: "" }, { start: 12, end: 16, after: "ddd\n" }];
    const next = applySplices(text, splices);
    expect(next).toBe("aaa\nccc\nddd\neee");
    expect(keepsSegments(next, keptSegments(text, splices))).toBe(true);
    expect(keepsSegments("aaa\nccc changed\nddd\neee", keptSegments(text, splices))).toBe(false);
  });
  it("keeps a rewritten section's command, star and label (\\chapter stays \\chapter)", () => {
    const orig = "\\chapter{緒論}\\label{chap:introduction}\n\nold body\n";
    expect(keepHeading(orig, "\\section{Intro}\n\\label{sec:intro}\nnew body\n")).toBe("\\chapter{緒論}\\label{chap:introduction}\nnew body\n");
    expect(keepHeading(orig, "\\section{前言}\nnew body\n", { retitle: true })).toBe("\\chapter{前言}\\label{chap:introduction}\nnew body\n");
  });
  it("citeEdits leaves other keys and the rest of the text alone", () => {
    expect(citeEdits("A~\\cite{x}. B \\citep[p.~2]{x, y}.", "x")).toEqual([{ start: 1, end: 10, after: "" }, { start: 14, end: 32, after: "\\citep[p.~2]{y}" }]);
  });
  it("paragraphsOf skips heading and label lines", () => {
    const rel = s.blocks.find((b) => b.title === "Related Work")!;
    expect(paragraphsOf(textOf(article, "sections/related.tex"), rel, s.blocks.filter((b) => b.kind !== "heading"))).toHaveLength(3);
  });
});
