import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createTestContext, hasTestDb, hasTestS3, ORIGIN, type TestContext } from "./helpers.js";
import { multipart, userSession } from "./slides-fixtures.js";
import { addStudyMember, insertStudy } from "./study-fixtures.js";
import { fixture, makePdf, mockServer, sendJson, sendText } from "./library-fixtures/helpers.js";
import { MockServer, sse } from "./ai-providers-mock.js";
import { createLibraryService, RateLimiter } from "../src/lib/library/index.js";
import { setLibraryServiceFactory } from "../src/lib/library/settings.js";
import { exportStudyBibtex } from "../src/lib/library/study-export.js";
import { aiJobHandler } from "../src/ai-worker/registry.js";
import "../src/ai-jobs/library/import-job.js";
import { LIBRARY_IMPORT_JOB } from "../src/ai-jobs/library/kinds.js";

process.env.PROVIDER_TOKEN_KEY ??= randomBytes(32).toString("base64");

const run = hasTestDb && hasTestS3 ? describe : describe.skip;
type Session = { id: string; cookie: string };
const fast = () => new RateLimiter({ intervalMs: 1, burst: 50, concurrency: 10 });
const PDF_WITH_DOI = makePdf([], {
  pages: [
    [["A Paper Uploaded As PDF For Testing", 16, 720], ["Some Author", 11, 690]],
    [["See doi:10.21437/Interspeech.2020-3015 for the final version.", 10, 700]],
  ],
});
const OA_PDF = makePdf([["Open Access Fulltext", 16, 720]]);

