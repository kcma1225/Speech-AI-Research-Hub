/** The shared artifact view (lib/artifacts/view.ts): one numbering, visible text apart from notes, source and rendered. */
import { describe, expect, it } from "vitest";
import { deckPageOfOffset, deckRenderedView, deckSourceView, latexView, noteView, unitAt, unitLabel, viewText } from "../src/lib/artifacts/view.js";

const QMD = `---\ntitle: "T"\nsubtitle: "Andrusenko et al., Interspeech 2024"\n---\n\n## A {.fit-90}\n\n- one ![fig](a.png){width=50%}\n\n<!-- hidden -->\n\n::: {.notes}\nsay this\n:::\n\n## B\n\nlast\n`;
const HTML = `<html><head><style>.x{}</style></head><body><div class="reveal"><div class="slides">
<section id="title-slide" class="quarto-title-block center"><h1 class="title">T</h1><p class="subtitle">Andrusenko et al., Interspeech 2024</p></section>
<section id="a" class="slide level2"><h2>A</h2><ul><li>one <img src="a.png" alt="fig"></li></ul><aside class="notes"><p>say this</p><style>span{}</style></aside></section>
<section id="b" class="slide level2"><h2>B</h2><p>last</p><script>var x=1</script></section></div></div></body></html>`;

describe("artifact view", () => {
  it("source and rendered decks number pages the same way; notes are never visible", () => {
    for (const v of [deckSourceView(QMD), deckRenderedView(HTML)]) {
      expect(v.units.map((u) => [u.page, u.kind, u.title])).toEqual([[1, "cover", "T"], [2, "slide", "A"], [3, "slide", "B"]]);
      expect(unitAt(v, 1)!.visible).toContain("Interspeech 2024");
      expect(unitAt(v, 2)!.visible).toContain("fig");
      expect(unitAt(v, 2)!.visible).not.toContain("say this");
      expect(unitAt(v, 2)!.notes).toContain("say this");
      expect(unitAt(v, -1)!.title).toBe("B");
      expect(unitLabel(v, unitAt(v, 3)!)).toBe("第 3 頁「B」");
    }
    expect(deckSourceView(QMD).units[1]!.visible).not.toContain("hidden");
    expect(deckRenderedView(HTML).units[2]!.visible).not.toContain("var x");
    expect(viewText(deckSourceView(QMD))).toContain("[講稿（不顯示在投影片上）]\nsay this");
  });
  it("offsets map to pages (front matter = the cover)", () => {
    expect(deckPageOfOffset(QMD, 5)).toBe(1);
    expect(deckPageOfOffset(QMD, QMD.indexOf("one"))).toBe(2);
    expect(deckPageOfOffset(QMD, QMD.indexOf("last"))).toBe(3);
    expect(deckPageOfOffset("## A\n\nx\n", 6)).toBe(1);
  });
  it("notes and LaTeX are sections", () => {
    const n = noteView("intro\n\n# One\n\ntext\n\n```\n# not a heading\n```\n\n## Two\n\nmore\n");
    expect(n.units.map((u) => [u.kind, u.page, u.title])).toEqual([["preamble", 0, ""], ["section", 1, "One"], ["section", 2, "Two"]]);
    expect(unitLabel(n, n.units[2]!)).toBe("第 2 節「Two」");
    const l = latexView("\\documentclass{x}\n\\section{Intro}\nA % comment\n\\section{Method}\nB\n");
    expect(l.units.map((u) => [u.kind, u.title])).toEqual([["preamble", ""], ["section", "Intro"], ["section", "Method"]]);
    expect(l.units[1]!.visible).not.toContain("comment");
  });
});
