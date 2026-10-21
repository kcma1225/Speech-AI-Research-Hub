/** Workflow engine pure parts: deterministic checks, JSON parsing, slides helpers, report building. */
import { describe, expect, it } from "vitest";
import { CHECKS, parseSlides, runChecks } from "../src/workflows/checks.js";
import { parseJson } from "../src/workflows/llm.js";
import { _test as slides } from "../src/workflows/playbooks/slides.js";
import { detectPlaybook } from "../src/workflows/playbooks/index.js";
import { buildReport } from "../src/workflows/engine.js";
import type { RunRow, StepRow } from "../src/workflows/types.js";

const slide = (title: string, notes = "這一頁要說明方法的核心想法與動機，以及它和前人的差異。") => `## ${title}\n\n- 重點一\n- 重點二\n\n::: {.notes}\n${notes}\n:::\n`;

describe("workflow checks", () => {
  it("parses slides with notes", () => {
    const s = parseSlides(`${slide("A")}\n${slide("B", "")}`);
    expect(s.map((x) => x.title)).toEqual(["A", "B"]);
    expect(s[0]!.notes.length).toBeGreaterThan(10);
    expect(s[0]!.body).not.toContain("notes");
    expect(s[1]!.notes).toBe("");
  });

  it("detects a truncated writer output (1 page instead of 3)", () => {
    const text = `${slide("Background")}\n## Method\n\n- 第一點\n`; // cut off mid-slide, no notes
    const r = runChecks(
      [{ id: "slide_count", params: { expected: 3 } }, { id: "slide_titles", params: { titles: ["Background", "Method", "Results"] } }, { id: "speaker_notes", params: { min_chars: 30 } }],
      text,
      null,
    );
    expect(r.map((c) => c.ok)).toEqual([false, false, false]);
    expect(r[0]!.detail).toContain("應為 3 頁");
    expect(r[1]!.detail).toContain("Results");
    expect(r[2]!.detail).toContain("Method");
  });

  it("flags placeholders except on student-owned pages", () => {
    const text = `${slide("Main results")}\n## My assessment\n\n〔　〕\n\n::: {.notes}\n（由報告者補充）\n:::\n`;
    expect(CHECKS.no_placeholder!(text, { params: { allow_titles: ["My assessment"] }, data: null }).ok).toBe(true);
    expect(CHECKS.no_placeholder!(text, { params: {}, data: null }).ok).toBe(false);
    expect(CHECKS.no_placeholder!("結果待補", { params: {}, data: null }).ok).toBe(false);
  });

  it("finds unclosed blocks", () => {
    expect(CHECKS.not_truncated!("## A\n\n::: {.notes}\n講稿", { params: {}, data: null }).ok).toBe(false);
    expect(CHECKS.not_truncated!("\\begin{itemize}\n\\item x", { params: {}, data: null }).ok).toBe(false);
    expect(CHECKS.not_truncated!(slide("A"), { params: {}, data: null }).ok).toBe(true);
  });

  it("checks citations against library keys (pandoc and LaTeX)", () => {
    const keys = ["chen2024", "wang2023"];
    expect(CHECKS.citations!("如 [@chen2024] 與 \\cite{wang2023}", { params: { keys, min: 2 }, data: null }).ok).toBe(true);
    const bad = CHECKS.citations!("見 \\cite{smith2020,chen2024}", { params: { keys }, data: null });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("smith2020");
  });

  it("checks tables, charts, numbers from source and sections", () => {
    const doc = "## 結果\n\n| 設定 | CER |\n|---|---|\n| base | 12.3 |\n| ours | 10.1 |\n\n```chart\n{\"type\":\"bar\",\"labels\":[\"base\",\"ours\"],\"series\":[{\"name\":\"CER\",\"data\":[12.3,10.1]}]}\n```\n";
    expect(CHECKS.table_rows!(doc, { params: { min: 2 }, data: null }).ok).toBe(true);
    expect(CHECKS.chart_blocks!(doc, { params: { min: 1 }, data: null }).ok).toBe(true);
    expect(CHECKS.numbers_from_source!(doc, { params: { source: "base CER 12.3, ours 10.1" }, data: null }).ok).toBe(true);
    const r = CHECKS.numbers_from_source!(doc, { params: { source: "base CER 12.3" }, data: null });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("10.1");
    expect(CHECKS.sections_present!("## 結果\n\\subsection{方法}", { params: { sections: ["結果", "方法"] }, data: null }).ok).toBe(true);
    expect(CHECKS.chart_blocks!("```chart\n{bad\n```", { params: {}, data: null }).ok).toBe(false);
  });

  it("render / compile checks read the step data", () => {
    expect(CHECKS.render_ok!("", { params: {}, data: { renderError: null } }).ok).toBe(true);
    expect(CHECKS.render_ok!("", { params: {}, data: { renderError: "ERROR: bad mermaid" } }).ok).toBe(false);
    expect(CHECKS.render_ok!("", { params: {}, data: { renderTimedOut: true } }).ok).toBe(false);
    expect(CHECKS.compile_ok!("", { params: {}, data: { compile: { status: "failure", errors: ["Undefined control sequence"] } } }).ok).toBe(false);
  });

  it("source references in a research brief", () => {
    expect(CHECKS.source_refs!("方法（§3.2，p. 4），結果見表 2 與 Fig. 3", { params: { min: 3 }, data: null }).ok).toBe(true);
    expect(CHECKS.source_refs!("沒有出處", { params: { min: 1 }, data: null }).ok).toBe(false);
  });
});

