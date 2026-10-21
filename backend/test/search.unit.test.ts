import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/lib/search/chunk.js";
import { rrf } from "../src/lib/search/rrf.js";
import { findHighlights, makeSnippet, plainText, relaxedThreshold, tokenizeQuery } from "../src/lib/search/text.js";

describe("chunkMarkdown", () => {
  it("returns nothing for empty text and one chunk for short text", () => {
    expect(chunkMarkdown("", "T")).toEqual([]);
    expect(chunkMarkdown("  \n\n ", "T")).toEqual([]);
    expect(chunkMarkdown("短短一段。", "標題")).toEqual(["標題\n短短一段。"]);
  });

  it("splits by headings and paragraphs near the target size with overlap and heading context", () => {
    const para = (n: number) => `第${n}段：${"語音辨識模型的實驗結果與分析。".repeat(12)}`;
    const md = `# 實驗\n\n${para(1)}\n\n${para(2)}\n\n## 結果\n\n${para(3)}\n\n${para(4)}\n\n${para(5)}`;
    const chunks = chunkMarkdown(md, "筆記", { target: 400, overlap: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.startsWith("筆記\n")).toBe(true);
      expect(c.length).toBeLessThan(400 * 1.5 + 200);
    }
    expect(chunks.some((c) => c.includes("實驗 › 結果"))).toBe(true);
    // Overlap: a later chunk starts with the tail of the previous one.
    const second = chunks[1]!.split("\n").slice(2).join("\n");
    const tailOfFirst = chunks[0]!.slice(-30);
    expect(second.includes(tailOfFirst.slice(-10)) || chunks[1]!.includes("結果")).toBe(true);
    // Deterministic.
    expect(chunkMarkdown(md, "筆記", { target: 400, overlap: 60 })).toEqual(chunks);
  });

  it("hard-splits a huge paragraph and keeps code fences intact", () => {
    const long = "a".repeat(5000);
    const chunks = chunkMarkdown(long, "", { target: 800 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => c.length <= 1300)).toBe(true);
    const fenced = chunkMarkdown("```\n# not a heading\n\ncode\n```\n\ntext", "T");
    expect(fenced.join("\n")).toContain("# not a heading");
    expect(fenced.join("\n")).not.toContain(" › ");
  });

  it("caps the number of chunks", () => {
    const md = Array.from({ length: 50 }, (_, i) => `段落 ${i} ${"x".repeat(300)}`).join("\n\n");
    expect(chunkMarkdown(md, "", { target: 300, maxChunks: 5 })).toHaveLength(5);
  });
});

describe("rrf", () => {
  it("fuses ranked lists by reciprocal rank", () => {
    const fused = rrf([["a", "b", "c"], ["c", "a", "d"]], 60);
    expect(fused.map((x) => x.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(rrf([[], []])).toEqual([]);
    // Duplicates inside one list count once.
    expect(rrf([["a", "a", "b"]]).find((x) => x.id === "a")!.score).toBeCloseTo(1 / 61);
  });
});

describe("query terms and snippets", () => {
  it("tokenizes CJK runs into bigrams for the relaxed match", () => {
    const t = tokenizeQuery("  語音情緒辨識  ");
    expect(t.terms).toEqual(["語音情緒辨識"]);
    expect(t.grams).toEqual(["語音", "音情", "情緒", "緒辨", "辨識"]);
    expect(t.relaxed).toBe(true);
    expect(relaxedThreshold(5)).toBe(3);
    const short = tokenizeQuery("辨識");
    expect(short).toMatchObject({ terms: ["辨識"], grams: ["辨識"], relaxed: false });
    const mixed = tokenizeQuery("Wav2Vec 自監督學習, ASR");
    expect(mixed.terms).toEqual(["wav2vec", "自監督學習", "asr"]);
    expect(mixed.grams).toEqual(["wav2vec", "自監", "監督", "督學", "學習", "asr"]);
    expect(tokenizeQuery("ＡＢＣ").terms).toEqual(["abc"]); // NFKC full-width
    expect(tokenizeQuery("speech recognition model")).toMatchObject({ grams: ["speech", "recognition", "model"], relaxed: true });
    expect(tokenizeQuery("   ").terms).toEqual([]);
  });

  it("builds snippets around the first match with highlight ranges", () => {
    const body = `${"前言內容。".repeat(40)}我們提出新的語音情緒辨識方法，並比較 baseline。${"後記。".repeat(30)}`;
    const s = makeSnippet(body, tokenizeQuery("語音情緒辨識"), 80);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    const [a, b] = s.highlights[0]!;
    expect(s.text.slice(a, b)).toBe("語音情緒辨識");
    const none = makeSnippet("abc def", tokenizeQuery("zzz"), 80);
    expect(none).toEqual({ text: "abc def", highlights: [] });
    expect(findHighlights("Speech speech", ["speech"])).toEqual([[0, 6], [7, 13]]);
    expect(findHighlights("語音辨識", ["語音", "音辨", "辨識"])).toEqual([[0, 4]]);
  });

  it("converts Markdown to plain text", () => {
    expect(plainText("# 標題\n\n- **粗體** [連結](http://x) `code`\n\n| a | b |\n|---|---|")).toBe("標題 粗體 連結 code a b");
  });
});
