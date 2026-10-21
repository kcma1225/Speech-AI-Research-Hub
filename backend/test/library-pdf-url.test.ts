import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { userSession } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { makePdf, mockServer, sendJson, sendText } from "./library-fixtures/helpers.js";
import { createLibraryService, RateLimiter } from "../src/lib/library/index.js";
import { setLibraryServiceFactory } from "../src/lib/library/settings.js";
import { citationPdfUrl } from "../src/lib/library/pdf.js";
import { fileNameFromUrl, planPdfUrl } from "../src/lib/library/pdf-url.js";

describe("planPdfUrl (landing pages → PDF URL)", () => {
  it("rewrites arXiv, ACL Anthology, OpenReview and DOIs", () => {
    expect(planPdfUrl("https://arxiv.org/abs/2301.00001")).toEqual({ kind: "arxiv", url: "https://arxiv.org/pdf/2301.00001" });
    expect(planPdfUrl("https://arxiv.org/abs/2301.00001v2")).toEqual({ kind: "arxiv", url: "https://arxiv.org/pdf/2301.00001v2" });
    expect(planPdfUrl("http://www.arxiv.org/html/2301.00001")).toEqual({ kind: "arxiv", url: "https://arxiv.org/pdf/2301.00001" });
    expect(planPdfUrl("arXiv:2301.00001")).toEqual({ kind: "arxiv", url: "https://arxiv.org/pdf/2301.00001" });
    expect(planPdfUrl("https://aclanthology.org/2023.acl-long.1/")).toEqual({ kind: "acl", url: "https://aclanthology.org/2023.acl-long.1.pdf" });
    expect(planPdfUrl("https://aclanthology.org/2023.acl-long.1.pdf")).toEqual({ kind: "direct", url: "https://aclanthology.org/2023.acl-long.1.pdf" });
    expect(planPdfUrl("https://openreview.net/forum?id=abcDEF123_x")).toEqual({ kind: "openreview", url: "https://openreview.net/pdf?id=abcDEF123_x" });
    expect(planPdfUrl("https://doi.org/10.1234/oa.5678")).toEqual({ kind: "doi", doi: "10.1234/oa.5678" });
    expect(planPdfUrl("10.1234/oa.5678")).toEqual({ kind: "doi", doi: "10.1234/oa.5678" });
    expect(planPdfUrl("https://doi.org/10.48550/arXiv.2301.00001")).toEqual({ kind: "arxiv", url: "https://arxiv.org/pdf/2301.00001" });
    expect(planPdfUrl("https://doi.org/10.18653/v1/2023.acl-long.1")).toEqual({ kind: "acl", url: "https://aclanthology.org/2023.acl-long.1.pdf" });
    expect(planPdfUrl("https://example.org/paper.pdf")).toEqual({ kind: "direct", url: "https://example.org/paper.pdf" });
  });
  it("rejects non-http(s) input", () => {
    expect(() => planPdfUrl("file:///etc/passwd")).toThrow("只支援 http/https 網址");
    expect(() => planPdfUrl("not a url")).toThrow("網址格式錯誤");
  });
  it("reads citation_pdf_url and names files", () => {
    const base = new URL("https://www.isca-archive.org/interspeech_2023/x23_interspeech.html");
    expect(citationPdfUrl(`<head><meta content="/a/b.pdf" name="citation_pdf_url"></head>`, base)).toBe("https://www.isca-archive.org/a/b.pdf");
    expect(citationPdfUrl(`<meta name='citation_pdf_url' content='https://x.org/p?id=1&amp;v=2'>`, base)).toBe("https://x.org/p?id=1&v=2");
    expect(citationPdfUrl(`<meta name="citation_title" content="x">`, base)).toBeNull();
    expect(fileNameFromUrl("https://arxiv.org/pdf/2301.00001")).toBe("2301.00001.pdf");
    expect(fileNameFromUrl("https://openreview.net/pdf?id=abc")).toBe("pdf.pdf");
    expect(fileNameFromUrl("https://x.org/files/My%20Paper.pdf")).toBe("My Paper.pdf");
  });
});

const run = hasTestDb && hasTestS3 ? describe : describe.skip;
type Session = { id: string; cookie: string };
const fast = () => new RateLimiter({ intervalMs: 1, burst: 50, concurrency: 10 });
const PDF = makePdf([["A Downloaded Paper About Speech", 16, 720]]);
const LANDING_PDF = makePdf([["Landing Page Paper", 16, 720]]);
const ARXIV_PDF = makePdf([["An arXiv Preprint", 16, 720]]);

