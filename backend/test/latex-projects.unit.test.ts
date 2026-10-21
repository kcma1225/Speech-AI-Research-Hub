import { describe, expect, it } from "vitest";
import { detectCompiler, detectRoot, stripCommonFolder } from "../src/lib/latex-projects/zip.js";
import { cleanLatex, keepTrailingNewlines, parseFixReply } from "../src/lib/latex-projects/ai.js";
import { sanitizeResult } from "../src/jobs/latex-finalizer.js";
import { escapeLatex } from "../src/lib/latex/templates.js";
import { roleOf, sectionTitle, sectionsOf, setSectionTitle, validProjectPath } from "../src/lib/latex-projects/store.js";
import { runnerManifest } from "../src/lib/latex-projects/service.js";

describe("LaTeX project helpers", () => {
  it("keeps the trailing newlines of an AI-fixed window (QA: the fix joined the next line / dropped the final newline)", () => {
    const window = "a \\foo{x}\nb\n";
    const code = parseFixReply("說明\n```latex\na x\nb\n```").code!;
    expect(code).toBe("a x\nb");
    expect(keepTrailingNewlines(window, code)).toBe("a x\nb\n");
    expect(keepTrailingNewlines("x\n\n", "y")).toBe("y\n\n");
    expect(keepTrailingNewlines("x", "y\n")).toBe("y\n");
  });

  it("detects the root file and the compiler of an imported project", () => {
    const files = [
      { path: "chapters/intro.tex", text: "\\chapter{Intro}" },
      { path: "old/main.tex", text: "% \\documentclass{article}\n\\begin{document}" },
      { path: "thesis.tex", text: "\\documentclass{ctexbook}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}" },
      { path: "main.tex", text: "\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\n\\end{document}" },
    ];
    expect(detectRoot(files)).toBe("main.tex");
    expect(detectRoot(files.filter((f) => f.path !== "main.tex"))).toBe("thesis.tex");
    expect(detectRoot([{ path: "a.tex", text: "\\section{x}" }])).toBeNull();
    expect(detectCompiler(files[3]!.text)).toBe("xelatex");
    expect(detectCompiler(files[2]!.text)).toBe("xelatex");
    expect(detectCompiler("% !TEX program = lualatex\n\\documentclass{article}")).toBe("lualatex");
    expect(detectCompiler("\\documentclass[conference]{IEEEtran}\n% \\usepackage{fontspec}")).toBe("pdflatex");
    expect(stripCommonFolder([{ path: "p/main.tex", data: Buffer.from("") }, { path: "p/fig/a.png", data: Buffer.from("") }]).map((f) => f.path)).toEqual(["main.tex", "fig/a.png"]);
    expect(stripCommonFolder([{ path: "main.tex", data: Buffer.from("") }, { path: "p/a.png", data: Buffer.from("") }]).map((f) => f.path)).toEqual(["main.tex", "p/a.png"]);
  });

  it("section titles: read and replace the first heading, ignoring comments", () => {
    const text = "% \\chapter{舊的}\n\\chapter[短]{緒論 \\textbf{與} 動機}\\label{chap:intro}\n\\section{背景}\n";
    expect(sectionTitle(text)).toBe("緒論 \\textbf{與} 動機");
    expect(setSectionTitle(text, "研究背景 & 動機", escapeLatex)).toBe("% \\chapter{舊的}\n\\chapter[短]{研究背景 \\& 動機}\\label{chap:intro}\n\\section{背景}\n");
    expect(sectionTitle("no heading")).toBeNull();
  });

  it("sections follow the root's \\input order; missing files show as broken tabs", () => {
    const root = "\\documentclass{article}\n\\input{macros}\n\\begin{document}\n\\input{sections/b}\n% \\input{sections/a}\n\\input{sections/missing}\n\\end{document}\n";
    const files = [{ id: "a", path: "sections/a.tex", kind: "text" as const }, { id: "b", path: "sections/b.tex", kind: "text" as const }];
    const s = sectionsOf(root, files, new Map([["a", "A"], ["b", "B"]]));
    expect(s.map((x) => [x.path, x.file_id, x.disabled, x.title])).toEqual([
      ["sections/b.tex", "b", false, "B"],
      ["sections/a.tex", "a", true, "A"],
      ["sections/missing.tex", null, false, null],
    ]);
  });

  it("path rules and roles", () => {
    for (const ok of ["main.tex", "sections/緒論.tex", "figures/a-1_b.png"]) expect(validProjectPath(ok)).toBe(true);
    for (const bad of ["../a.tex", "/a.tex", ".out/a", "a b.tex", "-x.tex", ".hidden", "a\\b.tex", "a/../b", "x{y}.tex"]) expect(validProjectPath(bad)).toBe(false);
    expect(roleOf("main.tex", "main.tex", new Set())).toBe("main");
    expect(roleOf("ch1.tex", "main.tex", new Set(["ch1.tex"]))).toBe("section");
    expect(roleOf("refs.bib", "main.tex", new Set())).toBe("bib");
    expect(roleOf("IEEEtran.cls", "main.tex", new Set())).toBe("style");
    expect(roleOf("figures/a.png", "main.tex", new Set())).toBe("asset");
  });

  it("runner manifest from a snapshot", () => {
    expect(runnerManifest([
      { path: "main.tex", key: "latex/p/blobs/aa", size: 3, sha256: "aa", fileId: "f", kind: "text", role: "main", contentType: null },
      { path: "a.png", key: "latex/p/blobs/bb", size: 9, sha256: "", fileId: "g", kind: "binary", role: "asset", contentType: "image/png" },
    ])).toEqual({ version: 1, files: [{ path: "main.tex", key: "latex/p/blobs/aa", size: 3, sha256: "aa" }, { path: "a.png", key: "latex/p/blobs/bb", size: 9 }] });
  });

  it("parses AI fix replies and strips wrapping fences", () => {
    expect(parseFixReply("`\\foo` 沒有定義，應為 \\textbf。\n```latex\n這是\\textbf{粗體}\n```\n")).toEqual({ explanation: "`\\foo` 沒有定義，應為 \\textbf。", code: "這是\\textbf{粗體}" });
    expect(parseFixReply("請上傳 Interspeech.cls。")).toEqual({ explanation: "請上傳 Interspeech.cls。", code: null });
    expect(cleanLatex("```latex\n\\section{A}\n```\ndata: [DONE]")).toBe("\\section{A}");
  });

  it("sanitizes runner results: keys must stay under the output prefix", () => {
    const r = sanitizeResult({ status: "success", pdfKey: "latex/p/builds/c/output.pdf", synctexKey: "latex/p/builds/c/../x", logKey: "slides/x", errors: [{ message: "x" }, null, 3], durationMs: -1 }, "latex/p/builds/c/");
    expect(r).toMatchObject({ status: "success", pdfKey: "latex/p/builds/c/output.pdf", synctexKey: null, logKey: null, durationMs: null });
    expect(r.stored.errors).toEqual([{ message: "x" }]);
    expect(sanitizeResult({ status: "weird" }, "p/").status).toBe("failure");
    // QA: warnings the runner did not explain get the backend's hint (no runner rebuild needed for new hints).
    const w = sanitizeResult({ status: "success", warnings: [{ severity: "warning", message: "Package epstopdf: Shell escape feature is not enabled." }, { message: "y", title_zh: "自訂" }] }, "p/");
    expect(w.stored.warnings[0]).toMatchObject({ code: "shell-escape-eps", title_zh: "EPS 圖片無法自動轉換" });
    expect(w.stored.warnings[1]).toEqual({ message: "y", title_zh: "自訂" });
  });
});
