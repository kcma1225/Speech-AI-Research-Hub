import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import CFB from "cfb";
import { describe, expect, it } from "vitest";
import {
  DOC_IMPORT_ACCEPT,
  DOC_IMPORT_FORMATS,
  DOC_IMPORT_MAX_BYTES,
  DocImportError,
  detectContentType,
  importDocument,
} from "../src/lib/doc-import/index.js";
import { HttpError } from "../src/lib/http.js";
import { parseDelimited } from "../src/lib/doc-import/text.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "doc-import-fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(dir, name)));
const utf8 = (s: string) => new TextEncoder().encode(s);

async function rejection(promise: Promise<unknown>): Promise<DocImportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DocImportError);
    expect(error).toBeInstanceOf(HttpError);
    return error as DocImportError;
  }
  throw new Error("expected a DocImportError");
}

describe("Magika content-type detection", () => {
  const expected: Record<string, string> = {
    "sample.csv": "csv",
    "sample.doc": "doc",
    "sample.docx": "docx",
    "sample.epub": "epub",
    "sample.html": "html",
    "sample.md": "markdown",
    "sample.odp": "odp",
    "sample.ods": "ods",
    "sample.odt": "odt",
    "sample.pdf": "pdf",
    "sample.ppt": "ppt",
    "sample.pptx": "pptx",
    "sample.rtf": "rtf",
    "sample.txt": "txt",
    "sample.xls": "xls",
    "sample.xlsx": "xlsx",
    "bad-program.pdf": "pebin",
    "bad-elf.pdf": "elf",
    "bad-image.pdf": "png",
    "bad-archive.docx": "zip",
    "bad-page.txt": "html",
  };
  for (const [name, label] of Object.entries(expected)) {
    it(`${name} → ${label}`, async () => {
      const r = await detectContentType(fixture(name));
      expect(r.label).toBe(label);
      expect(r.score).toBeGreaterThan(0.5);
    });
  }

  it("handles empty, tiny and concurrent inputs", async () => {
    expect((await detectContentType(new Uint8Array())).label).toBe("empty");
    expect((await detectContentType(utf8("hi"))).label).toBe("txt");
    expect((await detectContentType(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).label).toBe("unknown");
    const all = await Promise.all(["sample.pdf", "sample.docx", "bad-elf.pdf", "sample.md"].map((n) => detectContentType(fixture(n))));
    expect(all.map((r) => r.label)).toEqual(["pdf", "docx", "elf", "markdown"]);
    const png = await detectContentType(fixture("bad-image.pdf"));
    expect(png).toMatchObject({ label: "png", isText: false, modelLabel: "png" });
  });
});

describe("importDocument: extraction", () => {
  const RESEARCH = "本研究探討";
  const QUESTION = "如何在少於 10 小時的標註資料下達到可用的辨識率？";

  it("exposes the accept list and formats", () => {
    expect(DOC_IMPORT_ACCEPT.split(",")).toEqual(expect.arrayContaining([".pdf", ".docx", ".doc", ".pptx", ".ppt", ".md", ".csv", ".xlsx", ".epub"]));
    expect(DOC_IMPORT_ACCEPT).not.toContain(".xls,");
    expect(DOC_IMPORT_FORMATS.map((f) => f.format)).toHaveLength(16);
  });

  it("docx: headings, emphasis, lists, table, title from core.xml", async () => {
    const r = await importDocument(fixture("sample.docx"), "sample.docx");
    expect(r).toMatchObject({ format: "docx", detected: { label: "docx" }, title: "研究簡述範例", truncated: false, warnings: [] });
    expect(r.markdown).toContain("# 低資源語音辨識研究");
    expect(r.markdown).toContain("**低資源語言**");
    expect(r.markdown).toContain("## 研究問題");
    expect(r.markdown).toContain(`- ${QUESTION}`);
    expect(r.markdown).toContain("1. 以 wav2vec 2.0 進行預訓練");
    expect(r.markdown).toContain("| 模型 | CER |\n| --- | --- |\n| Baseline | 23.4% |");
    expect(r.chars).toBe(r.markdown.length);
  });

  it("pdf: paragraphs without CJK spacing, headings by size, lists", async () => {
    const r = await importDocument(fixture("sample.pdf"), "sample.pdf");
    expect(r).toMatchObject({ format: "pdf", pages: 2, title: "研究簡述範例" });
    expect(r.markdown).toContain("本研究探討低資源語言的自動語音辨識（ASR）");
    expect(r.markdown).toContain("## 研究問題");
    expect(r.markdown).toContain(`- ${QUESTION}`);
    expect(r.markdown).toContain("2. 以 CTC 微調");
    expect(r.markdown).toContain("Baseline 23.4%");
  });

  it("doc (Word 97): paragraphs and table", async () => {
    const r = await importDocument(fixture("sample.doc"), "sample.doc");
    expect(r.format).toBe("doc");
    expect(r.title).toBe("低資源語音辨識研究");
    expect(r.markdown).toContain(RESEARCH);
    expect(r.markdown).toContain("| Ours | 15.1% |");
  });

  it("odt: heading styles, lists, table", async () => {
    const r = await importDocument(fixture("sample.odt"), "sample.odt");
    expect(r).toMatchObject({ format: "odt", title: "研究簡述範例" });
    expect(r.markdown).toMatch(/^# 低資源語音辨識研究/);
    expect(r.markdown).toContain("## 方法");
    expect(r.markdown).toContain(`- ${QUESTION}`);
    expect(r.markdown).toContain("| Baseline | 23.4% |");
  });

  it("rtf: unicode escapes, headings, list items, table, info title", async () => {
    const r = await importDocument(fixture("sample.rtf"), "sample.rtf");
    expect(r).toMatchObject({ format: "rtf", title: "研究簡述範例" });
    expect(r.markdown).toContain("# 低資源語音辨識研究");
    expect(r.markdown).toContain(`## 研究問題\n\n- ${QUESTION}\n- Which pretraining`);
    expect(r.markdown).toContain("1. 以 wav2vec 2.0 進行預訓練\n2. 以 CTC 微調");
    expect(r.markdown).toContain("| 模型 | CER |\n| --- | --- |\n| Baseline | 23.4% |\n| Ours | 15.1% |");
  });

  it("rtf: \\'hh bytes decoded with \\ansicpg950 (Big5)", async () => {
    const r = await importDocument(utf8("{\\rtf1\\ansi\\ansicpg950 {\\fonttbl{\\f0 MingLiU;}}\\f0 \\'a4\\'a4\\'a4\\'e5 RTF\\par}"), "big5.rtf");
    expect(r.markdown).toBe("中文 RTF");
  });

  it("html: title, structure, no scripts or raw HTML", async () => {
    const r = await importDocument(fixture("sample.html"), "sample.html");
    expect(r).toMatchObject({ format: "html", title: "研究簡述範例" });
    expect(r.markdown).toContain("*跨語言遷移*");
    expect(r.markdown).toContain("| Ours | 15.1% |");
    const evil = await importDocument(
      utf8('<!doctype html><html><head><title>T</title><style>p{}</style></head><body><h1>標題</h1><p>文字 &lt;b&gt; <a href="javascript:alert(1)">連結</a> <a href="https://example.org/">網站</a></p><script>alert(1)</script><img src="data:x"><iframe src="https://e.org"></iframe></body></html>'),
      "evil.html",
    );
    expect(evil.markdown).toBe("# 標題\n\n文字 \\<b> 連結 [網站](https://example.org/)");
  });

  it("markdown: kept as written, raw HTML neutralised outside code", async () => {
    const r = await importDocument(fixture("sample.md"), "sample.md");
    expect(r).toMatchObject({ format: "markdown", detected: { label: "markdown" }, title: "低資源語音辨識研究" });
    expect(r.markdown).toBe(new TextDecoder().decode(fixture("sample.md")).trim());
    const html = await importDocument(utf8("# 筆記\n\n這是一段筆記 <b>粗體</b>\n<script>alert(1)</script>\n\n```html\n<div>code</div>\n```\n\n<https://example.org>\n"), "n.md");
    expect(html.markdown).toBe("# 筆記\n\n這是一段筆記 \\<b>粗體\\</b>\n\n```html\n<div>code</div>\n```\n\n<https://example.org>");
  });

  it("txt: UTF-8, UTF-16 with BOM and Big5", async () => {
    const r = await importDocument(fixture("sample.txt"), "sample.txt");
    expect(r).toMatchObject({ format: "txt", title: null });
    expect(r.markdown).toContain("研究問題：如何在少於 10 小時");
    const text = "會議紀錄\n\n今天討論了語音辨識的資料增強方法，以及下週的實驗安排。";
    const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(text, "utf16le"))]);
    expect((await importDocument(le, "utf16.txt")).markdown).toBe(text);
    const big5 = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5, 0xa4, 0xe5, 0xa5, 0xf3, 0xa1, 0x41, 0xb4, 0xfa, 0xb8, 0xd5, 0xa4, 0xa4, 0xa4, 0xe5]);
    expect((await importDocument(big5, "big5.txt")).markdown).toBe("中文文件，測試中文");
  });

  it("csv / tsv: GFM tables with quoted fields", async () => {
    const r = await importDocument(fixture("sample.csv"), "sample.csv");
    expect(r.markdown).toBe("| 模型 | CER | WER |\n| --- | --- | --- |\n| Baseline | 23.4 | 31.2 |\n| Ours | 15.1 | 22.8 |");
    const quoted = await importDocument(utf8('名稱,說明\n"a, b","含 ""引號"" 與\n換行"\nc|d,e\n'), "q.csv");
    expect(quoted.markdown).toBe('| 名稱 | 說明 |\n| --- | --- |\n| a, b | 含 "引號" 與 換行 |\n| c\\|d | e |');
    const tsv = await importDocument(utf8("模型\tCER\nOurs\t15.1\n"), "s.tsv");
    expect(tsv.markdown).toContain("| Ours | 15.1 |");
    expect(parseDelimited("a,b\n1,2\n3,4\n", ",", 2)).toEqual({ rows: [["a", "b"], ["1", "2"]], more: true });
  });

  it("csv: row cap adds a warning", async () => {
    const lines = ["編號,值", ...Array.from({ length: 250 }, (_, i) => `${i},值${i}`)].join("\n");
    const r = await importDocument(utf8(lines), "big.csv");
    expect(r.markdown.split("\n")).toHaveLength(201);
    expect(r.warnings).toEqual(["表格超過 200 列，只匯入前 200 列。"]);
  });

  it("pptx: slides in order, titles, bullets, speaker notes", async () => {
    const r = await importDocument(fixture("sample.pptx"), "sample.pptx");
    expect(r).toMatchObject({ format: "pptx", pages: 2, title: "低資源語音辨識研究" });
    expect(r.markdown).toBe(
      "## 低資源語音辨識研究\n\n- 以自監督預訓練模型為基礎\n- Cross-lingual transfer for Taiwanese Hokkien\n\n> 講者備註：強調資料量\n\n## 方法\n\n- wav2vec 2.0 預訓練\n- CTC 微調",
    );
  });

  it("ppt (PowerPoint 97): slides via the persist directory, with notes", async () => {
    const r = await importDocument(fixture("sample.ppt"), "sample.ppt");
    expect(r).toMatchObject({ format: "ppt", pages: 2 });
    expect(r.markdown).toBe(
      "## 低資源語音辨識研究\n\n- 以自監督預訓練模型為基礎\n- Cross-lingual transfer for Taiwanese Hokkien\n\n> 講者備註：強調資料量\n\n## 方法\n\n- wav2vec 2.0 預訓練\n- CTC 微調",
    );
  });

  it("odp: slides with notes", async () => {
    const r = await importDocument(fixture("sample.odp"), "sample.odp");
    expect(r).toMatchObject({ format: "odp", pages: 2 });
    expect(r.markdown).toContain("## 低資源語音辨識研究\n\n- 以自監督預訓練模型為基礎");
    expect(r.markdown).toContain("> 講者備註：強調資料量");
    expect(r.markdown).toContain("## 方法");
  });

  it("xlsx / ods: one section per sheet", async () => {
    for (const name of ["sample.xlsx", "sample.ods"]) {
      const r = await importDocument(fixture(name), name);
      expect(r.markdown).toBe("## sample\n\n| 模型 | CER | WER |\n| --- | --- | --- |\n| Baseline | 23.4 | 31.2 |\n| Ours | 15.1 | 22.8 |");
    }
  });

  it("epub: spine order through turndown, OPF title", async () => {
    const r = await importDocument(fixture("sample.epub"), "sample.epub");
    expect(r).toMatchObject({ format: "epub", title: "研究簡述範例" });
    expect(r.markdown).toContain(RESEARCH);
    expect(r.markdown).toContain("| Ours | 15.1% |");
  });

  it("truncates at maxChars with a warning", async () => {
    const para = "語音辨識研究需要大量標註資料，本段落用來測試截斷功能。";
    const text = Array.from({ length: 200 }, () => para).join("\n\n");
    const r = await importDocument(utf8(text), "long.txt", { maxChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(1000);
    expect(r.chars).toBeGreaterThan(800);
    expect(r.markdown.endsWith("。")).toBe(true);
    expect(r.warnings.at(-1)).toMatch(/^內容超過 1,000 字/);
  });

  it("strips control characters and keeps only the base file name", async () => {
    const r = await importDocument(utf8("第一行\u0000\u0007文字\r\n第二行\u202e反轉\n\n\n\n第三段"), "../../etc/筆記.txt");
    expect(r.markdown).toBe("第一行文字\n第二行反轉\n\n第三段");
    expect(r.filename).toBe("筆記.txt");
  });
});

