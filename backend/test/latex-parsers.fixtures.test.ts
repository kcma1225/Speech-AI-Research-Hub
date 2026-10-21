/**
 * Parsers against real logs produced by the latex-runner image (backend/test/latex-fixtures, refreshed
 * with LATEX_E2E_FIXTURES, see latex-runner/README.md). Paths in these logs are as TeX saw them in the
 * sandbox (/work/…, /usr/local/texlive/…).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBlg } from "../src/lib/latex/blg-parser.js";
import { parseLatexLog } from "../src/lib/latex/log-parser.js";

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./latex-fixtures/${name}`, import.meta.url)), "utf8");

describe("real LaTeX logs", () => {
  it.each(["template-zh-thesis", "template-ieee-conference", "template-article-zh", "template-article-en", "lualatex"])("%s has no errors", async name => {
    const parsed = parseLatexLog(await fixture(`${name}.log`));
    expect(parsed.errors).toEqual([]);
    expect(parsed.pages).toBeGreaterThan(0);
  });

  it("errors-mixed: file:line, token, hints, warnings and bad boxes", async () => {
    const parsed = parseLatexLog(await fixture("errors-mixed.log"));
    const codes = parsed.errors.map(error => `${error.file}:${error.line}:${error.code}`);
    expect(codes).toEqual(expect.arrayContaining([
      "sections/broken.tex:2:undefined-control-sequence",
      "sections/broken.tex:4:missing-dollar",
      "sections/broken.tex:6:environment-undefined",
      "sections/broken.tex:10:misplaced-alignment-tab",
    ]));
    expect(parsed.errors.find(error => error.code === "undefined-control-sequence")!.token).toBe("\\foo");
    expect(parsed.errors.some(error => error.code === "runaway-argument")).toBe(true);
    expect(parsed.warnings.some(warning => warning.code === "undefined-reference" && warning.file === "main.tex" && warning.line === 7)).toBe(true);
    expect(parsed.warnings.some(warning => warning.code === "undefined-citation" && warning.line === 7)).toBe(true);
    expect(parsed.badBoxes.some(box => box.file === "main.tex" && /Overfull/.test(box.message))).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/\/work\/|\/usr\/local\/texlive/);
  });

  it("missing-package: one file-not-found error with its line", async () => {
    const parsed = parseLatexLog(await fixture("missing-package.log"));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({ file: "main.tex", code: "file-not-found" });
    expect(parsed.errors[0]!.line).toBeGreaterThanOrEqual(2);
    expect(parsed.pages).toBeNull();
  });

  it("zh-pdflatex: unwrapped Unicode message with the XeLaTeX hint", async () => {
    const parsed = parseLatexLog(await fixture("zh-pdflatex.log"));
    expect(parsed.errors[0]).toMatchObject({ file: "main.tex", line: 3, code: "unicode-not-setup" });
    expect(parsed.errors[0]!.message).toMatch(/not set up for use with LaTeX/);
    expect(parsed.errors[0]!.hint_zh).toMatch(/XeLaTeX/);
  });

  it("missing-glyph: grouped warning", async () => {
    const parsed = parseLatexLog(await fixture("missing-glyph.log"));
    const glyph = parsed.warnings.find(warning => warning.code === "missing-glyph")!;
    expect(glyph.message).toMatch(/語/);
  });

  it("isolation: /etc/passwd is not found", async () => {
    const parsed = parseLatexLog(await fixture("isolation.log"));
    expect(parsed.errors.some(error => error.code === "file-not-found" && /passwd/.test(error.message))).toBe(true);
  });

  it("write-escape: openout outside the project is refused", async () => {
    const parsed = parseLatexLog(await fixture("write-escape.log"));
    expect(parsed.errors[0]).toMatchObject({ code: "cannot-write", file: "main.tex", line: 1 });
  });
});

describe("real .blg files", () => {
  it("BibTeX syntax error and missing entry", async () => {
    const parsed = parseBlg(await fixture("bibtex-errors.blg"));
    expect(parsed.tool).toBe("bibtex");
    expect(parsed.errors[0]).toMatchObject({ file: "refs.bib", line: 9, code: "bib-syntax" });
    expect(parsed.warnings.some(warning => /absent2021/.test(warning.message) && warning.code === "undefined-citation")).toBe(true);
  });

  it("biber syntax error mapped back to refs.bib and missing entry", async () => {
    const parsed = parseBlg(await fixture("biber-errors.blg"));
    expect(parsed.tool).toBe("biber");
    expect(parsed.errors.some(error => error.file === "refs.bib" && error.code === "bib-syntax")).toBe(true);
    expect(parsed.warnings.some(warning => warning.file === "refs.bib" && warning.line === 11)).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/\/tmp\/|\.utf8/);
  });

  it.each(["template-ieee-conference", "template-article-en"])("%s BibTeX run is clean", async name => {
    const parsed = parseBlg(await fixture(`${name}.blg`));
    expect(parsed.tool).toBe("bibtex");
    expect(parsed.errors).toEqual([]);
  });

  it.each(["template-zh-thesis", "template-article-zh"])("%s biber run is clean", async name => {
    const parsed = parseBlg(await fixture(`${name}.blg`));
    expect(parsed.tool).toBe("biber");
    expect(parsed.errors).toEqual([]);
  });
});
