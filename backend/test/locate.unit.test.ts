import { describe, expect, it } from "vitest";
import { visiblyChangedPages } from "../src/lib/artifacts/build-check.js";
import { closestPassage, locateEdits, looseMatches, type SuggestionTrail } from "../src/lib/artifacts/locate.js";
import { HttpError } from "../src/lib/http.js";

const DECK = `---
title: "WCTC-Biasing"
subtitle: "Interspeech 2024"
---

## My assessment

[AI 代填，待你確認]{.hub-ai-filled}

- The method is practical.

::: {.notes}
（AI 代填，待你確認：自動駕駛依研究資料草擬的建議）
:::

## Takeaways for my work

[AI 代填，待你確認]{.hub-ai-filled}

- Try it on our streaming model.

::: {.notes}
（AI 代填，待你確認：自動駕駛依研究資料草擬的建議）
:::
`;

const fail = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};
const deck = (trail: SuggestionTrail[] = []) => ({ kind: "deck" as const, reread: "get_deck", trail });

describe("locateEdits (production 64876e38)", () => {
  it("takes an exact unique passage, and the same text up to whitespace / line breaks", () => {
    const [h] = locateEdits(DECK, [{ before: "- The method is practical.", after: "- Practical." }], deck());
    expect(DECK.slice(h!.from, h!.to)).toBe("- The method is practical.");
    const [loose] = locateEdits(DECK, [{ before: "## My assessment\n[AI 代填，待你確認]{.hub-ai-filled}", after: "## My assessment" }], deck());
    expect(loose!.before).toBe("## My assessment\n\n[AI 代填，待你確認]{.hub-ai-filled}");
  });

  it("names the pages of a repeated passage, and `page` picks one", () => {
    const notes = "（AI 代填，待你確認：自動駕駛依研究資料草擬的建議）";
    expect(fail(() => locateEdits(DECK, [{ before: notes, after: "x" }], deck()))).toContain("出現 2 次（第 2 頁、第 3 頁）");
    const [h] = locateEdits(DECK, [{ before: notes, after: "I think it is practical.", page: 3 }], deck());
    expect(h!.from).toBeGreaterThan(DECK.indexOf("## Takeaways"));
    expect(fail(() => locateEdits(DECK, [{ before: "- Try it on our streaming model.", after: "x", page: 2 }], deck()))).toContain("第 2 頁沒有這段文字（它在第 3 頁）");
  });

  it("explains a miss: a pending suggestion's new text, text an applied one replaced; and shows the closest passage", () => {
    const pending: SuggestionTrail = { title: "簡化結論", status: "pending", mine: true, hunks: [{ before: "- The method is practical.", after: "- I think the main idea is useful." }] };
    const msg = fail(() => locateEdits(DECK, [{ before: "- I think the main idea is useful.", after: "x" }], deck([pending])));
    expect(msg).toContain("你還沒被接受的建議〈簡化結論〉");
    const applied: SuggestionTrail = { title: "改英文", status: "applied", mine: false, hunks: [{ before: "- Old wording of the takeaway here.", after: "- Try it on our streaming model." }] };
    expect(fail(() => locateEdits(DECK, [{ before: "- Old wording of the takeaway here.", after: "x" }], deck([applied])))).toContain("已經被使用者接受的建議〈改英文〉改掉了");
    const near = fail(() => locateEdits(DECK, [{ before: "## Takeaways for my research\n\n- Try it on the streaming model.", after: "x" }], deck()));
    expect(near).toContain("檔案目前最接近的是第 3 頁");
    expect(near).toContain("- Try it on our streaming model.");
  });

  it("refuses two edits of the same passage", () => {
    expect(fail(() => locateEdits(DECK, [{ before: "## My assessment", after: "a" }, { before: "My assessment\n\n[AI", after: "b" }], deck()))).toContain("改到同一段文字");
  });

  it("looseMatches / closestPassage", () => {
    expect(looseMatches("a  b\n c", "a b c")).toEqual([[0, 7]]);
    expect(closestPassage("alpha\nbeta\ngamma", "zzzz qqqq")).toBeNull();
  });
});

describe("visiblyChangedPages", () => {
  it("counts pages whose title or shown text changed, not speaker notes", () => {
    const notesOnly = DECK.replace("（AI 代填，待你確認：自動駕駛依研究資料草擬的建議）\n:::\n\n## Takeaways", "I think it is practical.\n:::\n\n## Takeaways");
    expect(visiblyChangedPages(DECK, notesOnly)).toEqual([]);
    expect(visiblyChangedPages(DECK, DECK.replace("- Try it on our streaming model.", "- Try it."))).toEqual([3]);
    expect(visiblyChangedPages(DECK, DECK.replace('subtitle: "Interspeech 2024"', 'subtitle: "Andrusenko et al., Interspeech 2024"'))).toEqual([1]);
  });
});
