import { describe, expect, it } from "vitest";
import { biberSourcePath, parseBiberBlg, parseBibtexBlg, parseBlg, parseLatexmkOutput } from "../src/lib/latex/blg-parser.js";
import { LATEX_HINTS, findHint } from "../src/lib/latex/hints.js";
import { isGeneratedPath, normalizeLogPath, parseLatexLog, scrubPaths, unwrapLog } from "../src/lib/latex/log-parser.js";
import { isSafeProjectPath } from "../src/lib/latex/contract.js";

describe("paths", () => {
  it("normalizes log paths", () => {
    expect(normalizeLogPath("./sections/intro.tex")).toBe("sections/intro.tex");
    expect(normalizeLogPath("/work/sections/./intro.tex")).toBe("sections/intro.tex");
    expect(normalizeLogPath("/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls")).toBe("<texmf>/tex/latex/base/article.cls");
    expect(normalizeLogPath("/tmp/secret/x.tex")).toBe("x.tex");
    expect(normalizeLogPath('"./my file.tex"')).toBe("my file.tex");
    expect(isGeneratedPath(".out/main.aux")).toBe(true);
    expect(isGeneratedPath("main.toc")).toBe(true);
    expect(isGeneratedPath("main.tex")).toBe(false);
    expect(scrubPaths("see /work/main.tex and /usr/local/texlive/2026/texmf-dist/tex/x.sty")).toBe("see main.tex and <texmf>/tex/x.sty");
  });

  it("validates project paths", () => {
    for (const ok of ["main.tex", "sections/intro.tex", "figures/a b.png", "中文/章節.tex", ".latexmkrc"]) expect(isSafeProjectPath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b", "-x.tex", "a/-b", ".out/x", "C:/x", "a\u0000b", "x".repeat(256)]) {
      expect(isSafeProjectPath(bad)).toBe(false);
    }
  });
});

describe("parseLatexLog (synthetic shapes)", () => {
  it("parses ! errors without -file-line-error using the file stack", () => {
    const log = [
      "(./main.tex",
      "LaTeX2e <2025-11-01>",
      "(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls",
      "Document Class: article 2025/01/22 v1.4n Standard LaTeX document class",
      "(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo))",
      "(./chapter.tex",
      "! Undefined control sequence.",
      "l.3 Some \\badmacro",
      "                   here",
      ")",
      "! Missing $ inserted.",
      "<inserted text> ",
      "                $",
      "l.9 x_",
      "      1",
      ")",
    ].join("\n");
    const parsed = parseLatexLog(log);
    expect(parsed.errors.map(error => [error.file, error.line, error.code])).toEqual([
      ["chapter.tex", 3, "undefined-control-sequence"],
      ["main.tex", 9, "missing-dollar"],
    ]);
    expect(parsed.errors[0]!.token).toBe("\\badmacro");
    expect(parsed.errors[0]!.context).toContain("l.3 Some \\badmacro");
  });

  it("parses warnings with continuation lines and line numbers", () => {
    const log = [
      "(./main.tex",
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
      "(hyperref)                removing `math shift' on input line 12.",
      "",
      "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 20.",
      "",
      "LaTeX Font Warning: Font shape `OT1/cmr/m/n' in size <5.5> not available",
      "(Font)              size <5> substituted on input line 30.",
      "Overfull \\hbox (15.0pt too wide) in paragraph at lines 40--42",
      "Underfull \\vbox (badness 10000) has occurred while \\output is active []",
      "Missing character: There is no 中 (U+4E2D) in font [lmroman10-regular]:mapping=tex-text;!",
      "Missing character: There is no 文 (U+6587) in font [lmroman10-regular]:mapping=tex-text;!",
      "Output written on .out/main.pdf (3 pages, 12345 bytes).",
      ")",
    ].join("\n");
    const parsed = parseLatexLog(log);
    expect(parsed.pages).toBe(3);
    expect(parsed.errors).toEqual([]);
    const [hyperref, reference, font, glyph] = parsed.warnings;
    expect(hyperref).toMatchObject({ file: "main.tex", line: 12, message: expect.stringContaining("removing `math shift'") });
    expect(hyperref!.message).toMatch(/^Package hyperref:/);
    expect(reference).toMatchObject({ line: 20, code: "undefined-reference" });
    expect(font).toMatchObject({ line: 30 });
    expect(glyph).toMatchObject({ code: "missing-glyph" });
    expect(glyph!.message).toContain("中 (U+4E2D), 文 (U+6587)");
    expect(parsed.badBoxes.map(box => box.line)).toEqual([40, null]);
  });

  it("drops a trailing Emergency stop when a real error exists", () => {
    const log = "(./main.tex\n./main.tex:2: LaTeX Error: File `x.sty' not found.\n\nType X to quit.\nEnter file name: \n./main.tex:2: Emergency stop.\n<read *> \n";
    const parsed = parseLatexLog(log);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({ file: "main.tex", line: 2, code: "file-not-found" });
  });

  it("keeps Emergency stop when it is the only error", () => {
    expect(parseLatexLog("(./main.tex\n! Emergency stop.\n<*> main.tex\n").errors[0]!.code).toBe("emergency-stop");
  });

  it("marks errors in generated files", () => {
    const parsed = parseLatexLog("(./main.tex (./.out/main.toc\n./.out/main.toc:1: Undefined control sequence.\nl.1 \\mymacro\n))");
    expect(parsed.errors[0]).toMatchObject({ file: ".out/main.toc", generated: true });
  });

  it("dedupes identical errors", () => {
    const one = "./a.tex:1: Undefined control sequence.\nl.1 \\x\n";
    expect(parseLatexLog(one + one).errors).toHaveLength(1);
  });

  it("unwraps 79-column logs", () => {
    const long = "Package foo Warning: " + "x".repeat(58);
    expect(long.length).toBe(79);
    const lines = [long, "continued on input line 4.", long, "y", long, "z"];
    expect(unwrapLog(lines)).toEqual([long + "continued on input line 4.", long + "y", long + "z"]);
    const parsed = parseLatexLog(["(./main.tex", ...lines, ")"].join("\n"));
    expect(parsed.warnings[0]).toMatchObject({ line: 4 });
  });
});

