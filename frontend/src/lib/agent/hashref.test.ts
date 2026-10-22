import { describe, expect, it } from "vitest";
import { activeHash, contextWithRefs, kindKeyword, mentionText, parseHash, replaceToken, suggestKinds } from "./hashref.ts";

const at = (text: string) => activeHash(text, text.length);

describe("# references", () => {
  it("finds the # being typed only at a word start", () => {
    expect(at("#")).toEqual({ start: 0, end: 1, raw: "" });
    expect(at("把 #簡報 週")).toEqual({ start: 2, end: 7, raw: "簡報 週" });
    expect(at("把#簡報")?.raw).toBe("簡報"); // CJK text before # is fine
    expect(at("C#")).toBeNull();
    expect(at("see a#b")).toBeNull();
    expect(at("&#")).toBeNull();
    expect(at("https://x.test/#frag")).toBeNull();
    expect(at("#簡報\n週報")).toBeNull(); // a new line ends it
    expect(at("# 週報")).toBeNull(); // markdown heading
    expect(at("#slides  ")).toBeNull(); // two spaces: done
    expect(at("##")).toBeNull();
    expect(at(`#${"x".repeat(80)}`)).toBeNull();
    // caret in the middle: only the part before it
    expect(activeHash("#簡報 週報 改成英文", 3)).toEqual({ start: 0, end: 3, raw: "簡報" });
  });

  it("parses kind keywords (zh and English) and the query", () => {
    expect(parseHash("")).toEqual({ kind: null, kindText: "", query: "" });
    expect(parseHash("簡報")).toEqual({ kind: "deck", kindText: "簡報", query: "" });
    expect(parseHash("簡報 週報")).toMatchObject({ kind: "deck", query: "週報" });
    expect(parseHash("簡報週報")).toMatchObject({ kind: "deck", query: "週報" });
    expect(parseHash("slides weekly report")).toMatchObject({ kind: "deck", query: "weekly report" });
    expect(parseHash("Slides:weekly")).toMatchObject({ kind: "deck", query: "weekly" });
    expect(parseHash("論文 wav2vec")).toMatchObject({ kind: "paper", query: "wav2vec" });
    expect(parseHash("論文專案")).toMatchObject({ kind: "latex_project", query: "" });
    expect(parseHash("latex 第三章")).toMatchObject({ kind: "latex_project", query: "第三章" });
    expect(parseHash("todo 錯誤")).toMatchObject({ kind: "task", query: "錯誤" });
    expect(parseHash("研究")).toMatchObject({ kind: "study" });
    // no word boundary after an English keyword: not a kind
    expect(parseHash("paperless")).toEqual({ kind: null, kindText: "paperless", query: "paperless" });
    expect(parseHash("zipformer")).toMatchObject({ kind: null, query: "zipformer" });
  });

  it("suggests kinds by prefix in both languages", () => {
    expect(suggestKinds("")).toHaveLength(7);
    expect(suggestKinds("sl")).toEqual(["deck"]);
    expect(suggestKinds("簡")).toEqual(["deck"]);
    expect(suggestKinds("論")).toEqual(["paper", "latex_project"]);
    expect(suggestKinds("me")).toEqual(["meeting"]);
    expect(suggestKinds("t")).toEqual(["latex_project", "task"]);
    expect(suggestKinds("zipformer")).toEqual([]);
    expect(kindKeyword("deck", "zh-TW")).toBe("簡報");
    expect(kindKeyword("deck", "en")).toBe("slides");
    expect(kindKeyword("latex_project", "en")).toBe("latex");
  });

  it("replaces the token and names the picked item", () => {
    const text = "把 #簡報 週 改成英文";
    const tok = activeHash(text, 7)!;
    expect(replaceToken(text, tok, mentionText("週報 v2"))).toEqual({ text: "把 〈週報 v2〉 改成英文", caret: 9 });
    const end = "改 #slides w";
    expect(replaceToken(end, at(end)!, "#簡報")).toEqual({ text: "改 #簡報 ", caret: 6 });
    expect(mentionText("A〈B〉")).toBe("〈AB〉");
  });

  it("turns study / task chips into page context", () => {
    const S = "s1";
    expect(contextWithRefs(null, [])).toBeNull();
    expect(contextWithRefs({ path: "/x", studySlug: "asr" }, [{ kind: "study", id: S }])).toEqual({ path: "/x", studyId: S });
    expect(contextWithRefs(null, [{ kind: "task", id: "t1", studyId: "s2" }])).toEqual({ studyId: "s2", taskId: "t1" });
    expect(contextWithRefs(null, [{ kind: "task", id: "t1", studyId: "s2" }, { kind: "study", id: S }])).toEqual({ studyId: S, taskId: "t1" });
    const ctx = { deckId: "d" };
    expect(contextWithRefs(ctx, [{ kind: "deck", id: "d2" }])).toBe(ctx);
  });
});
