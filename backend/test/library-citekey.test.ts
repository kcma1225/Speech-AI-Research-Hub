import { describe, expect, it } from "vitest";
import { assignCiteKeys, formatApa, formatIeee, generateCiteKey, keyAuthor, uniqueCiteKey, type PaperRecord } from "../src/lib/library/index.js";

const rec = (title: string, authors: PaperRecord["authors"], year?: number): PaperRecord => ({ type: "article-journal", title, authors, ...(year ? { year } : {}) });

describe("citation keys", () => {
  it("auth.lower + year + first significant title word", () => {
    expect(generateCiteKey(rec("Conformer: Convolution-augmented Transformer", [{ family: "Gulati", given: "Anmol" }], 2020))).toBe("gulati2020conformer");
    expect(generateCiteKey(rec("The Effect of Noise on ASR", [{ family: "Smith" }], 2019))).toBe("smith2019effect");
    expect(generateCiteKey(rec("wav2vec 2.0: A Framework", [{ family: "Baevski" }], 2020))).toBe("baevski2020wav2vec");
  });

  it("strips particles and accents", () => {
    expect(keyAuthor({ authors: [{ family: "Berg", particle: "van der", given: "Jan" }] })).toBe("berg");
    expect(keyAuthor({ authors: [{ family: "Müller-Šimić" }] })).toBe("mullersimic");
    expect(keyAuthor({ authors: [{ literal: "Jan van der Berg" }] })).toBe("berg");
  });

  it("romanizes Chinese names and titles with pinyin", () => {
    expect(generateCiteKey(rec("基於自監督學習之台語語音辨識", [{ literal: "王小明" }], 2023))).toBe("wang2023jiyu");
    expect(generateCiteKey(rec("華語兒童語音辨識", [{ family: "陳", given: "大文" }], 2021))).toBe("chen2021huayu");
    expect(keyAuthor({ authors: [{ literal: "歐陽娜娜" }] })).toBe("ouyang");
    expect(keyAuthor({ authors: [{ literal: "單小明" }] })).toBe("shan");
    expect(keyAuthor({ authors: [{ literal: "曾志偉" }] })).toBe("zeng");
  });

  it("falls back to zh + hash for scripts without a romanizer, anon without authors", () => {
    expect(keyAuthor({ authors: [{ literal: "さとう" }] })).toMatch(/^zh[0-9a-f]{6}$/);
    expect(keyAuthor({ authors: [{ literal: "さとう" }] })).toBe(keyAuthor({ authors: [{ literal: "さとう" }] }));
    expect(generateCiteKey(rec("Speech", []))).toBe("anonspeech");
  });

  it("uniqueness suffixes a, b, …, z, aa (case-insensitive)", () => {
    expect(uniqueCiteKey("k", [])).toBe("k");
    expect(uniqueCiteKey("k", ["K"])).toBe("ka");
    expect(uniqueCiteKey("k", ["k", "ka"])).toBe("kb");
    const taken = new Set(["k", ..."abcdefghijklmnopqrstuvwxyz".split("").map((c) => `k${c}`)]);
    expect(uniqueCiteKey("k", (x) => taken.has(x))).toBe("kaa");
  });

  it("assignCiteKeys keeps pinned keys and generates unique ones for the rest", () => {
    const a = rec("Conformer", [{ family: "Gulati" }], 2020);
    const keys = assignCiteKeys([{ ...a }, { ...a, citeKey: "gulati2020conformer" }, { ...a }, { ...a, citeKey: "bad key!" }], ["gulati2020conformera"]);
    expect(keys).toEqual(["gulati2020conformerb", "gulati2020conformer", "gulati2020conformerc", "gulati2020conformerd"]);
  });
});

describe("display formatting", () => {
  const conf: PaperRecord = {
    type: "paper-conference",
    title: "Conformer: Convolution-augmented Transformer for Speech Recognition",
    authors: [{ family: "Gulati", given: "Anmol" }, { family: "Qin", given: "James" }, { family: "Chiu", given: "Chung-Cheng" }],
    year: 2020,
    month: 10,
    containerTitle: "Proc. Interspeech 2020",
    pages: "5036–5040",
    doi: "10.21437/Interspeech.2020-3015",
  };

  it("APA-like", () => {
    expect(formatApa(conf)).toBe(
      "Gulati, A., Qin, J., & Chiu, C.-C. (2020). Conformer: Convolution-augmented Transformer for Speech Recognition. Proc. Interspeech 2020, 5036–5040. https://doi.org/10.21437/Interspeech.2020-3015",
    );
    expect(formatApa({ type: "thesis", title: "台語語音辨識", authors: [{ family: "王", given: "小明" }], year: 2023, publisher: "國立臺灣大學" })).toBe(
      "王小明. (2023). 台語語音辨識. 國立臺灣大學.",
    );
    expect(formatApa({ type: "article", title: "wav2vec 2.0", authors: [{ family: "Baevski", given: "Alexei" }], year: 2020, arxivId: "2006.11477" })).toBe(
      "Baevski, A. (2020). wav2vec 2.0. arXiv:2006.11477. https://arxiv.org/abs/2006.11477",
    );
  });

  it("IEEE-like", () => {
    expect(formatIeee(conf)).toBe(
      "A. Gulati, J. Qin, and C.-C. Chiu, “Conformer: Convolution-augmented Transformer for Speech Recognition,” in Proc. Interspeech 2020, Oct. 2020, pp. 5036–5040, doi: 10.21437/Interspeech.2020-3015.",
    );
    const many = { ...conf, authors: Array.from({ length: 8 }, (_, i) => ({ family: `F${i}`, given: "G" })) };
    expect(formatIeee(many).startsWith("G. F0 et al., “Conformer")).toBe(true);
    expect(formatIeee({ type: "document", title: "Untitled note", authors: [] })).toBe("“Untitled note.”");
  });
});
