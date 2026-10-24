/**
 * Long outputs as units (workflows/units.ts) and the deterministic pieces around them: budgets, neighbour summaries, one
 * unit continued / regenerated when cut (scripted model, no DB), stitching, the topic note scrub, LaTeX error → unit
 * mapping, and the deck helpers (fit variants, no positions, render-error pages, per-page sources).
 */
import { describe, expect, it } from "vitest";
import type { ChatResult } from "../src/ai/types.js";
import { budgetLine, generateUnit, joinContinuation, neighbourBlock, stitch, unitSummary, unitTokens } from "../src/workflows/units.js";
import { scrubNote } from "../src/workflows/playbooks/research.js";
import { assembleTex, unitsForErrors } from "../src/workflows/playbooks/latex.js";
import { _test as slides, FIT_VARIANTS, ONLINE_RE } from "../src/workflows/playbooks/slides.js";
import { CHECKS } from "../src/workflows/checks.js";
import type { WorkflowEnv } from "../src/workflows/env.js";

type Call = { purpose: string; messages: { role: string; content: unknown }[]; maxTokens?: number };
const reply = (text: string, stopReason: ChatResult["stopReason"] = "end_turn"): ChatResult => ({ text, reasoning: "", toolCalls: [], stopReason, usage: { inputTokens: 10, outputTokens: 10 }, message: { role: "assistant", content: text } });
/** An env whose model replies from a script (one entry per call, in order). */
function fakeEnv(script: ChatResult[]) {
  const calls: Call[] = [];
  const notes: string[] = [];
  const env = {
    call: async (req: Call) => {
      calls.push(req);
      return script.shift() ?? reply("");
    },
    note: async (t: string) => void notes.push(t),
  } as unknown as WorkflowEnv;
  return { env, calls, notes };
}
const req = { purpose: "write:test", role: "writer" as const, messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "寫「## B」" }], maxTokens: 4000 };

describe("units: budgets and neighbours", () => {
  it("states the budget in the artifact's language and sizes the output tokens from it", () => {
    expect(budgetLine({ chars: 1000 }, "zh")).toContain("約 1000 字（不要超過 1300 字）");
    expect(budgetLine({ words: 600 }, "en")).toContain("about 600 words (at most 780)");
    expect(budgetLine({ chars: 1000 }, "en")).toContain("about 200 words");
    expect(budgetLine({ bullets: 4 }, null)).toContain("最多 4 個條列");
    expect(budgetLine(undefined)).toBe("");
    expect(unitTokens({ chars: 4000 }, 8000)).toBe(13_000);
    expect(unitTokens({ chars: 200 }, 8000)).toBe(8000);
    expect(unitTokens({ chars: 9000 }, 8000)).toBe(16_000);
  });

  it("gives a unit its neighbours: their plan, or a summary of their text once written", () => {
    const units = [{ title: "A", purpose: "背景" }, { title: "B", points: ["重點 b"] }, { title: "C", points: ["重點 c1", "重點 c2"] }];
    const n = neighbourBlock(units, 1, ["## A\n\nA 段第一句是背景的說明，很重要。第二句不會出現。", undefined, undefined]);
    expect(n).toContain("上一個單元「A」：已寫：（A） A 段第一句是背景的說明，很重要。");
    expect(n).not.toContain("第二句");
    expect(n).toContain("下一個單元「C」：重點 c1；重點 c2");
    expect(neighbourBlock(units, 0)).not.toContain("上一個單元");
    expect(unitSummary("## X\n\n" + "長".repeat(400), 50).length).toBeLessThanOrEqual(51);
  });
});

