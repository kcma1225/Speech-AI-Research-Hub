import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { HttpError, conflict, isUniqueViolation, notFound, parse } from "../lib/http.js";
import { aiFor, toHttpError } from "../ai/platform/index.js";
import { permissionsOf, requireStudyEditor, requireStudyReader, studyUrl } from "../lib/studies/access.js";
import { recordActivity } from "../lib/studies/activity.js";
import { registerStudyCleanup } from "../lib/studies/cleanup.js";
import { READING_STATUSES, citeKeySchema, tagsSchema } from "../lib/library/schema.js";
import { addPaperToStudy, getPaper, libraryKeys, summarize, type PaperRow } from "../lib/library/store.js";
import { paperDetail } from "../lib/library/detail.js";
import { exportStudyLibrary } from "../lib/library/study-export.js";
import { NotEnoughText, paperRelevance } from "../lib/library/ai.js";

/** A study's reading list: `/studies/:ref/papers…`. Reads: everyone; writes: study editors (owner/member). */

const refParams = z.object({ ref: z.string().min(1).max(80) });
const paperParams = z.object({ ref: z.string().min(1).max(80), paperId: z.uuid() });
const NOT_IN_STUDY = "這篇文獻不在此研究的文獻庫中。";
const KEY_TAKEN = "這個引用鍵在此研究已被使用。";

const listQuery = z.object({
  status: z.enum([...READING_STATUSES, "all"]).default("all"),
  tag: z.string().trim().max(40).optional(),
  q: z.string().trim().max(200).optional(),
});

const addInput = z.object({ paperId: z.uuid(), citeKey: citeKeySchema.optional(), tags: tagsSchema.optional() });

