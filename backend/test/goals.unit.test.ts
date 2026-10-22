/** Goal layer pure parts: deliverable detection, topic extraction, templates vs. readiness, gaps, re-plan rules, the paper playbook's outline parser and main.tex, goal approval. */
import { describe, expect, it } from "vitest";
import "../src/workflows/playbooks/index.js";
import { capabilityOf, deliverableOf, gapsOf, languageOf, producersOf, templateFor, type Readiness } from "../src/workflows/goals/capabilities.js";
import { planGoal, replanAfter, templatePlan, topicOf, validStages } from "../src/workflows/goals/planner.js";
import { stageInputs } from "../src/workflows/goals/advance.js";
import { paperMain, parseOutline, sectionFile, withHeading } from "../src/workflows/playbooks/paper.js";
import { CHECKS } from "../src/workflows/checks.js";
import { autoApproval } from "../src/workflows/autopilot.js";
import { listInputs } from "../src/lib/latex/inputs.js";
import type { GoalRow, Stage } from "../src/workflows/goals/types.js";
import type { ModelPort } from "../src/workflows/types.js";

const R = (over: Partial<Readiness> = {}): Readiness => ({ study: { id: "s", title: "語料" }, papers: 0, papers_with_pdf: 0, notes: {}, outline_notes: [], recent_notes: [], latex_projects: [], decks: 0, experiment_notes: 0, ...over });

describe("deliverable of a request", () => {
  it("recognises a whole paper in the production wording, never a note", () => {
    expect(deliverableOf("幫我寫一篇 paper 有關於目前台灣語料的搜集狀況")).toBe("paper");
    expect(deliverableOf("可以開論文了")).toBe("paper");
    expect(deliverableOf("最後要給我一個 latex 論文")).toBe("paper");
    expect(deliverableOf("從零寫一篇關於台灣語音語料蒐集現況的論文")).toBe("paper");
  });
  it("keeps decks, sections, reviews and topic surveys apart", () => {
    expect(deliverableOf("把這篇論文做成簡報")).toBe("deck");
    expect(deliverableOf("幫我做論文報告")).toBe("deck");
    expect(deliverableOf("給我這篇論文的摘要")).toBeNull();
    expect(deliverableOf("幫我寫論文的 introduction 章節")).toBe("paper_section");
    expect(deliverableOf("幫我做文獻回顧")).toBe("lit_review");
    expect(deliverableOf("在 Zipformer 下研究有哪些 dynamic hotwording 做法")).toBe("topic_note");
    expect(deliverableOf("幫我擬論文大綱")).toBe("outline");
  });
  it("language and template of a paper", () => {
    expect(languageOf("寫一篇關於台灣語料的論文")).toBe("zh");
    expect(languageOf("write a paper on Taiwanese speech corpora")).toBe("en");
    expect(templateFor("寫碩士論文", "zh")).toBe("zh-thesis");
    expect(templateFor("寫一篇論文", "zh")).toBe("article-zh");
    expect(templateFor("x", "en")).toBe("ieee-conference");
  });
  it("extracts the paper topic", () => {
    expect(topicOf("幫我寫一篇 paper 有關於目前台灣語料的搜集狀況")).toBe("目前台灣語料的搜集狀況");
    expect(topicOf("從零寫一篇關於台灣語音語料蒐集現況的論文")).toBe("台灣語音語料蒐集現況");
    expect(topicOf("從零開始寫一篇關於「台灣語音語料蒐集現況」的論文。主題：華語、台語語料。")).toBe("台灣語音語料蒐集現況");
    expect(topicOf("寫一篇論文探討台語語料。語言：繁體中文")).toBe("台語語料");
  });
});