describe("units: one unit cut at the output limit", () => {
  it("continues only that unit and joins the continuation without the repeated overlap", async () => {
    const { env, calls, notes } = fakeEnv([reply("## B\n\n- 第一點\n- 第二點的前半", "max_tokens"), reply("第二點的前半段之後的內容\n- 第三點\n")]);
    const r = await generateUnit(env, req, "step-b");
    expect(r).toMatchObject({ continued: 1, regenerated: false, truncated: false });
    expect(r.text).toBe("## B\n\n- 第一點\n- 第二點的前半段之後的內容\n- 第三點\n");
    expect(calls.map((c) => c.purpose)).toEqual(["write:test", "write:test:continue"]);
    // The continuation carries the cut text as the assistant turn and asks to go on from its tail.
    const cont = calls[1]!.messages;
    expect(cont.at(-2)).toMatchObject({ role: "assistant", content: "## B\n\n- 第一點\n- 第二點的前半" });
    expect(String(cont.at(-1)!.content)).toContain("第二點的前半");
    expect(notes.join()).toContain("只接續寫完這一段");
  });

  it("an open block (unclosed notes) counts as cut even without max_tokens", async () => {
    const { env, calls } = fakeEnv([reply("## P1\n\n- a\n\n::: {.notes}\n講稿說到一半"), reply("講稿說到一半，接著寫完。\n:::\n")]);
    const r = await generateUnit(env, req, "s", { complete: (t) => !/::: \{\.notes\}\n[^:]*$/.test(t) });
    expect(calls).toHaveLength(2);
    expect(r.text.endsWith(":::\n")).toBe(true);
    expect(CHECKS.not_truncated!(r.text, { params: {}, data: null }).ok).toBe(true);
  });

  it("still cut after the continuation → one shorter regeneration of the unit", async () => {
    const { env, calls } = fakeEnv([reply("## B\n\n" + "長句。".repeat(50), "max_tokens"), reply("再長句。".repeat(50), "max_tokens"), reply("## B\n\n- 精簡版的完整內容\n")]);
    const r = await generateUnit(env, req, "s");
    expect(calls.map((c) => c.purpose)).toEqual(["write:test", "write:test:continue", "write:test:shorter"]);
    expect(r).toMatchObject({ text: "## B\n\n- 精簡版的完整內容\n", regenerated: true, truncated: false, continued: 1 });
  });

  it("a complete reply makes exactly one call", async () => {
    const { env, calls } = fakeEnv([reply("## B\n\n完整。\n")]);
    expect((await generateUnit(env, req, "s")).continued).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("joins a continuation that restarted from the beginning by keeping the longer, complete version", () => {
    const cut = "## Results\n\nThe proposed method lowers the WER on LibriSpeech test-other from";
    expect(joinContinuation(cut, `${cut} 5.2 to 4.1.\n`)).toBe(`${cut} 5.2 to 4.1.\n`);
    expect(joinContinuation("abc def ghi jkl mno", "jkl mno pqr")).toBe("abc def ghi jkl mno pqr");
    expect(joinContinuation("段落", "```markdown\n接著\n```")).toBe("段落接著");
  });
});

describe("units: deterministic stitching", () => {
  it("stitches units in order, drops a section a later unit repeats, strips fences / titles, closes a fence", () => {
    const out = stitch(["```markdown\n# 不要的標題\n\n## A\n\nA 內容\n```", "## B\n\nB 內容\n\n## A\n\n重複的 A（不是這個單元的）", "## C\n\n```chart\n{\"a\":1}"], { title: "筆記" });
    expect(out).toBe("# 筆記\n\n## A\n\nA 內容\n\n## B\n\nB 內容\n\n## C\n\n```chart\n{\"a\":1}\n```\n");
  });

  it("scrubs contradictory disclaimers and abstract-only detail from a topic note without touching the rest", () => {
    const text = "## 問題定義\n\n串流 ASR 的熱詞 [@f1]（p. 2）。部分筆記被截斷，因此略過。\n[@f1] 僅有定位層級筆記。用 [@a1, p. 3] 的做法與 [@a1]（表 2）。\n\n| 方法 | 論文 |\n|---|---|\n| X | [@f1] |\n";
    const r = scrubNote(text, { abstract_only: ["a1"], full: ["f1"] });
    expect(r.text).toBe("## 問題定義\n\n串流 ASR 的熱詞 [@f1]（p. 2）。\n用 [@a1] 的做法與 [@a1]。\n\n| 方法 | 論文 |\n|---|---|\n| X | [@f1] |\n");
    expect(r.removed).toBe(4);
    expect(CHECKS.topic_consistency!(r.text, { params: {}, data: { abstract_only: ["a1"], full: ["f1"] } }).ok).toBe(true);
  });
});

describe("LaTeX: compile errors → the units they point at", () => {
  it("maps file:line to the subsection unit, else open environments, else every unit (≤ 4)", () => {
    const parts = ["\\subsection{A}\nok\n", "\\subsection{B}\nline1\nline2\n", "\\subsection{C}\n\\begin{itemize}\n\\item x\n"];
    const { content, starts } = assembleTex("Method", parts);
    expect(starts).toEqual([4, 7, 11]);
    expect(content.split("\n")[starts[1]! - 1]).toBe("\\subsection{B}");
    expect(unitsForErrors(["sections/method.tex:8 Undefined control sequence"], "sections/method.tex", starts, parts)).toEqual([1]);
    expect(unitsForErrors(["Emergency stop"], "sections/method.tex", starts, parts)).toEqual([2]);
    expect(unitsForErrors(["Emergency stop"], "sections/method.tex", starts, parts.slice(0, 2))).toEqual([0, 1]);
  });
});

describe("decks: positions, fit variants, render errors, sources", () => {
  it("searches online for a topic deck only when the words ask for it ('research' is not 'search')", () => {
    expect(ONLINE_RE.test("Make an English research presentation on contextual biasing")).toBe(false);
    expect(ONLINE_RE.test("search for recent papers on contextual biasing")).toBe(true);
    expect(ONLINE_RE.test("幫我上網找論文做簡報")).toBe(true);
    expect(ONLINE_RE.test("做一份熱詞做法的主題簡報")).toBe(false);
  });

  it("does not count a diagram's spec as slide text", () => {
    const spec = `{"type":"pipeline","stages":[${Array.from({ length: 12 }, (_, i) => `{"id":"s${i}","label":"Stage number ${i}","kind":"process"}`).join(",")}]}`;
    const page = `## Method\n\n\`\`\`diagram\n${spec}\n\`\`\`\n\n- one\n- two\n`;
    expect(spec.length).toBeGreaterThan(600);
    expect(CHECKS.slide_length!(page, { params: { max_chars: 600 }, data: null }).ok).toBe(true);
    expect(CHECKS.slide_length!(`## Method\n\n${"字".repeat(700)}\n`, { params: { max_chars: 600 }, data: null }).ok).toBe(false);
  });

  it("never keeps model-written positions", () => {
    const body = '## T {.smaller}\n\n![x](a.png){.absolute top=200 left=0 width="50%"}\n\n::: {style="position: absolute; top: 10px"}\nhi\n:::\n\n<div style="position:absolute;left:3px">y</div>\n';
    const out = slides.stripPositions(body);
    expect(out).toContain("## T {.smaller}");
    expect(out).toContain('![x](a.png){width="50%"}');
    expect(out).not.toMatch(/absolute|top=|left=|position/);
  });

  it("applies the fit variants on the heading, one level at a time", () => {
    const raw = "## Results {.smaller}\n\n- a\n";
    const v1 = slides.withVariant(raw, 1);
    expect(v1.split("\n")[0]).toBe("## Results {.fit-90 .smaller}");
    expect(slides.variantOf(v1)).toBe(1);
    expect(slides.withVariant(v1, 3).split("\n")[0]).toBe(`## Results {.${FIT_VARIANTS[2]} .smaller}`);
    expect(slides.withVariant("## X\n- a", 2).split("\n")[0]).toBe("## X {.fit-80}");
    expect(slides.withVariant(v1, 0).split("\n")[0]).toBe("## Results {.smaller}");
  });

  it("sends only the pages a render error points at to the syntax fix", () => {
    const body = "## A\n\n- ok\n\n## B\n\n```chart\n{\"type\":\"bar\",}\n```\n\n## C\n\n- uses `weird_macro`\n";
    expect(slides.suspectPages(body, "Error: undefined control sequence 'weird_macro'").map((p) => p.index)).toEqual([3]);
    expect(slides.suspectPages(body, "render failed").map((p) => p.index)).toEqual([2]);
    expect(slides.suspectPages("## A\n\n- ok\n", "render failed")).toEqual([]);
  });

  it("adds each topic page's source papers by code and maps page sources to extraction steps", () => {
    const outline = [{ n: 1, title: "Deep biasing", points: [], sources: ["P2"] }, { n: 2, title: "Summary", points: [] }];
    const body = "## Deep biasing\n\n- a\n\n::: {.notes}\n講稿\n:::\n\n## Summary\n\n- b\n";
    const out = slides.withSourceLines(body, outline, (r) => (r === "P2" ? "Deep Context Biasing (2023)" : null), "en");
    expect(out).toContain("- a\n\n::: {.page-source}\nSources: Deep Context Biasing (2023)\n:::\n\n::: {.notes}");
    expect(out).toContain("## Summary\n\n- b\n");
    expect(slides.pageSources({ n: 1, title: "x", points: [], sources: ["P2", "P9"] }, 3)).toEqual(["paper_2"]);
    expect(slides.pageSources({ n: 1, title: "x", points: [], kind: "taxonomy" }, 2)).toEqual(["paper_1", "paper_2"]);
    expect(slides.pageSources({ n: 1, title: "x", points: [], kind: "title" }, 2)).toEqual([]);
  });

  it("keeps the planner's layout / role / sources on the outline, but only valid ones", () => {
    const o = slides.toOutline([{ title: "Deep biasing", points: ["a"], layout: "a", kind: "Method", sources: ["p1", "X", "P2"], purpose: "介紹 deep biasing" }, { title: "Other", points: [], layout: "Z", kind: "nope" }]);
    expect(o[0]).toMatchObject({ layout: "A", kind: "method", sources: ["P1", "P2"], purpose: "介紹 deep biasing" });
    expect(o[1]!.layout).toBeUndefined();
    expect(o[1]!.kind).toBeUndefined();
    expect(slides.outlineText(o)).toContain("（版型 A）（來源 P1、P2）");
  });

  it("topic deck writers depend on their source papers' extraction steps", () => {
    const outline = [{ n: 1, title: "Title", points: [], kind: "title" as const }, { n: 2, title: "Deep biasing", points: [], kind: "method" as const, sources: ["P1"] }, { n: 3, title: "Compare", points: [], kind: "comparison" as const }];
    const picks = [{ kind: "library" as const, paper_id: "p1", title: "Paper one", year: 2023, cite_key: "one2023", has_pdf: true, reason: "" }, { kind: "library" as const, paper_id: "p2", title: "Paper two", year: 2022, cite_key: "two2022", has_pdf: true, reason: "" }];
    // Both papers are named by some page: both are read (a few tool rounds: the digest carries the full text).
    const both = [...outline.slice(0, 2), { ...outline[2]!, sources: ["P2"] }];
    let steps = slides.laterSteps(both, false, picks);
    expect(steps.slice(0, 2).map((s) => s.key)).toEqual(["paper_1", "paper_2"]);
    expect(steps[0]!.inputs).toMatchObject({ pick: 0, max_tools: 4 });
    expect(steps.find((s) => s.key === "write_1")!.depends_on).toEqual(["outline"]);
    expect(steps.find((s) => s.key === "write_2")!.depends_on).toEqual(["outline", "paper_1"]);
    expect(steps.find((s) => s.key === "write_3")!.depends_on).toEqual(["outline", "paper_2"]);
    // A paper no page names is never imported or read; pages without refs rest on the used papers only.
    steps = slides.laterSteps(outline, false, picks);
    expect(steps.filter((s) => s.key.startsWith("paper_")).map((s) => s.key)).toEqual(["paper_1"]);
    expect(steps.find((s) => s.key === "write_3")!.depends_on).toEqual(["outline", "paper_1"]);
    expect(slides.usedPicks([{ n: 1, title: "x", points: [] }], 3)).toEqual([0, 1, 2]);
  });
});

describe("topic extractions", () => {
  it("finds the parts under English headings too", async () => {
    const { extractPart } = await import("../src/workflows/playbooks/research.js");
    const notes = "### [@k] P\n\n#### One-Sentence Summary\nS\n\n#### Method\nM (p. 2)\n\n#### Injection Point and Training / Inference\nI\n\n#### **Numbers Table**\n| a |\n";
    expect(extractPart(notes, "一句話")).toBe("S");
    expect(extractPart(notes, "方法")).toBe("M (p. 2)");
    expect(extractPart(notes, "注入位置")).toBe("I");
    expect(extractPart(notes, "數字表")).toBe("| a |");
  });
});
