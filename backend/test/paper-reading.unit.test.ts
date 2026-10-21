/**
 * Paper reading (no DB): heading detection and sectioning, full-text extraction from a real (generated) PDF with page
 * markers, section lookup and pagination, the note-synthesis task text, tool images (inline/keep/no-vision), image
 * token estimate, and the OpenAI codecs keeping tool-result images.
 */
import { describe, expect, it } from "vitest";
import { HeadingDetector, digest, extractFullText, pageLines, sectionize } from "../src/lib/library/fulltext.js";
import { findSection, sectionGroup, sliceText, tableOfContents } from "../src/agent/tools/papers-read.js";
import { estimateTokens, intentText, systemPrompt } from "../src/agent/prompt.js";
import { inlineToolImages, toolResultContent } from "../src/agent/images.js";
import { toOpenAiMessages } from "../src/ai/codecs/openai-chat.js";
import type { ChatMessage } from "../src/ai/types.js";
import type { Storage } from "../src/lib/storage.js";
import { PAPER_PDF } from "./library-fixtures/paper-pdf.js";

describe("heading detection", () => {
  it("accepts numbered, Roman and known headings in order and rejects sentences / equation numbers", () => {
    const d = new HeadingDetector();
    expect(d.detect("Abstract")).toMatchObject({ kind: "abstract" });
    expect(d.detect("1 Introduction")).toMatchObject({ number: "1", level: 1 });
    expect(d.detect("2 shows that the task is popular.")).toBeNull();
    expect(d.detect("3 Method")).toBeNull(); // skips 2: not monotonic
    expect(d.detect("2. Related Work")).toMatchObject({ number: "2" });
    expect(d.detect("2.1 Self-Supervised Models")).toMatchObject({ number: "2.1", level: 2 });
    expect(d.detect("2.3 Skipped")).toBeNull();
    expect(d.detect("(1)")).toBeNull();
    expect(d.detect("This sentence talks about the Method we use in this paper and more words here.")).toBeNull();
    expect(d.detect("References")).toMatchObject({ kind: "references" });
    const ieee = new HeadingDetector();
    expect(ieee.detect("Abstract—We study emotion.")).toMatchObject({ kind: "abstract" });
    expect(ieee.detect("I. INTRODUCTION")).toMatchObject({ number: "I" });
    expect(ieee.detect("A. Datasets")).toMatchObject({ number: "I.A", level: 2 });
    expect(ieee.detect("II. PROPOSED METHOD")).toMatchObject({ number: "II" });
  });

  it("rebuilds lines from pdf.js items by y position", () => {
    const lines = pageLines([
      { str: "Hello", x: 0, y: 700, h: 10, eol: false },
      { str: " world", x: 30, y: 700, h: 10, eol: false },
      { str: "Next line", x: 0, y: 680, h: 10, eol: false },
    ]);
    expect(lines).toEqual(["Hello world", "Next line"]);
  });

  it("sectionizes pages: abstract inline, page markers, running headers dropped", () => {
    const header = "Preprint. Under review.";
    const pages = [
      [header, "Title", "Abstract— We do X.", "1 Introduction", "intro text"],
      [header, "more intro", "2 Method", "method text"],
      [header, "3 Results", "results"],
      [header, "References", "[1] ref"],
    ];
    const s = sectionize(pages);
    expect(s.map((x) => x.id)).toEqual(["front", "abstract", "s1", "s2", "s3", "s4"]);
    expect(s[1]!.text).toBe("We do X.");
    expect(s[2]!.text).toContain("〔p. 2〕");
    expect(s[2]!.pageEnd).toBe(2);
    expect(s.every((x) => !x.text.includes(header))).toBe(true);
    expect(s.at(-1)!.kind).toBe("references");
  });
});