describe("capabilities, readiness and templates", () => {
  it("every built-in playbook declares what it produces", () => {
    expect(capabilityOf("paper_draft")?.produces).toBe("paper");
    expect(capabilityOf("lit_review")?.produces).toBe("lit_review");
    expect(producersOf("paper")).toEqual(["paper_draft"]);
  });
  it("gaps compare requirements with the snapshot", () => {
    expect(gapsOf({ study: true, papers: 2 }, R({ papers: 1 }))).toEqual(["文獻庫只有 1 篇（需要 ≥ 2）"]);
    expect(gapsOf({ latex_project: true }, R(), { project_id: "p" })).toEqual([]);
    expect(gapsOf({ study: true }, R({ study: null }))).toEqual(["還沒有研究"]);
  });
  it("a paper from a thin library starts with topic research; a rich one goes straight to the outline", () => {
    const thin = templatePlan("paper", "幫我寫一篇 paper 有關於目前台灣語料的搜集狀況", R({ papers: 2, papers_with_pdf: 1 }))!;
    expect(thin.stages.map((s) => s.playbook)).toEqual(["topic_research", "paper_outline", "paper_draft"]);
    expect(thin.stages[2]!.uses).toEqual([0, 1]);
    expect(thin.stages[2]!.inputs).toMatchObject({ language: "zh", template: "article-zh" });
    const rich = templatePlan("paper", "write a paper on speech corpora", R({ papers: 12, papers_with_pdf: 10 }))!;
    expect(rich.stages.map((s) => s.playbook)).toEqual(["paper_outline", "paper_draft"]);
    expect(rich.stages[1]!.inputs!.template).toBe("ieee-conference");
    expect(templatePlan("lit_review", "文獻回顧", R({ papers: 1 }))!.stages.map((s) => s.playbook)).toEqual(["topic_research", "lit_review"]);
  });
  it("planGoal uses the template for a recognised deliverable without calling the model", async () => {
    let calls = 0;
    const model = { chat: async () => { calls++; throw new Error("no"); }, available: async () => true, vision: async () => false } as unknown as ModelPort;
    const plan = await planGoal(model, "u", { request: "可以開論文了，主題是台灣語料蒐集", readiness: R() });
    expect(calls).toBe(0);
    expect(plan.deliverable.kind).toBe("paper");
    expect(plan.stages.at(-1)!.playbook).toBe("paper_draft");
  });
  it("LLM stages must end with the deliverable and use known playbooks", () => {
    expect(validStages([{ playbook: "topic_research" }, { playbook: "lit_review" }], "paper", "x")).toBeNull();
    expect(validStages([{ playbook: "nope" }], "note", "x")).toBeNull();
    expect(validStages([{ playbook: "topic_research" }, { playbook: "paper_draft", uses: [0, 5] }], "paper", "x")!.map((s) => s.uses)).toEqual([[], [0]]);
  });
});

const stage = (id: string, playbook: string, over: Partial<Stage> = {}): Stage => ({ id, playbook, title: id, why: "", request: "r", inputs: {}, uses: [], status: "pending", run_id: null, artifacts: [], added_by: "plan", ...over });
const goal = (stages: Stage[], over: Partial<GoalRow> = {}): GoalRow => ({ id: "g", user_id: "u", study_id: "s", conversation_id: null, tool_call_id: null, title: "論文", request: "寫論文", objective: "", deliverable: { kind: "paper", label: "論文", direct: true }, status: "running", stages, current: 0, autopilot: false, context: {}, readiness: null, state: { planner: "template", rounds: { topic_research: 1 } }, history: [], question: null, report: null, created_at: "", updated_at: "", finished_at: null, ...over });

describe("re-plan and hand-over", () => {
  it("a research stage that left the library thin gets one more round, once", async () => {
    let n = 0;
    const g = goal([stage("a", "topic_research", { status: "done" }), stage("b", "paper_outline", { uses: ["a"] }), stage("c", "paper_draft", { uses: ["a", "b"] })]);
    const out = await replanAfter(null, g, 0, R({ papers_with_pdf: 2 }), () => `x${++n}`);
    expect(out!.stages.map((s) => s.playbook)).toEqual(["topic_research", "topic_research", "paper_outline", "paper_draft"]);
    expect(out!.stages[2]!.uses).toEqual(["a", "x1"]);
    expect(await replanAfter(null, { ...g, state: { rounds: { topic_research: 2 } } }, 0, R({ papers_with_pdf: 2 }), () => "y")).toBeNull();
    expect(await replanAfter(null, g, 0, R({ papers_with_pdf: 9 }), () => "y")).toBeNull();
  });
  it("stage inputs carry the used stages' notes and project", () => {
    const g = goal([
      stage("a", "topic_research", { status: "done", artifacts: [{ kind: "note", id: "n1", url: "", title: "調研", role: "draft" }, { kind: "paper", id: "p", url: "", title: "x", role: "draft" }] }),
      stage("b", "paper_outline", { status: "done", artifacts: [{ kind: "note", id: "n2", url: "", title: "大綱", role: "draft" }] }),
      stage("c", "paper_draft", { uses: ["a", "b"], inputs: { language: "zh" } }),
    ]);
    expect(stageInputs(g, g.stages[2]!)).toEqual({ study: "s", language: "zh", note_ids: ["n1", "n2"] });
  });
});

