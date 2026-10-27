/**
 * A request about a part of the given deck (its notes, a page…) is an edit of that deck whatever the verb, and a
 * notes-only request keeps every slide body (production 79ab: 「從講稿中拿掉引用論文的部分」 became a new progress report
 * written over the deck; 「講稿要是中文的」 rewrote slide text and turned a diagram into a bar chart).
 */
import { describe, expect, it } from "vitest";
import "../src/workflows/playbooks/index.js";
import { notesOnlyAsked, route } from "../src/workflows/route.js";
import { keepSlideBodies } from "../src/workflows/playbooks/slides-requirements.js";
import { checkRun, contentClauses } from "../src/workflows/invariants.js";
import { detectRequirements } from "../src/workflows/requirements.js";

const deckRoute = (words: string) =>
  route({ words: [words], hint: "slides", inputs: { deck_id: "d1", study: "s1" }, ready: { papers: 2, papers_with_pdf: 2, experiment_notes: 1, latex_projects: 0, deckPages: 8 } } as never);

describe("deck-part requests on a given deck", () => {
  it("routes the production request as a notes-only edit", () => {
    const r = deckRoute("我想要從講稿中拿掉引用論文的部分這樣子還要講他來自哪一個論文很奇怪");
    expect(r.deck).toBe("edit");
    expect(r.edit).toBe("revise");
    expect(r.scope).toBe("notes");
    expect(r.reason).not.toContain("從 0 到 1");
  });
  it("reads removal verbs and page references as edits", () => {
    expect(deckRoute("把第 3 頁的那張表拿掉").deck).toBe("edit");
    expect(deckRoute("remove the citation from the speaker notes").scope).toBe("notes");
    expect(deckRoute("這頁的標題太長了").deck).toBe("edit");
    // A keyword hint for a note does not win over a given deck the words are about (scenario n81).
    const r = route({ words: ["Take the paper citations out of the speaker notes, it sounds odd to say which paper each idea came from."], hint: "generic", inputs: { deck_id: "d1", study: "s1" }, ready: { papers: 2, papers_with_pdf: 2, experiment_notes: 1, latex_projects: 0, deckPages: 8 } } as never);
    expect([r.kind, r.deck, r.scope]).toEqual(["deck", "edit", "notes"]);
  });
  it("keeps notes-only for notes requests and not when slides change too", () => {
    expect(notesOnlyAsked("有個東西我想要你幫我改這個簡報裡面的講稿要是中文的當然你應該要多用一點英文的專用名詞")).toBe(true);
    expect(notesOnlyAsked("講稿和投影片標題都改成英文")).toBe(false);
    expect(notesOnlyAsked("加一頁 related work，講稿也要寫")).toBe(false);
    expect(deckRoute("把投影片改成英文").scope).toBeUndefined();
  });
  it("still makes a new deck when one is asked for", () => {
    expect(deckRoute("幫我做一份新的進度報告簡報").deck).not.toBe("edit");
    expect(deckRoute("幫我準備這週的進度報告").deck).not.toBe("edit");
  });
});

describe("keepSlideBodies", () => {
  const originals = [
    "## Problem\n\n```diagram\n{\"type\":\"graph\"}\n```\n\n::: {.notes}\n這個方法來自 Smith et al. (2023)。\n:::",
    "## Results\n\n- WER 5.1%\n\n::: {.notes}\n結果如下。\n:::",
    "## Next\n\n- plan",
  ];
  it("keeps every body and takes only the new notes", () => {
    const written = [
      "## Problem\n\n```chart\n{\"type\":\"bar\"}\n```\n\n::: {.notes}\n這個方法的想法是先偵測熱詞。\n:::",
      "## Results (revised)\n\n- WER 4.0%\n\n::: {.notes}\n結果是錯字率下降。\n:::",
    ].join("\n\n");
    const out = keepSlideBodies(written, originals);
    expect(out).toContain("```diagram");
    expect(out).not.toContain("```chart");
    expect(out).toContain("WER 5.1%");
    expect(out).not.toContain("WER 4.0%");
    expect(out).toContain("先偵測熱詞");
    expect(out).not.toContain("Smith et al.");
    expect(out).toContain("結果是錯字率下降");
    // A page the writers dropped comes back as it was.
    expect(out).toContain("## Next\n\n- plan");
    expect(out.match(/^## /gm)).toHaveLength(3);
    expect(out.match(/\{\.notes\}/g)).toHaveLength(2);
  });
});

describe("invariants", () => {
  it("route.deck_part_edit flags a notes request routed as a new deck", () => {
    const run = { id: "r", status: "partial", playbook: "slides", inputs: { deck_id: "d1" }, brief: { user_words: ["我想要從講稿中拿掉引用論文的部分"] }, state: { route: { deck: "progress", kind: "deck" } } };
    expect(checkRun({ run } as never, ["route.deck_part_edit"])).toHaveLength(1);
    expect(checkRun({ run: { ...run, state: { route: { deck: "edit", kind: "deck" } } } } as never, ["route.deck_part_edit"])).toHaveLength(0);
  });
  it("deck.notes_only_bodies flags a changed slide body", () => {
    const original_slides = ["## A\n\n- x\n\n::: {.notes}\n舊\n:::", "## B\n\n- y"];
    const ok = { notes_only: true, original_slides, deck: { body: "## A\n\n- x\n\n::: {.notes}\n新\n:::\n\n## B\n\n- y\n" } };
    const bad = { notes_only: true, original_slides, deck: { body: "## A\n\n- x changed\n\n::: {.notes}\n新\n:::\n\n## B\n\n- y\n" } };
    expect(checkRun({ run: { id: "r", status: "done", playbook: "slides", state: ok } } as never, ["deck.notes_only_bodies"])).toHaveLength(0);
    expect(checkRun({ run: { id: "r", status: "done", playbook: "slides", state: bad } } as never, ["deck.notes_only_bodies"])[0]!.message).toContain("第 1 頁");
  });
});

describe("an instruction on the speaker notes is a requirement", () => {
  it("covers the production clause (scenario n80)", () => {
    const words = "我想要從講稿中拿掉引用論文的部分這樣子還要講他來自哪一個論文很奇怪";
    const r = detectRequirements(words, { kind: "deck" }).find((x) => x.params?.part === "notes" && x.type === "other");
    expect(r?.quote).toContain("拿掉引用論文");
    expect(detectRequirements("Take the paper citations out of the speaker notes", { kind: "deck" }).some((x) => x.params?.part === "notes")).toBe(true);
    // A notes language clause stays a language requirement only.
    expect(detectRequirements("講稿改成中文", { kind: "deck" }).filter((x) => x.type === "other")).toHaveLength(0);
  });
});

describe("contentClauses", () => {
  it("does not take a reason for an ask as an ask (scenario n82)", () => {
    const cs = contentClauses("把 speaker notes 裡引用 paper 的部分拿掉，講出處很奇怪。");
    expect(cs.find((c) => c.clause.includes("講出處很奇怪"))?.core).toBe(true);
    expect(cs.find((c) => c.clause.includes("拿掉"))?.core).toBe(false);
  });
});
