import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectDeck } from "../src/lib/slides/source.js";
import { deckZip, makeZip, PDF_BYTES, pptxBytes } from "./slides-fixtures.js";

describe("deck type detection", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "deck-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const detect = async (filename: string, data: Buffer, entry?: string) => {
    const file = path.join(dir, `f-${Math.random().toString(36).slice(2)}`);
    await writeFile(file, data);
    return detectDeck({ path: file, filename }, entry, 200 * 1024 * 1024);
  };
  const status = (promise: Promise<unknown>) => promise.then(() => 0, (error: { status?: number; message: string }) => `${error.status} ${error.message}`);

  it("accepts Quarto ZIPs, PDFs and PPTX by extension and magic bytes", async () => {
    expect(await detect("Deck.ZIP", deckZip())).toMatchObject({ sourceType: "quarto", entry: "index.qmd", scan: { files: 2 } });
    expect(await detect("paper.pdf", PDF_BYTES)).toEqual({ sourceType: "pdf", entry: "", scan: null });
    expect(await detect("talk.pptx", pptxBytes())).toEqual({ sourceType: "pptx", entry: "", scan: null });
  });

  it("rejects mismatched content, macros, legacy and encrypted files", async () => {
    expect(await status(detect("deck.zip", PDF_BYTES))).toMatch(/^415 檔案內容與副檔名不符/);
    expect(await status(detect("paper.pdf", deckZip()))).toMatch(/^415/);
    expect(await status(detect("talk.pptx", PDF_BYTES))).toMatch(/^415/);
    expect(await status(detect("talk.pptx", Buffer.from("d0cf11e0a1b11ae1000000000000", "hex")))).toMatch(/^400 簡報已加密或為舊版格式/);
    expect(await status(detect("talk.pptx", deckZip()))).toMatch(/^400 檔案不是有效的 PPTX/);
    expect(await status(detect("talk.pptx", makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }])))).toMatch(/^400 檔案不是有效的 PPTX/);
    expect(await status(detect("talk.pptx", pptxBytes([{ name: "ppt/vbaProject.bin", data: "x" }])))).toMatch(/^400 不支援含巨集/);
    expect(await status(detect("talk.pptx", pptxBytes([], "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml")))).toMatch(/^400 不支援含巨集/);
    expect(await status(detect("talk.pptm", pptxBytes()))).toMatch(/^400 不支援含巨集/);
    expect(await status(detect("talk.ppt", Buffer.from("d0cf11e0", "hex")))).toMatch(/^400 不支援舊版 \.ppt/);
    expect(await status(detect("talk.key", deckZip()))).toMatch(/^400 請選擇 200 MB 以下的 ZIP、PDF 或 PPTX/);
    expect(await status(detect("deck.zip", makeZip([{ name: "a.qmd" }, { name: "b.qmd" }])))).toMatch(/多個 QMD/);
  });
});