describe("importDocument: rejections", () => {
  const cases: [string, string, number, string, RegExp?][] = [
    ["bad-program.pdf", "program.pdf", 415, "not_document", /Windows 執行檔/],
    ["bad-elf.pdf", "elf.pdf", 415, "not_document", /Linux 執行檔/],
    ["bad-image.pdf", "image.pdf", 415, "content_mismatch", /PNG 圖片/],
    ["bad-archive.docx", "archive.docx", 415, "content_mismatch", /ZIP 壓縮檔/],
    ["bad-page.txt", "page.txt", 415, "content_mismatch", /HTML 網頁/],
    ["sample.docx", "renamed.pdf", 415, "content_mismatch", /Word 文件/],
    ["sample.pdf", "renamed.docx", 415, "content_mismatch", /PDF 文件/],
    ["sample.xls", "sample.xls", 415, "legacy_format"],
    ["sample.xls", "renamed.xlsx", 415, "legacy_format"],
    ["bad-program.pdf", "setup.exe", 415, "unsupported_format"],
  ];
  for (const [file, name, status, code, hint] of cases) {
    it(`${name} (${file}) → ${status} ${code}`, async () => {
      const e = await rejection(importDocument(fixture(file), name));
      expect(e.status).toBe(status);
      expect(e.extra.code).toBe(code);
      expect(e.message).toMatch(/[一-鿿]/);
      if (hint) expect(e.extra.hint).toMatch(hint);
    });
  }

  it("messages", async () => {
    expect((await rejection(importDocument(utf8("x"), "a.exe"))).message).toMatch(/^不支援這種檔案格式。可匯入：PDF、Word/);
    expect((await rejection(importDocument(fixture("sample.xls"), "a.xls"))).message).toBe("舊版 Excel (.xls) 請先另存為 .xlsx 或 CSV。");
    expect((await rejection(importDocument(fixture("bad-elf.pdf"), "a.pdf"))).message).toBe("這不是可匯入的文件檔。");
    expect((await rejection(importDocument(fixture("bad-page.txt"), "a.txt"))).message).toBe("檔案內容與副檔名不符。");
  });

  it("too large (checked before reading anything)", async () => {
    const huge = { byteLength: DOC_IMPORT_MAX_BYTES + 1, length: DOC_IMPORT_MAX_BYTES + 1 } as unknown as Uint8Array;
    const e = await rejection(importDocument(huge, "big.pdf"));
    expect([e.status, e.extra.code, e.message]).toEqual([413, "too_large", "檔案超過 30 MB。"]);
  });

  it("empty file and documents without text", async () => {
    const e = await rejection(importDocument(new Uint8Array(), "empty.docx"));
    expect([e.status, e.extra.code, e.message]).toEqual([422, "empty", "檔案裡沒有可匯入的文字。"]);
    expect((await rejection(importDocument(utf8("   \n\n  \t\n\n\n\n   "), "blank.txt"))).extra.code).toBe("empty");
    // A PDF page without a text layer (what a scan looks like to pdf.js).
    const scan = utf8(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n" +
        "4 0 obj\n<< /Length 22 >>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    );
    const pdf = await rejection(importDocument(scan, "scan.pdf"));
    expect([pdf.status, pdf.extra.code, pdf.extra.hint]).toEqual([422, "empty", "掃描版 PDF 需要先做文字辨識 (OCR)。"]);
  });

  it("password-protected OOXML (OLE EncryptedPackage) → 422 encrypted", async () => {
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, "EncryptionInfo", Buffer.alloc(512, 1));
    CFB.utils.cfb_add(container, "EncryptedPackage", Buffer.alloc(8192, 7));
    const bytes = new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer);
    const e = await rejection(importDocument(bytes, "secret.docx"));
    expect([e.status, e.extra.code]).toEqual([422, "encrypted"]);
  });

  it("zip bomb: an entry inflating past the cap is refused", async () => {
    // The real docx with word/document.xml replaced by 70 MB of spaces (~70 KB compressed).
    const zip = CFB.read(Buffer.from(fixture("sample.docx")), { type: "buffer" });
    const entry = CFB.find(zip, "Root Entry/word/document.xml")!;
    entry.content = Buffer.alloc(70 * 1024 * 1024, 0x20);
    entry.size = entry.content.length;
    const bytes = new Uint8Array(CFB.write(zip, { type: "buffer", fileType: "zip", compression: true }) as Buffer);
    expect(bytes.length).toBeLessThan(DOC_IMPORT_MAX_BYTES);
    const e = await rejection(importDocument(bytes, "bomb.docx"));
    expect([e.status, e.extra.code]).toEqual([422, "corrupt"]);
  });

  it("corrupt container → 422 corrupt", async () => {
    // Still detected as docx (same first bytes), but the central directory is cut off.
    const docx = fixture("sample.docx");
    const broken = docx.slice(0, docx.length - 200);
    const e = await rejection(importDocument(broken, "broken.docx"));
    expect([e.status, e.extra.code]).toEqual([422, "corrupt"]);
  });
});
