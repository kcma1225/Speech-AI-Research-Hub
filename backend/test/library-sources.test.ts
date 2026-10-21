import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArxivClient, arxivQuery, parseArxivAtom, createLibraryService, CrossrefClient, IscaArchiveClient, OpenAlexClient, parseIdentifier,
  RateLimiter, SemanticScholarClient, SourceError, UnpaywallClient, ZoteroClient, AclAnthologyClient, type LibraryConfig,
} from "../src/lib/library/index.js";
import { fixture, makePdf, mockServer, sendJson, sendText, type Recorded } from "./library-fixtures/helpers.js";

const fast = () => new RateLimiter({ intervalMs: 1, burst: 10, concurrency: 10 });
const limiters = () => ({
  openalex: fast(), s2: fast(), arxiv: fast(), crossref: fast(), acl: fast(), isca: fast(), unpaywall: fast(), zotero: fast(), grobid: fast(), download: fast(),
});

let srv: Awaited<ReturnType<typeof mockServer>>;
let hits429 = 0;

beforeAll(async () => {
  srv = await mockServer((req: Recorded, res) => {
    const p = req.url.pathname;
    const q = req.url.searchParams;
    // OpenAlex
    if (p === "/openalex/works") {
      return sendJson(res, fixture("openalex-search.json"), 200, { "x-ratelimit-cost-usd": "0.001", "x-ratelimit-remaining-usd": "0.75" });
    }
    if (p.startsWith("/openalex/works/doi:")) {
      const doi = decodeURIComponent(p.slice("/openalex/works/doi:".length)).toLowerCase();
      const works = JSON.parse(fixture("openalex-search.json")).results as { doi: string }[];
      const w = works.find((x) => x.doi.toLowerCase().endsWith(doi));
      return w ? sendJson(res, w, 200, { "x-ratelimit-cost-usd": "0" }) : sendJson(res, { error: "Not found" }, 404);
    }
    // Semantic Scholar
    if (p === "/s2/paper/search") return sendJson(res, fixture("s2-search.json"));
    if (p.startsWith("/s2/paper/")) {
      const id = decodeURIComponent(p.slice("/s2/paper/".length));
      const data = JSON.parse(fixture("s2-search.json")).data as { paperId: string; externalIds: Record<string, string> }[];
      const hit = data.find((d) => d.paperId === id || `DOI:${d.externalIds.DOI}`.toLowerCase() === id.toLowerCase() || `ARXIV:${d.externalIds.ArXiv}` === id);
      return hit ? sendJson(res, hit) : sendJson(res, { error: "Paper not found" }, 404);
    }
    // arXiv
    if (p === "/arxiv/query") {
      const atom = fixture("arxiv-search.atom");
      if (q.get("id_list") === "2005.08100") return sendText(res, atom.replace(/<entry>\s*<id>http:\/\/arxiv.org\/abs\/2110[\s\S]*?<\/entry>/, ""), "application/atom+xml");
      return sendText(res, atom, "application/atom+xml");
    }
    // Crossref
    if (p === "/crossref/works") {
      if (q.get("query.bibliographic")?.includes("Conformer")) {
        const w = JSON.parse(fixture("crossref-work.json")).message;
        return sendJson(res, { status: "ok", message: { items: [w] } });
      }
      return sendJson(res, fixture("crossref-search.json"));
    }
    if (p.startsWith("/crossref/works/")) {
      const doi = decodeURIComponent(p.slice("/crossref/works/".length)).toLowerCase();
      return doi === "10.21437/interspeech.2020-3015" ? sendJson(res, fixture("crossref-work.json")) : sendText(res, "Resource not found.", "text/plain", 404);
    }
    // Unpaywall
    if (p.startsWith("/unpaywall/")) {
      return decodeURIComponent(p.slice("/unpaywall/".length)) === "10.1234/oa" ? sendJson(res, fixture("unpaywall.json")) : sendJson(res, { error: true }, 404);
    }
    // ACL
    if (p === "/acl/2020.acl-main.1.bib") return sendText(res, fixture("acl.bib"), "text/x-bibtex");
    // ISCA
    if (p === "/isca/interspeech_2020/index.html") return sendText(res, fixture("isca-index.html"), "text/html");
    if (/^\/isca\/interspeech_20\d\d\/index\.html$/.test(p)) return sendText(res, "<html></html>", "text/html");
    if (p === "/isca/interspeech_2020/gulati20_interspeech.html") return sendText(res, fixture("isca-paper.html"), "text/html");
    // Zotero
    if (p === "/zotero/keys/current") {
      return req.headers["zotero-api-key"] === "good" ? sendJson(res, { key: "good", userID: 475425, username: "lab", access: { user: { library: true } } }) : sendJson(res, "Forbidden", 403);
    }
    if (p === "/zotero/users/475425/groups") return sendJson(res, [{ id: 99, data: { name: "Speech Lab" } }]);
    if (p === "/zotero/users/475425/items/top") {
      return sendJson(res, fixture("zotero-items.json"), 200, { "last-modified-version": "1205", "total-results": "3", backoff: "0" });
    }
    if (p === "/zotero/users/475425/deleted") return sendJson(res, { collections: [], items: ["OLD00001"], searches: [], tags: [], settings: [] });
    // Rate limit
    if (p === "/flaky") {
      hits429++;
      return hits429 === 1 ? sendJson(res, { error: "slow down" }, 429, { "retry-after": "1" }) : sendJson(res, { ok: true });
    }
    // Downloads
    if (p === "/files/ok.pdf") return sendText(res, makePdf([["Hello", 12, 700]]), "application/pdf");
    if (p === "/files/redirect") {
      res.writeHead(302, { location: "/files/ok.pdf" });
      return res.end();
    }
    if (p === "/files/landing") return sendText(res, "<html>login</html>", "text/html");
    if (p === "/files/fake.pdf") return sendText(res, "not a pdf at all", "application/pdf");
    if (p === "/files/big.pdf") return sendText(res, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300_000)]), "application/octet-stream");
    sendJson(res, { error: `unexpected ${p}` }, 500);
  });
});
afterAll(() => srv.close());

