/** Library tools (lib/library/store.ts, createLibraryService via libraryService). Paper text is always untrusted. */
import { z } from "zod";
import { badRequest, conflict, HttpError, isUniqueViolation, notFound } from "../../lib/http.js";
import { SourceError } from "../../lib/library/http.js";
import { authorDisplayName } from "../../lib/library/normalize.js";
import { DEFAULT_SEARCH_SOURCES, parseIdentifier } from "../../lib/library/service.js";
import { autoFetchPdf, autoPdfText, type AutoPdfOutcome } from "../../lib/library/auto-pdf.js";
import { libraryService } from "../../lib/library/settings.js";
import { addPaperToStudy, findPaperMatches, getPaper, insertPaper, likeEscape, mergeIntoPaper, type PaperRow } from "../../lib/library/store.js";
import type { PaperRecord } from "../../lib/library/types.js";
import { studyUrl } from "../../lib/studies/access.js";
import { recordActivity } from "../../lib/studies/activity.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, editStudy, isUuid, readStudy, scrub, studyRef, studyTarget, uuidArg, withEditableStudy } from "./util.js";

const PAPER_MISSING = "文獻不存在。";

const authorsOf = (r: PaperRecord | undefined) => (r?.authors ?? []).slice(0, 6).map(authorDisplayName).filter(Boolean).join(", ") + ((r?.authors?.length ?? 0) > 6 ? " et al." : "");
const compactPaper = (p: PaperRow) => ({ id: p.id, title: scrub(p.title), authors: authorsOf(p.record), year: p.year, venue: p.venue, doi: p.doi, arxiv_id: p.arxiv_id, has_pdf: !!p.pdf_key });

/** Per-user throttle for agent-initiated online lookups (shares the spirit of /library/search: 20/min). */
const hits = new Map<string, number[]>();
export function throttle(userId: string) {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 20) throw new HttpError(429, "搜尋太頻繁，請稍等一分鐘再試。");
  list.push(now);
  hits.set(userId, list);
}
const sourceError = (e: unknown) => (e instanceof SourceError ? new HttpError(502, e.message || "外部文獻服務暫時無法使用。") : e);

