import { describe, expect, it } from "vitest";
import { labelSummary } from "../src/agent/summary-labels.js";

const study = { id: "9696d128-abd6-4e2e-b8a5-6b427356ad4b", slug: "qa2-agent", title: "QA2 Agent 語音研究" };

describe("labelSummary", () => {
  it("replaces ids and slugs the result names", () => {
    expect(labelSummary(`查看研究 ${study.id} 的進度`, { study })).toBe("查看研究 〈QA2 Agent 語音研究〉 的進度");
    expect(labelSummary("讀取研究 qa2-agent", { study })).toBe("讀取研究 〈QA2 Agent 語音研究〉");
    expect(labelSummary("讀取文獻 p1-aaaaaaaa", { id: "p1-aaaaaaaa", title: "wav2vec 2.0" })).toBe("讀取文獻 〈wav2vec 2.0〉");
  });
  it("leaves other text alone", () => {
    expect(labelSummary("讀取研究 qa2-agent-2", { study })).toBe("讀取研究 qa2-agent-2");
    expect(labelSummary("搜尋 qa2", { results: [] })).toBe("搜尋 qa2");
    expect(labelSummary("", { study })).toBe("");
  });
});
