import { describe, expect, it } from "vitest";
import {
  detectFormat, exportBibtex, exportCslJson, exportRis, importAny, importBibtex, importCslJson, importEndnoteXml,
  importRis, importZoteroRdf, LibraryImportError, recordToBibtex, escapeBibtex, type PaperRecord,
} from "../src/lib/library/index.js";
import { fixture } from "./library-fixtures/helpers.js";

/** Fields that must survive an export → import round trip. */
const core = (r: PaperRecord) => ({
  type: r.type, title: r.title, authors: r.authors, year: r.year, month: r.month, containerTitle: r.containerTitle,
  volume: r.volume, issue: r.issue, pages: r.pages, doi: r.doi?.toLowerCase(), arxivId: r.arxivId, publisher: r.publisher,
});

describe("BibTeX import", () => {
  const res = importBibtex(fixture("sample.bib"));
  const byKey = Object.fromEntries(res.records.map((r) => [r.citeKey, r]));

  it("imports good entries and warns about the broken one", () => {
    expect(res.format).toBe("bibtex");
    expect(Object.keys(byKey)).toEqual(["gulati20_interspeech", "baevski2020wav2vec", "wang2023thesis", "chen2022asr", "hfdocs", "radford2023whisper"]);
    expect(res.warnings.some((w) => w.key === "broken" && w.message.includes("BibTeX 語法錯誤"))).toBe(true);
  });

  it("maps fields, @string macros, pages and venue", () => {
    const g = byKey.gulati20_interspeech!;
    expect(g.type).toBe("paper-conference");
    expect(g.title).toBe("Conformer: Convolution-augmented Transformer for Speech Recognition");
    expect(g.containerTitle).toBe("Proc. Interspeech 2020");
    expect(g.venue).toBe("Interspeech");
    expect(g.pages).toBe("5036–5040");
    expect(g.doi).toBe("10.21437/Interspeech.2020-3015");
    expect(g.authors).toHaveLength(11);
    expect(g.authors[0]).toEqual({ family: "Gulati", given: "Anmol" });
    expect(g.keywords).toEqual(["ASR", "conformer"]);
    expect(g.bibtex).toContain("@inproceedings{gulati20_interspeech");
  });

  it("recognizes arXiv preprints", () => {
    const w = byKey.baevski2020wav2vec!;
    expect(w.type).toBe("article");
    expect(w.arxivId).toBe("2006.11477");
    expect(w.containerTitle).toBeUndefined();
    expect(w.month).toBe(6);
  });

  it("handles Chinese entries, LaTeX accents, particles, organisations", () => {
    const t = byKey.wang2023thesis!;
    expect(t.type).toBe("thesis");
    expect(t.authors).toEqual([{ literal: "王小明" }]);
    expect(t.publisher).toBe("國立臺灣大學電信工程學研究所");
    expect(t.extra?.type).toBe("mastersthesis");
    const c = byKey.chen2022asr!;
    expect(c.title).toBe("Code-Switching ASR for Mandarin-English Lectures");
    expect(c.authors[1]).toEqual({ family: "林", given: "志豪" });
    expect(c.authors[2]).toEqual({ family: "Müller", given: "Jörg" });
    expect(c.authors[3]).toEqual({ family: "Berg", given: "Jan", particle: "van der" });
    expect(c.doi).toBe("10.1109/ICASSP43922.2022.9746001");
    expect(c.venue).toBe("ICASSP");
    const h = byKey.hfdocs!;
    expect(h.type).toBe("webpage");
    expect(h.authors).toEqual([{ literal: "Hugging Face" }]);
    expect([h.year, h.month, h.day]).toEqual([2024, 3, 15]);
    expect(byKey.radford2023whisper!.note).toBe("50% of the time & more");
  });
});

