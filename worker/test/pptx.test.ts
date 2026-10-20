import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeXml, notesFromXml, pptxSlides, readPptx, resolveTarget, titleFromXml } from "../src/pptx.js";
import { pptxParts, writeZip } from "./pptx-fixture.js";

describe("pptx notes extraction", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pptx-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("maps notes to slides in presentation order, skipping hidden slides", async () => {
    const file = path.join(dir, "deck.pptx");
    await writeZip(file, pptxParts([
      { title: "語音辨識 &amp; 合成", notes: ["第一段備忘", "第二段 &lt;重點&gt;"] },
      { title: "Hidden", notes: ["secret"], hidden: true },
      { title: "No notes" },
      { title: "Results", notes: ["WER 下降 12%"] },
    ]));
    const slides = pptxSlides(await readPptx(file));
    expect(slides).toEqual([
      { title: "語音辨識 & 合成", notes: "第一段備忘\n第二段 <重點>" },
      { title: "No notes" },
      { title: "Results", notes: "WER 下降 12%" },
    ]);
  });

  it("rejects macros, non-PPTX zips and garbage", async () => {
    const macro = path.join(dir, "macro.pptx");
    await writeZip(macro, pptxParts([{ title: "x" }], { "ppt/vbaProject.bin": "binary" }));
    await expect(readPptx(macro)).rejects.toThrow(/巨集/);
    const macroType = path.join(dir, "macro2.pptx");
    const parts = pptxParts([{ title: "x" }]);
    parts["[Content_Types].xml"] = parts["[Content_Types].xml"]!.replace("presentation.main+xml", "slideshow.macroEnabled.main+xml");
    await writeZip(macroType, parts);
    await expect(readPptx(macroType)).rejects.toThrow(/巨集/);
    const notPptx = path.join(dir, "deck.zip.pptx");
    await writeZip(notPptx, { "index.qmd": "# hi" });
    await expect(readPptx(notPptx)).rejects.toThrow(/不是有效的 PPTX/);
    const garbage = path.join(dir, "garbage.pptx");
    await writeZip(garbage, {});
    await (await import("node:fs/promises")).writeFile(garbage, Buffer.from("D0CF11E0A1B11AE1", "hex"));
    await expect(readPptx(garbage)).rejects.toThrow(/無法讀取/);
  });

  it("parses XML helpers", () => {
    expect(decodeXml("a &amp; b &#x4E2D;&#25991; &quot;q&quot; &bogus;")).toBe('a & b 中文 "q" &bogus;');
    expect(resolveTarget("ppt/slides", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolveTarget("ppt", "/ppt/slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    const notes = '<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>line</a:t></a:r><a:br/><a:r><a:t>break</a:t></a:r></a:p><a:p/><a:p><a:pPr lvl="1"/><a:r><a:t xml:space="preserve">  indented </a:t></a:r></a:p></p:txBody></p:sp></p:notes>';
    expect(notesFromXml(notes)).toBe("line\nbreak\n\n  indented");
    expect(titleFromXml('<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t> World</a:t></a:r></a:p></p:txBody></p:sp></p:sld>')).toBe("Hello World");
    expect(titleFromXml("<p:sld></p:sld>")).toBeUndefined();
  });
});
