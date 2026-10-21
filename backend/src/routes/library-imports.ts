import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from "../lib/http.js";
import { decryptJson, encryptJson } from "../ai/platform/crypto.js";
import { toHttpError } from "../ai/platform/index.js";
import { enqueueJob } from "../jobs/queue.js";
import { loadStudyAccess, requireStudyEditor, studyUrl } from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import { receiveUpload } from "../lib/slides/upload.js";
import { importAny } from "../lib/library/import.js";
import { SourceError } from "../lib/library/http.js";
import { ZoteroClient, type ZoteroLibraryRef } from "../lib/library/sources/zotero.js";
import { LibraryImportError, type ImportFormat } from "../lib/library/types.js";
import { citeKeySchema, recordInputSchema } from "../lib/library/schema.js";
import { confirmImport, createImportPreview, getImportBatch, previewSummary, type ImportBatch } from "../lib/library/imports.js";
import { storePaperPdf } from "../lib/library/files.js";
import { libraryService } from "../lib/library/settings.js";
import { LIBRARY_IMPORT_JOB, type LibraryImportPayload } from "../ai-jobs/library/kinds.js";

/** Imports (file / Zotero / PDF) with a preview → confirm step, and the user's Zotero connection. */

const refParams = z.object({ ref: z.string().min(1).max(80) });
const idParams = z.object({ id: z.uuid() });
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const FORMATS: ImportFormat[] = ["bibtex", "ris", "endnote-xml", "csl-json", "zotero-rdf"];
const MAX_PDF_FETCH = 300;

const textImport = z.object({
  text: z.string().min(1).max(IMPORT_MAX_BYTES),
  format: z.enum(FORMATS as [ImportFormat, ...ImportFormat[]]).optional(),
  filename: z.string().max(255).optional(),
});

const zoteroImport = z.object({
  /** `mine`: the caller's saved key; `lab`: the admin-configured lab library; `key`: the one-off `apiKey`. */
  source: z.enum(["mine", "lab", "key"]).default("mine"),
  apiKey: z.string().trim().min(10).max(100).optional(),
  library: z.object({ type: z.enum(["user", "group"]), id: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().positive()]) }).optional(),
  collectionKey: z.string().regex(/^[A-Z0-9]{8}$/).optional(),
  remember: z.boolean().default(false),
});

const confirmInput = z.object({
  decisions: z
    .array(
      z.object({
        index: z.number().int().min(0),
        action: z.enum(["add", "link", "skip"]),
        paperId: z.uuid().optional(),
        citeKey: citeKeySchema.optional(),
        record: recordInputSchema.optional(),
      }),
    )
    .max(5000)
    .default([]),
  /** Fetch open-access PDFs for the imported papers in the background (ai-worker job). */
  fetchPdfs: z.boolean().default(false),
});

export const batchView = (b: ImportBatch) => ({
  id: b.id,
  study_id: b.study_id,
  source: b.source,
  format: b.format,
  file_name: b.file_name,
  status: b.status,
  items: b.items,
  warnings: b.warnings,
  counts: b.counts,
  summary: previewSummary(b.items),
  job_id: b.job_id,
  created_at: b.created_at,
  confirmed_at: b.confirmed_at,
});

const zoteroAad = (userId: string) => `${userId}:zotero`;

function zoteroError(e: unknown): unknown {
  if (e instanceof SourceError) {
    if (e.status === 403 || e.status === 401) return new HttpError(400, "Zotero API key 無效或沒有讀取權限。", { code: "zotero_auth" });
    return new HttpError(502, e.message || "Zotero 暫時無法連線。", { code: "zotero_unavailable" });
  }
  return toHttpError(e);
}