describe("blg parsers (synthetic shapes)", () => {
  it("parses BibTeX errors and warnings", () => {
    const blg = [
      "This is BibTeX, Version 0.99e (TeX Live 2026)",
      "The top-level auxiliary file: .out/main.aux",
      "The style file: plain.bst",
      "Database file #1: refs.bib",
      "I was expecting a `,' or a `}'---line 9 of file refs.bib",
      " :   author = {Broken, Bob},",
      " :   ^^^^^^",
      "I'm skipping whatever remains of this entry",
      'Warning--I didn\'t find a database entry for "absent2021"',
      "Warning--empty publisher in nojournal2018",
      "Warning--empty journal in x",
      "--line 3 of file other.bib",
      "(There was 1 error message)",
    ].join("\n");
    const parsed = parseBlg(blg);
    expect(parsed.tool).toBe("bibtex");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({ source: "bibtex", file: "refs.bib", line: 9, code: "bib-syntax" });
    expect(parsed.errors[0]!.context).toContain("author = {Broken, Bob}");
    expect(parsed.warnings.map(warning => [warning.file, warning.line, warning.code ?? null])).toEqual([
      ["refs.bib", null, "undefined-citation"],
      ["refs.bib", null, null],
      ["other.bib", 3, null],
    ]);
  });

  it("parses missing database / missing \\bibdata", () => {
    const parsed = parseBibtexBlg("This is BibTeX\nI couldn't open database file nothere.bib\n---line 3 of file main.aux\nI found no \\bibdata command---while reading file main.aux\n");
    expect(parsed.errors.some(error => error.code === "bib-database-missing")).toBe(true);
  });

  it("parses biber and maps temporary .utf8 files back", () => {
    const blg = [
      "[0] Config.pm:308> INFO - This is Biber 2.21",
      "[50] Utils.pm:410> WARN - I didn't find a database entry for 'absent2021' (section 0)",
      "[60] Utils.pm:420> ERROR - BibTeX subsystem: /tmp/biber_tmp_AbCd/refs.bib_12345.utf8, line 12, syntax error: at end of input, expected end of entry (\"}\" or \")\")",
      "[70] Biber.pm:131> WARN - Datamodel: article entry 'x' (refs.bib): Invalid field 'publisher' for entrytype 'article'",
      "[80] Biber.pm:131> ERROR - Cannot find 'missing.bib'!",
    ].join("\n");
    const parsed = parseBiberBlg(blg);
    expect(parsed.errors.map(error => [error.file, error.line, error.code])).toEqual([
      ["refs.bib", 12, "bib-syntax"],
      ["missing.bib", null, "bib-database-missing"],
    ]);
    expect(parsed.warnings.map(warning => [warning.file, warning.code ?? null])).toEqual([
      [null, "undefined-citation"],
      ["refs.bib", null],
    ]);
    expect(JSON.stringify(parsed)).not.toContain("/tmp/");
    expect(biberSourcePath("/tmp/x/refs.bib_99.utf8")).toBe("refs.bib");
  });

  it("parses latexmk's error summary", () => {
    const out = "Collected error summary (may duplicate other messages):\n  biber: Command for 'biber' gave return code 2\n      Refer to '.out/main.blg' for details\nLatexmk: Failure to make '.out/main.pdf'\n";
    expect(parseLatexmkOutput(out).map(item => item.message)).toEqual(["biber 結束代碼 2", "Failure to make '.out/main.pdf'"]);
    const crashed = "Latexmk: Error return from 'biber .out/main'\nCollected error summary (may duplicate other messages):\n  biber .out/main: Could not open biber log file '.out/main.blg'\n";
    const parsed = parseLatexmkOutput(crashed);
    expect(parsed.map(item => item.message)).toEqual(["biber 執行失敗", "biber 執行失敗：Could not open biber log file '.out/main.blg'"]);
    expect(parsed.every(item => item.code === "bib-tool-failed")).toBe(true);
  });
});

