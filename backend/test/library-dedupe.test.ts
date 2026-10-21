import { describe, expect, it } from "vitest";
import {
  compareRecords, dedupeRecords, doiKey, findDuplicates, mergeRecords, normalizeArxivId, normalizeDoi, normalizeTitle,
  parseName, titleSimilarity, trigramSimilarity, type PaperRecord,
} from "../src/lib/library/index.js";

const conformer: PaperRecord = {
  type: "paper-conference",
  title: "Conformer: Convolution-augmented Transformer for Speech Recognition",
  authors: [{ family: "Gulati", given: "Anmol" }, { family: "Qin", given: "James" }],
  year: 2020,
  containerTitle: "Proc. Interspeech 2020",
  doi: "10.21437/Interspeech.2020-3015",
  citeKey: "gulati2020conformer",
};

describe("normalization", () => {
  it("DOIs: prefixes, URLs, trailing punctuation, case kept, doiKey folds", () => {
    expect(normalizeDoi("https://doi.org/10.1109/ICASSP43922.2022.9747077")).toBe("10.1109/ICASSP43922.2022.9747077");
    expect(normalizeDoi("doi: 10.18653/v1/2020.acl-main.1.")).toBe("10.18653/v1/2020.acl-main.1");
    expect(normalizeDoi("(see 10.1016/S0140-6736(20)30183-5)")).toBe("10.1016/S0140-6736(20)30183-5");
    expect(normalizeDoi("http://dx.doi.org/10.1000%2F182")).toBe("10.1000/182");
    expect(normalizeDoi("not a doi")).toBeUndefined();
    expect(doiKey("DOI:10.21437/Interspeech.2020-3015")).toBe("10.21437/interspeech.2020-3015");
  });

  it("arXiv ids: versions, URLs, old style, arXiv DOIs", () => {
    expect(normalizeArxivId("2005.08100v3")).toBe("2005.08100");
    expect(normalizeArxivId("https://arxiv.org/pdf/2005.08100v1.pdf")).toBe("2005.08100");
    expect(normalizeArxivId("arXiv:2110.04934")).toBe("2110.04934");
    expect(normalizeArxivId("cs/0601001v2")).toBe("cs/0601001");
    expect(normalizeArxivId("math.GT/0309136")).toBe("math.GT/0309136");
    expect(normalizeArxivId("10.48550/arXiv.2006.11477")).toBe("2006.11477");
    expect(normalizeArxivId("arXiv preprint arXiv:2006.11477")).toBe("2006.11477");
    expect(normalizeArxivId("hello 1234")).toBeUndefined();
  });

  it("titles: casefold, NFKC, accents, LaTeX, HTML, punctuation, CJK spacing", () => {
    expect(normalizeTitle("{Conformer}: Convolution-augmented Transformer!")).toBe("conformer convolution augmented transformer");
    expect(normalizeTitle("Ｗａｖ２Ｖｅｃ <i>2.0</i> — Café")).toBe("wav2vec 2 0 cafe");
    expect(normalizeTitle("\\textbf{Deep} Speech")).toBe("deep speech");
    expect(normalizeTitle("基於 自監督 學習：台語")).toBe("基於自監督學習台語");
  });

  it("trigram similarity matches pg_trgm", () => {
    // From the PostgreSQL pg_trgm docs: similarity('word', 'two words') = 0.36363637
    expect(trigramSimilarity("word", "two words")).toBeCloseTo(0.363636, 5);
    expect(trigramSimilarity("abc", "abc")).toBe(1);
    expect(trigramSimilarity("", "")).toBe(0);
  });

  it("CJK titles use character bigrams", () => {
    expect(titleSimilarity("華語兒童語音辨識之資料增強方法", "華語兒童語音辨識的資料增強方法")).toBeGreaterThan(0.7);
    expect(titleSimilarity("華語兒童語音辨識", "台語語音合成")).toBeLessThan(0.2);
  });

  it("parses free-form names", () => {
    expect(parseName("Gulati, Anmol")).toEqual({ family: "Gulati", given: "Anmol" });
    expect(parseName("Anmol Gulati")).toEqual({ family: "Gulati", given: "Anmol" });
    expect(parseName("Jan van der Berg")).toEqual({ family: "Berg", given: "Jan", particle: "van der" });
    expect(parseName("van der Berg, Jan")).toEqual({ family: "Berg", given: "Jan", particle: "van der" });
    expect(parseName("王小明")).toEqual({ literal: "王小明" });
    expect(parseName("  ")).toBeUndefined();
  });
});