run("add a paper PDF by URL", () => {
  let ctx: TestContext;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let study: { id: string; slug: string };
  let paperId = "";
  let srv: Awaited<ReturnType<typeof mockServer>>;
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session, url: string, payload: object) => ctx.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
  const attach = (who: Session, url: string) => send(who, `/api/library/papers/${paperId}/pdf-from-url`, { url });

  beforeAll(async () => {
    srv = await mockServer((req, res) => {
      const p = req.url.pathname;
      if (p === "/files/ok.pdf") return sendText(res, PDF, "application/pdf");
      if (p === "/files/page.html") return sendText(res, "<html><body>Sign in</body></html>", "text/html; charset=utf-8");
      if (p === "/files/landing.html") return sendText(res, `<html><head><meta name="citation_pdf_url" content="/files/landing.pdf"></head></html>`, "text/html");
      if (p === "/files/landing.pdf") return sendText(res, LANDING_PDF, "application/pdf");
      if (p === "/files/fake.pdf") return sendText(res, "<html>nope</html>", "application/pdf");
      if (p === "/files/big.pdf") {
        res.writeHead(200, { "content-type": "application/pdf", "content-length": String(60 * 1024 * 1024) });
        res.write(PDF);
        return void setTimeout(() => res.destroy(), 200);
      }
      if (p === "/files/login.pdf") return sendText(res, "forbidden", "text/plain", 403);
      if (p === "/redirect/private") {
        res.writeHead(302, { location: "http://127.0.0.1:1/secret.pdf" });
        return void res.end();
      }
      if (p === "/redirect/metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        return void res.end();
      }
      if (p.startsWith("/arxivpdf/")) return p === "/arxivpdf/2301.00001" ? sendText(res, ARXIV_PDF, "application/pdf") : sendText(res, "nf", "text/plain", 404);
      if (p.startsWith("/unpaywall/")) {
        const doi = decodeURIComponent(p.slice("/unpaywall/".length)).toLowerCase();
        if (doi === "10.1234/oa.5678") return sendJson(res, { doi, is_oa: true, best_oa_location: { url_for_pdf: `${srv.url}/files/ok.pdf` } });
        return sendJson(res, { message: "nf" }, 404);
      }
      sendJson(res, { error: p }, 404);
    });
    const mockHost = new URL(srv.url).host;
    setLibraryServiceFactory((config) => {
      const svc = createLibraryService({
        ...config,
        baseUrls: { crossref: `${srv.url}/crossref`, openalex: `${srv.url}/openalex`, arxiv: `${srv.url}/arxiv`, unpaywall: `${srv.url}/unpaywall`, isca: `${srv.url}/isca`, acl: `${srv.url}/acl`, s2: `${srv.url}/s2` },
        limiters: { crossref: fast(), openalex: fast(), arxiv: fast(), unpaywall: fast(), isca: fast(), acl: fast(), s2: fast(), download: fast() },
        // Only the mock server counts as reachable: other private addresses stay blocked, as in production.
        allowPrivateDownloads: (u) => u.host === mockHost,
      });
      // arxiv.org/pdf/<id> (from the abs rewrite) is served by the mock server.
      return { ...svc, downloadPdf: (url, o) => svc.downloadPdf(url.replace(/^https:\/\/arxiv\.org\/pdf\//, `${srv.url}/arxivpdf/`), o) };
    });
    ctx = await createTestContext();
    owner = await userSession(ctx.db, "student", "Url Owner");
    member = await userSession(ctx.db, "student", "Url Member");
    outsider = await userSession(ctx.db, "student", "Url Outsider");
    study = await insertStudy(ctx.db, owner.id, "URL study");
    await addStudyMember(ctx.db, study.id, member.id);
    await ctx.db.query(`INSERT INTO system_settings(key,value) VALUES('library.contact_email','"speech-ai-hub@example.org"'),('library.unpaywall_email','"speech-ai-hub@example.org"')`);
    const add = await send(owner, "/api/library/papers", { record: { type: "paper-conference", title: "QA Paper For URL Downloads", authors: [{ family: "Lin", given: "Ya" }], year: 2024 }, study: study.slug, onDuplicate: "add" });
    expect(add.statusCode).toBe(201);
    paperId = json(add).paper.id;
  });
  afterAll(async () => {
    setLibraryServiceFactory(undefined);
    await srv?.close();
    await ctx?.close();
  });

  it("downloads a PDF link and stores it with source url (study editors only)", async () => {
    expect((await attach(outsider, `${srv.url}/files/ok.pdf`)).statusCode).toBe(403);
    const r = await attach(member, `${srv.url}/files/ok.pdf`);
    expect(r.statusCode).toBe(201);
    expect(json(r).paper.has_pdf).toBe(true);
    expect(json(r).download).toMatchObject({ url: `${srv.url}/files/ok.pdf`, bytes: PDF.length, kind: "direct" });
    const file = (await ctx.db.query("SELECT source,source_url,file_name,added_by FROM paper_files WHERE paper_id=$1", [paperId])).rows[0];
    expect(file).toMatchObject({ source: "url", source_url: `${srv.url}/files/ok.pdf`, file_name: "ok.pdf", added_by: member.id });
  });

  it("rewrites an arXiv abs page and follows citation_pdf_url on landing pages", async () => {
    const r = await attach(owner, "https://arxiv.org/abs/2301.00001");
    expect(r.statusCode).toBe(201);
    expect(json(r).download.kind).toBe("arxiv");
    const l = await attach(owner, `${srv.url}/files/landing.html`);
    expect(l.statusCode).toBe(201);
    expect(json(l).download.url).toBe(`${srv.url}/files/landing.pdf`);
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM paper_files WHERE paper_id=$1", [paperId])).rows[0].n).toBe(3);
  });

  it("resolves a DOI through the open-access lookup", async () => {
    const r = await attach(owner, "https://doi.org/10.1234/oa.5678");
    expect(r.statusCode).toBe(201); // same bytes as ok.pdf → deduped by sha256
    const nf = await attach(owner, "10.9999/closed");
    expect(nf.statusCode).toBe(404);
    expect(json(nf)).toMatchObject({ code: "no_open_access" });
  });

  it("explains non-PDF, too large, login, unreachable and invalid URLs in 繁中", async () => {
    const html = await attach(member, `${srv.url}/files/page.html`);
    expect(html.statusCode).toBe(415);
    expect(json(html)).toMatchObject({ code: "not_pdf" });
    expect(json(html).error).toContain("不是 PDF");
    expect(json(await attach(member, `${srv.url}/files/fake.pdf`))).toMatchObject({ code: "not_pdf" });
    const big = await attach(member, `${srv.url}/files/big.pdf`);
    expect(big.statusCode).toBe(413);
    expect(json(big).error).toContain("太大");
    const login = await attach(member, `${srv.url}/files/login.pdf`);
    expect(login.statusCode).toBe(422);
    expect(json(login)).toMatchObject({ code: "login_required" });
    expect(json(login).error).toContain("需要登入");
    const gone = await attach(member, "https://does-not-exist.invalid/paper.pdf");
    expect(gone.statusCode).toBe(502);
    expect(json(gone)).toMatchObject({ code: "unreachable" });
    const bad = await attach(member, "ftp://example.org/a.pdf");
    expect(bad.statusCode).toBe(400);
    expect(json(bad)).toMatchObject({ code: "invalid_url" });
    expect((await attach(member, "")).statusCode).toBe(400);
  });

  it("blocks private addresses, also after a redirect", async () => {
    for (const url of ["http://127.0.0.1:1/x.pdf", "http://10.0.0.5/x.pdf", "http://[::1]:8080/x.pdf", "http://localhost:1/x.pdf", `${srv.url}/redirect/private`, `${srv.url}/redirect/metadata`]) {
      const r = await attach(owner, url);
      expect(r.statusCode, url).toBe(400);
      expect(json(r), url).toMatchObject({ code: "blocked_url" });
    }
  });

  it("creates a paper from a PDF URL: preview with dedupe, confirm stores the file", async () => {
    expect((await send(outsider, "/api/library/pdf-from-url", { url: `${srv.url}/files/landing.pdf`, study: study.slug })).statusCode).toBe(403);
    const r = await send(member, "/api/library/pdf-from-url", { url: `${srv.url}/files/landing.pdf`, study: study.slug });
    expect(r.statusCode).toBe(201);
    const batch = json(r).batch;
    expect(batch).toMatchObject({ source: "pdf", format: "pdf-url", file_name: "landing.pdf", status: "preview" });
    expect(batch.items).toHaveLength(1);
    const c = await send(member, `/api/library/imports/${batch.id}/confirm`, { decisions: [{ index: 0, action: "add", record: { ...batch.items[0].record, title: "Landing Page Paper" } }] });
    expect(c.statusCode).toBe(200);
    const created = json(c).result.papers[0].paperId;
    const file = (await ctx.db.query("SELECT source,source_url FROM paper_files WHERE paper_id=$1", [created])).rows[0];
    expect(file).toMatchObject({ source: "url", source_url: `${srv.url}/files/landing.pdf` });
    const bad = await send(member, "/api/library/pdf-from-url", { url: `${srv.url}/files/page.html` });
    expect(bad.statusCode).toBe(415);
  });
});
