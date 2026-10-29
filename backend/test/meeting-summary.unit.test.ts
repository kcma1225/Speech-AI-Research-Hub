/** Imported meeting summaries (src/lib/meetings/summary.ts): action items, assignees, due dates, reconciliation. */
import { describe, expect, it } from "vitest";
import type { AnalysisInput, AnalysisResult } from "../src/lib/meetings/analysis.js";
import { finalMessages, buildRefs } from "../src/lib/meetings/analysis.js";
import { extractActionItems, findAssignee, findDue, reconcileSummaryTasks, resolvePerson, sameTask } from "../src/lib/meetings/summary.js";

const DAY = "2026-10-28";

describe("summary: due dates and assignees", () => {
  it("reads dates in common forms, with the meeting's year", () => {
    expect(findDue("跑完 baseline 11/5 前", DAY)).toEqual({ due: "2026-11-05", rest: "跑完 baseline" });
    expect(findDue("交初稿（截止：2026/12/01）", DAY).due).toBe("2026-12-01");
    expect(findDue("整理數據 11月12日", DAY).due).toBe("2026-11-12");
    expect(findDue("下學期 1/15 前提交", DAY).due).toBe("2027-01-15");
    expect(findDue("改 2/30", DAY).due).toBeNull();
    expect(findDue("比較 3 個模型", DAY).due).toBeNull();
  });
  it("reads the assignee markers", () => {
    expect(findAssignee("跑 baseline @林雅婷")).toEqual({ assignee: "林雅婷", rest: "跑 baseline" });
    expect(findAssignee("整理數據（負責：柏宇）").assignee).toBe("柏宇");
    expect(findAssignee("Owner: Brian - write the intro").assignee).toBe("Brian");
    expect(findAssignee("[雅婷] 補實驗").assignee).toBe("雅婷");
    expect(findAssignee("雅婷：補實驗").assignee).toBe("雅婷");
    expect(findAssignee("注意：資料要備份").assignee).toBeNull();
    expect(findAssignee("補實驗").assignee).toBeNull();
  });
  it("resolves names to accounts: exact, else one unique partial match", () => {
    const people = [{ id: "u1", name: "林雅婷" }, { id: "u2", name: "陳柏宇" }, { id: "u3", name: "林雅雯" }];
    expect(resolvePerson("林雅婷", people)).toBe("u1");
    expect(resolvePerson("柏宇", people)).toBe("u2");
    expect(resolvePerson("林雅", people)).toBeNull(); // two people match
    expect(resolvePerson("王", people)).toBeNull();
    expect(resolvePerson(null, people)).toBeNull();
  });
});

describe("summary: action items", () => {
  const md = `# 週會摘要

## 進度
- 雅婷：baseline WER 18%
- [ ] 柏宇 確認資料授權

## 研究A：語音情緒辨識
討論了資料增強。

### Action Items
- @林雅婷 跑 SpecAugment 的對照實驗 11/5 前
  - 用 IEMOCAP 的 session 1–4
- **陳柏宇**：整理標註規範
- [x] 已完成的事也列出

## 待辦事項
| 事項 | 負責人 | 期限 |
|---|---|---|
| 寫 related work | 林雅婷 | 2026/11/20 |
| 更新簡報 | | |

## 其他
- 下週停課
`;
  it("finds checkboxes anywhere, bullets and tables under task headings, with details", () => {
    const items = extractActionItems(md, DAY);
    expect(items.map((i) => [i.title, i.assignee, i.due])).toEqual([
      ["柏宇 確認資料授權", null, null],
      ["跑 SpecAugment 的對照實驗", "林雅婷", "2026-11-05"],
      ["整理標註規範", "陳柏宇", null],
      ["已完成的事也列出", null, null],
      ["寫 related work", "林雅婷", "2026-11-20"],
      ["更新簡報", null, null],
    ]);
    expect(items[1]!.detail).toContain("IEMOCAP");
    expect(items[1]!.headings).toEqual(["週會摘要", "研究A：語音情緒辨識", "Action Items"]);
  });
  it("matches the same task worded slightly differently", () => {
    expect(sameTask("跑 SpecAugment 的對照實驗", "跑SpecAugment對照實驗")).toBe(true);
    expect(sameTask("寫 related work", "撰寫 related work 章節")).toBe(true);
    expect(sameTask("寫 related work", "更新簡報")).toBe(false);
  });
});