describe("full text of a PDF", () => {
  it("extracts sections with pages; TOC drops references; groups subsections; paginates", async () => {
    const ft = await extractFullText(PAPER_PDF);
    expect(ft.numPages).toBe(3);
    const titles = ft.sections.map((s) => `${s.number ?? ""} ${s.title}`.trim());
    expect(titles).toEqual(["Title and authors", "Abstract", "1 Introduction", "2 Related Work", "2.1 Self-Supervised Models", "3 Method", "3.1 Training", "4 Experiments", "5 Conclusion", "References"]);
    const intro = ft.sections.find((s) => s.number === "1")!;
    expect(intro.text).toContain("2 shows that"); // a sentence stays body text
    const method = ft.sections.find((s) => s.number === "3")!;
    expect([method.pageStart, method.pageEnd]).toEqual([2, 2]);
    expect(tableOfContents(ft, false).some((s) => s.kind === "references")).toBe(false);
    expect(tableOfContents(ft, true).some((s) => s.kind === "references")).toBe(true);

    const idx = findSection(ft, "3");
    expect(ft.sections[idx]!.title).toBe("Method");
    const group = sectionGroup(ft, idx);
    expect(group.map((s) => s.number)).toEqual(["3", "3.1"]);
    expect(findSection(ft, "experiments")).toBe(ft.sections.findIndex((s) => s.number === "4"));
    expect(findSection(ft, "s1")).toBe(ft.sections.findIndex((s) => s.id === "s1"));
    expect(findSection(ft, "§2.1")).toBe(ft.sections.findIndex((s) => s.number === "2.1"));
    expect(findSection(ft, "nope")).toBe(-1);

    const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const a = sliceText(long, 0, 400);
    expect(a.part.endsWith("\n")).toBe(true);
    expect(a.next).toBeGreaterThan(200);
    const b = sliceText(long, a.next!, 100_000);
    expect(a.part + b.part).toBe(long);
    expect(b.next).toBeNull();

    const d = digest(ft, 2000);
    expect(d).toContain("## 3 Method（p. 2）");
    expect(d).not.toContain("Baevski");
  });

  it("rejects non-PDF data", async () => {
    await expect(extractFullText(Buffer.from("hello"))).rejects.toThrow();
  });
});

describe("prompts", () => {
  it("the 整理成筆記 task asks to synthesise the user's questions into Q&A with LaTeX", () => {
    const t = intentText("make_note");
    expect(t).toMatch(/^<task kind="make_note"/);
    expect(t).toContain("使用者問過的每個問題");
    expect(t).toContain("我的疑問與解答");
    expect(t).toContain("create_note");
    expect(t).toContain("$$...$$");
  });
  it("the chat prompt tells the assistant to read the full text and explain equations symbol by symbol", () => {
    const s = systemPrompt({ mode: "chat", user: { name: "林", role: "student" }, memories: null });
    expect(s).toContain("read_paper");
    expect(s).toContain("view_paper_pages");
    expect(s).toContain("逐一說明每個符號");
    expect(s).toContain("create_deck");
    expect(s).toContain("只有在使用者要求時");
    expect(s).toContain("```chart");
  });
  it("counts images at a fixed cost, not by base64 length", () => {
    const big = "A".repeat(400_000);
    const msgs: ChatMessage[] = [{ role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x" }, { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: big } }] }] }];
    const n = estimateTokens(msgs);
    expect(n).toBeGreaterThan(1500);
    expect(n).toBeLessThan(3000);
  });
});

describe("tool images", () => {
  const store = new Map<string, Buffer>([["agent/c/1-0.jpg", Buffer.from("img1")], ["agent/c/2-0.jpg", Buffer.from("img2")], ["agent/c/3-0.jpg", Buffer.from("img3")]]);
  const storage = { getBuffer: async (k: string) => store.get(k) ?? null } as unknown as Storage;
  const toolMsg = (id: string): ChatMessage => ({ role: "tool", content: [{ type: "tool_result", tool_use_id: id, content: toolResultContent("pages", [{ key: `agent/c/${id}-0.jpg`, mediaType: "image/jpeg" }]) }] });

  it("inlines only the newest two image results; drops all without vision", async () => {
    const msgs = await inlineToolImages(storage, [toolMsg("1"), toolMsg("2"), toolMsg("3")], { vision: true });
    const blocks = msgs.map((m) => ((m.content as any[])[0].content as any[]));
    expect(blocks[0]!.some((b) => b.type === "image")).toBe(false);
    expect(blocks[0]!.at(-1).text).toContain("已省略");
    expect(blocks[2]![1]).toEqual({ type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: Buffer.from("img3").toString("base64") } });
    expect(blocks[1]![1].source.data).toBe(Buffer.from("img2").toString("base64"));
    const none = await inlineToolImages(storage, [toolMsg("3")], { vision: false });
    const c = ((none[0]!.content as any[])[0].content as any[]);
    expect(c.some((b) => b.type === "image")).toBe(false);
    expect(c.at(-1).text).toContain("無法看圖");
  });

  it("openai-chat sends tool-result images as a following user message", () => {
    const out = toOpenAiMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "view_paper_pages", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "p. 3" }, { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } }] }] },
    ]);
    expect(out[1]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "p. 3" });
    expect(out[2]).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }] });
  });
});
