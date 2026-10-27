/**
 * Edits of a part of an existing paper / note route to an edit, never to a new artifact (audit F3 / F6 / F7):
 * 「把 Related Work 第二段刪掉」 became a literature-review note (LIT_RE), 「把 latex 論文裡的 Table 2 拿掉」 a NEW paper
 * project, 「把調研筆記裡 RNN-T 那節刪掉」 a new topic survey importing 8–12 papers; a full-file `content` overwrote a file
 * under autopilot. Plus the write guard of the edit mode and its invariants.
 */
import { describe, expect, it } from "vitest";
import "../src/workflows/playbooks/index.js";
import { editsExisting, latexEditAsked, noteEditRedirect, route } from "../src/workflows/route.js";
import { checkRun } from "../src/workflows/invariants.js";
import { spliceFiles, resolveWords, _test as editTest, type PlannedTarget } from "../src/workflows/playbooks/latex-edit.js";
import { assembleTex, existingSection } from "../src/workflows/playbooks/latex.js";
import { projectStructure } from "../src/lib/latex/structure.js";
import { keptLineShare, WHOLE_REWRITE_RE } from "../src/lib/latex-projects/agent-tools.js";

const ready = { papers: 4, papers_with_pdf: 4, experiment_notes: 0, latex_projects: 1 };
const withProject = (words: string, hint?: string) => route({ words: [words], hint, inputs: { project_id: "p1", study: "s1" }, ready } as never);

describe("LaTeX part edits route to an edit of the given project", () => {
  it("the audit's requests", () => {
    for (const w of ["把 Related Work 第二段刪掉", "把 latex 論文裡的 Table 2 拿掉", "把第三節刪掉", "Remove Section 4", "附錄 A 不需要了", "圖 3 的說明改清楚一點", "把 Introduction 寫得更清楚", "把 chen2020 的引用拿掉"]) {
      const r = withProject(w);
      expect([w, r.playbook, r.latex, r.kind]).toEqual([w, "latex_section", "edit", "latex"]);
    }
    // The assistant's keyword hint (lit_review, paper_draft) does not win over the words.
    const r = withProject("把 Related Work 第二段刪掉", "lit_review");
    expect([r.playbook, r.latex, r.hint?.accepted]).toEqual(["latex_section", "edit", false]);
    expect(withProject("把 latex 論文裡的 Table 2 拿掉", "paper_draft").playbook).toBe("latex_section");
  });
  it("without project_id: words pointing at the study's existing paper", () => {
    const r = route({ words: ["把 latex 論文裡的 Table 2 拿掉"], inputs: { study: "s1" }, ready } as never);
    expect([r.playbook, r.latex]).toEqual(["latex_section", "edit"]);
    // …but not when the study has no LaTeX project.
    expect(route({ words: ["把 latex 論文裡的 Table 2 拿掉"], inputs: { study: "s1" }, ready: { ...ready, latex_projects: 0 } } as never).latex).toBeUndefined();
  });
  it("new papers, new sections and decks are not edits", () => {
    expect(withProject("幫我寫一篇新的論文").latex).toBeUndefined();
    expect(withProject("新增一節 Related Work").latex).toBeUndefined();
    expect(withProject("幫我寫 Related Work 章節，引用文獻庫的論文").latex).toBeUndefined();
    expect(withProject("幫我寫 Related Work 章節，引用文獻庫的論文").playbook).toBe("latex_section");
    expect(latexEditAsked("把第三頁的投影片刪掉")).toBe(false);
    const deck = route({ words: ["把第 3 頁刪掉"], inputs: { deck_id: "d1", project_id: "p1" }, ready: { ...ready, deckPages: 8 } } as never);
    expect(deck.latex).toBeUndefined();
  });
  it("a fixed non-LaTeX Brief kind (a goal stage) is kept", () => {
    expect(route({ words: ["把第三節刪掉"], kind: "note", inputs: { project_id: "p1" }, ready } as never).latex).toBeUndefined();
  });
  it("never starts a goal for an edit (start_workflow guard)", () => {
    expect(editsExisting(["把 latex 論文裡的 Table 2 拿掉"], "移除表 2")).toBe(true);
    expect(editsExisting(["幫我寫一篇論文"], "寫論文")).toBe(false);
  });
});

