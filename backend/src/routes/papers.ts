import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { requireAdmin, requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { aiFor, toHttpError } from "../ai/platform/index.js";
import { loadStudyAccess, findStudy } from "../lib/studies/access.js";
import { receiveUpload } from "../lib/slides/upload.js";
import { DEFAULT_SEARCH_SOURCES, parseIdentifier, type SearchSource } from "../lib/library/service.js";
import { SourceError } from "../lib/library/http.js";
import { normalizeTitle } from "../lib/library/normalize.js";
import { parseRecordInput, tagsSchema, citeKeySchema } from "../lib/library/schema.js";
import {
  addPaperToStudy, findPaperMatches, getPaper, insertPaper, likeEscape, mergeIntoPaper, summarize, updatePaperRecord,
  libraryKeys, type PaperRow,
} from "../lib/library/store.js";
import { paperDetail, paperPermissions } from "../lib/library/detail.js";
import { fetchOpenAccessPdf, storePaperPdf } from "../lib/library/files.js";
import { attachPdfFromUrl, downloadPdfFromUrl } from "../lib/library/pdf-url.js";
import { autoFetchPdf, type AutoPdfOutcome } from "../lib/library/auto-pdf.js";
import { fulltextKey } from "../lib/library/fulltext.js";
import { libraryService, librarySettingsView, saveLibrarySettings } from "../lib/library/settings.js";
import { NotEnoughText, summarizePaper } from "../lib/library/ai.js";
import { createImportPreview } from "../lib/library/imports.js";
import { recordActivity } from "../lib/studies/activity.js";
import { studyUrl } from "../lib/studies/access.js";
import libraryStudy from "./library-study.js";
import libraryImports, { batchView } from "./library-imports.js";

/**
 * Lab-wide library (`/library/*`): papers shared by the whole lab, PDFs, online search, external-service settings.
 * Registers the study reading lists (library-study.ts) and imports (library-imports.ts) as child plugins.
 * docs/architecture.md "Library".
 */

const idParams = z.object({ id: z.uuid() });
const MISSING = "文獻不存在。";
const PDF_MAX = 50 * 1024 * 1024;

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  venue: z.string().trim().max(120).optional(),
  year: z.coerce.number().int().min(1000).max(3000).optional(),
  yearFrom: z.coerce.number().int().min(1000).max(3000).optional(),
  yearTo: z.coerce.number().int().min(1000).max(3000).optional(),
  study: z.string().trim().min(1).max(80).optional(),
  has_pdf: z.enum(["true", "false", "1", "0"]).optional(),
  sort: z.enum(["recent", "year", "title"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const addInput = z.object({
  identifier: z.string().trim().min(1).max(500).optional(),
  record: z.unknown().optional(),
  /** Study id or slug: also add the paper to this study's library (study editors only). */
  study: z.string().trim().min(1).max(80).optional(),
  citeKey: citeKeySchema.optional(),
  tags: tagsSchema.optional(),
  /** `ask` (default): 409 with the candidates when a likely/possible duplicate exists. `link`: use `paperId`. `add`: create anyway. */
  onDuplicate: z.enum(["ask", "link", "add"]).default("ask"),
  paperId: z.uuid().optional(),
});

const patchInput = z.object({ record: z.unknown() });

const searchQuery = z.object({
  q: z.string().trim().min(1).max(300),
  sources: z.string().max(100).optional(),
  yearFrom: z.coerce.number().int().min(1000).max(3000).optional(),
  yearTo: z.coerce.number().int().min(1000).max(3000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  study: z.string().trim().min(1).max(80).optional(),
});

const settingsInput = z.object({
  contact_email: z.email().max(200).or(z.literal("")).nullable().optional(),
  unpaywall_email: z.email().max(200).or(z.literal("")).nullable().optional(),
  grobid_url: z.url({ protocol: /^https?$/ }).max(300).or(z.literal("")).nullable().optional(),
  openalex_api_key: z.string().trim().max(200).nullable().optional(),
  s2_api_key: z.string().trim().max(200).nullable().optional(),
  zotero_api_key: z.string().trim().max(200).nullable().optional(),
  zotero_library: z
    .object({ type: z.enum(["user", "group"]), id: z.string().trim().regex(/^\d{1,12}$/), name: z.string().trim().max(120).optional() })
    .nullable()
    .optional(),
});

/** Per-user throttle for online search (external APIs have their own limiters too). */
const searchHits = new Map<string, number[]>();
function throttleSearch(userId: string) {
  const now = Date.now();
  const list = (searchHits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 20) throw new HttpError(429, "搜尋太頻繁，請稍等一分鐘再試。");
  list.push(now);
  searchHits.set(userId, list);
}

export function sourceHttpError(e: unknown): unknown {
  if (e instanceof SourceError) return new HttpError(502, e.message || "外部文獻服務暫時無法使用。", { code: `source_${e.source}` });
  return e;
}

const pdfUrlInput = z.object({ url: z.string().trim().min(1, "請貼上 PDF 網址。").max(2000, "網址太長。"), study: z.string().trim().min(1).max(80).optional() });

/** Friendly 繁中 errors for "add a PDF by URL" (`code` lets the UI react). */
const URL_ERRORS: Record<string, { status: number; error: (m: string) => string }> = {
  invalid_url: { status: 400, error: (m) => m || "網址格式錯誤。" },
  blocked_url: { status: 400, error: () => "不允許連到內部網路或本機位址。" },
  not_pdf: { status: 415, error: (m) => `${m}。請改貼 PDF 的直接連結，或先下載再上傳。` },
  too_large: { status: 413, error: (m) => `${m}。` },
  login_required: { status: 422, error: () => "這個網站需要登入才能下載，請先在瀏覽器下載 PDF 再上傳。" },
  no_open_access: { status: 404, error: (m) => `${m}。` },
  timeout: { status: 504, error: () => "下載逾時，請稍後再試或改上傳檔案。" },
  unreachable: { status: 502, error: (m) => `無法連線到這個網址（${m}）。` },
  http_error: { status: 502, error: (m) => `${m}，請確認網址是否正確。` },
};
export function pdfUrlHttpError(e: unknown): unknown {
  if (e instanceof SourceError && e.source === "download") {
    const code = e.code ?? "unreachable";
    const spec = URL_ERRORS[code] ?? URL_ERRORS.unreachable!;
    return new HttpError(spec.status, spec.error(e.message), { code });
  }
  return sourceHttpError(e);
}

export async function requirePaper(app: FastifyInstance, id: string, forUpdate = false) {
  const paper = await getPaper(app.db, id, forUpdate);
  if (!paper) throw notFound(MISSING);
  return paper;
}

export async function requirePaperEditor(app: FastifyInstance, user: CurrentUser, paper: PaperRow) {
  const perms = await paperPermissions(app.db, paper, user);
  if (!perms.edit) throw forbidden("只有加入這篇文獻的人、使用它的研究成員或管理員可以修改。");
  return perms;
}

export function sendPdf(reply: FastifyReply, object: { body: NodeJS.ReadableStream; contentLength?: number; contentRange?: string }, fileName: string, download: boolean) {
  reply
    .header("Content-Type", "application/pdf")
    .header("Accept-Ranges", "bytes")
    .header("Content-Disposition", `${download ? "attachment" : "inline"}; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .header("Cache-Control", "private, no-store")
    .header("X-Content-Type-Options", "nosniff");
  if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
  if (object.contentRange) reply.code(206).header("Content-Range", object.contentRange);
  return reply.send(object.body);
}

/** File name for a downloaded PDF: `<first author> <year> - <title>.pdf`. */
export function pdfFileName(p: PaperRow) {
  const a = p.record.authors?.[0];
  const who = a?.family ?? a?.literal ?? "";
  return `${[who, p.year].filter(Boolean).join(" ")}${who || p.year ? " - " : ""}${p.title}`.replace(/[\\/:*?"<>|\r\n]+/g, " ").slice(0, 150) + ".pdf";
}

export default async function papers(app: FastifyInstance) {
  await app.register(libraryStudy);
  await app.register(libraryImports);

  // ---------------------------------------------------------------- list / detail

  app.get("/library/papers", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(listQuery, request.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (q.q) {
      const norm = normalizeTitle(q.q) || q.q.toLowerCase();
      const like = `%${likeEscape(norm)}%`;
      const raw = `%${likeEscape(q.q.toLowerCase())}%`;
      const pn = p(norm);
      where.push(
        `(p.title_norm LIKE ${p(like)} OR (length(${pn}) >= 4 AND p.title_norm % ${pn}) OR lower(p.authors_text) LIKE ${p(raw)} OR p.doi_key = ${p(q.q.toLowerCase())} OR p.arxiv_id = ${p(q.q)} OR lower(coalesce(p.venue,'')) = ${p(q.q.toLowerCase())})`,
      );
    }
    if (q.venue) where.push(`lower(p.venue) = ${p(q.venue.toLowerCase())}`);
    if (q.year) where.push(`p.year = ${p(q.year)}`);
    if (q.yearFrom) where.push(`p.year >= ${p(q.yearFrom)}`);
    if (q.yearTo) where.push(`p.year <= ${p(q.yearTo)}`);
    if (q.has_pdf) where.push(q.has_pdf === "true" || q.has_pdf === "1" ? "p.pdf_key IS NOT NULL" : "p.pdf_key IS NULL");
    if (q.study) {
      const study = await findStudy(app.db, q.study);
      if (!study) throw notFound("研究不存在。");
      where.push(`EXISTS (SELECT 1 FROM study_papers x WHERE x.paper_id=p.id AND x.study_id=${p(study.id)})`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = q.sort === "year" ? "p.year DESC NULLS LAST, p.title" : q.sort === "title" ? "p.title_norm" : "p.created_at DESC";
    const base = params.length;
    const rows = await app.db.query<PaperRow & { studies: { id: string; slug: string; title: string }[]; total: number }>(
      `SELECT p.*, count(*) OVER()::int AS total,
              coalesce((SELECT json_agg(json_build_object('id',s.id,'slug',s.slug,'title',s.title) ORDER BY s.title)
                          FROM study_papers sp JOIN studies s ON s.id=sp.study_id WHERE sp.paper_id=p.id), '[]') AS studies
         FROM papers p ${w} ORDER BY ${order} LIMIT $${base + 1} OFFSET $${base + 2}`,
      [...params, q.limit, q.offset],
    );
    const facets = await app.db.query<{ kind: string; value: string; count: number }>(
      `SELECT 'venue' AS kind, venue AS value, count(*)::int AS count FROM papers p ${w ? `${w} AND` : "WHERE"} venue IS NOT NULL GROUP BY venue
       UNION ALL
       SELECT 'year', year::text, count(*)::int FROM papers p ${w ? `${w} AND` : "WHERE"} year IS NOT NULL GROUP BY year`,
      params,
    );
    void user;
    return reply.header("Cache-Control", "no-store").send({
      papers: rows.rows.map((r) => ({ ...summarize(r), studies: r.studies })),
      total: rows.rows[0]?.total ?? (q.offset ? (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM papers p ${w}`, params)).rows[0]!.n : 0),
      facets: {
        venues: facets.rows.filter((f) => f.kind === "venue").sort((a, b) => b.count - a.count).slice(0, 40).map((f) => ({ value: f.value, count: f.count })),
        years: facets.rows.filter((f) => f.kind === "year").map((f) => ({ value: Number(f.value), count: f.count })).sort((a, b) => b.value - a.value),
      },
    });
  });

  app.get("/library/papers/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const paper = await requirePaper(app, id);
    return reply.header("Cache-Control", "no-store").send({ paper: await paperDetail(app.db, paper, user) });
  });

  // ---------------------------------------------------------------- add / edit / delete

  /** Looks an identifier up online and reports lab matches; writes nothing. */
  app.post("/library/resolve", async (request) => {
    const user = await requireUser(request);
    const { identifier } = parse(z.object({ identifier: z.string().trim().min(1).max(500) }), request.body, "請輸入 DOI、arXiv 編號或論文網址。");
    throttleSearch(user.id);
    if (!parseIdentifier(identifier)) throw badRequest("看不懂這個識別碼，請輸入 DOI、arXiv 編號、ACL Anthology、OpenAlex 或 Semantic Scholar 的網址。");
    const { service } = await libraryService(app.db);
    const res = await service.resolveIdentifier(identifier).catch((e) => {
      throw sourceHttpError(e);
    });
    if (!res) throw notFound("找不到這個識別碼對應的文獻。");
    const matches = await findPaperMatches(app.db, res.record, 3);
    return { record: res.record, sources: res.sources, identifier: res.identifier, matches: matches.map((m) => ({ level: m.level, reason: m.reason, paper: summarize(m.paper) })) };
  });

  app.post("/library/papers", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(addInput, request.body);
    if (!input.identifier && !input.record) throw badRequest("請輸入識別碼或文獻資料。");
    const studyAccess = input.study ? await loadStudyAccess(app.db, input.study, user) : null;
    if (studyAccess && !studyAccess.canEdit) throw forbidden("只有研究成員可以修改。");
    let record;
    if (input.record) record = parseRecordInput(input.record);
    else {
      if (!parseIdentifier(input.identifier!)) throw badRequest("看不懂這個識別碼，請輸入 DOI、arXiv 編號或論文網址。");
      throttleSearch(user.id);
      const { service } = await libraryService(app.db);
      const res = await service.resolveIdentifier(input.identifier!).catch((e) => {
        throw sourceHttpError(e);
      });
      if (!res) throw notFound("找不到這個識別碼對應的文獻。");
      record = res.record;
    }
    const result = await transaction(app.db, async (client) => {
      const matches = await findPaperMatches(client, record, 5);
      const same = matches.find((m) => m.level === "same");
      let paper: PaperRow | null = null;
      let created = false;
      if (input.onDuplicate === "link") {
        if (!input.paperId) throw badRequest("請選擇要使用的文獻。");
        const target = await getPaper(client, input.paperId, true);
        if (!target) throw notFound(MISSING);
        paper = await mergeIntoPaper(client, target, record, user.id);
      } else if (same) {
        paper = await mergeIntoPaper(client, (await getPaper(client, same.paper.id, true))!, record, user.id);
      } else if (input.onDuplicate === "ask" && matches.length) {
        return { duplicate: matches };
      } else {
        try {
          await client.query("SAVEPOINT add_paper");
          paper = await insertPaper(client, record, user.id);
          created = true;
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          await client.query("ROLLBACK TO SAVEPOINT add_paper");
          throw conflict("文獻庫已有相同識別碼的文獻。");
        }
      }
      let citeKey: string | null = null;
      let addedToStudy = false;
      if (studyAccess) {
        await client.query("SELECT id FROM studies WHERE id=$1 FOR UPDATE", [studyAccess.study.id]);
        const res = await addPaperToStudy(client, { studyId: studyAccess.study.id, paper, userId: user.id, citeKey: input.citeKey ?? record.citeKey, tags: input.tags });
        citeKey = res.citeKey;
        addedToStudy = res.inserted;
        if (res.inserted)
          await recordActivity(client, {
            studyId: studyAccess.study.id, actorId: user.id, kind: "paper_added", title: paper.title,
            url: studyUrl(studyAccess.study.slug, "papers"), targetType: "paper", targetId: paper.id,
          });
      }
      return { paper, created, citeKey, addedToStudy };
    });
    if ("duplicate" in result) {
      return reply.code(409).send({
        error: "文獻庫裡可能已有這篇文獻，請選擇要使用既有的還是新增一筆。",
        code: "duplicate",
        record,
        duplicates: result.duplicate!.map((m) => ({ level: m.level, reason: m.reason, paper: summarize(m.paper) })),
      });
    }
    // Added by identifier: open-access full text right away (≤ 15 s; otherwise queued as an `ai_library_import` job).
    let pdf: AutoPdfOutcome | null = null;
    let paper = result.paper;
    if (input.identifier && !input.record && !paper.pdf_key) {
      pdf = await autoFetchPdf(app.db, app.storage, paper, user.id, { budgetMs: 15_000 }).catch((e): AutoPdfOutcome => {
        request.log.warn({ err: e, paperId: paper.id }, "auto pdf fetch failed");
        return { status: "failed" };
      });
      if (pdf.status === "stored") paper = (await getPaper(app.db, paper.id)) ?? paper;
    }
    return reply.code(result.created ? 201 : 200).send({
      paper: await paperDetail(app.db, paper, user),
      pdf: pdf ? { status: pdf.status, source: pdf.source ?? null, jobId: pdf.jobId ?? null } : { status: paper.pdf_key ? "exists" : "none", source: null, jobId: null },
      created: result.created,
      study: studyAccess ? { id: studyAccess.study.id, cite_key: result.citeKey, added: result.addedToStudy } : null,
    });
  });

  app.patch("/library/papers/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { record: raw } = parse(patchInput, request.body);
    const record = parseRecordInput(raw);
    const paper = await requirePaper(app, id);
    await requirePaperEditor(app, user, paper);
    try {
      // An edited record no longer matches the imported BibTeX text, so exports regenerate it.
      const updated = await updatePaperRecord(app.db, id, { ...record, oaPdfUrl: record.oaPdfUrl ?? paper.record.oaPdfUrl }, user.id, { bibtex: null });
      return { paper: await paperDetail(app.db, updated, user) };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("另一筆文獻已使用相同的 DOI 或 arXiv 編號。");
      throw e;
    }
  });

  app.delete("/library/papers/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const paper = await requirePaper(app, id);
    const perms = await paperPermissions(app.db, paper, user);
    if (!perms.delete) {
      if (perms.used > 0 && (paper.added_by === user.id || perms.edit)) throw conflict(`這篇文獻還在 ${perms.used} 個研究的文獻庫中，請先從研究移除。`);
      throw forbidden("只有加入這篇文獻的人或管理員可以刪除。");
    }
    await app.db.query("DELETE FROM papers WHERE id=$1", [id]);
    await app.storage.deletePrefix(libraryKeys.paperPrefix(id)).catch((e) => request.log.warn({ err: e }, "paper file cleanup failed"));
    return { ok: true };
  });

  // ---------------------------------------------------------------- PDF

  app.get("/library/papers/:id/pdf", async (request, reply) => {
    await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { download } = parse(z.object({ download: z.enum(["1", "0"]).optional() }), request.query);
    const paper = await requirePaper(app, id);
    const object = paper.pdf_key ? await app.storage.get(paper.pdf_key, request.headers.range) : null;
    if (!object) throw notFound("這篇文獻還沒有 PDF。");
    return sendPdf(reply, object, pdfFileName(paper), download === "1");
  });

  app.post("/library/papers/:id/pdf", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const paper = await requirePaper(app, id);
    await requirePaperEditor(app, user, paper);
    const upload = await receiveUpload(request, PDF_MAX);
    try {
      if (!upload.file?.bytes) throw badRequest("請選擇 PDF 檔案。");
      const data = await readFile(upload.file.path);
      try {
        await storePaperPdf(app.db, app.storage, { paperId: id, data, source: "upload", fileName: upload.file.filename, userId: user.id });
      } catch (e) {
        if ((e as { notPdf?: boolean }).notPdf) throw new HttpError(415, "檔案不是 PDF。");
        throw e;
      }
    } finally {
      await upload.cleanup();
    }
    return reply.code(201).send({ paper: await paperDetail(app.db, (await getPaper(app.db, id))!, user) });
  });

  app.delete("/library/papers/:id/pdf/:fileId", async (request) => {
    const user = await requireUser(request);
    const { id, fileId } = parse(z.object({ id: z.uuid(), fileId: z.uuid() }), request.params);
    const paper = await requirePaper(app, id);
    await requirePaperEditor(app, user, paper);
    const file = (await app.db.query<{ key: string }>("DELETE FROM paper_files WHERE id=$1 AND paper_id=$2 RETURNING key", [fileId, id])).rows[0];
    if (!file) throw notFound("檔案不存在。");
    await app.db.query(
      "UPDATE papers SET pdf_key=(SELECT key FROM paper_files WHERE paper_id=$1 ORDER BY created_at DESC LIMIT 1),updated_at=now() WHERE id=$1",
      [id],
    );
    await app.storage.delete(file.key).catch(() => {});
    await app.storage.delete(fulltextKey(file.key)).catch(() => {});
    return { paper: await paperDetail(app.db, (await getPaper(app.db, id))!, user) };
  });

  /** Finds an open-access PDF online and stores it (synchronous, ≤ ~90 s). */
  app.post("/library/papers/:id/fetch-pdf", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const paper = await requirePaper(app, id);
    await requirePaperEditor(app, user, paper);
    throttleSearch(user.id);
    const { service } = await libraryService(app.db);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const outcome = await fetchOpenAccessPdf(app.db, app.storage, service, paper, user.id, { signal: ctrl.signal }).catch((e) => {
        throw sourceHttpError(e);
      });
      if (outcome.status === "not_found") return reply.code(404).send({ error: "找不到開放取用的全文，請自行上傳 PDF。", code: "no_open_access" });
      if (outcome.status === "failed")
        return reply.code(502).send({ error: `找到全文連結，但下載失敗：${outcome.message}`, code: "download_failed", url: outcome.url });
      return { outcome, paper: await paperDetail(app.db, (await getPaper(app.db, id))!, user) };
    } finally {
      clearTimeout(timer);
    }
  });

  /** Download a PDF from a pasted URL (or landing page / DOI) and store it on the paper; same permission as upload. */
  app.post("/library/papers/:id/pdf-from-url", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const { url } = parse(pdfUrlInput, request.body);
    const paper = await requirePaper(app, id);
    await requirePaperEditor(app, user, paper);
    throttleSearch(user.id);
    const { service } = await libraryService(app.db);
    const stored = await attachPdfFromUrl(app.db, app.storage, service, { paperId: id, url, userId: user.id, maxBytes: PDF_MAX }).catch((e) => {
      throw pdfUrlHttpError(e);
    });
    return reply.code(201).send({
      paper: await paperDetail(app.db, (await getPaper(app.db, id))!, user),
      download: { url: stored.finalUrl, bytes: stored.bytes, kind: stored.kind },
    });
  });

  /** Upload a PDF to create a paper: extracts metadata and returns an import preview (confirm via /library/imports/:id/confirm). */
  app.post("/library/pdf", async (request, reply) => {
    const user = await requireUser(request);
    const upload = await receiveUpload(request, PDF_MAX);
    try {
      if (!upload.file?.bytes) throw badRequest("請選擇 PDF 檔案。");
      const studyRef = upload.fields.study?.trim();
      const access = studyRef ? await loadStudyAccess(app.db, studyRef, user) : null;
      if (access && !access.canEdit) throw forbidden("只有研究成員可以修改。");
      const data = await readFile(upload.file.path);
      return reply.code(201).send(await pdfImportPreview(user, access?.study.id ?? null, data, upload.file.filename, null));
    } finally {
      await upload.cleanup();
    }
  });

  /** Same as POST /library/pdf, but the PDF is downloaded from a pasted URL (landing pages and DOIs resolved). */
  app.post("/library/pdf-from-url", async (request, reply) => {
    const user = await requireUser(request);
    const input = parse(pdfUrlInput, request.body);
    const access = input.study ? await loadStudyAccess(app.db, input.study, user) : null;
    if (access && !access.canEdit) throw forbidden("只有研究成員可以修改。");
    throttleSearch(user.id);
    const { service } = await libraryService(app.db);
    const pdf = await downloadPdfFromUrl(service, input.url, { maxBytes: PDF_MAX }).catch((e) => {
      throw pdfUrlHttpError(e);
    });
    const body = await pdfImportPreview(user, access?.study.id ?? null, pdf.data, pdf.fileName, pdf.finalUrl);
    return reply.code(201).send({ ...body, download: { url: pdf.finalUrl, bytes: pdf.data.length, kind: pdf.plan.kind } });
  });

  /** PDF → metadata → one-item import preview; the file waits at `library/imports/<batchId>/upload.pdf` until confirm. */
  async function pdfImportPreview(user: CurrentUser, studyId: string | null, data: Buffer, fileName: string, sourceUrl: string | null) {
    const { service } = await libraryService(app.db);
    let extracted;
    try {
      extracted = await service.extractPdfRecord(data, { sourceUrl });
    } catch (e) {
      if (e instanceof SourceError && e.source === "pdf") throw new HttpError(415, e.message || "檔案不是 PDF。");
      throw sourceHttpError(e);
    }
    const record = extracted.record ?? { type: "document" as const, title: fileName.replace(/\.pdf$/i, "").slice(0, 300) || "未命名文獻", authors: [] };
    const batchId = randomUUID();
    const fileKey = libraryKeys.importUpload(batchId);
    await app.storage.put(fileKey, data, "application/pdf");
    const batch = await createImportPreview(app.db, {
      id: batchId, studyId, userId: user.id, source: "pdf", format: sourceUrl ? "pdf-url" : "pdf", fileName,
      records: [record], warnings: extracted.warnings.map((message) => ({ index: 0, message })), fileKey,
    });
    if (sourceUrl) await app.db.query("UPDATE import_batches SET source_url=$2 WHERE id=$1", [batchId, sourceUrl.slice(0, 2000)]);
    return { batch: batchView(batch), extraction: { method: extracted.method, identifiers: extracted.identifiers, titleGuess: extracted.titleGuess ?? null } };
  }

  // ---------------------------------------------------------------- AI

  app.post("/library/papers/:id/ai/summary", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const paper = await requirePaper(app, id);
    try {
      return await summarizePaper(aiFor(app), app.storage, paper, { userId: user.id });
    } catch (e) {
      if (e instanceof NotEnoughText) throw new HttpError(422, e.message, { code: "no_text" });
      throw toHttpError(e);
    }
  });

  // ---------------------------------------------------------------- online search

  app.get("/library/search", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(searchQuery, request.query, "請輸入搜尋關鍵字。");
    throttleSearch(user.id);
    const allowed: SearchSource[] = ["openalex", "s2", "arxiv", "crossref", "isca"];
    const sources = q.sources ? (q.sources.split(",").filter((s) => (allowed as string[]).includes(s)) as SearchSource[]) : DEFAULT_SEARCH_SOURCES;
    if (!sources.length) throw badRequest("請至少選擇一個搜尋來源。");
    const { service } = await libraryService(app.db);
    const result = await service.searchPapers(q.q, { sources, limit: q.limit, yearFrom: q.yearFrom, yearTo: q.yearTo });
    const study = q.study ? await findStudy(app.db, q.study) : null;
    const hits = [];
    for (const h of result.hits) {
      const m = (await findPaperMatches(app.db, h.record, 1))[0];
      let existing = null;
      if (m && (m.level === "same" || m.level === "likely")) {
        const inStudy = study ? (await app.db.query("SELECT 1 FROM study_papers WHERE study_id=$1 AND paper_id=$2", [study.id, m.paper.id])).rowCount! > 0 : false;
        existing = { paperId: m.paper.id, level: m.level, inStudy };
      }
      hits.push({ record: h.record, sources: h.sources, existing });
    }
    return reply.header("Cache-Control", "no-store").send({ hits, errors: result.errors, skipped: result.skipped });
  });

  // ---------------------------------------------------------------- settings (admin)

  app.get("/library/settings", async (request, reply) => {
    await requireAdmin(request);
    return reply.header("Cache-Control", "no-store").send({ settings: await librarySettingsView(app.db) });
  });

  app.put("/library/settings", async (request, reply) => {
    const user = await requireAdmin(request);
    const input = parse(settingsInput, request.body);
    try {
      await saveLibrarySettings(app.db, {
        contactEmail: input.contact_email,
        unpaywallEmail: input.unpaywall_email,
        grobidUrl: input.grobid_url,
        openalexKey: input.openalex_api_key,
        s2Key: input.s2_api_key,
        zoteroKey: input.zotero_api_key,
        zoteroLibrary: input.zotero_library,
      }, user.id);
    } catch (e) {
      throw toHttpError(e);
    }
    return reply.header("Cache-Control", "no-store").send({ settings: await librarySettingsView(app.db) });
  });
}