describe("workflow helpers", () => {
  it("parses JSON replies with fences and chatter", () => {
    expect(parseJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('結果是 {"verdict":"pass","issues":[]} 以上')).toEqual({ verdict: "pass", issues: [] });
    expect(parseJson("no json")).toBeNull();
    expect(parseJson('{"x":"含 } 的字串"}\ndata: [DONE]')).toEqual({ x: "含 } 的字串" });
  });

  it("splits a slide outline into writer groups of ≤ 3 pages with per-group checks", () => {
    const outline = Array.from({ length: 11 }, (_, i) => ({ n: i + 1, title: `P${i + 1}`, points: [], ...(i === 10 ? { student_owned: true } : {}) }));
    const steps = slides.writerSteps(outline);
    expect(steps.map((s) => s.key)).toEqual(["write_1", "write_4", "write_7", "write_10"]);
    expect(steps[3]!.inputs).toEqual({ pages: [10, 11] });
    const count = steps[0]!.verify!.checks.find((c) => c.id === "slide_count");
    expect(count!.params).toEqual({ expected: 3 });
    const later = slides.laterSteps(outline, false).map((s) => s.key);
    expect(later).toEqual(["write_1", "write_4", "write_7", "write_10", "assemble", "notes", "final"]);
    expect(slides.laterSteps(outline, true).map((s) => s.key)).toContain("design");
  });

  it("injects speaker notes into the matching slides", () => {
    const body = `## A\n\n- x\n\n## B\n\n- y\n\n::: {.notes}\n短\n:::\n`;
    const out = slides.injectNotes(body, [{ title: "A", notes: "A 的講稿內容" }, { title: "B", notes: "B 的新講稿" }]);
    const parsed = parseSlides(out);
    expect(parsed.map((p) => p.notes)).toEqual(["A 的講稿內容", "B 的新講稿"]);
  });

  it("detects the playbook from a request", () => {
    expect(detectPlaybook("幫我從這篇論文做 11 頁的論文報告簡報", {})).toBe("slides");
    expect(detectPlaybook("寫一份這篇論文的閱讀筆記", {})).toBe("reading_note");
    expect(detectPlaybook("整理這幾篇的文獻回顧", {})).toBe("lit_review");
    expect(detectPlaybook("準備下週組會的議程", {})).toBe("meeting_prep");
    expect(detectPlaybook("把實驗結果 CER 整理成報告", {})).toBe("experiment_report");
    expect(detectPlaybook("幫我想一個資料清理流程", {})).toBe("generic");
  });

  it("never reports success when a criterion failed", () => {
    const run = { criteria: [{ id: "a", text: "正好 11 頁", kind: "check", status: "fail", reason: "實際 10 頁" }, { id: "b", text: "可以編譯", kind: "check", status: "pass" }], artifacts: [] } as unknown as RunRow;
    const steps = [{ title: "撰寫第 1–3 頁", status: "passed", kind: "task", history: [{}, {}] }] as unknown as StepRow[];
    const r = buildReport(run, steps, "partial", null, null);
    expect(r.summary_md).toContain("部分完成");
    expect(r.issues.join()).toContain("正好 11 頁");
    expect(r.done[0]).toContain("修正後通過");
  });
});

import { askUserInput } from "../src/agent/ask.js";
describe("ask_user shows what it asks about", () => {
  const q = (prompt: string) => ({ id: "q1", prompt, type: "yes_no" as const });
  it("refuses a card asking about 「以下」 content it does not show", () => {
    expect(askUserInput.safeParse({ intro: "請確認", questions: [q("是否採用以下 11 頁架構？")] }).success).toBe(false);
    const outline = Array.from({ length: 11 }, (_, i) => `${i + 1}. 第 ${i + 1} 頁標題：重點`).join("\n");
    expect(askUserInput.safeParse({ intro: outline, questions: [q("是否採用以下 11 頁架構？")] }).success).toBe(true);
    expect(askUserInput.safeParse({ intro: "幾個問題", questions: [q("你想報告哪篇論文？")] }).success).toBe(true);
  });
});
describe("ask_user false positives", () => {
  it("allows choice questions that say 以下哪一個", () => {
    expect(askUserInput.safeParse({ questions: [{ id: "q", prompt: "以下哪一個比較接近你的想法？", type: "single_choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }).success).toBe(true);
  });
});

import { completionReview } from "../src/agent/guards.js";
describe("chat completion check vs start_workflow", () => {
  it("the recommended reply after start_workflow is not flagged as a false write claim", () => {
    const calls = [{ tool: "start_workflow", risk: "read" as const, status: "done", step: 0 }];
    expect(completionReview({ text: "我已經把這件事交給工作流程，正在規劃；計畫卡片準備好時請確認後按「開始」。", calls, earlierWrite: false, plan: null })).toBeNull();
    // A false claim of a finished deck is still caught.
    expect(completionReview({ text: "已建立簡報草稿，共 11 頁。", calls, earlierWrite: false, plan: null })).not.toBeNull();
  });
});
