/** Verification ledger helpers: quote matching, self-contradiction, the false-positive screen, section diffs, report lists. */
import { describe, expect, it } from "vitest";
import { changedSections, ledgerReport, quoteIn, screenIssue, sectionHashes, selfContradictory } from "../src/workflows/ledger.js";
import { buildReport } from "../src/workflows/engine.js";
import type { RunRow, StepRow } from "../src/workflows/types.js";

describe("workflow verification ledger", () => {
  it("finds quotes despite whitespace, punctuation, Markdown and 「…」, but not invented ones", () => {
    const text = "## 方法\n\n- **WavLM** 使用 *masked* prediction，\n  CER 從 12.3% 降到 10.1%。";
    expect(quoteIn("WavLM 使用 masked prediction", text)).toBe(true);
    expect(quoteIn("CER 從 12.3%…10.1%", text)).toBe(true);
    expect(quoteIn("「CER 從 12.3% 降到 10.1%」", text)).toBe(true);
    expect(quoteIn("所有模型都使用 masking", text)).toBe(false);
    expect(quoteIn("", text)).toBe(false);
  });

  it("flags self-contradictory issue texts (the production example) and keeps real ones", () => {
    expect(selfContradictory("會載入第 2 頁而非 Fig. 1 所在的第 2 頁")).toBe(true);
    expect(selfContradictory("把「Fig. 1」改為「Fig. 1」")).toBe(true);
    expect(selfContradictory("說明文字寫 Fig. 2，但嵌入的是第 3 頁而非第 4 頁的 Fig. 2")).toBe(false);
    expect(selfContradictory("標題寫 Fig. 2，但圖片是 Fig. 1")).toBe(false);
  });

  it("screens issues: quote must be in the output, source quote in the sources, errors need a quote", () => {
    const out = "第 3 頁：DTW 標成 trainable。";
    const src = "DTW is applied at inference only.";
    expect(screenIssue({ severity: "high", kind: "error", text: "DTW 不可訓練", quote: "DTW 標成 trainable", source_quote: "DTW is applied at inference only" }, out, src)).toBeNull();
    expect(screenIssue({ severity: "high", kind: "error", text: "x", quote: "WavLM" }, out, src)).toBe("引用的原文不在產出中");
    expect(screenIssue({ severity: "high", kind: "error", text: "x", quote: "DTW 標成 trainable", source_quote: "DTW is trained jointly" }, out, src)).toBe("引用的來源原文不在來源資料中");
    expect(screenIssue({ severity: "high", kind: "error", text: "x" }, out, src)).toBe("沒有引用產出中的原文");
    expect(screenIssue({ severity: "medium", kind: "missing", text: "缺少結論" }, out, src)).toBeNull();
  });

  it("detects which sections changed between final rounds", () => {
    const v1 = "## A\n\nA 內容\n\n## B\n\nB 第 1 版";
    const v2 = "## A\n\nA 內容\n\n## B\n\nB 第 2 版";
    expect(changedSections(v1, sectionHashes(v1))).toEqual([]);
    expect(changedSections(v2, sectionHashes(v1))).toEqual(["## B\n\nB 第 2 版"]);
  });

  it("report lists fixed / unresolved / invalid issues and counts them in the summary", () => {
    const ledger = (items: object[]) => ({ ledger: { reviewed: true, next: 9, items } });
    const steps = [
      { title: "撰寫第 1–3 頁", status: "passed", kind: "task", history: [{}, {}], inputs: ledger([
        { id: "i1", status: "fixed", severity: "high", text: "CER 數字錯", rounds: 0, opened: 0 },
        { id: "i2", status: "unresolved", severity: "medium", text: "流程圖其實是條列", where: "第 3 頁", rounds: 3, opened: 0 },
        { id: "i3", status: "invalid", severity: "high", text: "自相矛盾", note: "問題描述自相矛盾", rounds: 0, opened: 0 },
      ]) },
    ] as unknown as StepRow[];
    const run = { criteria: [{ id: "a", text: "忠於來源", kind: "judge", status: "pass" }], artifacts: [], state: { final_ledger: { sections: [], items: { a: { status: "pass", fails: 1 } } } } } as unknown as RunRow;
    const l = ledgerReport(run, steps);
    expect(l.fixed).toEqual(["「撰寫第 1–3 頁」：CER 數字錯", "最終驗收：忠於來源"]);
    expect(l.unresolved).toEqual(["「撰寫第 1–3 頁」第 3 頁：流程圖其實是條列"]);
    expect(l.invalid[0]).toContain("問題描述自相矛盾");
    const r = buildReport(run, steps, "done", null, null);
    expect(r.summary_md).toContain("已修正 2 個、仍未解決 1 個、判定無效 1 個");
    expect(r.issues.join()).toContain("仍未解決");
    expect(r.ledger).toEqual(l);
  });
});
