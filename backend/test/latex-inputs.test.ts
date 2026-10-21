import { describe, expect, it } from "vitest";
import { addInput, inputTarget, listInputs, normalizeInputPath, removeInput, renameInput, reorderInputs, setInputEnabled } from "../src/lib/latex/inputs.js";

const MAIN = `\\documentclass{article}
\\input{macros} % preamble input, not a section
\\begin{document}
\\maketitle

\\input{sections/intro}   % 緒論
  \\input{sections/method.tex}
% \\input{sections/old}
\\appendix
\\include{sections/appendix}

Some text \\input{sections/inline} more text.
% a comment mentioning \\input{sections/ghost}

\\bibliography{refs}
\\end{document}
\\input{sections/after-end}
`;

describe("listInputs", () => {
  it("lists body inputs in order with managed/disabled flags", () => {
    expect(listInputs(MAIN).map(entry => [entry.path, entry.managed, entry.disabled, entry.command])).toEqual([
      ["sections/intro.tex", true, false, "input"],
      ["sections/method.tex", true, false, "input"],
      ["sections/old.tex", true, true, "input"],
      ["sections/appendix.tex", true, false, "include"],
      ["sections/inline.tex", false, false, "input"],
    ]);
  });

  it("treats the whole file as body when there is no \\begin{document}", () => {
    expect(listInputs("\\input{a}\n\\input{b}\n").map(entry => entry.path)).toEqual(["a.tex", "b.tex"]);
  });

  it("ignores \\begin{document} inside comments", () => {
    const text = "% \\begin{document}\n\\input{pre}\n\\begin{document}\n\\input{body}\n\\end{document}\n";
    expect(listInputs(text).map(entry => entry.path)).toEqual(["body.tex"]);
  });

  it("normalizes paths", () => {
    expect(normalizeInputPath("./sections/a")).toBe("sections/a.tex");
    expect(normalizeInputPath("fig/plot.tikz")).toBe("fig/plot.tikz");
    expect(normalizeInputPath("v1.2/a")).toBe("v1.2/a.tex");
    expect(inputTarget("sections/a.tex")).toBe("sections/a");
  });
});

describe("addInput", () => {
  it("adds after the last managed entry with the same indentation", () => {
    const text = "\\begin{document}\n  \\input{sections/a}\n  \\input{sections/b} % x\n\n\\end{document}\n";
    expect(addInput(text, "sections/c.tex")).toBe("\\begin{document}\n  \\input{sections/a}\n  \\input{sections/b} % x\n  \\input{sections/c}\n\n\\end{document}\n");
  });

  it("adds after a given entry", () => {
    const text = "\\begin{document}\n\\input{sections/a}\n\\input{sections/b}\n\\end{document}\n";
    expect(addInput(text, "sections/x.tex", { after: "sections/a.tex" })).toBe("\\begin{document}\n\\input{sections/a}\n\\input{sections/x}\n\\input{sections/b}\n\\end{document}\n");
  });

  it("goes before the bibliography when there are no entries yet", () => {
    const text = "\\begin{document}\nHello\n\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n";
    expect(addInput(text, "sections/a.tex")).toBe("\\begin{document}\nHello\n\n\\input{sections/a}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n");
  });

  it("goes before \\end{document} otherwise and keeps CRLF", () => {
    const text = "\\begin{document}\r\nHi\r\n\\end{document}\r\n";
    expect(addInput(text, "sections/a.tex")).toBe("\\begin{document}\r\nHi\r\n\\input{sections/a}\r\n\\end{document}\r\n");
  });

  it("is a no-op when already listed (also when disabled)", () => {
    expect(addInput(MAIN, "sections/intro.tex")).toBe(MAIN);
    expect(addInput(MAIN, "sections/old")).toBe(MAIN);
  });

  it("can add \\include", () => {
    const text = "\\begin{document}\n\\end{document}";
    expect(addInput(text, "chapters/one.tex", { command: "include" })).toBe("\\begin{document}\n\\include{chapters/one}\n\\end{document}");
  });
});

describe("removeInput / renameInput / setInputEnabled", () => {
  it("removes a managed line and leaves everything else", () => {
    const result = removeInput(MAIN, "sections/method.tex");
    expect(result).not.toContain("sections/method");
    expect(result.split("\n").length).toBe(MAIN.split("\n").length - 1);
    expect(result).toContain("\\input{sections/intro}   % 緒論");
  });

  it("cuts an inline input out of its line", () => {
    expect(removeInput(MAIN, "sections/inline")).toContain("Some text  more text.");
  });

  it("does not touch comments or the preamble", () => {
    expect(removeInput(MAIN, "sections/ghost")).toBe(MAIN);
    expect(removeInput(MAIN, "macros")).toBe(MAIN);
  });

  it("renames keeping comment and command", () => {
    const result = renameInput(MAIN, "sections/intro.tex", "sections/introduction.tex");
    expect(result).toContain("\\input{sections/introduction}   % 緒論");
    expect(renameInput(MAIN, "sections/appendix", "sections/app")).toContain("\\include{sections/app}");
  });

  it("disables and re-enables an entry", () => {
    const disabled = setInputEnabled(MAIN, "sections/method.tex", false);
    expect(disabled).toContain("  % \\input{sections/method.tex}");
    expect(listInputs(disabled).find(entry => entry.path === "sections/method.tex")?.disabled).toBe(true);
    expect(setInputEnabled(disabled, "sections/method.tex", true)).toBe(MAIN);
  });
});

describe("reorderInputs", () => {
  it("permutes managed lines inside the existing slots", () => {
    const result = reorderInputs(MAIN, ["sections/appendix.tex", "sections/intro.tex"]);
    const lines = result.split("\n");
    expect(lines[5]).toBe("\\include{sections/appendix}");
    expect(lines[6]).toBe("\\input{sections/intro}   % 緒論");
    expect(lines[7]).toBe("  \\input{sections/method.tex}");
    expect(lines[8]).toBe("\\appendix");
    expect(lines[9]).toBe("% \\input{sections/old}");
    expect(listInputs(result).map(entry => entry.path)).toEqual([
      "sections/appendix.tex",
      "sections/intro.tex",
      "sections/method.tex",
      "sections/old.tex",
      "sections/inline.tex",
    ]);
  });

  it("is the identity for the current order and ignores unknown paths", () => {
    const order = listInputs(MAIN).filter(entry => entry.managed).map(entry => entry.path);
    expect(reorderInputs(MAIN, order)).toBe(MAIN);
    expect(reorderInputs(MAIN, ["nope.tex"])).toBe(MAIN);
  });
});
