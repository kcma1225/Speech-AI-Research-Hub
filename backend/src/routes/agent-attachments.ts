/**
 * Assistant attachments (docs/architecture.md "Agent → Attachments"): files uploaded into a conversation and the
 * picker data (studies → notes / papers / decks / meetings / LaTeX projects of a study). Everyone signed in reads
 * every study; admins never reach these routes (workspaceGuard). Messages carry the refs (`attachments` on
 * POST …/messages); `src/agent/attachments/` resolves them.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import { loadStudyAccess } from "../lib/studies/access.js";
import { sectionTitle } from "../lib/latex-projects/store.js";
import {
  attachmentsInput, describeRef, ownUpload, storeUpload, uploadView, UPLOAD_ACCEPT, UPLOAD_IMAGE_MAX_BYTES, UPLOAD_MAX_BYTES,
} from "../agent/attachments/index.js";

const idParams = z.object({ id: z.uuid() });
const studiesQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const itemsQuery = z.object({
  study: z.string().trim().min(1).max(80),
  kind: z.enum(["note", "paper", "deck", "meeting", "latex_project"]),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const resolveInput = z.object({ conversation_id: z.uuid().nullable().optional(), attachments: attachmentsInput });

const likeOf = (q: string | undefined) => (q?.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

export default async function agentAttachments(app: FastifyInstance) {
  app.get("/agent/attach/formats", async (request) => {
    await requireUser(request);
    return { accept: UPLOAD_ACCEPT, maxBytes: UPLOAD_MAX_BYTES, maxImageBytes: UPLOAD_IMAGE_MAX_BYTES, maxPerMessage: 10 };
  });

  // ---------------------------------------------------------------- uploads

  app.post("/agent/conversations/:id/uploads", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個對話。");
    const conv = (await app.db.query<{ id: string; mode: string }>("SELECT id,mode FROM conversations WHERE id=$1 AND user_id=$2", [id, user.id])).rows[0];
    if (!conv) throw notFound("找不到這個對話。");
    if (!request.isMultipart()) throw badRequest("請選擇檔案。");
    let file: { name: string; bytes: Buffer } | null = null;
    for await (const part of request.parts({ limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } })) {
      if (part.type === "field") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      if (part.file.truncated) throw new HttpError(413, "檔案超過 30 MB。", { code: "too_large" });
      file = { name: (part.filename || "file").slice(0, 255), bytes: Buffer.concat(chunks) };
    }
    if (!file) throw badRequest("請選擇檔案。");
    const row = await storeUpload(app, user.id, conv.id, file);
    reply.code(201);
    return { attachment: uploadView(row) };
  });

  /** The uploaded file (conversation owner only; never rendered as HTML). */
  app.get("/agent/uploads/:id", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個檔案。");
    const up = await ownUpload(app.db, user.id, id);
    if (!up) throw notFound("找不到這個檔案。");
    const object = await app.storage.get(up.object_key);
    if (!object) throw notFound("找不到這個檔案。");
    const image = up.kind === "image";
    return reply
      .header("Content-Type", image ? up.mime : "application/octet-stream")
      .header("Content-Length", String(object.contentLength ?? up.bytes))
      .header("Cache-Control", "private, max-age=3600")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Content-Disposition", `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(up.filename)}`)
      .send(object.body);
  });

  /** The text the server extracted from an upload (what the assistant reads), for the chat's document viewer. */
  app.get("/agent/uploads/:id/text", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個檔案。");
    const up = await ownUpload(app.db, user.id, id);
    if (!up) throw notFound("找不到這個檔案。");
    reply.header("Cache-Control", "no-store");
    return { upload: uploadView(up), text_md: up.text_md ?? "" };
  });

  /** Removes an upload that no message references yet (chip removed before sending). */
  app.delete("/agent/uploads/:id", async (request) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "找不到這個檔案。");
    const up = await ownUpload(app.db, user.id, id);
    if (!up) throw notFound("找不到這個檔案。");
    const used = (await app.db.query("SELECT 1 FROM agent_messages WHERE conversation_id=$1 AND attachments @> $2::jsonb LIMIT 1", [up.conversation_id, JSON.stringify([{ kind: "upload", id }])])).rowCount;
    if (used) return { ok: true, kept: true };
    await app.db.query("DELETE FROM agent_uploads WHERE id=$1", [id]);
    await app.storage.delete(up.object_key).catch(() => undefined);
    return { ok: true, kept: false };
  });

  // ---------------------------------------------------------------- picker data

  /** Studies to pick from: mine first (owner/member/advisor), then the rest of the lab; archived last. */
  app.get("/agent/attach/studies", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(studiesQuery, request.query);
    const rows = (await app.db.query<{ id: string; slug: string; title: string; status: string; activity_at: string; my_role: string | null; owner_name: string | null }>(
      `SELECT s.id,s.slug,s.title,s.status,s.activity_at,sm.role AS my_role,
              (SELECT u.name FROM study_members o JOIN users u ON u.id=o.user_id WHERE o.study_id=s.id AND o.role='owner') AS owner_name
         FROM studies s LEFT JOIN study_members sm ON sm.study_id=s.id AND sm.user_id=$1
        WHERE ($2::text IS NULL OR s.title ILIKE $2 OR s.slug ILIKE $2)
        ORDER BY (sm.role IS NOT NULL) DESC, (s.status='archived'), s.activity_at DESC LIMIT $3`,
      [user.id, likeOf(q.q), q.limit ?? 100],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return { studies: rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, status: r.status, activity_at: r.activity_at, mine: !!r.my_role, my_role: r.my_role, owner: r.owner_name })) };
  });

  /** Items of one category in a study, most recent first. */
  app.get("/agent/attach/items", async (request, reply) => {
    const user = await requireUser(request);
    const q = parse(itemsQuery, request.query);
    const access = await loadStudyAccess(app.db, q.study, user);
    const sid = access.study.id;
    const like = likeOf(q.q);
    const limit = q.limit ?? 60;
    let items: Record<string, unknown>[];
    switch (q.kind) {
      case "note":
        items = (await app.db.query(
          `SELECT n.id,n.title,n.kind AS note_kind,n.event_date,n.updated_at AS date,u.name AS author FROM notes n LEFT JOIN users u ON u.id=n.created_by
            WHERE n.study_id=$1 AND ($2::text IS NULL OR n.title ILIKE $2) ORDER BY n.updated_at DESC LIMIT $3`,
          [sid, like, limit],
        )).rows;
        break;
      case "paper":
        items = (await app.db.query(
          `SELECT p.id,p.title,p.year,p.venue,p.authors_text AS authors,(p.pdf_key IS NOT NULL) AS has_pdf,sp.cite_key,sp.updated_at AS date
             FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
            WHERE sp.study_id=$1 AND ($2::text IS NULL OR p.title ILIKE $2 OR p.authors_text ILIKE $2 OR sp.cite_key ILIKE $2) ORDER BY sp.updated_at DESC LIMIT $3`,
          [sid, like, limit],
        )).rows.map((r) => ({ ...r, authors: String(r.authors ?? "").split(";").slice(0, 3).join(";") }));
        break;
      case "deck":
        items = (await app.db.query(
          `SELECT d.id,d.title,d.kind AS deck_kind,d.updated_at AS date,d.active_version_id,
                  COALESCE((SELECT json_agg(json_build_object('id',v.id,'version',v.version,'status',v.status,'page_count',v.page_count,'created_at',v.created_at) ORDER BY v.version DESC)
                              FROM (SELECT * FROM slide_versions WHERE deck_id=d.id ORDER BY version DESC LIMIT 20) v), '[]'::json) AS versions
             FROM decks d WHERE d.study_id=$1 AND ($2::text IS NULL OR d.title ILIKE $2) ORDER BY d.updated_at DESC LIMIT $3`,
          [sid, like, limit],
        )).rows;
        break;
      case "meeting":
        items = (await app.db.query(
          `SELECT m.id,m.title,m.held_at AS date,m.status FROM meetings m JOIN meeting_studies ms ON ms.meeting_id=m.id
            WHERE ms.study_id=$1 AND ($2::text IS NULL OR m.title ILIKE $2) ORDER BY m.held_at DESC LIMIT $3`,
          [sid, like, limit],
        )).rows;
        break;
      case "latex_project":
        items = (await app.db.query(
          `SELECT p.id,p.title,p.kind AS latex_kind,p.updated_at AS date,(SELECT count(*)::int FROM latex_files f WHERE f.project_id=p.id AND f.kind='text') AS text_files
             FROM latex_projects p WHERE p.study_id=$1 AND ($2::text IS NULL OR p.title ILIKE $2) ORDER BY p.updated_at DESC LIMIT $3`,
          [sid, like, limit],
        )).rows;
        break;
    }
    reply.header("Cache-Control", "no-store");
    return { study: { id: sid, slug: access.study.slug, title: access.study.title }, kind: q.kind, items };
  });

  /** Text files of a LaTeX project (main first, then sections in \input order) for picking specific sections. */
  app.get("/agent/attach/latex/:id/files", async (request, reply) => {
    const user = await requireUser(request);
    const { id } = parse(idParams, request.params, "LaTeX 專案不存在。");
    const project = (await app.db.query<{ study_id: string; title: string }>("SELECT study_id,title FROM latex_projects WHERE id=$1", [id])).rows[0];
    if (!project) throw notFound("LaTeX 專案不存在。");
    await loadStudyAccess(app.db, project.study_id, user);
    const rows = (await app.db.query<{ id: string; path: string; role: string; position: number | null; bytes: string; updated_at: string; head: string | null }>(
      `SELECT id,path,role,position,bytes,updated_at,CASE WHEN role IN ('section','main') THEN left(content,4000) END AS head
         FROM latex_files WHERE project_id=$1 AND kind='text'
        ORDER BY (role='main') DESC, (role='section') DESC, position NULLS LAST, path`,
      [id],
    )).rows;
    reply.header("Cache-Control", "no-store");
    return {
      project: { id, title: project.title },
      files: rows.map((r) => ({ id: r.id, path: r.path, role: r.role, position: r.position, bytes: Number(r.bytes), updated_at: r.updated_at, heading: r.head && r.role === "section" ? sectionTitle(r.head) : null })),
    };
  });

  /** Titles / links of refs (the 「目前頁面」 shortcut and restored drafts); same access checks as sending. */
  app.post("/agent/attach/resolve", async (request) => {
    const user = await requireUser(request);
    const input = parse(resolveInput, request.body);
    if (input.conversation_id) {
      const own = (await app.db.query("SELECT 1 FROM conversations WHERE id=$1 AND user_id=$2", [input.conversation_id, user.id])).rowCount;
      if (!own) throw notFound("找不到這個對話。");
    }
    const out = [];
    for (const ref of input.attachments) out.push(await describeRef(app, user, input.conversation_id ?? null, ref));
    return { attachments: out };
  });
}