describe("a part of an existing note is not a new survey", () => {
  it("redirects to a note edit (no run, no imports)", () => {
    const r = route({ words: ["把調研筆記裡 RNN-T 那節刪掉"], inputs: { study: "s1" }, ready } as never);
    expect(r.redirect).toBe("note_edit");
    expect(r.playbook).not.toBe("topic_research");
    expect(noteEditRedirect({ words: [], inputs: { note_ids: ["n1"] } }, "再補一篇 Conformer 的論文")).toBeTruthy();
    expect(editsExisting(["把調研筆記裡 RNN-T 那節刪掉"], "x")).toBe(true);
  });
  it("a new survey is still a survey", () => {
    expect(route({ words: ["幫我調研 dynamic hotwording 有哪些做法"], inputs: { study: "s1" }, ready } as never).playbook).toBe("topic_research");
    expect(route({ words: ["重新調研一份新的筆記，關於 RNN-T 有哪些做法"], inputs: { note_ids: ["n1"] }, ready } as never).redirect).toBeUndefined();
  });
});

describe("invariants", () => {
  const run = (playbook: string, route: Record<string, unknown>, words: string, inputs: Record<string, unknown> = { project_id: "p1" }) => ({ run: { id: "r", status: "done", playbook, inputs, brief: { user_words: [words], base: 1 }, state: { route } } } as never);
  it("route.latex_part_edit flags a part request routed as creation", () => {
    expect(checkRun(run("lit_review", { playbook: "lit_review", kind: "lit_review" }, "把 Related Work 第二段刪掉"), ["route.latex_part_edit"])).toHaveLength(1);
    expect(checkRun(run("paper_draft", { playbook: "paper_draft", kind: "latex" }, "把 latex 論文裡的 Table 2 拿掉"), ["route.latex_part_edit"])).toHaveLength(1);
    expect(checkRun(run("latex_section", { playbook: "latex_section", kind: "latex", latex: "edit" }, "把 Related Work 第二段刪掉"), ["route.latex_part_edit"])).toHaveLength(0);
    expect(checkRun(run("paper_draft", { playbook: "paper_draft", kind: "latex" }, "幫我寫一篇新的論文"), ["route.latex_part_edit"])).toHaveLength(0);
  });
  it("route.note_part_not_research flags a survey re-run for a note edit", () => {
    expect(checkRun(run("topic_research", { playbook: "topic_research" }, "把調研筆記裡 RNN-T 那節刪掉", { note_ids: ["n1"] }), ["route.note_part_not_research"])).toHaveLength(1);
    expect(checkRun(run("topic_research", { playbook: "topic_research" }, "幫我調研 RNN-T 有哪些做法", { note_ids: ["n1"] }), ["route.note_part_not_research"])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the edit mode's write guard

const files = [
  { path: "main.tex", text: "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\\label{sec:intro}\nIntro.\n\n\\input{sections/related}\n\\input{sections/method}\n\\end{document}\n" },
  { path: "sections/related.tex", text: "\\section{Related Work}\\label{sec:rw}\n\nPara one.\n\nPara two about RNN-T.\n\nPara three.\n" },
  { path: "sections/method.tex", text: "\\section{Method}\nM.\n\\begin{table}\\caption{Results}\\label{tab:r}\\end{table}\n\\begin{table}\\caption{Ablation}\\end{table}\n" },
];
const ids = Object.fromEntries(files.map((f, i) => [f.path, `f${i}`]));
const s = projectStructure(files, "main.tex");
const plan = (words: string): PlannedTarget[] => {
  const r = resolveWords([words], s, files, new Map());
  if (r.kind !== "parts") throw new Error(r.kind);
  const byPath = new Map(files.map((f) => [f.path, { ...f, id: ids[f.path]! }] as const));
  return r.targets.map((t, i) => ({ key: `edit_${i + 1}`, kind: t.kind, action: t.action, ref: t.ref, clause: t.clause, heading: t.kind === "block" && t.block?.kind === "heading", retitle: false, ranges: t.action === "remove" ? editTest.removalSplices(t, byPath, "main.tex") : t.ranges.map((x) => ({ ...x, file_id: ids[x.path]!, before: byPath.get(x.path)!.text.slice(x.start, x.end) })) }));
};
const live = files.map((f) => ({ path: f.path, file_id: ids[f.path]!, text: f.text }));

describe("spliceFiles (edit mode write guard)", () => {
  it("removes one paragraph and keeps everything else byte for byte", () => {
    const res = spliceFiles(live, plan("把 Related Work 第二段刪掉"), {});
    expect(res.issues).toEqual([]);
    expect(res.files.map((f) => f.path)).toEqual(["sections/related.tex"]);
    expect(res.files[0]!.next).toBe("\\section{Related Work}\\label{sec:rw}\n\nPara one.\n\nPara three.\n");
    const run = { run: { id: "r", status: "done", state: { latex_edit_result: res } } } as never;
    expect(checkRun(run, ["latex.part_scope_kept"])).toEqual([]);
    // A result that changed a kept part is flagged.
    const bad = { ...res, files: [{ ...res.files[0]!, next: res.files[0]!.next.replace("Para one", "Para 1") }] };
    expect(checkRun({ run: { id: "r", status: "done", state: { latex_edit_result: bad } } } as never, ["latex.part_scope_kept"])).toHaveLength(1);
  });
  it("removes Table 2 only; a whole section file goes by its \\input line", () => {
    const t2 = spliceFiles(live, plan("把 Table 2 拿掉"), {});
    expect(t2.files[0]!.next).toBe("\\section{Method}\nM.\n\\begin{table}\\caption{Results}\\label{tab:r}\\end{table}\n");
    const sec = spliceFiles(live, plan("把第二節刪掉"), {});
    expect(sec.files.map((f) => [f.path, f.next])).toEqual([["main.tex", files[0]!.text.replace("\\input{sections/related}\n", "")]]);
  });
  it("a rewritten section keeps its command and labels; a lost \\label is an issue", () => {
    const t = plan("Related Work 改短一點");
    const ok = spliceFiles(live, t, { edit_1: "\\subsection{RW}\nShorter text.\n" });
    expect(ok.issues).toEqual([]);
    expect(ok.files[0]!.next).toBe("\\section{Related Work}\\label{sec:rw}\nShorter text.\n");
    const intro = plan("Introduction 改寫");
    const res = spliceFiles(live, intro, { edit_1: "\\section{Intro}\nNew intro.\n" });
    expect(res.files[0]!.next).toBe(files[0]!.text.replace("Intro.\n\n", "New intro.\n\n"));
    const m = plan("把 Method 改寫");
    expect(spliceFiles(live, m, { edit_1: "\\section{Method}\nNo tables.\n" }).issues.join()).toContain("\\label{tab:r}");
  });
  it("a file changed since planning is not spliced blindly", () => {
    const changed = live.map((f) => (f.path === "sections/related.tex" ? { ...f, text: `% edited\n${f.text}` } : f));
    expect(spliceFiles(changed, plan("把 Related Work 第二段刪掉"), {}).issues.join()).toContain("規劃後被修改過");
  });
});

describe("creation mode (F2) and the full-content guard (F7)", () => {
  it("finds an existing section in the root file instead of writing a duplicate file", () => {
    const tops = s.blocks.filter((b) => b.kind === "heading" && b.level === "section");
    expect(existingSection(tops, "Introduction").map((b) => b.path)).toEqual(["main.tex"]);
    expect(existingSection(tops, "Conclusion")).toEqual([]);
  });
  it("assembleTex writes a \\chapter (and lifts subsections) in a thesis", () => {
    const { content } = assembleTex("結論", ["\\subsection{總結}\n文字。", "\\subsubsection{細節}\n細節。"], "chapter");
    expect(content).toMatch(/^\\chapter\{結論\}\n\\label\{chap:[^}]+\}\n\n\\section\{總結\}\n文字。\n\n\\subsection\{細節\}\n細節。\n$/);
    expect(assembleTex("Conclusion", ["\\subsection{A}\nx"]).content).toMatch(/^\\section\{Conclusion\}\n\\label\{sec:conclusion\}\n\n\\subsection\{A\}/);
  });
  it("a full-file content that keeps most lines is a part edit; a rewrite request allows it", () => {
    const cur = Array.from({ length: 20 }, (_, i) => `Line number ${i} of the section text.`).join("\n");
    expect(keptLineShare(cur, cur.replace("Line number 3", "Changed line 3"))).toBeGreaterThan(0.9);
    expect(keptLineShare(cur, "Completely new text\nnothing kept here at all")).toBe(0);
    expect(WHOLE_REWRITE_RE.test("幫我把整個檔案重寫")).toBe(true);
    expect(WHOLE_REWRITE_RE.test("把第二段刪掉")).toBe(false);
  });
});
