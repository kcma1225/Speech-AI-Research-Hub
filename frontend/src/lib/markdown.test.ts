import { describe, expect, it } from "vitest";
import { cellWidth, markdownToHtml, unclosedMathStart } from "./markdown.ts";

const html = (s: string, streaming = false) => markdownToHtml(s, { streaming });
const hasMath = (s: string) => s.includes('class="katex');

describe("math delimiters", () => {
  it("renders $…$ and \\(…\\) inline", () => {
    expect(hasMath(html("Energy $E=mc^2$ here"))).toBe(true);
    expect(hasMath(html("Energy \\(E=mc^2\\) here"))).toBe(true);
    expect(html("Energy \\(E=mc^2\\) here")).not.toContain("md-math\"");
  });

  it("renders $$…$$, \\[…\\] and ```math as display blocks with a copy button and data-tex", () => {
    for (const src of ["$$\na^2+b^2=c^2\n$$", "\\[\na^2+b^2=c^2\n\\]", "\\[a^2+b^2=c^2\\]", "```math\na^2+b^2=c^2\n```"]) {
      const out = html(src);
      expect(out, src).toContain('class="md-math"');
      expect(out, src).toContain('data-tex="a^2+b^2=c^2"');
      expect(out, src).toContain("md-math-copy");
      expect(out, src).toContain("katex-display");
    }
  });

  it("display math interrupts a paragraph", () => {
    const out = html("The loss is\n\\[\n\\mathcal{L} = -\\sum_t \\log p(y_t)\n\\]\nwhere y is the label.");
    expect(out).toContain('class="md-math"');
    expect(out).toContain("where y is the label");
  });

  it("\\[…\\] inside a sentence renders as display math", () => {
    expect(html("so \\[x = 1\\] holds")).toContain("katex-display");
  });

  it("escapes data-tex attribute content", () => {
    expect(html('$$\n\\text{"a" < b}\n$$')).toContain('data-tex="\\text{&quot;a&quot; &lt; b}"');
  });
});

describe("currency is not math", () => {
  it.each([
    "It costs $5 and $10.",
    "US$3 or NT$100",
    "Budget: $100,000",
    "it costs $5.",
    "Pay $5 to buy a $ thing",
    "價格 $5，$10 也可以",
    "$3 and more$",
  ])("%s", (src) => {
    expect(hasMath(html(src))).toBe(false);
  });

  it("escaped \\$ stays a dollar sign", () => {
    const out = html("\\$x$ and \\$y\\$");
    expect(hasMath(out)).toBe(false);
    expect(out).toContain("$x$");
  });

  it("still renders number-led math with operators", () => {
    expect(hasMath(html("$2 \\times 3 = 6$"))).toBe(true);
  });
});

describe("code is untouched", () => {
  it("inline code and fences keep their dollars and backslashes", () => {
    const out = html("Use `$x$` and `\\(y\\)`\n\n```python\nprint('$a$', '\\[b\\]')\n```");
    expect(hasMath(out)).toBe(false);
    expect(out).toContain("<code>$x$</code>");
    expect(out).toContain("<code>\\(y\\)</code>");
  });
});

describe("streaming", () => {
  it("finds an unclosed display block", () => {
    expect(unclosedMathStart("text\n$$\na+b")).toBe(5);
    expect(unclosedMathStart("text\n\\[\na+b")).toBe(5);
    expect(unclosedMathStart("a\n```math\nx")).toBe(2);
    expect(unclosedMathStart("$$a$$ done")).toBe(-1);
    expect(unclosedMathStart("```\n$$\n```")).toBe(-1);
    expect(unclosedMathStart("`$$` in code")).toBe(-1);
  });

  it("shows a pending placeholder instead of half-rendered TeX", () => {
    const out = html("Here is the loss:\n\n$$\n\\mathcal{L} = \\sum", true);
    expect(out).toContain("Here is the loss");
    expect(out).toContain("md-math-pending");
    expect(hasMath(out)).toBe(false);
    expect(out).toContain("\\mathcal{L} = \\sum");
  });

  it("pending ```math fence", () => {
    const out = html("Loss\n\n```math\n\\frac{a}{", true);
    expect(out).toContain("md-math-pending");
    expect(hasMath(out)).toBe(false);
  });

  it("renders normally once the delimiter arrives", () => {
    const out = html("Loss:\n\n$$\n\\mathcal{L} = \\sum_i x_i\n$$", true);
    expect(out).not.toContain("md-math-pending");
    expect(out).toContain('class="md-math"');
  });

  it("an unfinished inline $ is plain text, not an error", () => {
    const out = html("The term $\\alpha + ", true);
    expect(hasMath(out)).toBe(false);
    expect(out).not.toContain("katex-error");
  });
});

describe("```chart", () => {
  it("renders a bar chart SVG from a JSON spec and keeps invalid specs as code", async () => {
    const { parseChartSpec, renderChartSvg, niceTicks } = await import("./chart.ts");
    const spec = parseChartSpec('{"type":"bar","title":"CER","labels":["W1","W2"],"series":[{"name":"CER","data":[12.5,10.1]}]}');
    expect(spec?.type).toBe("bar");
    const svg = renderChartSvg(spec!);
    expect(svg).toContain("<svg");
    expect(svg.match(/<rect /g)?.length).toBe(2);
    expect(svg).toContain("12.5");
    const line = renderChartSvg(parseChartSpec('{"type":"line","labels":["a","b","c"],"series":[{"name":"x","data":[1,null,3]},{"name":"y","data":[2,3,4]}]}')!);
    expect(line.match(/<polyline /g)?.length).toBe(1); // the gap splits x into single points (no line), y is one line
    expect(parseChartSpec("not json")).toBeNull();
    expect(parseChartSpec('{"type":"pie","series":[]}')).toBeNull();
    expect(niceTicks(0, 13)).toEqual([0, 5, 10, 15]);
    expect(markdownToHtml('```chart\n{"labels":["a"],"series":[{"data":[3]}]}\n```')).toContain('class="md-chart"');
    expect(markdownToHtml("```chart\n{oops\n```")).toContain("<pre");
    expect(renderChartSvg(parseChartSpec('{"title":"<script>","series":[{"data":[1]}]}')!)).not.toContain("<script>");
  });
});

describe("CJK emphasis", () => {
  it("bolds and italicises next to CJK text and punctuation", () => {
    expect(markdownToHtml("**重點：**後面的文字")).toContain("<strong>重點：</strong>後面");
    expect(markdownToHtml("這是**「引號內」**的強調")).toContain("<strong>「引號內」</strong>");
    expect(markdownToHtml("見（**表 2**）結果")).toContain("<strong>表 2</strong>");
    expect(markdownToHtml("*斜體*，然後")).toContain("<em>斜體</em>");
    expect(markdownToHtml("English **bold** text")).toContain("<strong>bold</strong>");
    expect(markdownToHtml("2 * 3 * 4")).not.toContain("<em>");
  });
});

describe("table cells", () => {
  it("counts CJK as double width", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("台語ab")).toBe(6);
  });
  it("marks sentence-length cells to wrap, keeps short cells on one line", () => {
    const html = markdownToHtml("| 模型 | 說明 |\n|---|---|\n| small | 台語音訊好收（廣播、戲劇、Podcast），但逐字稿稀少，網路字幕多是華語 |");
    expect(html).toMatch(/<td class="md-wrap">台語音訊/);
    expect(html).toMatch(/<td>small<\/td>/);
    expect(html).toMatch(/<th>模型<\/th>/);
  });
});