run("library routes", () => {
  let ctx: TestContext;
  let owner: Session; // study owner (student)
  let member: Session;
  let outsider: Session; // student, not in the study
  let professor: Session; // advisor
  let admin: Session;
  let study: { id: string; slug: string };
  let other: { id: string; slug: string };
  let srv: Awaited<ReturnType<typeof mockServer>>;
  const llm = new MockServer();
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const send = (who: Session | null, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: { origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (who: Session | null, url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers: { ...(who ? { cookie: who.cookie } : {}), ...headers } });
  const upload = (who: Session, url: string, fields: Record<string, string>, file: { filename: string; data: Buffer; type?: string }) => {
    const body = multipart(fields, file);
    return ctx.app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: who.cookie, ...body.headers }, payload: body.payload });
  };

  beforeAll(async () => {
    srv = await mockServer((req, res) => {
      const p = req.url.pathname;
      if (p.startsWith("/crossref/works/")) {
        const doi = decodeURIComponent(p.slice("/crossref/works/".length)).toLowerCase();
        return doi === "10.21437/interspeech.2020-3015" ? sendJson(res, fixture("crossref-work.json")) : sendText(res, "Resource not found.", "text/plain", 404);
      }
      if (p === "/crossref/works") {
        if (req.url.searchParams.get("query")) return sendJson(res, fixture("crossref-search.json"));
        return sendJson(res, { status: "ok", message: { items: [] } });
      }
      if (p.startsWith("/arxiv")) return sendText(res, fixture("arxiv-search.atom"), "application/atom+xml");
      if (p.startsWith("/unpaywall/")) {
        const doi = decodeURIComponent(p.slice("/unpaywall/".length)).toLowerCase();
        if (doi === "10.1234/oa.5678") return sendJson(res, { doi, is_oa: true, best_oa_location: { url_for_pdf: `${srv.url}/files/oa.pdf`, license: "cc-by" } });
        return sendJson(res, { message: "nf" }, 404);
      }
      if (p === "/files/oa.pdf") return sendText(res, OA_PDF, "application/pdf");
      sendJson(res, { error: p }, 404);
    });
    setLibraryServiceFactory((config) =>
      createLibraryService({
        ...config,
        baseUrls: { crossref: `${srv.url}/crossref`, openalex: `${srv.url}/openalex`, arxiv: `${srv.url}/arxiv`, unpaywall: `${srv.url}/unpaywall`, isca: `${srv.url}/isca`, acl: `${srv.url}/acl`, s2: `${srv.url}/s2` },
        limiters: { crossref: fast(), openalex: fast(), arxiv: fast(), unpaywall: fast(), isca: fast(), acl: fast(), s2: fast(), download: fast() },
        allowPrivateDownloads: true,
      }),
    );
    await llm.start();
    llm.on("POST", "/v1/chat/completions", (req) => ({
      chunks: sse([
        { choices: [{ index: 0, delta: { role: "assistant", content: req.json.messages[1].content.includes("<study>") ? "高度相關。\n### 可以借用的地方\n- 架構" : "```markdown\n### 研究問題\n- 語音辨識\n```" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]),
    }));
    ctx = await createTestContext();
    owner = await userSession(ctx.db, "student", "Lib Owner");
    member = await userSession(ctx.db, "student", "Lib Member");
    outsider = await userSession(ctx.db, "student", "Lib Outsider");
    professor = await userSession(ctx.db, "professor", "Lib Prof");
    admin = await userSession(ctx.db, "admin", "Lib Admin");
    study = await insertStudy(ctx.db, owner.id, "ASR study");
    other = await insertStudy(ctx.db, outsider.id, "Other study");
    await addStudyMember(ctx.db, study.id, member.id);
    await addStudyMember(ctx.db, study.id, professor.id, "advisor");
    await ctx.db.query("INSERT INTO system_settings(key,value) VALUES('library.contact_email', '\"speech-ai-hub@example.org\"')");
    await ctx.db.query("UPDATE studies SET summary_md='以自監督模型改善台語語音辨識。' WHERE id=$1", [study.id]);
  });
  afterAll(async () => {
    setLibraryServiceFactory(undefined);
    await srv?.close();
    await llm.stop();
    await ctx?.close();
  });

  let batchId = "";
  const papers: Record<string, string> = {};

  it("previews a BibTeX import and confirms it", async () => {
    const r = await upload(owner, `/api/studies/${study.slug}/imports`, {}, { filename: "lab.bib", data: Buffer.from(fixture("sample.bib")), type: "application/x-bibtex" });
    expect(r.statusCode).toBe(201);
    const batch = json(r).batch;
    expect(batch.format).toBe("bibtex");
    expect(batch.status).toBe("preview");
    expect(batch.items.length).toBeGreaterThanOrEqual(5);
    expect(batch.warnings.length).toBeGreaterThan(0); // the broken entry
    expect(batch.items.every((i: any) => i.action === "add" && !i.match)).toBe(true);
    expect(batch.items.find((i: any) => i.record.title.startsWith("Conformer")).citeKey).toBe("gulati20_interspeech");
    // Nothing written yet.
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM papers")).rows[0].n).toBe(0);
    // Members only.
    expect((await upload(outsider, `/api/studies/${study.slug}/imports`, {}, { filename: "lab.bib", data: Buffer.from("@misc{a,title={x}}") })).statusCode).toBe(403);
    expect((await upload(professor, `/api/studies/${study.slug}/imports`, {}, { filename: "lab.bib", data: Buffer.from("@misc{a,title={x}}") })).statusCode).toBe(403);
    // Another user cannot confirm someone else's preview.
    expect((await send(member, "POST", `/api/library/imports/${batch.id}/confirm`, {})).statusCode).toBe(404);
    const skipIndex = batch.items.find((i: any) => i.record.title.includes("wav2vec")).index;
    const c = await send(owner, "POST", `/api/library/imports/${batch.id}/confirm`, { decisions: [{ index: skipIndex, action: "skip" }] });
    expect(c.statusCode).toBe(200);
    expect(json(c).result).toMatchObject({ added: batch.items.length - 1, linked: 0, skipped: 1 });
    expect(json(c).batch.status).toBe("done");
    expect((await send(owner, "POST", `/api/library/imports/${batch.id}/confirm`, {})).statusCode).toBe(409);
    batchId = batch.id;
    const list = json(await get(outsider, `/api/studies/${study.slug}/papers`));
    expect(list.papers).toHaveLength(batch.items.length - 1);
    expect(list.counts.unread).toBe(batch.items.length - 1);
    expect(list.permissions.edit).toBe(false);
    for (const sp of list.papers) papers[sp.cite_key] = sp.paper.id;
    expect(papers.gulati20_interspeech).toBeTruthy();
    const activity = (await ctx.db.query("SELECT kind,title FROM study_activity WHERE study_id=$1", [study.id])).rows;
    expect(activity).toContainEqual(expect.objectContaining({ kind: "papers_imported" }));
  });

  it("detects duplicates when importing EndNote XML", async () => {
    const r = await send(owner, "POST", `/api/studies/${study.slug}/imports`, { text: fixture("endnote.xml"), filename: "lab.xml" });
    expect(r.statusCode).toBe(201);
    const batch = json(r).batch;
    expect(batch.format).toBe("endnote-xml");
    const conformer = batch.items.find((i: any) => i.record.title.startsWith("Conformer"));
    expect(conformer.match).toMatchObject({ level: "same", reason: "doi" });
    expect(conformer.match.paper.id).toBe(papers.gulati20_interspeech);
    expect(conformer.inStudy).toBe(true);
    expect(conformer.action).toBe("skip");
    expect(batch.summary.inStudy).toBe(1);
    // Into another study: same paper is linked, not duplicated.
    const r2 = json(await send(outsider, "POST", `/api/studies/${other.slug}/imports`, { text: fixture("endnote.xml"), filename: "lab.xml" })).batch;
    const c2 = r2.items.find((i: any) => i.record.title.startsWith("Conformer"));
    expect(c2.action).toBe("link");
    const done = json(await send(outsider, "POST", `/api/library/imports/${r2.id}/confirm`, {}));
    expect(done.result.linked).toBe(1);
    expect(done.result.added).toBe(r2.items.length - 1);
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM papers WHERE doi_key='10.21437/interspeech.2020-3015'")).rows[0].n).toBe(1);
    // Cancel the first preview.
    expect((await send(owner, "DELETE", `/api/library/imports/${batch.id}`)).statusCode).toBe(200);
  });

  it("rejects .enl files and empty imports with zh messages", async () => {
    const r = await upload(owner, `/api/studies/${study.slug}/imports`, {}, { filename: "lab.enl", data: Buffer.from("SQLite format 3") });
    expect(r.statusCode).toBe(400);
    expect(json(r).error).toContain("EndNote");
    const e = await send(owner, "POST", `/api/studies/${study.slug}/imports`, { text: "% nothing\n", format: "bibtex" });
    expect([400, 422]).toContain(e.statusCode);
  });

  it("keeps cite keys unique per study (case-insensitive) and edits reading data", async () => {
    const id = papers.baevski2020wav2vec ?? Object.values(papers)[1]!;
    const target = Object.entries(papers).find(([k]) => k !== "gulati20_interspeech")!;
    const dup = await send(member, "PATCH", `/api/studies/${study.slug}/papers/${target[1]}`, { cite_key: "GULATI20_INTERSPEECH" });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error).toBe("這個引用鍵在此研究已被使用。");
    expect((await send(member, "PATCH", `/api/studies/${study.slug}/papers/${target[1]}`, { cite_key: "bad key!" })).statusCode).toBe(400);
    const ok = await send(member, "PATCH", `/api/studies/${study.slug}/papers/${target[1]}`, { cite_key: "renamed2024", reading_status: "reading", tags: ["ASR", "asr", "baseline"], notes_md: "## 筆記\n重點" });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).studyPaper).toMatchObject({ cite_key: "renamed2024", reading_status: "reading", tags: ["ASR", "baseline"], notes_md: "## 筆記\n重點", notes_updated_by: "Lib Member" });
    expect((await send(professor, "PATCH", `/api/studies/${study.slug}/papers/${target[1]}`, { reading_status: "read" })).statusCode).toBe(403);
    const filtered = json(await get(owner, `/api/studies/${study.slug}/papers?status=reading&tag=asr`));
    expect(filtered.papers).toHaveLength(1);
    expect(filtered.tags).toContainEqual({ tag: "ASR", count: 1 });
    void id;
  });

  it("exports the study library (BibTeX, RIS, CSL-JSON) and exportStudyBibtex", async () => {
    const bib = await get(professor, `/api/studies/${study.slug}/papers/export?format=bibtex`);
    expect(bib.statusCode).toBe(200);
    expect(bib.headers["content-type"]).toContain("application/x-bibtex");
    expect(bib.headers["content-disposition"]).toContain(".bib");
    expect(bib.body).toContain("@inproceedings{gulati20_interspeech,");
    expect(bib.body).toContain("renamed2024");
    expect(bib.body).toContain("王小明");
    const ris = await get(owner, `/api/studies/${study.slug}/papers/export?format=ris`);
    expect(ris.body).toMatch(/^TY {2}- /m);
    expect(ris.body).toContain("ID  - gulati20_interspeech");
    const csl = JSON.parse((await get(owner, `/api/studies/${study.slug}/papers/export?format=csl-json`)).body);
    expect(csl.map((i: any) => i.id)).toContain("gulati20_interspeech");
    const helper = await exportStudyBibtex(ctx.db, study.id);
    expect(helper.count).toBe(csl.length);
    expect(helper.keys).toContain("renamed2024");
    expect(helper.bibtex).toBe(bib.body);
    expect((await exportStudyBibtex(ctx.db, other.id, { paperIds: [] })).bibtex).toBe("");
  });

  it("lists and searches the lab library", async () => {
    const all = json(await get(professor, "/api/library/papers"));
    expect(all.total).toBeGreaterThanOrEqual(7);
    const conformer = all.papers.find((p: any) => p.id === papers.gulati20_interspeech);
    expect(conformer.studies.map((s: any) => s.slug).sort()).toEqual([study.slug, other.slug].sort());
    expect(json(await get(owner, "/api/library/papers?q=conformer")).papers[0].id).toBe(papers.gulati20_interspeech);
    expect(json(await get(owner, "/api/library/papers?q=gulati")).papers.map((p: any) => p.id)).toContain(papers.gulati20_interspeech);
    expect(json(await get(owner, "/api/library/papers?q=10.21437/interspeech.2020-3015")).papers).toHaveLength(1);
    expect(json(await get(owner, `/api/library/papers?study=${other.slug}&year=2023`)).papers.every((p: any) => p.year === 2023)).toBe(true);
    expect(json(await get(owner, "/api/library/papers?has_pdf=true")).papers).toHaveLength(0);
    expect(all.facets.venues.find((v: any) => v.value === "Interspeech")).toBeTruthy();
    const d = json(await get(outsider, `/api/library/papers/${papers.gulati20_interspeech}`)).paper;
    expect(d.citations.apa).toContain("Gulati");
    expect(d.citations.ieee).toContain("Conformer");
    expect(d.studies).toHaveLength(2);
    expect(d.permissions).toEqual({ edit: true, delete: false }); // editor of `other`
    expect(json(await get(professor, `/api/library/papers/${papers.gulati20_interspeech}`)).paper.permissions.edit).toBe(false);
    expect((await get(null, "/api/library/papers")).statusCode).toBe(401);
  });

  it("scopes the lab library to papers of studies I own (scope=mine), with counts for both", async () => {
    const inStudy = (await ctx.db.query<{ paper_id: string }>("SELECT paper_id FROM study_papers WHERE study_id=$1", [study.id])).rows.map((r) => r.paper_id).sort();
    const inOther = (await ctx.db.query<{ paper_id: string }>("SELECT paper_id FROM study_papers WHERE study_id=$1", [other.id])).rows.map((r) => r.paper_id).sort();
    const all = json(await get(owner, "/api/library/papers?limit=100"));
    const mine = json(await get(owner, "/api/library/papers?scope=mine&limit=100"));
    expect(all.papers.length).toBe(all.counts.all); // default stays the whole library
    expect(mine.papers.map((p: any) => p.id).sort()).toEqual(inStudy);
    expect(mine.total).toBe(inStudy.length);
    expect(mine.counts).toEqual({ mine: inStudy.length, all: all.counts.all });
    // A member (not owner) of `study` owns nothing; the other study's owner sees only its papers.
    expect(json(await get(member, "/api/library/papers?scope=mine")).papers).toHaveLength(0);
    expect(json(await get(outsider, "/api/library/papers?scope=mine&limit=100")).papers.map((p: any) => p.id).sort()).toEqual(inOther);
    // Other filters apply to both counts.
    const searched = json(await get(owner, "/api/library/papers?scope=mine&q=conformer"));
    expect(searched.counts.mine).toBe(searched.total);
    expect(searched.counts.all).toBeGreaterThanOrEqual(searched.counts.mine);
    expect((await get(owner, "/api/library/papers?scope=bogus")).statusCode).toBe(400);
  });

  it("adds by identifier and asks about likely duplicates", async () => {
    const res = await send(member, "POST", "/api/library/resolve", { identifier: "https://doi.org/10.21437/Interspeech.2020-3015" });
    expect(res.statusCode).toBe(200);
    expect(json(res).matches[0]).toMatchObject({ level: "same" });
    expect((await send(member, "POST", "/api/library/resolve", { identifier: "hello world" })).statusCode).toBe(400);
    expect((await send(member, "POST", "/api/library/resolve", { identifier: "10.9999/missing" })).statusCode).toBe(404);
    // Same DOI → existing paper, no new row; added to a study where it already is → not added again.
    const add = await send(member, "POST", "/api/library/papers", { identifier: "10.21437/Interspeech.2020-3015", study: study.slug });
    expect(add.statusCode).toBe(200);
    expect(json(add)).toMatchObject({ created: false, study: { added: false, cite_key: "gulati20_interspeech" } });
    // Manual record with the same title but no DOI → likely duplicate → 409 with candidates.
    const manual = { type: "paper-conference", title: "Conformer: Convolution-Augmented Transformer for Speech Recognition", authors: [{ family: "Gulati", given: "Anmol" }], year: 2020 };
    const dup = await send(member, "POST", "/api/library/papers", { record: manual });
    expect(dup.statusCode).toBe(409);
    expect(json(dup)).toMatchObject({ code: "duplicate" });
    expect(json(dup).duplicates[0].paper.id).toBe(papers.gulati20_interspeech);
    const link = await send(member, "POST", "/api/library/papers", { record: manual, onDuplicate: "link", paperId: papers.gulati20_interspeech });
    expect(json(link).paper.id).toBe(papers.gulati20_interspeech);
    // A brand-new manual paper, into the study with a requested key that is taken → generated unique key.
    const fresh = await send(member, "POST", "/api/library/papers", {
      record: { type: "article-journal", title: "Open Access Test Paper", authors: [{ family: "Lin", given: "Mei" }], year: 2024, doi: "10.1234/OA.5678" },
      study: study.slug,
      citeKey: "renamed2024",
    });
    expect(fresh.statusCode).toBe(201);
    expect(json(fresh).study.cite_key).toBe("renamed2024a");
    papers.oa = json(fresh).paper.id;
    expect((await send(professor, "POST", "/api/library/papers", { record: { title: "x" }, study: study.slug })).statusCode).toBe(403);
    // Adding an existing paper directly.
    const sp = await send(outsider, "POST", `/api/studies/${other.slug}/papers`, { paperId: papers.oa });
    expect(sp.statusCode).toBe(201);
    expect(json(sp).cite_key).toBe("lin2024open");
    expect((await send(outsider, "POST", `/api/studies/${other.slug}/papers`, { paperId: papers.oa })).statusCode).toBe(409);
  });

  it("edits paper metadata with permission checks", async () => {
    const d = json(await get(member, `/api/library/papers/${papers.oa}`)).paper;
    const r = await send(member, "PATCH", `/api/library/papers/${papers.oa}`, { record: { ...d.record, title: "Open Access Test Paper (revised)" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).paper.title).toBe("Open Access Test Paper (revised)");
    expect((await send(professor, "PATCH", `/api/library/papers/${papers.oa}`, { record: d.record })).statusCode).toBe(403);
    expect((await send(member, "PATCH", `/api/library/papers/${papers.oa}`, { record: { ...d.record, doi: "10.21437/Interspeech.2020-3015" } })).statusCode).toBe(409);
  });

  it("uploads, streams with Range, fetches open-access PDFs and runs the import job", async () => {
    const up = await upload(member, `/api/library/papers/${papers.gulati20_interspeech}/pdf`, {}, { filename: "conformer.pdf", data: PDF_WITH_DOI, type: "application/pdf" });
    expect(up.statusCode).toBe(201);
    expect(json(up).paper.has_pdf).toBe(true);
    expect((await upload(professor, `/api/library/papers/${papers.gulati20_interspeech}/pdf`, {}, { filename: "x.pdf", data: PDF_WITH_DOI })).statusCode).toBe(403);
    expect((await upload(member, `/api/library/papers/${papers.gulati20_interspeech}/pdf`, {}, { filename: "x.pdf", data: Buffer.from("not a pdf") })).statusCode).toBe(415);
    const full = await get(professor, `/api/library/papers/${papers.gulati20_interspeech}/pdf`);
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("application/pdf");
    expect(full.headers["content-disposition"]).toMatch(/^inline/);
    const part = await get(professor, `/api/library/papers/${papers.gulati20_interspeech}/pdf`, { range: "bytes=0-4" });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("%PDF-");
    expect((await get(professor, `/api/library/papers/${papers.oa}/pdf`)).statusCode).toBe(404);

    const f = await send(member, "POST", `/api/library/papers/${papers.oa}/fetch-pdf`);
    expect(f.statusCode).toBe(200);
    expect(json(f).outcome).toMatchObject({ status: "stored", source: "unpaywall" });
    expect(json(f).paper.has_pdf).toBe(true);
    expect(json(f).paper.oa_url).toContain("/files/oa.pdf");
    const nf = await send(member, "POST", `/api/library/papers/${papers.renamed2024 ?? papers.wang2023thesis}/fetch-pdf`);
    expect(nf.statusCode).toBe(404);
    expect(json(nf).code).toBe("no_open_access");

    // Job handler: one paper with an OA PDF (reset), one without.
    await ctx.db.query("UPDATE papers SET pdf_key=NULL WHERE id=$1", [papers.oa]);
    await ctx.db.query("DELETE FROM paper_files WHERE paper_id=$1", [papers.oa]);
    const handler = aiJobHandler(LIBRARY_IMPORT_JOB)!;
    const result = await handler.run({
      job: { id: "00000000-0000-0000-0000-000000000000", kind: LIBRARY_IMPORT_JOB, payload: { batchId, paperIds: [papers.oa, papers.wang2023thesis ?? papers.gulati20_interspeech], userId: member.id }, attempts: 1, maxAttempts: 3, createdBy: member.id },
      db: ctx.db, storage: ctx.storage, ai: undefined as never, log: ctx.app.log, signal: new AbortController().signal,
      progress: async () => {}, checkpoint: null, saveCheckpoint: async () => {},
    });
    expect(result).toMatchObject({ stored: 1, total: 2 });
  });

  it("imports a PDF: extracts metadata, dedupes, stores the file on confirm", async () => {
    const r = await upload(owner, "/api/library/pdf", { study: study.slug }, { filename: "conformer-final.pdf", data: PDF_WITH_DOI, type: "application/pdf" });
    expect(r.statusCode).toBe(201);
    const { batch, extraction } = json(r);
    expect(extraction.method).toBe("doi");
    expect(batch.items[0].match).toMatchObject({ level: "same" });
    expect(batch.items[0].inStudy).toBe(true);
    // Lab-only PDF import of a new work (no DOI found → title guess).
    const plain = makePdf([["Completely New Work About Tone Modeling", 16, 720], ["Nobody", 10, 690]]);
    const r2 = json(await upload(outsider, "/api/library/pdf", {}, { filename: "new.pdf", data: plain, type: "application/pdf" }));
    expect(r2.batch.items[0].record.title).toBe("Completely New Work About Tone Modeling");
    expect(r2.batch.items[0].action).toBe("add");
    const c = json(await send(outsider, "POST", `/api/library/imports/${r2.batch.id}/confirm`, { decisions: [{ index: 0, action: "add", record: { ...r2.batch.items[0].record, year: 2025 } }] }));
    expect(c.result.added).toBe(1);
    const pid = c.result.papers[0].paperId;
    const d = json(await get(outsider, `/api/library/papers/${pid}`)).paper;
    expect(d).toMatchObject({ has_pdf: true, year: 2025 });
    expect(d.files[0]).toMatchObject({ source: "upload", file_name: "new.pdf" });
    expect(d.permissions).toEqual({ edit: true, delete: true });
    expect((await send(owner, "DELETE", `/api/library/papers/${pid}`)).statusCode).toBe(403);
    expect((await send(outsider, "DELETE", `/api/library/papers/${pid}`)).statusCode).toBe(200);
    expect((await get(outsider, `/api/library/papers/${pid}`)).statusCode).toBe(404);
  });

  it("searches online and marks papers already in the library", async () => {
    const r = await get(member, `/api/library/search?q=conformer&sources=arxiv,crossref&study=${study.slug}`);
    expect(r.statusCode).toBe(200);
    const body = json(r);
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.errors).toEqual([]);
    const known = body.hits.find((h: any) => h.existing);
    expect(known).toBeTruthy();
    expect(known.existing).toMatchObject({ paperId: papers.gulati20_interspeech, inStudy: true });
    const skipped = json(await get(member, "/api/library/search?q=conformer&sources=openalex,s2"));
    expect(skipped.skipped.map((s: any) => s.source).sort()).toEqual(["openalex", "s2"]);
    expect((await get(member, "/api/library/search?q=")).statusCode).toBe(400);
  });

  it("manages external-service settings (admin only, keys masked)", async () => {
    expect((await get(member, "/api/library/settings")).statusCode).toBe(403);
    const put = await send(admin, "PUT", "/api/library/settings", { contact_email: "speech-ai-hub@example.org", openalex_api_key: "oa-secret-key-1234", grobid_url: "http://grobid:8070" });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("oa-secret-key");
    expect(json(put).settings).toMatchObject({ contact_email: "speech-ai-hub@example.org", grobid_url: "http://grobid:8070", openalex_api_key: { set: true, last4: "1234" }, s2_api_key: { set: false } });
    const raw = (await ctx.db.query("SELECT value::text AS v FROM system_settings WHERE key='library.openalex_api_key'")).rows[0].v;
    expect(raw).not.toContain("oa-secret");
    expect((await send(admin, "PUT", "/api/library/settings", { contact_email: "not-an-email" })).statusCode).toBe(400);
    const cleared = json(await send(admin, "PUT", "/api/library/settings", { openalex_api_key: null, grobid_url: "" })).settings;
    expect(cleared).toMatchObject({ openalex_api_key: { set: false }, grobid_url: null, contact_email: "speech-ai-hub@example.org" });
  });

  it("AI summary and relevance go through the analysis role", async () => {
    const before = await send(member, "POST", `/api/library/papers/${papers.gulati20_interspeech}/ai/summary`);
    expect(before.statusCode).toBe(503);
    expect(json(before).code).toBe("llm_unavailable");
    const prov = json(await send(admin, "POST", "/api/admin/ai/providers", { family: "llm", kind: "openai-compatible", name: "mock", config: { baseUrl: `${llm.url}/v1` }, secrets: { apiKey: "sk-x" } })).provider.id;
    const route = json(await send(admin, "POST", "/api/admin/ai/routes", { name: "analysis", capability: "chat", strategy: "single", members: [{ provider_id: prov, model: "glm/glm-5.3-flash" }] })).route.id;
    expect((await send(admin, "PUT", "/api/admin/ai/roles/analysis", { route_id: route })).statusCode).toBe(200);
    const s = await send(member, "POST", `/api/library/papers/${papers.gulati20_interspeech}/ai/summary`);
    expect(s.statusCode).toBe(200);
    expect(json(s)).toMatchObject({ markdown: "### 研究問題\n- 語音辨識", usedPdf: true });
    const sentToModel = llm.last().json.messages[1].content as string;
    expect(sentToModel).toContain("<paper>");
    const rel = await send(member, "POST", `/api/studies/${study.slug}/papers/${papers.gulati20_interspeech}/ai/relevance`);
    expect(rel.statusCode).toBe(200);
    expect(json(rel).markdown).toContain("高度相關");
    expect((await send(professor, "POST", `/api/studies/${study.slug}/papers/${papers.gulati20_interspeech}/ai/relevance`)).statusCode).toBe(403);
  });

  it("removes papers from a study; decks.paper_id is set null when a paper is deleted", async () => {
    const deck = (await ctx.db.query<{ id: string }>(
      "INSERT INTO decks(study_id,kind,paper_id,title,slug,share_key,created_by,updated_by) VALUES($1,'paper_report',$2,'Report','rep-' || substr(md5(random()::text),1,6),md5(random()::text),$3,$3) RETURNING id",
      [other.id, papers.oa, outsider.id],
    )).rows[0]!.id;
    expect((await send(member, "DELETE", `/api/studies/${other.slug}/papers/${papers.oa}`)).statusCode).toBe(403);
    expect((await send(outsider, "DELETE", `/api/studies/${other.slug}/papers/${papers.oa}`)).statusCode).toBe(200);
    expect((await send(member, "DELETE", `/api/library/papers/${papers.oa}`)).statusCode).toBe(409); // still in `study`
    expect((await send(member, "DELETE", `/api/studies/${study.slug}/papers/${papers.oa}`)).statusCode).toBe(200);
    expect((await send(member, "DELETE", `/api/library/papers/${papers.oa}`)).statusCode).toBe(200);
    expect((await ctx.db.query("SELECT paper_id FROM decks WHERE id=$1", [deck])).rows[0].paper_id).toBeNull();
  });
});