describe("hints", () => {
  it("has at least 30 distinct entries with zh text", () => {
    expect(LATEX_HINTS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(LATEX_HINTS.map(hint => hint.code)).size).toBe(LATEX_HINTS.length);
    for (const hint of LATEX_HINTS) expect(hint.hint_zh).toMatch(/[\u4e00-\u9fff]/);
  });

  it.each([
    ["Undefined control sequence.", "undefined-control-sequence"],
    ["Missing $ inserted.", "missing-dollar"],
    ["LaTeX Error: File `foo.sty' not found.", "file-not-found"],
    ["LaTeX Error: Environment foo undefined.", "environment-undefined"],
    ["LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{document}.", "begin-end-mismatch"],
    ["LaTeX Error: Missing \\begin{document}.", "missing-begin-document"],
    ["LaTeX Error: Can be used only in preamble.", "preamble-only"],
    ["LaTeX Error: Option clash for package xcolor.", "option-clash"],
    ["LaTeX Error: Command \\foo already defined.", "command-already-defined"],
    ["Extra }, or forgotten $.", "extra-brace-or-dollar"],
    ["Missing } inserted.", "missing-brace"],
    ["Too many }'s.", "too-many-braces"],
    ["Extra alignment tab has been changed to \\cr.", "extra-alignment-tab"],
    ["Misplaced alignment tab character &.", "misplaced-alignment-tab"],
    ["Paragraph ended before \\textbf was complete.", "runaway-argument"],
    ["Double superscript.", "double-script"],
    ["Display math should end with $$.", "bad-math-delimiter"],
    ["LaTeX Error: There's no line here to end.", "no-line-to-end"],
    ["Illegal unit of measure (pt inserted).", "illegal-unit"],
    ["Missing number, treated as zero.", "missing-number"],
    ["LaTeX Error: Lonely \\item--perhaps a missing list environment.", "lonely-item"],
    ["LaTeX Error: Something's wrong--perhaps a missing \\item.", "missing-item"],
    ["LaTeX Error: Not in outer par mode.", "not-in-outer-par"],
    ["LaTeX Error: Unknown graphics extension: .eps.", "graphics-problem"],
    ["Illegal parameter number in definition of \\x.", "illegal-parameter"],
    ["Argument of \\@sect has an extra }.", "extra-brace-argument"],
    ["LaTeX Error: \\verb illegal in command argument.", "lr-mode"],
    ["Package xcolor Error: Undefined color `foo'.", "undefined-color"],
    ["TeX capacity exceeded, sorry [main memory size=5000000].", "capacity-exceeded"],
    ["I can't write on file `/tmp/x.txt'.", "cannot-write"],
    ["Package fontspec Error: The font \"Foo\" cannot be found.", "font-not-found"],
    ["LaTeX Error: Unicode character 中 (U+4E2D) not set up for use with LaTeX.", "unicode-not-setup"],
    ["Citation `x' on page 1 undefined on input line 3.", "undefined-citation"],
    ["There were undefined references.", "undefined-reference"],
    ["Label `x' multiply defined.", "multiply-defined-label"],
    ["Package biblatex: Please (re)run Biber on the file: main", "biblatex-backend"],
    ["Emergency stop.", "emergency-stop"],
  ])("%s → %s", (message, code) => {
    expect(findHint(message)?.code).toBe(code);
  });
});