const patchInput = z
  .object({
    reading_status: z.enum(READING_STATUSES).optional(),
    tags: tagsSchema.optional(),
    notes_md: z.string().max(200_000).optional(),
    cite_key: citeKeySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0);

const exportQuery = z.object({
  format: z.enum(["bibtex", "ris", "csl-json"]).default("bibtex"),
  ids: z.string().max(40 * 1000).optional(),
  abstract: z.enum(["1", "0"]).optional(),
});

type StudyPaperRow = PaperRow & {
  cite_key: string;
  reading_status: string;
  tags: string[];
  notes_md: string;
  sp_added_by: string | null;
  added_by_name: string | null;
  sp_created_at: string;
  sp_updated_at: string;
  notes_updated_at: string | null;
  notes_updated_by_name: string | null;
};

const STUDY_PAPER_SQL = `SELECT p.*, sp.cite_key, sp.reading_status, sp.tags, sp.notes_md, sp.added_by AS sp_added_by, ua.name AS added_by_name,
         sp.created_at AS sp_created_at, sp.updated_at AS sp_updated_at, sp.notes_updated_at, un.name AS notes_updated_by_name
    FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
    LEFT JOIN users ua ON ua.id=sp.added_by LEFT JOIN users un ON un.id=sp.notes_updated_by`;

const studyPaperView = (r: StudyPaperRow) => ({
  paper: summarize(r),
  cite_key: r.cite_key,
  reading_status: r.reading_status,
  tags: r.tags,
  notes_md: r.notes_md,
  added_by: r.sp_added_by ? { id: r.sp_added_by, name: r.added_by_name ?? "" } : null,
  created_at: r.sp_created_at,
  updated_at: r.sp_updated_at,
  notes_updated_at: r.notes_updated_at,
  notes_updated_by: r.notes_updated_by_name,
});

async function loadStudyPaper(app: FastifyInstance, studyId: string, paperId: string) {
  return (await app.db.query<StudyPaperRow>(`${STUDY_PAPER_SQL} WHERE sp.study_id=$1 AND sp.paper_id=$2`, [studyId, paperId])).rows[0] ?? null;
}

export default async function libraryStudy(app: FastifyInstance) {
  // Import previews keep their uploaded PDF in S3 until confirm; remove them with the study.
  registerStudyCleanup("library", async (client, studyId) => {
    const batches = (await client.query<{ id: string }>("SELECT id FROM import_batches WHERE study_id=$1 AND file_key IS NOT NULL", [studyId])).rows;
    if (!batches.length) return;
    return async () => {
      for (const b of batches) await app.storage.deletePrefix(libraryKeys.importPrefix(b.id)).catch(() => {});
    };
  });

  app.get("/studies/:ref/papers", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { access } = await requireStudyReader(request, ref);
    const q = parse(listQuery, request.query);
    const where = ["sp.study_id=$1"];
    const params: unknown[] = [access.study.id];
    if (q.status !== "all") {
      params.push(q.status);
      where.push(`sp.reading_status=$${params.length}`);
    }
    if (q.tag) {
      params.push(q.tag.toLowerCase());
      where.push(`EXISTS (SELECT 1 FROM unnest(sp.tags) t WHERE lower(t)=$${params.length})`);
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const n = params.length;
      where.push(`(lower(p.title) LIKE $${n} OR lower(p.authors_text) LIKE $${n} OR lower(sp.cite_key) LIKE $${n} OR lower(sp.notes_md) LIKE $${n} OR lower(coalesce(p.venue,'')) LIKE $${n})`);
    }
    const rows = await app.db.query<StudyPaperRow>(`${STUDY_PAPER_SQL} WHERE ${where.join(" AND ")} ORDER BY sp.created_at DESC`, params);
    const stats = await app.db.query<{ reading_status: string; n: number }>(
      "SELECT reading_status, count(*)::int AS n FROM study_papers WHERE study_id=$1 GROUP BY reading_status",
      [access.study.id],
    );
    const tags = await app.db.query<{ tag: string; n: number }>(
      "SELECT min(t) AS tag, count(*)::int AS n FROM study_papers, unnest(tags) t WHERE study_id=$1 GROUP BY lower(t) ORDER BY n DESC, 1 LIMIT 100",
      [access.study.id],
    );
    const counts = { unread: 0, reading: 0, read: 0, total: 0 };
    for (const s of stats.rows) {
      counts[s.reading_status as "unread"] = s.n;
      counts.total += s.n;
    }
    return reply.header("Cache-Control", "no-store").send({
      papers: rows.rows.map(studyPaperView),
      tags: tags.rows.map((t) => ({ tag: t.tag, count: t.n })),
      counts,
      permissions: permissionsOf(access),
    });
  });

  app.post("/studies/:ref/papers", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    const input = parse(addInput, request.body);
    const res = await transaction(app.db, async (client) => {
      await client.query("SELECT id FROM studies WHERE id=$1 FOR UPDATE", [access.study.id]);
      const paper = await getPaper(client, input.paperId);
      if (!paper) throw notFound("文獻不存在。");
      const taken = new Set((await client.query<{ k: string }>("SELECT lower(cite_key) AS k FROM study_papers WHERE study_id=$1", [access.study.id])).rows.map((r) => r.k));
      if (input.citeKey && taken.has(input.citeKey.toLowerCase())) {
        const own = (await client.query("SELECT 1 FROM study_papers WHERE study_id=$1 AND paper_id=$2", [access.study.id, paper.id])).rowCount;
        if (!own) throw conflict(KEY_TAKEN);
      }
      const r = await addPaperToStudy(client, { studyId: access.study.id, paper, userId: user.id, citeKey: input.citeKey, tags: input.tags, taken });
      if (!r.inserted) throw conflict("這篇文獻已在此研究的文獻庫中。");
      await recordActivity(client, {
        studyId: access.study.id, actorId: user.id, kind: "paper_added", title: paper.title,
        url: studyUrl(access.study.slug, "papers"), targetType: "paper", targetId: paper.id,
      });
      return r;
    });
    const row = (await loadStudyPaper(app, access.study.id, input.paperId))!;
    return reply.code(201).send({ studyPaper: studyPaperView(row), cite_key: res.citeKey });
  });

  app.get("/studies/:ref/papers/export", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const { access } = await requireStudyReader(request, ref);
    const q = parse(exportQuery, request.query);
    const ids = q.ids ? q.ids.split(",").filter(Boolean) : undefined;
    if (ids && (ids.length > 2000 || ids.some((id) => !z.uuid().safeParse(id).success))) throw new HttpError(400, "欄位內容不正確。");
    const out = await exportStudyLibrary(app.db, access.study.id, q.format, { paperIds: ids, abstract: q.abstract === "1" });
    const name = `${access.study.slug}-library.${out.ext}`;
    return reply
      .header("Content-Type", out.contentType)
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(out.body);
  });

  app.get("/studies/:ref/papers/:paperId", async (request, reply) => {
    const { ref, paperId } = parse(paperParams, request.params);
    const { user, access } = await requireStudyReader(request, ref);
    const row = await loadStudyPaper(app, access.study.id, paperId);
    if (!row) throw notFound(NOT_IN_STUDY);
    return reply.header("Cache-Control", "no-store").send({
      studyPaper: studyPaperView(row),
      paper: await paperDetail(app.db, row, user),
      permissions: permissionsOf(access),
    });
  });

  app.patch("/studies/:ref/papers/:paperId", async (request) => {
    const { ref, paperId } = parse(paperParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    const input = parse(patchInput, request.body);
    const sets: string[] = ["updated_at=now()"];
    const params: unknown[] = [access.study.id, paperId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      sets.push(`${sql}=$${params.length}`);
    };
    if (input.reading_status) add("reading_status", input.reading_status);
    if (input.tags) add("tags", input.tags);
    if (input.cite_key) add("cite_key", input.cite_key);
    if (input.notes_md !== undefined) {
      add("notes_md", input.notes_md);
      add("notes_updated_by", user.id);
      sets.push("notes_updated_at=now()");
    }
    try {
      const r = await app.db.query(`UPDATE study_papers SET ${sets.join(",")} WHERE study_id=$1 AND paper_id=$2`, params);
      if (!r.rowCount) throw notFound(NOT_IN_STUDY);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(KEY_TAKEN);
      throw e;
    }
    if (input.reading_status === "read") {
      const p = await getPaper(app.db, paperId);
      if (p)
        await recordActivity(app.db, {
          studyId: access.study.id, actorId: user.id, kind: "paper_read", title: p.title,
          url: studyUrl(access.study.slug, "papers"), targetType: "paper", targetId: paperId,
        });
    }
    return { studyPaper: studyPaperView((await loadStudyPaper(app, access.study.id, paperId))!) };
  });

  app.delete("/studies/:ref/papers/:paperId", async (request) => {
    const { ref, paperId } = parse(paperParams, request.params);
    const { access } = await requireStudyEditor(request, ref);
    const r = await app.db.query("DELETE FROM study_papers WHERE study_id=$1 AND paper_id=$2", [access.study.id, paperId]);
    if (!r.rowCount) throw notFound(NOT_IN_STUDY);
    return { ok: true };
  });

  /** AI: how this paper relates to the study (from the study summary). Returns Markdown to insert into notes. */
  app.post("/studies/:ref/papers/:paperId/ai/relevance", async (request) => {
    const { ref, paperId } = parse(paperParams, request.params);
    const { user, access } = await requireStudyEditor(request, ref);
    const row = await loadStudyPaper(app, access.study.id, paperId);
    if (!row) throw notFound(NOT_IN_STUDY);
    try {
      return await paperRelevance(aiFor(app), app.storage, row, access.study, { userId: user.id });
    } catch (e) {
      if (e instanceof NotEnoughText) throw new HttpError(422, e.message, { code: "no_text" });
      throw toHttpError(e);
    }
  });
}
