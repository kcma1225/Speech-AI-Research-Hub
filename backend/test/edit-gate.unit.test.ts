/** The artifact edit gate's pure parts (lib/artifacts/build-check.ts) and the turn-end rule on refused edits (guards.ts). */
import { describe, expect, it } from "vitest";
import { checkNoteEdit, EDIT_REFUSED, errorLines, noteProblems, refusal } from "../src/lib/artifacts/build-check.js";
import { completionReview, type RunCall } from "../src/agent/guards.js";

describe("edit gate", () => {
  it("note structure: only what the edit breaks", () => {
    expect(noteProblems("# A\n\n```py\nx\n```\n\n$$a$$\n")).toEqual([]);
    expect(checkNoteEdit("# A\n", "# A\n\n```py\nx\n")).toMatchObject({ ok: false, problems: ["程式碼區塊（```）沒有關閉"] });
    expect(checkNoteEdit("# A\n\n$$\nx\n", "# A\n\n$$\nx\n\nmore\n").ok).toBe(true);
    expect(noteProblems("<!-- a\n")).toEqual(["HTML 註解（<!-- -->）沒有關閉"]);
  });
  it("build logs: the error lines, colours stripped", () => {
    expect(errorLines("\u001b[91mERROR: YAMLException: duplicated mapping key (index.qmd, 4:1)\u001b[39m\n3: subtitle: x\nOK")).toEqual(["ERROR: YAMLException: duplicated mapping key (index.qmd, 4:1)"]);
    expect(errorLines("a\nb\nc\nd")).toEqual(["b", "c", "d"]);
  });
  it("the refusal names the problems and how to re-read", () => {
    const r = refusal("簡報", { ok: false, problems: ["編譯錯誤：x"], verified: "built" }, "get_deck");
    expect(r.startsWith(EDIT_REFUSED)).toBe(true);
    expect(r).toContain("實際編譯");
    expect(r).toContain("get_deck");
  });
  it("a refused edit keeps the turn open until a later edit of the same artifact goes through", () => {
    const refused: RunCall = { tool: "suggest_deck_edit", risk: "write", status: "failed", step: 1, refused: true, target: "d1|f1" };
    const facts = (calls: RunCall[]) => ({ text: "好了", calls, earlierWrite: true, plan: null });
    expect(completionReview(facts([refused]))).toContain("沒有建立");
    expect(completionReview(facts([refused, { ...refused, status: "done", refused: false, step: 2 }]))).toBeNull();
    // Another artifact's success does not settle it.
    expect(completionReview(facts([refused, { ...refused, status: "done", refused: false, target: "d2|f9" }]))).toContain("沒有建立");
  });
});

import { bibClaimProblems, newBibClaimProblems } from "../src/lib/artifacts/facts.js";
import { runChecks } from "../src/workflows/checks.js";

describe("claims about the paper's venue need the library record (61666f10)", () => {
  const pub = { venue: "Interspeech", year: 2024, preprint: false, title: "Fast Context-Biasing for CTC and Transducer ASR models", first_author: "Andrusenko" };
  const pre = { ...pub, venue: "arXiv", preprint: true };
  it("「不是會議論文」 is never supported", () => {
    expect(bibClaimProblems("這篇論文發表於 arXiv，2024 年，並不是會議論文。", pub)[0]).toContain("Interspeech 2024");
    expect(bibClaimProblems("這篇論文發表於 arXiv，2024 年，並不是會議論文。", pre)[0]).toContain("目前只查到 arXiv 預印本紀錄");
    expect(bibClaimProblems("This is not a conference paper.", pub)).toHaveLength(1);
  });
  it("a venue said about THIS paper must match; other papers' venues are not checked", () => {
    expect(bibClaimProblems("這篇論文發表於 ICASSP 2024。", pub)[0]).toContain("文獻庫記錄的是 Interspeech 2024");
    expect(bibClaimProblems("這篇論文正式發表於 Interspeech 2024。", pub)).toEqual([]);
    expect(bibClaimProblems("這篇論文發表於 Interspeech 2023。", pub)[0]).toContain("年份");
    expect(bibClaimProblems("CLAS 由 Pundak 等人發表於 SLT 2018。", pub)).toEqual([]);
    expect(bibClaimProblems("Andrusenko et al. published it at ICASSP.", pub)).toHaveLength(1);
    expect(bibClaimProblems("這篇論文發表於 Interspeech 2024。", pre)[0]).toContain("沒有查證");
  });
  it("only what an edit adds; the check reads the whole deck (notes included)", () => {
    const before = "這篇論文並不是會議論文。";
    expect(newBibClaimProblems(before, `${before}\n新增一行。`, pub)).toEqual([]);
    expect(runChecks([{ id: "bib_claims", params: pub }], "", { full: "## A\n\nx\n\n::: {.notes}\n這篇發表於 arXiv，不是會議論文。\n:::\n" })[0]).toMatchObject({ ok: false });
  });
});