describe("compareRecords", () => {
  it("same: DOI (case-insensitive), arXiv, S2 id", () => {
    expect(compareRecords(conformer, { ...conformer, title: "x", doi: "10.21437/INTERSPEECH.2020-3015" }).level).toBe("same");
    const a = { ...conformer, doi: undefined, arxivId: "2005.08100" };
    expect(compareRecords(a, { type: "article", title: "?", authors: [], doi: "10.48550/arXiv.2005.08100" }).reason).toBe("arxiv");
    expect(compareRecords({ ...a, arxivId: undefined, ids: { s2: "ABC" } }, { type: "article", title: "?", authors: [], ids: { s2: "abc" } }).reason).toBe("s2");
  });

  it("likely: same normalized title, year ±1, same first author", () => {
    const pre: PaperRecord = { type: "article", title: "CONFORMER: convolution augmented transformer for speech recognition.", authors: [{ literal: "Anmol Gulati" }], year: 2021, arxivId: "2005.08100" };
    expect(compareRecords(conformer, pre)).toMatchObject({ level: "likely", reason: "title" });
  });

  it("possible: fuzzy title ≥ 0.93", () => {
    const b: PaperRecord = { ...conformer, doi: undefined, title: "Conformer: Convolution-augmented Transformers for Speech Recognition" };
    const m = compareRecords({ ...conformer, doi: undefined }, b);
    expect(m.level).toBe("possible");
    expect(m.score).toBeGreaterThanOrEqual(0.93);
  });

  it("none: different year, different first author, or two different publisher DOIs", () => {
    expect(compareRecords(conformer, { ...conformer, doi: undefined, year: 2024 }).level).toBe("none");
    expect(compareRecords(conformer, { ...conformer, doi: undefined, authors: [{ family: "Smith" }] }).level).toBe("none");
    // journal vs conference version with distinct DOIs: only flagged as possible
    expect(compareRecords(conformer, { ...conformer, doi: "10.1109/taslp.2021.1" }).level).toBe("possible");
    expect(compareRecords(conformer, { ...conformer, doi: undefined, title: "Whisper" }).level).toBe("none");
  });

  it("findDuplicates orders by level then score", () => {
    const cands = [
      { ...conformer, doi: undefined, title: "Conformer: Convolution-augmented Transformers for Speech Recognition", citeKey: "fuzzy" },
      { ...conformer, citeKey: "exact" },
      { ...conformer, doi: undefined, title: "Totally different", citeKey: "none" },
    ];
    expect(findDuplicates({ ...conformer, citeKey: undefined }, cands).map((c) => c.item.citeKey)).toEqual(["exact", "fuzzy"]);
  });
});

describe("mergeRecords / dedupeRecords", () => {
  it("fills missing fields, prefers richer authors and abstract, keeps the primary key", () => {
    const other: PaperRecord = {
      type: "paper-conference",
      title: "Conformer: Convolution-augmented Transformer for Speech Recognition",
      authors: [{ family: "Gulati", given: "Anmol" }, { family: "Qin", given: "James" }, { family: "Chiu", given: "Chung-Cheng" }],
      year: 2020,
      month: 10,
      pages: "5036–5040",
      abstract: "Recently Transformer and Convolution neural network (CNN) based models have shown promising results.",
      ids: { s2: "0170fc", openalex: "W3097777922" },
      arxivId: "2005.08100",
      keywords: ["ASR", "conformer"],
      citeKey: "other",
    };
    const m = mergeRecords({ ...conformer, abstract: "Short.", keywords: ["asr"], ids: { dblp: "conf/x" } }, other);
    expect(m.citeKey).toBe("gulati2020conformer");
    expect(m.authors).toHaveLength(3);
    expect(m.abstract).toBe(other.abstract);
    expect(m.pages).toBe("5036–5040");
    expect(m.month).toBe(10);
    expect(m.arxivId).toBe("2005.08100");
    expect(m.ids).toEqual({ s2: "0170fc", openalex: "W3097777922", dblp: "conf/x" });
    expect(m.keywords).toEqual(["asr", "conformer"]);
  });

  it("upgrades a preprint to its published version", () => {
    const pre: PaperRecord = { type: "article", title: conformer.title, authors: [{ family: "Gulati", given: "Anmol" }], year: 2020, arxivId: "2005.08100", doi: "10.48550/arXiv.2005.08100" };
    const m = mergeRecords(pre, conformer);
    expect(m.type).toBe("paper-conference");
    expect(m.containerTitle).toBe("Proc. Interspeech 2020");
    expect(m.doi).toBe("10.21437/Interspeech.2020-3015");
    expect(m.arxivId).toBe("2005.08100");
  });

  it("groups duplicates from several sources", () => {
    const groups = dedupeRecords([
      conformer,
      { type: "article", title: "Whisper", authors: [{ family: "Radford" }], year: 2022 },
      { ...conformer, doi: "10.21437/interspeech.2020-3015", citeKey: undefined, ids: { s2: "x" } },
      { type: "article", title: "conformer convolution augmented transformer for speech recognition", authors: [{ family: "Gulati" }], year: 2020, arxivId: "2005.08100" },
    ]);
    expect(groups.map((g) => g.members)).toEqual([[0, 2, 3], [1]]);
    expect(groups[0]!.record.ids?.s2).toBe("x");
    expect(groups[0]!.record.arxivId).toBe("2005.08100");
  });
});
