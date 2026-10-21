import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibraryService, extractIdentifiers, extractPdfText, GrobidClient, RateLimiter, SourceError } from "../src/lib/library/index.js";
import { fixture, makePdf, mockServer, sendJson, sendText } from "./library-fixtures/helpers.js";

const fast = () => new RateLimiter({ intervalMs: 1, burst: 10, concurrency: 10 });

const conformerPdf = makePdf(
  [],
  {
    pages: [
      [
        ["Conformer: Convolution-augmented Transformer", 17, 720],
        ["for Speech Recognition", 17, 700],
        ["Anmol Gulati, James Qin", 11, 670],
        ["arXiv:2005.08100v1 [eess.AS] 16 May 2020", 8, 400],
      ],
      [["1. Introduction. See doi:10.21437/Interspeech.2020-3015 for the final version.", 10, 700]],
      [["References: [1] A. Vaswani et al., doi:10.5555/3295222.3295349", 9, 700]],
    ],
    info: { Title: "", Producer: "test" },
  },
);

const noIdPdf = makePdf([
  ["Robust Speech Recognition via Large-Scale Weak Supervision", 16, 720],
  ["Alec Radford, Jong Wook Kim", 11, 690],
  ["We study the capabilities of speech processing systems trained simply to predict large amounts of transcripts.", 9, 650],
]);

describe("PDF text and identifiers", () => {
  it("extracts first pages + last page and guesses the title from the largest font", async () => {
    const t = await extractPdfText(conformerPdf);
    expect(t.numPages).toBe(3);
    expect(t.pages).toHaveLength(3);
    expect(t.pages[0]).toContain("arXiv:2005.08100v1");
    expect(t.titleGuess).toBe("Conformer: Convolution-augmented Transformer for Speech Recognition");
    expect(t.info.Producer).toBe("test");
  });

  it("finds DOI and arXiv id; arXiv DOIs are not taken as the publisher DOI", async () => {
    const t = await extractPdfText(conformerPdf);
    expect(extractIdentifiers(t)).toEqual({ doi: "10.21437/Interspeech.2020-3015", arxivId: "2005.08100" });
    expect(extractIdentifiers({ pages: ["see https://doi.org/10.48550/arXiv.2006.11477 and nothing else"] })).toEqual({ arxivId: "2006.11477" });
    expect(extractIdentifiers({ pages: ["no ids"], info: { Subject: "doi:10.1109/ICASSP.2022.1" } })).toEqual({ doi: "10.1109/ICASSP.2022.1" });
  });

  it("rejects non-PDF and broken PDFs with zh messages", async () => {
    await expect(extractPdfText(Buffer.from("hello"))).rejects.toThrow("檔案不是 PDF");
    await expect(extractPdfText(Buffer.from("%PDF-1.4\ngarbage"))).rejects.toBeInstanceOf(SourceError);
  });
});

describe("PDF → record", () => {
  let srv: Awaited<ReturnType<typeof mockServer>>;
  let grobidBody = "";
  beforeAll(async () => {
    srv = await mockServer((req, res) => {
      const p = req.url.pathname;
      if (p.startsWith("/crossref/works/")) {
        const doi = decodeURIComponent(p.slice("/crossref/works/".length)).toLowerCase();
        return doi === "10.21437/interspeech.2020-3015" ? sendJson(res, fixture("crossref-work.json")) : sendText(res, "Resource not found.", "text/plain", 404);
      }
      if (p === "/crossref/works") return sendJson(res, { status: "ok", message: { items: [] } });
      if (p.startsWith("/openalex/")) return sendJson(res, { error: "nf" }, 404);
      if (p === "/grobid/api/processHeaderDocument") {
        grobidBody = req.body.toString("latin1");
        return sendText(
          res,
          "@article{-1,\n  author = {Radford, Alec and Kim, Jong Wook},\n  title = {Robust Speech Recognition via Large-Scale Weak Supervision},\n  year = {2022},\n  abstract = {We study the capabilities of speech processing systems.}\n}\n",
          "application/x-bibtex",
        );
      }
      if (p === "/grobid/api/processReferences") {
        return sendText(res, "@article{b0,\n  author = {Vaswani, Ashish},\n  title = {Attention Is All You Need},\n  year = {2017}\n}\n\n@inproceedings{b1,\n  author = {Graves, Alex},\n  title = {Sequence Transduction with Recurrent Neural Networks},\n  year = {2012}\n}\n", "application/x-bibtex");
      }
      if (p === "/grobid/api/isalive") return sendText(res, "true", "text/plain");
      sendJson(res, { error: p }, 500);
    });
  });
  afterAll(() => srv.close());

  const svc = (grobid = false) =>
    createLibraryService({
      contactEmail: "lab@example.org",
      baseUrls: { crossref: `${srv.url}/crossref`, openalex: `${srv.url}/openalex`, arxiv: `${srv.url}/arxiv` },
      limiters: { crossref: fast(), openalex: fast(), arxiv: fast(), grobid: fast() },
      ...(grobid ? { grobidUrl: `${srv.url}/grobid` } : {}),
    });

  it("resolves the DOI found in the PDF and keeps the arXiv id", async () => {
    const r = await svc().extractPdfRecord(conformerPdf);
    expect(r.method).toBe("doi");
    expect(r.record).toMatchObject({ title: "Conformer: Convolution-augmented Transformer for Speech Recognition", doi: "10.21437/Interspeech.2020-3015", arxivId: "2005.08100", publisher: "ISCA" });
  });

  it("falls back to GROBID, then to the title guess", async () => {
    const g = await svc(true).extractPdfRecord(noIdPdf);
    expect(g.method).toBe("grobid");
    expect(g.record).toMatchObject({ title: "Robust Speech Recognition via Large-Scale Weak Supervision", year: 2022 });
    expect(g.record!.citeKey).toBeUndefined();
    expect(grobidBody).toContain('name="input"');
    expect(grobidBody).toContain("%PDF-1.4");
    const guess = await svc(false).extractPdfRecord(noIdPdf);
    expect(guess.method).toBe("guess");
    expect(guess.record).toEqual({ type: "document", title: "Robust Speech Recognition via Large-Scale Weak Supervision", authors: [] });
    expect(guess.warnings[0]).toContain("請確認資料");
  });

  it("GROBID client: references and liveness", async () => {
    const c = new GrobidClient({ url: `${srv.url}/grobid`, limiter: fast() });
    expect(await c.isAlive()).toBe(true);
    const refs = await c.processReferences(noIdPdf);
    expect(refs.map((r) => r.title)).toEqual(["Attention Is All You Need", "Sequence Transduction with Recurrent Neural Networks"]);
    expect(await new GrobidClient({ url: "http://127.0.0.1:1" }).isAlive()).toBe(false);
  });
});
