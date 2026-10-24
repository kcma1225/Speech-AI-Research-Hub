import { describe, expect, it } from "vitest";
import { CHECKS as checks, scrubPlaceholders } from "../src/workflows/checks.js";

// The production case (eval deck_exact_pages): the template's 「距上次新數字：〔N〕 週」 survived three writer rounds.
const deck = `## 對帳
![](diagrams/a.svg){.hub-diagram}

- 已完成：6 篇文獻回顧＋四指標筆記

::: {.takeaway}
距上次新數字：〔N〕週｜落差＝下方三張待辦卡
:::

::: {.notes}
這頁用時間軸對照里程碑。已完成 6 篇文獻回顧。距上次新數字的週數目前無法計算，因此頁面保留〔N〕待補。下方三張任務卡是待辦。
:::

## Table 1

| 方法 | CER |
|---|---|
| baseline | 5.1% |
| ours | 〔　〕 |

\`\`\`chart
{"title": "TODO keep code"}
\`\`\`

## 卡住

- 問題：〔　〕
`;

describe("scrubPlaceholders", () => {
  it("drops placeholder segments, rows and note sentences outside the student's own pages", () => {
    const r = scrubPlaceholders(deck, ["卡住"]);
    expect(r.pages).toEqual(["對帳", "Table 1"]);
    expect(r.body).toContain("落差＝下方三張待辦卡");
    expect(r.body).not.toContain("〔N〕");
    expect(r.body).toContain("這頁用時間軸對照里程碑。已完成 6 篇文獻回顧。下方三張任務卡是待辦。");
    expect(r.body).toContain("| baseline | 5.1% |");
    expect(r.body).not.toContain("| ours |");
    expect(r.body).toContain('"TODO keep code"');
    expect(r.body).toContain("- 問題：〔　〕");
    const clean = checks.no_placeholder!(r.body.replace(/```[\s\S]*?```/g, ""), { params: { allow_titles: ["卡住"], on_slide: true }, data: null });
    expect(clean.ok).toBe(true);
  });

  it("removes a div left empty and leaves clean decks untouched", () => {
    const r = scrubPlaceholders("## A\n\n::: {.takeaway}\nTBD\n:::\n\n- ok\n");
    expect(r.body).toBe("## A\n\n- ok\n");
    const same = "## B\n\n- 數字 5.1%\n";
    expect(scrubPlaceholders(same)).toEqual({ body: same, removed: 0, pages: [] });
  });
});
