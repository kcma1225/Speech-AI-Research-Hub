import { describe, expect, it } from "vitest";
import { listInputs } from "../src/lib/latex/inputs.js";
import { LATEX_TEMPLATES, addSection, escapeLatex, generateTemplate, nextSectionName, sectionPath } from "../src/lib/latex/templates.js";

describe("generateTemplate", () => {
  it.each(LATEX_TEMPLATES.map(template => [template.id]))("%s follows the split-file convention", id => {
    const project = generateTemplate(id);
    const main = project.files.find(file => file.path === "main.tex")!.content;
    const entries = listInputs(main);
    expect(entries.map(entry => entry.path)).toEqual(project.sections);
    expect(entries.every(entry => entry.managed && !entry.disabled)).toBe(true);
    for (const section of project.sections) {
      expect(section).toMatch(/^sections\/[a-z0-9-]+\.tex$/);
      expect(project.files.some(file => file.path === section)).toBe(true);
    }
    expect(project.files.some(file => file.path === "refs.bib")).toBe(true);
    expect(new Set(project.files.map(file => file.path)).size).toBe(project.files.length);
    // Packages belong in main.tex only.
    for (const file of project.files.filter(file => file.path.startsWith("sections/"))) expect(file.content).not.toMatch(/\\usepackage|\\documentclass/);
  });

  it("uses XeLaTeX + biber + Noto CJK TC for the Chinese thesis", () => {
    const project = generateTemplate("zh-thesis", { title: "語音辨識_研究 & 100%" });
    const main = project.files[0]!.content;
    expect(project.compiler).toBe("xelatex");
    expect(project.bibTool).toBe("biber");
    expect(main).toContain("{ctexbook}");
    expect(main).toContain("\\setCJKmainfont{Noto Serif CJK TC}");
    expect(main).toContain("\\addbibresource{refs.bib}");
    expect(main).toContain("語音辨識\\_研究 \\& 100\\%");
  });

  it("uses pdfLaTeX + BibTeX for the IEEE paper", () => {
    const project = generateTemplate("ieee-conference");
    expect(project.compiler).toBe("pdflatex");
    expect(project.bibTool).toBe("bibtex");
    expect(project.files[0]!.content).toContain("\\documentclass[conference]{IEEEtran}");
    expect(project.files[0]!.content).toContain("\\bibliographystyle{IEEEtran}");
  });
});

describe("sections", () => {
  it("validates section names", () => {
    expect(sectionPath("intro-2")).toBe("sections/intro-2.tex");
    for (const bad of ["", "../x", "a/b", "-x", "中文", "a b", "x".repeat(65)]) expect(() => sectionPath(bad)).toThrow();
  });

  it("suggests free names", () => {
    expect(nextSectionName(["sections/section-1.tex", "sections/section-2.tex"])).toBe("section-3");
  });

  it("adds a section file and its \\input after the last section", () => {
    const project = generateTemplate("zh-thesis");
    const added = addSection(project.files[0]!.content, { name: "future-work", title: "未來工作", command: "chapter" });
    expect(added.file).toEqual({ path: "sections/future-work.tex", content: "\\chapter{未來工作}\\label{chap:future-work}\n\n" });
    const paths = listInputs(added.main).map(entry => entry.path);
    expect(paths.at(-1)).toBe("sections/future-work.tex");
    expect(added.main.indexOf("\\input{sections/future-work}")).toBeLessThan(added.main.indexOf("\\backmatter"));
  });

  it("escapes LaTeX specials", () => {
    expect(escapeLatex("a\\b{c}$d&e#f^g_h%i~j")).toBe("a\\textbackslash{}b\\{c\\}\\$d\\&e\\#f\\textasciicircum{}g\\_h\\%i\\textasciitilde{}j");
  });
});
