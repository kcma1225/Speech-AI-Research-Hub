import { describe, expect, it } from "vitest";
import { bibEntries, carriedEntries, citedKeys } from "../src/lib/latex/bib-carry.js";

const OLD = `% sample
@inproceedings{baevski2020wav2vec,
  title = {wav2vec 2.0},
  year = {2020}
}

@string{foo = "bar"}

@inproceedings{radford2023whisper,
  title = {Robust Speech Recognition via Large-Scale Weak Supervision},
  year = {2023}
}
@article{unused2020,
  title = {Never cited}
}
`;

describe("auto bib: carry cited entries that are not in the library", () => {
  it("finds cite keys of every cite command, ignoring comments", () => {
    const keys = citedKeys(["a \\cite{x, y} b \\citep[p.~3]{z} \\parencite[see][12]{w}\n% \\cite{commented}\n\\nocite{n} \\textcite*{t}", "100\\% \\autocite{u}"]);
    expect([...keys].sort()).toEqual(["n", "t", "u", "w", "x", "y", "z"]);
  });

  it("splits entries and skips @string", () => {
    expect(bibEntries(OLD).map((e) => e.key)).toEqual(["baevski2020wav2vec", "radford2023whisper", "unused2020"]);
    expect(bibEntries(OLD)[1]!.text).toMatch(/^@inproceedings\{radford2023whisper,[\s\S]*2023\}\n\}$/);
  });

  it("keeps only cited entries missing from the library (keys compared case-insensitively)", () => {
    const cited = citedKeys(["\\cite{baevski2020wav2vec,radford2023whisper}"]);
    expect(carriedEntries(OLD, ["Baevski2020wav2vec", "devlin2019bert"], cited).map((e) => e.key)).toEqual(["radford2023whisper"]);
    expect(carriedEntries(OLD, ["radford2023whisper", "baevski2020wav2vec"], cited)).toEqual([]);
  });
});