export default async function libraryImports(app: FastifyInstance) {
  async function savedZoteroKey(userId: string) {
    const row = (await app.db.query<{ api_key: Buffer; zotero_user_id: string; username: string | null }>(
      "SELECT api_key,zotero_user_id,username FROM library_zotero_accounts WHERE user_id=$1",
      [userId],
    )).rows[0];
    if (!row) return null;
    try {
      return { apiKey: decryptJson<string>(row.api_key, zoteroAad(userId)), zoteroUserId: Number(row.zotero_user_id), username: row.username };
    } catch {
      return null;
    }
  }

  async function zoteroClient(apiKey: string) {
    const { settings } = await libraryService(app.db);
    return new ZoteroClient({ apiKey, contactEmail: settings.contactEmail ?? undefined });
  }

  /** Resolves which key/library a Zotero request uses. */
  async function zoteroTarget(userId: string, input: z.infer<typeof zoteroImport>) {
    if (input.source === "lab") {
      const { settings } = await libraryService(app.db);
      if (!settings.zoteroKey || !settings.zoteroLibrary) throw badRequest("管理員尚未設定實驗室的 Zotero 文獻庫。");
      return { apiKey: settings.zoteroKey, library: { type: settings.zoteroLibrary.type, id: settings.zoteroLibrary.id } as ZoteroLibraryRef, saved: null };
    }
    if (input.source === "key") {
      if (!input.apiKey) throw badRequest("請輸入 Zotero API key。");
      return { apiKey: input.apiKey, library: input.library ?? null, saved: null };
    }
    const saved = await savedZoteroKey(userId);
    if (!saved) throw badRequest("你還沒有連結 Zotero，請先輸入 API key。");
    return { apiKey: saved.apiKey, library: input.library ?? ({ type: "user", id: saved.zoteroUserId } as ZoteroLibraryRef), saved };
  }

  async function rememberZotero(userId: string, apiKey: string) {
    const client = await zoteroClient(apiKey);
    const info = await client.verifyKey().catch((e) => {
      throw zoteroError(e);
    });
    let enc: Buffer;
    try {
      enc = encryptJson(apiKey, zoteroAad(userId));
    } catch (e) {
      throw toHttpError(e);
    }
    await app.db.query(
      `INSERT INTO library_zotero_accounts(user_id,api_key,zotero_user_id,username,updated_at) VALUES($1,$2,$3,$4,now())
       ON CONFLICT (user_id) DO UPDATE SET api_key=excluded.api_key,zotero_user_id=excluded.zotero_user_id,username=excluded.username,updated_at=now()`,
      [userId, enc, info.userId, info.username ?? null],
    );
    return info;
  }

  // ---------------------------------------------------------------- previews

  app.post("/studies/:ref/imports", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    let text: string;
    let filename: string | undefined;
    let format: ImportFormat | undefined;
    if (request.isMultipart()) {
      const upload = await receiveUpload(request, IMPORT_MAX_BYTES);
      try {
        if (!upload.file?.bytes) throw badRequest("請選擇要匯入的檔案。");
        filename = upload.file.filename;
        const buf = await readFile(upload.file.path);
        if (buf.subarray(0, 5).toString("latin1") === "%PDF-") throw badRequest("PDF 請用「上傳 PDF」加入。");
        text = buf.toString("utf8").replace(/^﻿/, "");
        const f = upload.fields.format;
        if (f && (FORMATS as string[]).includes(f)) format = f as ImportFormat;
      } finally {
        await upload.cleanup();
      }
    } else {
      const input = parse(textImport, request.body);
      text = input.text;
      filename = input.filename;
      format = input.format;
    }
    let parsed;
    try {
      parsed = importAny(text, { format, filename });
    } catch (e) {
      if (e instanceof LibraryImportError) throw badRequest(e.message);
      throw e;
    }
    if (!parsed.records.length) {
      return reply.code(422).send({ error: "檔案裡沒有可以匯入的文獻。", code: "empty", warnings: parsed.warnings.slice(0, 50) });
    }
    const batch = await createImportPreview(app.db, {
      studyId: access.study.id, userId: user.id, source: "file", format: parsed.format, fileName: filename ?? null, records: parsed.records, warnings: parsed.warnings,
    });
    return reply.code(201).send({ batch: batchView(batch) });
  });

  app.post("/studies/:ref/imports/zotero", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    const input = parse(zoteroImport, request.body);
    const target = await zoteroTarget(user.id, input);
    const client = await zoteroClient(target.apiKey);
    let library = target.library;
    if (!library) {
      const info = await client.verifyKey().catch((e) => {
        throw zoteroError(e);
      });
      library = { type: "user", id: info.userId };
    }
    if (input.source === "key" && input.remember) await rememberZotero(user.id, target.apiKey);
    const res = await client.listItems(library, { collectionKey: input.collectionKey, max: 2000 }).catch((e) => {
      throw zoteroError(e);
    });
    if (!res.items.length) return reply.code(422).send({ error: "這個 Zotero 文獻庫（或資料夾）沒有可以匯入的文獻。", code: "empty" });
    const batch = await createImportPreview(app.db, {
      studyId: access.study.id, userId: user.id, source: "zotero", format: "zotero-api",
      fileName: `Zotero ${library.type === "group" ? "group" : "user"} ${library.id}${input.collectionKey ? ` / ${input.collectionKey}` : ""}`,
      records: res.items.map((i) => i.record), warnings: [],
    });
    return reply.code(201).send({ batch: batchView(batch) });
  });

  app.get("/studies/:ref/imports", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const user = await requireUser(request);
    const access = await loadStudyAccess(app.db, ref, user);
    const rows = await app.db.query(
      `SELECT b.id,b.source,b.format,b.file_name,b.status,b.counts,b.job_id,b.created_at,b.confirmed_at,u.name AS user_name,
              jsonb_array_length(b.warnings) AS warning_count, j.status AS job_status, j.progress AS job_progress, j.result AS job_result
         FROM import_batches b JOIN users u ON u.id=b.user_id LEFT JOIN jobs j ON j.id=b.job_id
        WHERE b.study_id=$1 AND b.status='done' ORDER BY b.created_at DESC LIMIT 20`,
      [access.study.id],
    );
    return reply.header("Cache-Control", "no-store").send({ imports: rows.rows });
  });

  app.get("/library/imports/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const batch = await getImportBatch(app.db, id);
    if (!batch || batch.user_id !== user.id) throw notFound("找不到這次匯入。");
    return reply.header("Cache-Control", "no-store").send({ batch: batchView(batch) });
  });

  app.delete("/library/imports/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const batch = await getImportBatch(app.db, id);
    if (!batch || batch.user_id !== user.id) throw notFound("找不到這次匯入。");
    if (batch.status !== "preview") throw conflict("這次匯入已經完成。");
    await app.db.query("UPDATE import_batches SET status='cancelled',items='[]',file_key=NULL WHERE id=$1", [id]);
    if (batch.file_key) await app.storage.delete(batch.file_key).catch(() => {});
    return { ok: true };
  });

  app.post("/library/imports/:id/confirm", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params);
    const input = parse(confirmInput, request.body);
    const pre = await getImportBatch(app.db, id);
    if (!pre || pre.user_id !== user.id) throw notFound("找不到這次匯入。");
    const access = pre.study_id ? await loadStudyAccess(app.db, pre.study_id, user) : null;
    if (access && !access.canEdit) throw forbidden("只有研究成員可以修改。");
    const pdfData = pre.source === "pdf" && pre.file_key ? await app.storage.getBuffer(pre.file_key) : null;
    const out = await transaction(app.db, async (client) => {
      const batch = await getImportBatch(client, id, true);
      if (!batch || batch.status !== "preview") throw conflict("這次匯入已經完成或已取消。");
      const result = await confirmImport(client, batch, input.decisions, user.id, batch.study_id);
      if (pdfData && result.resolved[0]) {
        // `/library/pdf-from-url` previews remember the URL (format `pdf-url`).
        const sourceUrl = batch.format === "pdf-url"
          ? ((await client.query<{ source_url: string | null }>("SELECT source_url FROM import_batches WHERE id=$1", [batch.id])).rows[0]?.source_url ?? null)
          : null;
        await storePaperPdf(client, app.storage, {
          paperId: result.resolved[0].paperId, data: pdfData, source: batch.format === "pdf-url" ? "url" : "upload", sourceUrl, fileName: batch.file_name, userId: user.id,
        });
      }
      let jobId: string | null = null;
      const targets = result.papers.map((p) => p.paperId);
      if (input.fetchPdfs && targets.length && batch.source !== "pdf") {
        const missing = (await client.query<{ id: string }>("SELECT id FROM papers WHERE id = ANY($1::uuid[]) AND pdf_key IS NULL LIMIT $2", [targets, MAX_PDF_FETCH])).rows.map((r) => r.id);
        if (missing.length) {
          jobId = await enqueueJob(client, LIBRARY_IMPORT_JOB, { batchId: id, paperIds: missing, userId: user.id } satisfies LibraryImportPayload, user.id);
        }
      }
      const counts = { added: result.added, linked: result.linked, skipped: result.skipped, total: batch.items.length };
      await client.query(
        "UPDATE import_batches SET status='done',confirmed_at=now(),counts=$2,job_id=$3,file_key=NULL,items=$4 WHERE id=$1",
        [id, JSON.stringify(counts), jobId, JSON.stringify(batch.items.map((i) => ({ ...i, result: result.papers.find((p) => p.index === i.index) ?? null })))],
      );
      if (access && result.papers.length) {
        await recordActivity(client, {
          studyId: access.study.id, actorId: user.id, kind: "papers_imported",
          title: result.papers.length === 1 ? (batch.items[result.papers[0]!.index]?.record.title ?? "1 篇文獻") : `匯入 ${result.papers.length} 篇文獻`,
          url: studyUrl(access.study.slug, "papers"), targetType: "import_batch", targetId: id,
          metadata: { count: result.papers.length, source: batch.source, format: batch.format },
        });
      }
      return { result, jobId, fileKey: batch.file_key };
    });
    if (out.fileKey) await app.storage.delete(out.fileKey).catch(() => {});
    const batch = (await getImportBatch(app.db, id))!;
    return {
      batch: batchView(batch),
      result: out.result,
      jobId: out.jobId,
      pdfFetch: input.fetchPdfs ? (out.jobId ? "queued" : "none") : null,
    };
  });

  // ---------------------------------------------------------------- Zotero connection

  app.get("/library/zotero", async (request, reply) => {
    const user = await requireUser(request);
    const saved = await savedZoteroKey(user.id);
    const { settings } = await libraryService(app.db);
    return reply.header("Cache-Control", "no-store").send({
      account: saved ? { username: saved.username, zotero_user_id: saved.zoteroUserId, key_last4: saved.apiKey.slice(-4) } : null,
      lab: settings.zoteroKey && settings.zoteroLibrary ? { library: settings.zoteroLibrary } : null,
    });
  });

  app.put("/library/zotero", async (request) => {
    const user = await requireUser(request);
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(10).max(100) }), request.body, "請輸入 Zotero API key。");
    const info = await rememberZotero(user.id, apiKey);
    return { account: { username: info.username ?? null, zotero_user_id: info.userId, key_last4: apiKey.slice(-4) }, groups: info.groups };
  });

  app.delete("/library/zotero", async (request) => {
    const user = await requireUser(request);
    await app.db.query("DELETE FROM library_zotero_accounts WHERE user_id=$1", [user.id]);
    return { ok: true };
  });

  /** Libraries (own + groups) and collections reachable with a key, for the import picker. */
  app.post("/library/zotero/browse", async (request) => {
    const user = await requireUser(request);
    const input = parse(zoteroImport.pick({ source: true, apiKey: true, library: true }), request.body);
    const target = await zoteroTarget(user.id, { ...input, remember: false });
    const client = await zoteroClient(target.apiKey);
    try {
      if (input.source === "lab") {
        return { libraries: [{ type: target.library!.type, id: String(target.library!.id), name: "實驗室" }], collections: await client.listCollections(target.library!) };
      }
      const info = await client.verifyKey();
      const libraries = [
        ...(info.canReadUserLibrary ? [{ type: "user" as const, id: String(info.userId), name: info.username ?? "我的文獻庫" }] : []),
        ...info.groups.map((g) => ({ type: "group" as const, id: String(g.id), name: g.name })),
      ];
      const lib = input.library ?? (libraries[0] ? { type: libraries[0].type, id: libraries[0].id } : null);
      return { libraries, collections: lib ? await client.listCollections(lib) : [] };
    } catch (e) {
      throw zoteroError(e);
    }
  });

}