describe("BibTeX export", () => {
  const records = importBibtex(fixture("sample.bib")).records;

  it("round-trips through our own parser", () => {
    const again = importBibtex(exportBibtex(records)).records;
    expect(again.map(core)).toEqual(records.map(core));
    expect(again.map((r) => r.citeKey)).toEqual(records.map((r) => r.citeKey));
  });

  it("escapes LaTeX specials and keeps CJK as UTF-8", () => {
    expect(escapeBibtex("50% & $5 #1 a_b {x} ~ ^ \\")).toBe("50\\% \\& \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}");
    const bib = exportBibtex(records);
    expect(bib).toContain("author  = {{王小明}}");
    expect(bib).toContain("Chen, Yi-Ting and 林, 志豪 and Müller, Jörg and van der Berg, Jan");
    expect(bib).toContain("@mastersthesis{wang2023thesis,");
    expect(bib).toContain("note      = {50\\% of the time \\& more}");
    expect(bib).toContain("title     = {Code-Switching {ASR} for Mandarin-English Lectures}");
    expect(bib).toContain("month         = jun,");
    expect(bib).toContain("archiveprefix = {arXiv}");
  });

  it("ascii mode converts accented Latin but leaves CJK", () => {
    const c = records.find((r) => r.citeKey === "chen2022asr")!;
    const out = recordToBibtex(c, "k", { ascii: true });
    expect(out).toContain('M{\\"u}ller, J{\\"o}rg');
    expect(out).toContain("林, 志豪");
    expect(importBibtex(out).records[0]!.authors[2]).toEqual({ family: "Müller", given: "Jörg" });
  });

  it("generates unique keys for records without one, avoiding existing keys", () => {
    const r: PaperRecord = { type: "article-journal", title: "The Conformer Revisited", authors: [{ family: "Gulati", given: "A." }], year: 2020 };
    const bib = exportBibtex([r, { ...r }], { existingKeys: ["gulati2020conformer"] });
    expect(bib).toContain("@article{gulati2020conformera,");
    expect(bib).toContain("@article{gulati2020conformerb,");
  });

  it("useOriginal re-emits the imported entry text with the new key", () => {
    const g = records[0]!;
    const out = recordToBibtex(g, "newkey", { useOriginal: true });
    expect(out.startsWith("@inproceedings{newkey,")).toBe(true);
    expect(out).toContain("issn      = {2958-1796}");
  });
});

describe("RIS", () => {
  const res = importRis(fixture("sample.ris"));

  it("imports records, continuation lines, CJK names, SP/EP pages", () => {
    expect(res.records).toHaveLength(4);
    const [a, b, c, d] = res.records;
    expect(a!.citeKey).toBe("li2021taslp");
    expect([a!.year, a!.month, a!.day]).toEqual([2022, 11, 1]);
    expect(a!.abstract).toContain("hybrid modeling to end-to-end modeling.");
    expect(a!.keywords).toEqual(["end-to-end", "speech recognition"]);
    expect(b!.type).toBe("paper-conference");
    expect(b!.pages).toBe("1399–1403");
    expect(b!.venue).toBe("Interspeech");
    expect(c!.authors).toEqual([{ family: "陳", given: "大文" }, { literal: "李美玲" }]);
    expect(c!.title).toBe("華語兒童語音辨識之資料增強方法");
    expect(d!.type).toBe("document");
  });

  it("warns (zh) about unknown types and missing titles", () => {
    expect(res.warnings.map((w) => w.message)).toEqual([
      "不認得的類型「WHATEVER」，當作一般文件匯入",
      "缺少標題（TI/T1），已略過此筆資料",
    ]);
  });

  it("round-trips", () => {
    const again = importRis(exportRis(res.records)).records;
    expect(again.map(core)).toEqual(res.records.map(core));
  });

  it("accepts an unterminated last record with a warning", () => {
    const r = importRis("TY  - JOUR\nTI  - Lonely\nAU  - Doe, J.\n");
    expect(r.records[0]!.title).toBe("Lonely");
    expect(r.warnings[0]!.message).toContain("ER");
  });
});

describe("EndNote XML", () => {
  const res = importEndnoteXml(fixture("endnote.xml"));

  it("imports records with style runs and entities", () => {
    expect(res.records).toHaveLength(3);
    const [a, b, c] = res.records;
    expect(a!.type).toBe("paper-conference");
    expect(a!.doi).toBe("10.21437/Interspeech.2020-3015");
    expect(a!.month).toBe(10);
    expect(a!.url).toContain("isca-archive.org");
    expect(b!.title).toBe("基於Transformer 的語音轉換 & 評估");
    expect(b!.authors[0]).toEqual({ family: "張", given: "家豪" });
    expect(b!.issn).toBe("2329-9290");
    expect(b!.venue).toBe("TASLP");
    expect(c!.type).toBe("book");
    expect(c!.isbn).toBe("9780131873216");
    expect(c!.edition).toBe("3rd");
  });

  it("warns about empty records and rejects non-EndNote XML", () => {
    expect(res.warnings).toEqual([{ index: 3, key: "15", message: "缺少標題，已略過此筆資料" }]);
    expect(() => importEndnoteXml("<foo/>")).toThrow(LibraryImportError);
  });
});