/** Outbound query hygiene: no URLs, no long opaque tokens, ≤ 300 chars. */
export function cleanOutboundQuery(q: string) {
  return q
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

registerAgentTool({
  name: "list_papers",
  title: "列出文獻",
  titleEn: "List papers",
  risk: "read",
  description: "List papers. With `study`: the study's reading list (cite key, reading status, tags). Without: search the lab-wide library by title/author substring `q`.",
  input: z.object({ study: studyRef.optional(), q: z.string().max(200).optional(), status: z.enum(["unread", "reading", "read"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
  summarize: (a) => (a.study ? `列出研究 ${a.study} 的文獻` : `在文獻庫搜尋「${a.q ?? ""}」`),
  async execute(a, ctx) {
    const limit = a.limit ?? 20;
    const q = a.q?.trim() ? `%${likeEscape(a.q.trim())}%` : null;
    if (a.study) {
      const access = await readStudy(ctx, a.study);
      const rows = (await ctx.db.query<PaperRow & { cite_key: string; reading_status: string; tags: string[] }>(
        `SELECT p.*, sp.cite_key, sp.reading_status, sp.tags FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
          WHERE sp.study_id=$1 AND ($2::text IS NULL OR sp.reading_status=$2) AND ($3::text IS NULL OR p.title ILIKE $3 OR p.authors_text ILIKE $3)
          ORDER BY sp.created_at DESC LIMIT $4`,
        [access.study.id, a.status ?? null, q, limit],
      )).rows;
      return { data: { study: { id: access.study.id, slug: access.study.slug, title: access.study.title }, papers: rows.map((p) => ({ ...compactPaper(p), cite_key: p.cite_key, reading_status: p.reading_status, tags: p.tags })) }, untrusted: rows.length > 0, source: "文獻資料" };
    }
    const rows = (await ctx.db.query<PaperRow>(
      `SELECT p.* FROM papers p WHERE ($1::text IS NULL OR p.title ILIKE $1 OR p.authors_text ILIKE $1 OR p.venue ILIKE $1) ORDER BY p.created_at DESC LIMIT $2`,
      [q, limit],
    )).rows;
    return { data: { papers: rows.map(compactPaper) }, untrusted: rows.length > 0, source: "文獻資料" };
  },
});

registerAgentTool({
  name: "get_paper",
  title: "讀取文獻",
  titleEn: "Read paper",
  risk: "read",
  description: "Read a lab paper's metadata and abstract; with `study` also its cite key, reading status and the study's reading notes.",
  input: z.object({ paper_id: uuidArg("Paper"), study: studyRef.optional() }),
  summarize: () => "讀取文獻",
  async execute(a, ctx) {
    if (!isUuid(a.paper_id)) throw notFound(PAPER_MISSING);
    const paper = await getPaper(ctx.db, a.paper_id);
    if (!paper) throw notFound(PAPER_MISSING);
    let inStudy = null;
    if (a.study) {
      const access = await readStudy(ctx, a.study);
      const sp = (await ctx.db.query<{ cite_key: string; reading_status: string; tags: string[]; notes_md: string }>("SELECT cite_key,reading_status,tags,notes_md FROM study_papers WHERE study_id=$1 AND paper_id=$2", [access.study.id, paper.id])).rows[0];
      inStudy = sp ? { study: access.study.title, cite_key: sp.cite_key, reading_status: sp.reading_status, tags: sp.tags, notes_md: clip(scrub(sp.notes_md), 4000) } : { study: access.study.title, in_study: false };
    }
    const studies = (await ctx.db.query<{ slug: string; title: string; cite_key: string }>("SELECT s.slug,s.title,sp.cite_key FROM study_papers sp JOIN studies s ON s.id=sp.study_id WHERE sp.paper_id=$1 LIMIT 20", [paper.id])).rows;
    return {
      data: { paper: { ...compactPaper(paper), abstract: clip(scrub(paper.abstract ?? ""), 6000), url: paper.record.url ?? null }, study: inStudy, used_in: studies },
      untrusted: true,
      source: `文獻〈${clip(paper.title, 40)}〉`,
      links: [{ label: clip(paper.title, 60), url: `/library?paper=${paper.id}`, kind: "paper" }],
    };
  },
});

registerAgentTool({
  name: "search_papers_online",
  title: "線上搜尋論文",
  titleEn: "Search papers online",
  risk: "read",
  openWorld: true,
  description: "Search scholarly APIs (OpenAlex, Semantic Scholar, arXiv, Crossref) for papers. The query leaves the hub: keep it to topic keywords; never include private content. Results show whether a paper is already in the lab library.",
  input: z.object({ query: z.string().trim().min(2).max(300), limit: z.number().int().min(1).max(10).optional(), year_from: z.number().int().min(1900).max(2100).optional(), year_to: z.number().int().min(1900).max(2100).optional() }),
  summarize: (a) => `線上搜尋論文「${cleanOutboundQuery(a.query)}」`,
  async execute(a, ctx) {
    const query = cleanOutboundQuery(a.query);
    if (query.length < 2) throw badRequest("搜尋關鍵字太短。");
    throttle(ctx.user.id);
    const { service } = await libraryService(ctx.db);
    const result = await service.searchPapers(query, { sources: DEFAULT_SEARCH_SOURCES, limit: a.limit ?? 5, yearFrom: a.year_from, yearTo: a.year_to, signal: ctx.signal }).catch((e) => {
      throw sourceError(e);
    });
    const hitsOut = [];
    for (const h of result.hits.slice(0, a.limit ?? 5)) {
      const m = (await findPaperMatches(ctx.db, h.record, 1))[0];
      hitsOut.push({
        title: scrub(h.record.title), authors: authorsOf(h.record), year: h.record.year ?? null, venue: h.record.venue ?? h.record.containerTitle ?? null,
        doi: h.record.doi ?? null, arxiv_id: h.record.arxivId ?? null, abstract: clip(scrub(h.record.abstract ?? ""), 600),
        in_library: m && (m.level === "same" || m.level === "likely") ? m.paper.id : null,
        open_access: !!(h.record.oaPdfUrl || h.record.arxivId),
      });
    }
    return { data: { query, hits: hitsOut, errors: result.errors, skipped: result.skipped }, untrusted: true, source: "線上搜尋結果" };
  },
});

async function linkIntoStudy(ctx: AgentToolContext, client: import("pg").PoolClient, access: Awaited<ReturnType<typeof editStudy>>, paper: PaperRow) {
  await client.query("SELECT id FROM studies WHERE id=$1 FOR UPDATE", [access.study.id]);
  const r = await addPaperToStudy(client, { studyId: access.study.id, paper, userId: ctx.user.id });
  if (r.inserted) {
    await recordActivity(client, { studyId: access.study.id, actorId: ctx.user.id, kind: "paper_added", title: paper.title, url: studyUrl(access.study.slug, "papers"), targetType: "paper", targetId: paper.id });
  }
  return r;
}

/**
 * Imports a paper by identifier into the lab library (an existing lab copy is reused) and links it to the study, then
 * fetches its open-access PDF (identifiers only leave the hub). Used by `import_paper` and the topic-research workflow
 * (after the user approved the plan that lists the imports). Edit access is re-checked inside the transaction.
 */
export async function importIntoStudy(ctx: AgentToolContext, studyId: string, identifier: string, pdfOpts: { budgetMs?: number; queueOnFailure?: boolean } = {}) {
  if (!parseIdentifier(identifier)) throw badRequest("看不懂這個識別碼，請提供 DOI、arXiv 編號或論文網址。");
  throttle(ctx.user.id);
  const { service } = await libraryService(ctx.db);
  const resolved = await service.resolveIdentifier(identifier).catch((e) => {
    throw sourceError(e);
  });
  if (!resolved) throw notFound("找不到這個識別碼對應的文獻。");
  const record = resolved.record;
  const out = await withEditableStudy(ctx, studyId, async (client, locked) => {
    const matches = await findPaperMatches(client, record, 3);
    const best = matches.find((m) => m.level === "same") ?? matches.find((m) => m.level === "likely");
    let paper: PaperRow;
    let created = false;
    if (best) paper = best.level === "same" ? await mergeIntoPaper(client, (await getPaper(client, best.paper.id, true))!, record, ctx.user.id) : best.paper;
    else {
      try {
        await client.query("SAVEPOINT agent_add_paper");
        paper = await insertPaper(client, record, ctx.user.id);
        created = true;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await client.query("ROLLBACK TO SAVEPOINT agent_add_paper");
        throw conflict("文獻庫已有相同識別碼的文獻。");
      }
    }
    const r = await linkIntoStudy(ctx, client, locked, paper);
    return { paper, created, ...r };
  });
  // Full text right away when it is open access (≤ ~20 s, else a background job): the assistant should read the paper.
  const pdf = await autoFetchPdf(ctx.db, ctx.app.storage, out.paper, ctx.user.id, { signal: ctx.signal, ...pdfOpts }).catch((e): AutoPdfOutcome => {
    ctx.app.log.warn({ err: e, paperId: out.paper.id }, "auto pdf fetch failed");
    return { status: "failed" };
  });
  return { ...out, pdf, hasPdf: pdf.status === "stored" || pdf.status === "exists" };
}

/** Links a paper already in the lab library to the study (the topic-research workflow's in-library candidates). */
export async function linkPaperToStudy(ctx: AgentToolContext, studyId: string, paperId: string) {
  if (!isUuid(paperId)) throw notFound(PAPER_MISSING);
  return withEditableStudy(ctx, studyId, async (client, access) => {
    const paper = await getPaper(client, paperId);
    if (!paper) throw notFound(PAPER_MISSING);
    return { paper, ...(await linkIntoStudy(ctx, client, access, paper)) };
  });
}

registerAgentTool({
  name: "import_paper",
  title: "匯入論文",
  titleEn: "Import paper",
  risk: "write",
  openWorld: true,
  description: "Import a paper by identifier (DOI, arXiv id, ACL Anthology / OpenAlex / Semantic Scholar URL) into the lab library and add it to a study's reading list. An existing lab copy is reused (no duplicates). The open-access PDF is fetched automatically when available (result `pdf.status`: stored / exists / queued (background) / not_found / failed).",
  input: z.object({ study: studyRef, identifier: z.string().trim().min(3).max(300) }),
  summarize: (a) => `匯入論文 ${a.identifier}`,
  target: async (a, ctx) => ({ ...studyTarget(await editStudy(ctx, a.study)), url: undefined }),
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    const { pdf, hasPdf, ...out } = await importIntoStudy(ctx, access.study.id, a.identifier);
    return {
      data: {
        paper: { ...compactPaper(out.paper), has_pdf: hasPdf },
        created_in_library: out.created, added_to_study: out.inserted, cite_key: out.citeKey,
        pdf: { status: pdf.status, ...(pdf.source ? { source: pdf.source } : {}), message: autoPdfText(pdf) },
        next: hasPdf ? "Use read_paper with this paper_id to read the full text before explaining it." : undefined,
      },
      untrusted: true,
      links: [{ label: clip(out.paper.title, 60), url: studyUrl(access.study.slug, "papers"), kind: "paper" }],
    };
  },
});

registerAgentTool({
  name: "add_paper_to_study",
  title: "加入研究文獻庫",
  titleEn: "Add paper to study",
  risk: "write",
  description: "Add a paper that is already in the lab library (paper_id from list_papers / search_papers_online in_library) to a study's reading list.",
  input: z.object({ study: studyRef, paper_id: uuidArg("Paper") }),
  summarize: () => "把文獻加入研究文獻庫",
  target: async (a, ctx) => ({ ...studyTarget(await editStudy(ctx, a.study)), url: undefined }),
  async execute(a, ctx) {
    if (!isUuid(a.paper_id)) throw notFound(PAPER_MISSING);
    const out = await withEditableStudy(ctx, a.study, async (client, access) => {
      const paper = await getPaper(client, a.paper_id);
      if (!paper) throw notFound(PAPER_MISSING);
      return { paper, slug: access.study.slug, ...(await linkIntoStudy(ctx, client, access, paper)) };
    });
    return { data: { paper: compactPaper(out.paper), added: out.inserted, cite_key: out.citeKey }, links: [{ label: clip(out.paper.title, 60), url: studyUrl(out.slug, "papers"), kind: "paper" }] };
  },
});

registerAgentTool({
  name: "remove_paper_from_study",
  title: "從研究移除文獻",
  titleEn: "Remove paper from study",
  risk: "destructive",
  description: "Remove a paper from a study's reading list (the lab library copy stays; the study's reading notes for it are lost). Always asks the user.",
  input: z.object({ study: studyRef, paper_id: uuidArg("Paper") }),
  summarize: () => "從研究文獻庫移除文獻",
  async target(a, ctx) {
    const access = await editStudy(ctx, a.study);
    const row = isUuid(a.paper_id) ? (await ctx.db.query<{ title: string }>("SELECT p.title FROM study_papers sp JOIN papers p ON p.id=sp.paper_id WHERE sp.study_id=$1 AND sp.paper_id=$2", [access.study.id, a.paper_id])).rows[0] : undefined;
    if (!row) throw notFound("這篇文獻不在此研究的文獻庫中。");
    return { ...studyTarget(access), label: `${access.study.title} · ${clip(row.title, 60)}`, url: studyUrl(access.study.slug, "papers") };
  },
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    if (!isUuid(a.paper_id)) throw notFound(PAPER_MISSING);
    const r = await ctx.db.query("DELETE FROM study_papers WHERE study_id=$1 AND paper_id=$2", [access.study.id, a.paper_id]);
    if (!r.rowCount) throw notFound("這篇文獻不在此研究的文獻庫中。");
    return { data: { removed: true } };
  },
});