const OUTLINE = `# 論文大綱：台灣語音語料蒐集現況

## 論文題目
台灣語音語料蒐集現況與挑戰

## 主要貢獻
- 整理現有語料
- 指出缺口

## 章節規劃
### 1. 緒論
- 重點：背景與動機
- 引用：[@chen2021], [@lin2022]
### 2. 現有語料
- 華語、台語、客語語料 [@lin2022]
### 3. 蒐集方法
- 眾包與錄音
### 4. 結論
- 總結

## 參考文獻
- [@chen2021] A
`;

describe("paper playbooks", () => {
  it("parses the outline note format", () => {
    const o = parseOutline(OUTLINE)!;
    expect(o.title).toBe("台灣語音語料蒐集現況與挑戰");
    expect(o.contributions).toHaveLength(2);
    expect(o.sections.map((s) => s.title)).toEqual(["緒論", "現有語料", "蒐集方法", "結論"]);
    expect(o.sections[0]!.cites).toEqual(["chen2021", "lin2022"]);
    expect(o.sections[0]!.points).toEqual(["背景與動機"]);
    expect(CHECKS.outline_sections!(OUTLINE, { params: { min: 4 }, data: null }).ok).toBe(true);
    expect(CHECKS.outline_sections!(OUTLINE, { params: { min: 5 }, data: null }).ok).toBe(false);
  });
  it("builds main.tex with the paper's sections instead of the template samples", () => {
    const paths = [sectionFile(0, "Introduction"), sectionFile(1, "現有語料")];
    expect(paths).toEqual(["sections/s01-introduction.tex", "sections/s02.tex"]);
    const zh = listInputs(paperMain("article-zh", "題目", "作者", paths, "sections/abstract.tex")).map((i) => i.path);
    expect(zh).toEqual(["sections/abstract.tex", ...paths]);
    const ieee = listInputs(paperMain("ieee-conference", "T", "A", paths, "sections/abstract.tex")).map((i) => i.path);
    expect(ieee).toEqual(["sections/abstract.tex", ...paths]);
    const thesis = paperMain("zh-thesis", "題目", "作者", paths, "sections/abstract-zh.tex");
    expect(listInputs(thesis).map((i) => i.path)).toEqual(["sections/abstract-zh.tex", ...paths]);
    expect(thesis.indexOf("s01-introduction")).toBeGreaterThan(thesis.indexOf("\\mainmatter"));
  });
  it("adds the heading a writer left out", () => {
    expect(withHeading("內文", "緒論", 0, "section")).toMatch(/^\\section\{緒論\}\\label\{sec:s1\}/);
    expect(withHeading("```latex\n\\section{緒論}\n內文\n```", "緒論", 0, "section")).toBe("\\section{緒論}\n內文\n");
    expect(withHeading("\\section{緒論}\n內文", "緒論", 0, "chapter")).toMatch(/^\\chapter\{緒論\}/);
  });
});

describe("goal approval of stage plans", () => {
  it("covers library imports, never overwrites", () => {
    expect(autoApproval({ autopilot: false, autoApprovable: true, writes: [{ kind: "paper", label: "匯入論文" }, { kind: "note", label: "n", effect: "new" }], tainted: true, goal: true }).auto).toBe(true);
    expect(autoApproval({ autopilot: false, autoApprovable: true, writes: [{ kind: "deck", label: "覆蓋", effect: "overwrite" }], tainted: false, goal: true }).auto).toBe(false);
    expect(autoApproval({ autopilot: false, autoApprovable: true, writes: [], tainted: false, goal: true, manual: true }).auto).toBe(false);
  });
});

describe("deliverable edge cases", () => {
  it("asking for papers to read is not a paper to write", () => {
    expect(deliverableOf("給我幾篇台灣語料相關的論文")).not.toBe("paper");
    expect(deliverableOf("幫我寫這篇論文的閱讀筆記")).toBe("reading_note");
  });
});
