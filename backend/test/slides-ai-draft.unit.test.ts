import { describe, expect, it } from "vitest";
import { appendSlides, continueMessages, countSlides, draftMessages, dropLastSlide, expectedPages } from "../src/lib/slides/ai-context.js";

describe("AI deck draft helpers", () => {
  it("reads the planned page count from the user's instructions", () => {
    expect(expectedPages("paper_report")).toBe(13);
    expect(expectedPages("progress", "請強調 WER")).toBe(8);
    expect(expectedPages("paper_report", "請建立一份繁體中文的 11 頁論文報告，適合約 15–20 分鐘口頭報告。")).toBe(11);
    expect(expectedPages("paper_report", "Make 9 slides")).toBe(9);
    // 「第 9 與第 15 encoder layers」/「第 3 頁」 are references, not counts; a numbered structure counts.
    expect(expectedPages("paper_report", "頁面結構：\n1. 標題頁\n2. 動機\n5. 方法：第 9 與第 15 層注入\n10. 限制\n11. 結論")).toBe(11);
    expect(expectedPages("paper_report", "把第 3 頁寫短一點")).toBe(13);
  });

  it("lets the user's structure override the fixed format and asks for every page at once", () => {
    const [, user] = draftMessages("paper_report", "DATA", "請建立 11 頁");
    expect(user!.content).toContain("優先於上面的規則");
    expect(user!.content).toContain("請一次輸出完整的 11 頁論文報告");
    expect(draftMessages("progress", "D")[1]!.content).toContain("完整的 8 頁進度報告");
  });

  it("drops a cut-off last slide, appends only new slides, and asks to continue from the next page", () => {
    const body = "## A\n\na\n\n## B\n\nb\n\n## C\n\nhalf";
    expect(countSlides(dropLastSlide(body))).toBe(2);
    expect(dropLastSlide("## A\n\nonly")).toBe("## A\n\nonly");
    const merged = appendSlides("## A\n\na\n\n## B\n\nb\n", "## B\n\nrepeat\n\n## C\n\nc\n\n## D\n\nd\n");
    expect(merged).toBe("## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n\n## D\n\nd\n");
    const msgs = continueMessages(draftMessages("paper_report", "D", "11 頁"), "## A\n\na\n\n## B\n\nb\n", 11);
    expect(msgs.at(-2)).toEqual({ role: "assistant", content: "## A\n\na\n\n## B\n\nb\n" });
    expect(msgs.at(-1)!.content).toContain("從第 3 頁接著寫完剩下的 9 頁");
  });
});