const cfg = (extra: Partial<LibraryConfig> = {}): LibraryConfig => ({
  contactEmail: "lab@example.org",
  openalexApiKey: "oa-key",
  s2ApiKey: "s2-key",
  baseUrls: {
    openalex: `${srv.url}/openalex`, s2: `${srv.url}/s2`, arxiv: `${srv.url}/arxiv`, crossref: `${srv.url}/crossref`,
    acl: `${srv.url}/acl`, isca: `${srv.url}/isca`, unpaywall: `${srv.url}/unpaywall`,
  },
  limiters: limiters(),
  allowPrivateDownloads: true,
  ...extra,
});

describe("source clients (mock HTTP)", () => {
  it("OpenAlex: search maps works, sends key and filters, tracks usage", async () => {
    const c = new OpenAlexClient({ apiKey: "oa-key", baseUrl: `${srv.url}/openalex`, limiter: fast() });
    const rs = await c.search("conformer", { limit: 5, yearFrom: 2020, yearTo: 2022 });
    const req = srv.requests.findLast((r) => r.url.pathname === "/openalex/works")!;
    expect(req.url.searchParams.get("api_key")).toBe("oa-key");
    expect(req.url.searchParams.get("filter")).toBe("publication_year:2020-2022");
    expect(req.url.searchParams.get("per_page")).toBe("5");
    expect(c.lastUsage).toEqual({ costUsd: 0.001, remainingUsd: 0.75 });
    const [a, b] = rs;
    expect(a).toMatchObject({
      type: "paper-conference", year: 2020, month: 10, doi: "10.21437/interspeech.2020-3015", arxivId: "2005.08100",
      pages: "5036–5040", venue: "Interspeech", oaPdfUrl: "https://arxiv.org/pdf/2005.08100", ids: { openalex: "W3097777922" },
    });
    expect(a!.authors[0]).toEqual({ family: "Gulati", given: "Anmol" });
    expect(a!.abstract).toBe("Recently Transformer and Convolution neural network based models");
    expect(b).toMatchObject({ venue: "ICASSP", doi: "10.1109/icassp43922.2022.9747077" });
    expect(b!.oaPdfUrl).toBeUndefined();
  });

  it("OpenAlex: refuses to search once the daily budget is gone", async () => {
    const c = new OpenAlexClient({ apiKey: "k", baseUrl: `${srv.url}/openalex`, limiter: fast() });
    c.lastUsage = { remainingUsd: 0 };
    await expect(c.search("x")).rejects.toThrow("OpenAlex 今日額度已用完");
  });

  it("Semantic Scholar: search with x-api-key, year range, externalIds", async () => {
    const c = new SemanticScholarClient({ apiKey: "s2-key", baseUrl: `${srv.url}/s2`, limiter: fast() });
    const rs = await c.search("conformer", { limit: 2, yearFrom: 2019 });
    const req = srv.requests.findLast((r) => r.url.pathname === "/s2/paper/search")!;
    expect(req.headers["x-api-key"]).toBe("s2-key");
    expect(req.url.searchParams.get("year")).toBe("2019-");
    expect(req.url.searchParams.get("fields")).toContain("openAccessPdf");
    expect(rs[0]).toMatchObject({
      type: "paper-conference", containerTitle: "Interspeech", arxivId: "2005.08100", doi: "10.21437/interspeech.2020-3015",
      ids: { s2: "0170fc76e934ee643f869df18fb617d5357e8b4e", s2Corpus: "218674528", dblp: "conf/interspeech/GulatiQCPZYHWZW20" },
      oaPdfUrl: "https://arxiv.org/pdf/2005.08100", month: 5,
    });
    expect(rs[1]!.oaPdfUrl).toBeUndefined(); // empty openAccessPdf.url
    expect(rs[1]!.venue).toBe("NeurIPS");
    expect(await c.getPaper("DOI:10.9999/none")).toBeNull();
  });

  it("arXiv: Atom parsing, query building, API errors", async () => {
    expect(arxivQuery('conformer "speech recognition"', { yearFrom: 2020 })).toBe('(all:conformer AND all:"speech recognition") AND submittedDate:[202001010000 TO 210012312359]');
    const c = new ArxivClient({ baseUrl: `${srv.url}/arxiv`, limiter: fast() });
    const rs = await c.search("conformer speech", { limit: 2 });
    expect(srv.requests.findLast((r) => r.url.pathname === "/arxiv/query")!.url.searchParams.get("search_query")).toBe("all:conformer AND all:speech");
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({
      type: "article", title: "Conformer: Convolution-augmented Transformer for Speech Recognition", arxivId: "2005.08100",
      year: 2020, month: 5, day: 16, url: "https://arxiv.org/abs/2005.08100", oaPdfUrl: "https://arxiv.org/pdf/2005.08100v1",
    });
    expect(rs[0]!.keywords?.[0]).toBe("eess.AS");
    expect(rs[0]!.authors).toHaveLength(3);
    expect(rs[1]).toMatchObject({ doi: "10.1109/ICASSP43922.2022.9747077", note: "ICASSP 2022", venue: "ICASSP" });
    expect((await c.getById("2005.08100v2"))?.arxivId).toBe("2005.08100");
    await expect(c.getByIds(["bad"])).resolves.toEqual([]); // invalid ids never reach the API
    expect(() => parseArxivAtom(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id><title>Error</title><summary>incorrect id format for x</summary></entry></feed>`)).toThrow("arXiv 查詢錯誤");
  });

  it("arXiv: matchTitle accepts only close titles", async () => {
    const c = new ArxivClient({ baseUrl: `${srv.url}/arxiv`, limiter: fast() });
    const m = await c.matchTitle("Wav2vec-Switch: Contrastive Learning from Original-Noisy Speech Pairs for Robust Speech Recognition");
    expect(m?.record.arxivId).toBe("2110.04934");
    expect(await c.matchTitle("Something entirely unrelated to anything")).toBeNull();
  });

  it("Crossref: search, singleton (404 → null), mailto, JATS abstract cleanup, org authors", async () => {
    const c = new CrossrefClient({ contactEmail: "lab@example.org", baseUrl: `${srv.url}/crossref`, limiter: fast() });
    const rs = await c.search("self-supervised speech", { yearFrom: 2021, yearTo: 2022 });
    const req = srv.requests.findLast((r) => r.url.pathname === "/crossref/works")!;
    expect(req.url.searchParams.get("mailto")).toBe("lab@example.org");
    expect(req.url.searchParams.get("filter")).toBe("from-pub-date:2021-01-01,until-pub-date:2022-12-31");
    expect(req.headers["user-agent"]).toContain("mailto:lab@example.org");
    expect(rs[0]).toMatchObject({ type: "paper-conference", venue: "ICASSP", isbn: "9781665405409", pages: "7097–7101", year: 2022, month: 5 });
    expect(rs[1]!.title).toBe("Self-supervised Speech Representation Learning: A Review");
    expect(rs[1]!.abstract).toBe("Although supervised deep learning has revolutionized speech & audio processing…");
    expect(rs[1]!.authors[1]).toEqual({ literal: "SSL Survey Consortium" });
    const w = await c.getByDoi("https://doi.org/10.21437/Interspeech.2020-3015");
    expect(w).toMatchObject({ type: "paper-conference", containerTitle: "Interspeech 2020", publisher: "ISCA", year: 2020, month: 10, day: 25 });
    expect(await c.getByDoi("10.1/missing")).toBeNull();
  });

  it("Unpaywall: best PDF location; unavailable without email", async () => {
    const c = new UnpaywallClient({ contactEmail: "lab@example.org", baseUrl: `${srv.url}/unpaywall`, limiter: fast() });
    expect(await c.pdfUrl("10.1234/oa")).toEqual({ url: "https://www.aclweb.org/anthology/2020.acl-main.1.pdf", license: "cc-by", landingUrl: "https://doi.org/10.18653/v1/2020.acl-main.1" });
    expect(srv.requests.findLast((r) => r.url.pathname.startsWith("/unpaywall/"))!.url.searchParams.get("email")).toBe("lab@example.org");
    expect(await c.pdfUrl("10.1234/closed")).toBeNull();
    expect(new UnpaywallClient({}).available).toBe(false);
  });

  it("ACL Anthology: id → BibTeX record + PDF URL", async () => {
    const c = new AclAnthologyClient({ baseUrl: `${srv.url}/acl`, limiter: fast() });
    const r = await c.getById("https://aclanthology.org/2020.acl-main.1/");
    expect(r).toMatchObject({ type: "paper-conference", doi: "10.18653/v1/2020.acl-main.1", ids: { acl: "2020.acl-main.1" }, venue: "ACL", pages: "1–6", oaPdfUrl: `${srv.url}/acl/2020.acl-main.1.pdf` });
    expect(r!.authors[1]).toEqual({ family: "Chrupała", given: "Grzegorz" });
  });

  it("ISCA Archive: index parsing, title search, paper page", async () => {
    const c = new IscaArchiveClient({ baseUrl: `${srv.url}/isca`, limiter: fast() });
    const list = await c.listYear(2020);
    expect(list.map((e) => e.id)).toContain("interspeech_2020/gulati20_interspeech");
    const g = list.find((e) => e.id.endsWith("gulati20_interspeech"))!;
    expect(g.authors).toHaveLength(11);
    expect(g.pdfUrl).toBe(`${srv.url}/isca/interspeech_2020/gulati20_interspeech.pdf`);
    const before = srv.requests.length;
    await c.listYear(2020);
    expect(srv.requests.length).toBe(before); // cached
    const found = await c.findByTitle("Conformer: convolution-augmented transformer for speech recognition", 2020);
    expect(found?.entry.id).toBe("interspeech_2020/gulati20_interspeech");
    const rs = await c.search("transformer speech recognition", { yearFrom: 2020, yearTo: 2020 });
    const ids = rs.map((r) => r.ids?.isca);
    expect(ids).toEqual(expect.arrayContaining(["interspeech_2020/gulati20_interspeech", "interspeech_2020/lu20g_interspeech", "interspeech_2020/tian20c_interspeech"]));
    expect(ids).not.toContain("interspeech_2020/zhao20j_interspeech"); // no "recognition" in the title
    expect(rs.every((r) => r.venue === "Interspeech" && r.year === 2020)).toBe(true);
    const paper = await c.getPaper("interspeech_2020/gulati20_interspeech");
    expect(paper).toMatchObject({ doi: "10.21437/Interspeech.2020-3015", pages: "5036–5040", containerTitle: "Proc. Interspeech 2020", venue: "Interspeech", issn: "2958-1796" });
    expect(paper!.abstract).toMatch(/^Recently Transformer and Convolution neural network/);
    expect(paper!.citeKey).toBeUndefined();
  });

  it("Zotero: key check, paging headers, CSL mapping, Citation Key from extra, tags", async () => {
    const bad = new ZoteroClient({ apiKey: "bad", baseUrl: `${srv.url}/zotero`, limiter: fast() });
    await expect(bad.verifyKey()).rejects.toBeInstanceOf(SourceError);
    const c = new ZoteroClient({ apiKey: "good", baseUrl: `${srv.url}/zotero`, limiter: fast() });
    expect(await c.verifyKey()).toEqual({ userId: 475425, username: "lab", canReadUserLibrary: true, groups: [{ id: 99, name: "Speech Lab" }] });
    const { items, libraryVersion, total } = await c.listItems({ type: "user", id: 475425 }, { since: 1100 });
    const req = srv.requests.findLast((r) => r.url.pathname === "/zotero/users/475425/items/top")!;
    expect(req.headers["zotero-api-version"]).toBe("3");
    expect(req.url.searchParams.get("since")).toBe("1100");
    expect(req.url.searchParams.get("include")).toBe("data,csljson");
    expect(libraryVersion).toBe(1205);
    expect(total).toBe(3);
    expect(items.map((i) => i.key)).toEqual(["X42A7DEE", "ZH000001"]);
    expect(items[0]!.record).toMatchObject({ citeKey: "gulati2020conformer", arxivId: "2005.08100", keywords: ["ASR", "to-read"], type: "paper-conference" });
    expect(items[1]!.record).toMatchObject({ type: "thesis", title: "多語者語音合成", publisher: "國立清華大學", year: 2024, month: 7 });
    expect(items[1]!.record.citeKey).toBeUndefined();
    expect(await c.deletedSince({ type: "user", id: 475425 }, 1100)).toEqual(["OLD00001"]);
  });
});

describe("rate limiting and retries", () => {
  it("token bucket spaces requests", async () => {
    const l = new RateLimiter({ intervalMs: 60, burst: 1, concurrency: 1 });
    const t0 = Date.now();
    const times = await Promise.all([0, 1, 2].map(() => l.schedule(async () => Date.now() - t0)));
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(50);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(50);
  });

  it("concurrency gate holds back extra requests", async () => {
    const l = new RateLimiter({ intervalMs: 1, burst: 10, concurrency: 2 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        l.schedule(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("429 with Retry-After pauses the limiter and retries", async () => {
    const { requestJson } = await import("../src/lib/library/http.js");
    const l = new RateLimiter({ intervalMs: 1, burst: 1, concurrency: 1 });
    hits429 = 0;
    const t0 = Date.now();
    const res = await requestJson<{ ok: boolean }>(`${srv.url}/flaky`, { source: "crossref", limiter: l });
    expect(res.data).toEqual({ ok: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});

describe("library service", () => {
  it("parseIdentifier recognizes ids and URLs", () => {
    expect(parseIdentifier("https://doi.org/10.1109/ICASSP43922.2022.9747077")).toEqual({ kind: "doi", value: "10.1109/ICASSP43922.2022.9747077" });
    expect(parseIdentifier("https://arxiv.org/abs/2005.08100v2")).toEqual({ kind: "arxiv", value: "2005.08100" });
    expect(parseIdentifier("2005.08100")).toEqual({ kind: "arxiv", value: "2005.08100" });
    expect(parseIdentifier("10.48550/arXiv.2006.11477")).toEqual({ kind: "arxiv", value: "2006.11477" });
    expect(parseIdentifier("https://aclanthology.org/2020.acl-main.1.pdf")).toEqual({ kind: "acl", value: "2020.acl-main.1" });
    expect(parseIdentifier("https://openalex.org/W3097777922")).toEqual({ kind: "openalex", value: "W3097777922" });
    expect(parseIdentifier("https://www.semanticscholar.org/paper/Conformer/0170fc76e934ee643f869df18fb617d5357e8b4e")).toEqual({ kind: "s2", value: "0170fc76e934ee643f869df18fb617d5357e8b4e" });
    expect(parseIdentifier("https://www.isca-archive.org/interspeech_2020/gulati20_interspeech.pdf")).toEqual({ kind: "isca", value: "interspeech_2020/gulati20_interspeech" });
    expect(parseIdentifier("https://example.com/paper")).toBeNull();
  });

  it("searchPapers merges and dedupes across sources with attribution", async () => {
    const svc = createLibraryService(cfg());
    const res = await svc.searchPapers("conformer", { limit: 20, sources: ["openalex", "s2", "arxiv", "crossref", "acl"] });
    expect(res.errors).toEqual([]);
    expect(res.skipped.map((s) => s.source)).toEqual(["acl"]);
    const conf = res.hits.find((h) => h.record.title.startsWith("Conformer"))!;
    expect(conf.sources).toEqual(["openalex", "s2", "arxiv"]);
    expect(conf.record).toMatchObject({ type: "paper-conference", arxivId: "2005.08100", ids: { openalex: "W3097777922", s2: "0170fc76e934ee643f869df18fb617d5357e8b4e" } });
    const sw = res.hits.find((h) => h.record.title.startsWith("Wav2vec-Switch"))!;
    expect(sw.sources.sort()).toEqual(["arxiv", "crossref", "openalex"]);
    expect(sw.record.arxivId).toBe("2110.04934");
    const titles = res.hits.map((h) => h.record.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    const venues = await svc.searchPapers("conformer", { venues: ["icassp"] });
    expect(venues.hits.every((h) => h.record.venue === "ICASSP")).toBe(true);
  });

  it("searchPapers skips keyless sources and reports failures in zh", async () => {
    const svc = createLibraryService(cfg({ openalexApiKey: undefined, s2ApiKey: undefined, baseUrls: { ...cfg().baseUrls, crossref: "http://127.0.0.1:1" } }));
    const res = await svc.searchPapers("conformer", { sources: ["openalex", "s2", "crossref", "arxiv"] });
    expect(res.skipped).toEqual([
      { source: "openalex", reason: "未設定 OpenAlex API key" },
      { source: "s2", reason: "未設定 Semantic Scholar API key" },
    ]);
    expect(res.errors).toEqual([{ source: "crossref", status: 0, message: "無法連線到 Crossref" }]);
    expect(res.hits.length).toBe(2);
  });

  it("resolveIdentifier: DOI via Crossref enriched by OpenAlex; arXiv; ACL", async () => {
    const svc = createLibraryService(cfg());
    const r = await svc.resolveIdentifier("doi:10.21437/Interspeech.2020-3015");
    expect(r?.sources).toEqual(["crossref", "openalex"]);
    expect(r?.record).toMatchObject({ doi: "10.21437/Interspeech.2020-3015", arxivId: "2005.08100", ids: { openalex: "W3097777922" }, publisher: "ISCA" });
    expect((await svc.resolveIdentifier("arXiv:2005.08100"))?.record.title).toContain("Conformer");
    expect((await svc.resolveIdentifier("2020.acl-main.1"))?.record.ids?.acl).toBe("2020.acl-main.1");
    expect(await svc.resolveIdentifier("10.1/missing")).toBeNull();
    expect(await svc.resolveIdentifier("hello world")).toBeNull();
  });

  it("findOpenAccessPdf follows the source order", async () => {
    const svc = createLibraryService(cfg());
    const base = { type: "paper-conference" as const, authors: [{ family: "Gulati", given: "Anmol" }], title: "x" };
    expect(await svc.findOpenAccessPdf({ ...base, arxivId: "2005.08100" })).toEqual({ url: "https://arxiv.org/pdf/2005.08100", source: "arxiv" });
    expect(await svc.findOpenAccessPdf({ ...base, doi: "10.18653/v1/2020.acl-main.1" })).toEqual({ url: `${srv.url}/acl/2020.acl-main.1.pdf`, source: "acl" });
    expect(
      await svc.findOpenAccessPdf({ ...base, title: "Conformer: Convolution-augmented Transformer for Speech Recognition", year: 2020, doi: "10.21437/Interspeech.2020-3015" }),
    ).toEqual({ url: `${srv.url}/isca/interspeech_2020/gulati20_interspeech.pdf`, source: "isca" });
    expect(await svc.findOpenAccessPdf({ ...base, doi: "10.1234/oa" })).toMatchObject({ source: "unpaywall", license: "cc-by" });
    // ICASSP (closed): Unpaywall/OpenAlex/S2 give nothing → arXiv title match
    const icassp = await svc.findOpenAccessPdf({
      type: "paper-conference", title: "Wav2vec-Switch: Contrastive Learning from Original-Noisy Speech Pairs for Robust Speech Recognition",
      authors: [{ family: "Wang", given: "Yiming" }], year: 2022, doi: "10.1109/icassp43922.2022.9747077",
    });
    expect(icassp).toEqual({ url: "https://arxiv.org/pdf/2110.04934", source: "arxiv-title", arxivId: "2110.04934" });
    expect(await svc.findOpenAccessPdf({ ...base, title: "Nothing to find here at all" }, { titleMatch: false })).toBeNull();
  });

  it("downloadPdf: redirects, content-type, magic, size cap", async () => {
    const svc = createLibraryService(cfg());
    const ok = await svc.downloadPdf(`${srv.url}/files/redirect`);
    expect(ok.finalUrl).toBe(`${srv.url}/files/ok.pdf`);
    expect(ok.data.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(svc.downloadPdf(`${srv.url}/files/landing`)).rejects.toThrow("連結不是 PDF");
    await expect(svc.downloadPdf(`${srv.url}/files/fake.pdf`)).rejects.toThrow("下載的檔案不是 PDF");
    await expect(svc.downloadPdf(`${srv.url}/files/big.pdf`, { maxBytes: 100_000 })).rejects.toThrow("PDF 太大");
  });

  it("downloadPdf blocks private addresses unless allowed", async () => {
    const svc = createLibraryService(cfg({ allowPrivateDownloads: false }));
    await expect(svc.downloadPdf(`${srv.url}/files/ok.pdf`)).rejects.toThrow("不允許連到內部網路位址");
    await expect(svc.downloadPdf("file:///etc/passwd")).rejects.toThrow("只支援 http/https 網址");
  });
});