describe("CSL-JSON", () => {
  const res = importCslJson(fixture("sample.csl.json"));

  it("imports items, string date-parts, raw dates, literals, arXiv URLs", () => {
    expect(res.records).toHaveLength(3);
    const [a, b, c] = res.records;
    expect([a!.year, a!.month, a!.day]).toEqual([2021, 10, 26]);
    expect(a!.citeKey).toBeUndefined(); // Zotero URI ids are not cite keys
    expect(a!.keywords).toEqual(["self-supervised", "speech"]);
    expect(b!.citeKey).toBe("lin2024taiwanese");
    expect(b!.authors[1]).toEqual({ literal: "國立陽明交通大學語音實驗室" });
    expect([b!.year, b!.month]).toEqual([2024, 6]);
    expect(b!.containerTitle).toBe("臺灣語文研究");
    expect(c!.type).toBe("article");
    expect(c!.arxivId).toBe("2110.07205");
    expect(res.warnings.map((w) => w.index)).toEqual([3, 4]);
  });

  it("round-trips including ids", () => {
    const withIds = res.records.map((r) => ({ ...r, ids: { s2: "abc", openalex: "W1" } }));
    const again = importCslJson(exportCslJson(withIds)).records;
    expect(again.map(core)).toEqual(withIds.map(core));
    expect(again[0]!.ids).toEqual({ s2: "abc", openalex: "W1" });
  });

  it("rejects invalid JSON with a zh message", () => {
    expect(() => importCslJson("{nope")).toThrow("CSL-JSON 格式錯誤");
  });
});

describe("Zotero RDF", () => {
  const res = importZoteroRdf(fixture("zotero.rdf"));

  it("imports items, resolves isPartOf references, skips attachments and memos", () => {
    expect(res.records.map((r) => r.title)).toEqual([
      "HuBERT: Self-Supervised Speech Representation Learning by Masked Prediction of Hidden Units",
      "低資源客語語音辨識",
      "Speech Podcast Episode 3",
    ]);
    const [a, b] = res.records;
    expect(a!.containerTitle).toBe("IEEE/ACM Transactions on Audio, Speech, and Language Processing");
    expect(a!.doi).toBe("10.1109/TASLP.2021.3122291");
    expect(a!.issn).toBe("2329-9290");
    expect(a!.keywords).toEqual(["self-supervised", "Speech recognition"]);
    expect(b!.authors).toEqual([{ family: "吳", given: "建宏" }, { literal: "Speech Lab" }]);
    expect(b!.publisher).toBe("ISCA");
    expect(b!.publisherPlace).toBe("Incheon");
    expect(b!.containerTitle).toBe("Proc. Interspeech 2022");
    expect(res.warnings[0]!.message).toContain("podcast");
  });
});

describe("format detection", () => {
  it("detects each fixture", () => {
    expect(detectFormat(fixture("sample.bib"))).toBe("bibtex");
    expect(detectFormat(fixture("sample.ris"))).toBe("ris");
    expect(detectFormat(fixture("endnote.xml"))).toBe("endnote-xml");
    expect(detectFormat(fixture("sample.csl.json"))).toBe("csl-json");
    expect(detectFormat(fixture("zotero.rdf"))).toBe("zotero-rdf");
    expect(detectFormat("hello")).toBeUndefined();
  });

  it("importAny explains .enl and unknown files in zh", () => {
    expect(() => importAny("SQLite format 3", { filename: "Lab.enl" })).toThrow("EndNote 資料庫檔");
    expect(() => importAny("hello")).toThrow("無法判斷檔案格式");
    expect(importAny(fixture("sample.ris"), { filename: "x.ris" }).records).toHaveLength(4);
  });
});