describe("summary: reconcile with the model's drafts", () => {
  const input: AnalysisInput = {
    title: "週會", heldAt: "2026-10-28 14:00", notes: "", language: "zh-TW",
    studies: [
      { id: "sA", title: "語音情緒辨識", owner: "林雅婷", summary: "", stage: null, members: [{ id: "u1", name: "林雅婷", role: "owner" }, { id: "u9", name: "王教授", role: "advisor" }], decks: [] },
      { id: "sB", title: "低資源 ASR", owner: "陳柏宇", summary: "", stage: null, members: [{ id: "u2", name: "陳柏宇", role: "owner" }], decks: [] },
    ],
    participants: [{ id: "u9", name: "王教授" }],
    segments: [],
    speakerNames: new Map(),
    feedback: [],
    summary: "x",
  };
  const result = (): AnalysisResult => ({
    drafts: [
      { studyId: "sA", summary_md: "", feedback_md: "", tasks: [{ title: "跑SpecAugment對照實驗", detail: "", assignee_id: null, due: null }], evidence: [] },
      { studyId: "sB", summary_md: "", feedback_md: "", tasks: [], evidence: [] },
    ],
    other_md: "", other_evidence: [], speaker_guesses: [], warnings: [],
  });
  it("fills the assignee / due of kept items, adds missing ones to the right study, lists the rest under 其他", () => {
    const r = result();
    const items = [
      { title: "跑 SpecAugment 的對照實驗", detail: "", assignee: "雅婷", due: "2026-11-05", headings: [] },
      { title: "整理標註規範", detail: "", assignee: "陳柏宇", due: null, headings: [] }, // by person → sB
      { title: "補 IEMOCAP 實驗", detail: "", assignee: null, due: null, headings: ["語音情緒辨識"] }, // by heading → sA
      { title: "訂會議室", detail: "", assignee: null, due: null, headings: [] }, // nowhere
      { title: "教授要看的稿", detail: "", assignee: "王教授", due: null, headings: [] }, // advisor: not assignable, no study
    ];
    expect(reconcileSummaryTasks(r, input, items)).toEqual({ added: 2, filled: 1, unplaced: 2 });
    expect(r.drafts[0]!.tasks).toEqual([
      { title: "跑SpecAugment對照實驗", detail: "", assignee_id: "u1", due: "2026-11-05" },
      { title: "補 IEMOCAP 實驗", detail: "", assignee_id: null, due: null },
    ]);
    expect(r.drafts[1]!.tasks).toEqual([{ title: "整理標註規範", detail: "", assignee_id: "u2", due: null }]);
    expect(r.other_md).toContain("訂會議室");
    expect(r.other_md).toContain("教授要看的稿（王教授）");
  });
  it("one study: everything goes there", () => {
    const one = { ...input, studies: [input.studies[0]!] };
    const r = { ...result(), drafts: [result().drafts[0]!] };
    expect(reconcileSummaryTasks(r, one, [{ title: "訂會議室", detail: "", assignee: null, due: null, headings: [] }]).added).toBe(1);
  });
  it("the prompt carries the summary and its rules only when there is one", () => {
    const refs = buildRefs(input);
    const withSummary = finalMessages({ ...input, summary: "## 待辦\n- 寫論文" }, refs, { transcript: [] });
    expect(String(withSummary[1]!.content)).toContain("<meeting_summary");
    expect(String(withSummary[1]!.content)).not.toContain("<transcript>");
    expect(String(withSummary[0]!.content)).toContain("每一個待辦");
    const without = finalMessages({ ...input, summary: "" }, refs, { transcript: [] });
    expect(String(without[1]!.content)).not.toContain("<meeting_summary");
    expect(String(without[0]!.content)).not.toContain("<meeting_summary>");
  });
});
