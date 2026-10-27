/**
 * Notes module entry (registered once in app.ts, root level): the collaboration WebSocket `/api/collab`
 * (`app.collab`), notes, note templates and suggestions. See docs/architecture.md "Notes" and docs/editor-collab.md.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { aiFor, toHttpError } from "../ai/platform/index.js";
import type { ChatMessage } from "../ai/types.js";
import { registerCollab } from "../collab/plugin.js";
import { replaceText } from "../collab/text.js";
import { transaction, type Queryable } from "../db.js";
import { requireUser, type CurrentUser } from "../lib/auth.js";
import { badRequest, forbidden, HttpError, notFound, parse } from "../lib/http.js";
import { cleanOutput, continueMessages, DRAFT_SHOWN, draftMessages, partMessages, rewriteMessages } from "../lib/notes/ai.js";
import { mergeRefs, noteOutline, noteRefs, wholeNoteAsk } from "../lib/notes/outline.js";
import { noteDraftContext } from "../lib/notes/ai-context.js";
import {
  addVersion, createNote, disconnectNotes, findNote, forgetNoteDocs, listNotes, NOTE_KINDS, noteDocName, noteUrl, type NoteKind, type NoteRow,
} from "../lib/notes/store.js";
import { loadStudyAccess, permissionsOf, requireStudyEditor, requireStudyReader, type StudyAccess } from "../lib/studies/access.js";
import { registerStudyCleanup } from "../lib/studies/cleanup.js";
import { dateOnly } from "../lib/studies/tasks.js";
import { createSuggestion } from "../lib/suggestions/service.js";
import "../lib/suggestions/study-summary.js";
import noteTemplates from "./note-templates.js";
import suggestions from "./suggestions.js";

const MISSING = "筆記不存在。";
const noteParams = z.object({ id: z.uuid() });
const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });
const refParams = z.object({ ref: z.string().min(1).max(80) });
const title = z.string().trim().min(1).max(200);
const listQuery = z.object({
  q: z.string().max(200).optional(),
  template: z.uuid().optional(),
  kind: z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]).optional(),
  author: z.string().max(40).optional(),
});
const createInput = z.object({
  title: title.optional(),
  template_id: z.uuid().nullable().optional(),
  event_date: dateOnly.nullable().optional(),
  content_md: z.string().max(200_000).optional(),
});
const patchInput = z.object({ title: title.optional(), event_date: dateOnly.nullable().optional(), template_id: z.uuid().nullable().optional() });
const versionInput = z.object({ label: z.string().trim().max(200).optional() });
const instruction = z.string().trim().max(1000).optional();
const draftInput = z.object({ instruction });
const rewriteInput = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  before: z.string().max(50_000),
  mode: z.enum(["rewrite", "bullets", "shorten", "expand", "fix"]).default("rewrite"),
  instruction,
});
const continueInput = z.object({ at: z.number().int().min(0), instruction });

const MAX_VOICE_BYTES = 30 * 1024 * 1024;
const MAX_VOICE_SECONDS = 10 * 60 + 5;

const taipeiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());

async function noteWithAccess(request: FastifyRequest, id: string, db: Queryable = request.server.db): Promise<{ user: CurrentUser; note: NoteRow; access: StudyAccess }> {
  const user = await requireUser(request);
  const note = await findNote(db, id);
  if (!note) throw notFound(MISSING);
  return { user, note, access: await loadStudyAccess(db, note.study_id, user) };
}

async function editableNote(request: FastifyRequest, id: string) {
  const ctx = await noteWithAccess(request, id);
  if (!ctx.access.canEdit) throw forbidden("只有研究成員可以修改。");
  return ctx;
}

/** Live text of a note (the Yjs document; falls back to the materialized copy). */
async function liveText(app: FastifyInstance, note: NoteRow) {
  return (await app.collab.readDoc(noteDocName(note.id), (doc) => doc.getText("content").toString())) ?? note.content_md;
}

const templateVisible = async (db: Queryable, id: string, userId: string) =>
  (await db.query<{ id: string; name: string; kind: NoteKind; body_md: string; ai_prompt: string }>(
    "SELECT id,name,kind,body_md,ai_prompt FROM note_templates WHERE id=$1 AND (scope='system' OR owner_id=$2)",
    [id, userId],
  )).rows[0] ?? null;

registerStudyCleanup("notes", async (client, studyId) => {
  const ids = (await client.query<{ id: string }>("SELECT id FROM notes WHERE study_id=$1", [studyId])).rows.map((r) => r.id);
  await forgetNoteDocs(client, ids);
  return async () => disconnectNotes(ids);
});

// ---------------------------------------------------------------- SSE for AI actions

type SseSend = (event: string, data: unknown) => void;
/**
 * Streams an AI action as Server-Sent Events over the POST response: `delta` {text} while the model writes, then
 * `suggestion` {suggestion} (or `error` {error, code?, hint?}), then `done`. Errors before streaming starts are
 * normal JSON errors.
 */
async function streamAction(reply: FastifyReply, run: (send: SseSend, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const send: SseSend = (event, data) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.on("close", () => controller.abort());
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  try {
    await run(send, controller.signal);
  } catch (e) {
    const err = toHttpError(e);
    if (err instanceof HttpError) send("error", { error: err.message, ...err.extra });
    else {
      reply.log.error({ err: e }, "note ai action failed");
      send("error", { error: "AI 產生內容時發生錯誤，請稍後再試。" });
    }
  } finally {
    clearInterval(ping);
    send("done", {});
    res.end();
  }
}

async function streamChat(app: FastifyInstance, messages: ChatMessage[], maxTokens: number, userId: string, send: SseSend, signal: AbortSignal, meta?: { cut?: boolean }) {
  let text = "";
  for await (const ev of aiFor(app).chatStream("writing", { messages, maxTokens, temperature: 0.4, reasoning: { effort: "low" } }, { userId, signal })) {
    if (ev.type === "text_delta") {
      text += ev.text;
      send("delta", { text: ev.text });
    } else if (ev.type === "done" && meta) meta.cut = ev.stopReason === "max_tokens";
    else if (ev.type === "error") throw ev.error;
  }
  const out = cleanOutput(text);
  if (!out) throw new HttpError(502, "AI 沒有產生任何內容，請再試一次。");
  return out;
}

// ---------------------------------------------------------------- routes

async function notesRoutes(app: FastifyInstance) {
  app.get("/studies/:ref/notes", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const query = parse(listQuery, request.query);
    const { user, access } = await requireStudyReader(request, ref);
    const authorId = query.author === "me" ? user.id : query.author && z.uuid().safeParse(query.author).success ? query.author : undefined;
    const result = await listNotes(app.db, access.study.id, { q: query.q, templateId: query.template, kind: query.kind, authorId });
    reply.header("Cache-Control", "no-store");
    return { ...result, permissions: permissionsOf(access) };
  });

  app.post("/studies/:ref/notes", async (request, reply) => {
    const { ref } = parse(refParams, request.params);
    const input = parse(createInput, request.body);
    const { user, access } = await requireStudyEditor(request, ref);
    const template = input.template_id ? await templateVisible(app.db, input.template_id, user.id) : null;
    if (input.template_id && !template) throw badRequest("找不到這個範本。");
    const eventDate = input.event_date === undefined ? taipeiToday() : input.event_date;
    const noteTitle = input.title ?? `${template?.name ?? "筆記"} ${eventDate ?? taipeiToday()}`;
    const id = await transaction(app.db, (client) =>
      createNote(client, {
        studyId: access.study.id, studySlug: access.study.slug, title: noteTitle.slice(0, 200), templateId: template?.id ?? null, kind: template?.kind ?? "custom",
        contentMd: input.content_md ?? template?.body_md ?? "", eventDate, actorId: user.id,
      }),
    );
    reply.code(201);
    return { note: await findNote(app.db, id), url: noteUrl(access.study.slug, id) };
  });

  app.get("/notes/:id", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const { note, access } = await noteWithAccess(request, id);
    const template = note.template_id
      ? (await app.db.query("SELECT id,name,kind,scope FROM note_templates WHERE id=$1", [note.template_id])).rows[0] ?? null
      : null;
    reply.header("Cache-Control", "no-store");
    return {
      note: { ...note, content_md: await liveText(app, note) },
      doc_name: noteDocName(note.id),
      study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
      template,
      permissions: permissionsOf(access),
    };
  });

  app.patch("/notes/:id", async (request) => {
    const { id } = parse(noteParams, request.params);
    const input = parse(patchInput, request.body);
    const { user, note } = await editableNote(request, id);
    let kind: NoteKind | undefined;
    if (input.template_id) {
      const template = await templateVisible(app.db, input.template_id, user.id);
      if (!template) throw badRequest("找不到這個範本。");
      kind = template.kind;
    }
    await app.db.query(
      `UPDATE notes SET title=coalesce($2,title), event_date=CASE WHEN $3::boolean THEN $4::date ELSE event_date END,
              template_id=CASE WHEN $5::boolean THEN $6::uuid ELSE template_id END, kind=coalesce($7,kind), updated_at=now(), updated_by=$8 WHERE id=$1`,
      [note.id, input.title ?? null, input.event_date !== undefined, input.event_date ?? null, input.template_id !== undefined, input.template_id ?? null, kind ?? null, user.id],
    );
    app.collab.broadcast(noteDocName(note.id), { type: "meta" });
    return { note: await findNote(app.db, note.id) };
  });

  app.delete("/notes/:id", async (request) => {
    const { id } = parse(noteParams, request.params);
    const { note } = await editableNote(request, id);
    await transaction(app.db, async (client) => {
      await forgetNoteDocs(client, [note.id]);
      await client.query("DELETE FROM notes WHERE id=$1", [note.id]);
    });
    disconnectNotes([note.id]);
    return { ok: true };
  });

  // ---- versions

  app.get("/notes/:id/versions", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    await noteWithAccess(request, id);
    const versions = (
      await app.db.query(
        `SELECT v.id,v.version,v.kind,v.label,v.author,v.actor_id,u.name AS actor_name,v.created_at,length(v.content_md) AS size
           FROM note_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE v.note_id=$1 ORDER BY v.version DESC LIMIT 200`,
        [id],
      )
    ).rows;
    reply.header("Cache-Control", "no-store");
    return { versions };
  });

  app.get("/notes/:id/versions/:versionId", async (request, reply) => {
    const { id, versionId } = parse(versionParams, request.params);
    await noteWithAccess(request, id);
    const version = (
      await app.db.query(
        `SELECT v.id,v.version,v.kind,v.label,v.author,v.actor_id,u.name AS actor_name,v.created_at,v.content_md
           FROM note_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE v.note_id=$1 AND v.id=$2`,
        [id, versionId],
      )
    ).rows[0];
    if (!version) throw notFound("版本不存在。");
    reply.header("Cache-Control", "no-store");
    return { version };
  });

  app.post("/notes/:id/versions", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const input = parse(versionInput, request.body ?? {});
    const { user, note } = await editableNote(request, id);
    const text = await liveText(app, note);
    const version = await transaction(app.db, async (client) => {
      await client.query("UPDATE notes SET content_md=$2 WHERE id=$1", [note.id, text]);
      return addVersion(client, note.id, { kind: "manual", label: input.label ?? "", content: text, author: "user", actorId: user.id });
    });
    reply.code(201);
    return { version };
  });

  app.post("/notes/:id/versions/:versionId/restore", async (request) => {
    const { id, versionId } = parse(versionParams, request.params);
    const { user, note } = await editableNote(request, id);
    const old = (await app.db.query<{ version: number; content_md: string }>("SELECT version,content_md FROM note_versions WHERE note_id=$1 AND id=$2", [id, versionId])).rows[0];
    if (!old) throw notFound("版本不存在。");
    // Applied as a diff to the live document: connected editors see the change, nothing is rebuilt from text.
    await app.collab.edit(noteDocName(note.id), user.id, (_doc, ytext) => replaceText(ytext, old.content_md));
    const version = await transaction(app.db, async (client) => {
      await client.query("UPDATE notes SET content_md=$2, updated_at=now(), updated_by=$3 WHERE id=$1", [note.id, old.content_md, user.id]);
      return addVersion(client, note.id, { kind: "restore", label: `還原至第 ${old.version} 版`, content: old.content_md, author: "user", actorId: user.id });
    });
    return { version, note: await findNote(app.db, note.id) };
  });

  app.get("/notes/:id/export", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const { note } = await noteWithAccess(request, id);
    const text = await liveText(app, note);
    const file = `${note.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "note"}.md`;
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="note.md"; filename*=UTF-8''${encodeURIComponent(file)}`);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return `# ${note.title}\n\n${text}`;
  });

  // ---- voice input (role asr)

  app.post("/notes/:id/transcribe", async (request) => {
    const { id } = parse(noteParams, request.params);
    const { user } = await editableNote(request, id);
    if (!request.isMultipart()) throw badRequest("請上傳錄音檔。");
    const dir = await mkdtemp(join(tmpdir(), "voice-"));
    try {
      let durationSec: number | undefined;
      let language: string | undefined;
      let path: string | null = null;
      let mime = "audio/webm";
      for await (const part of request.parts({ limits: { fileSize: MAX_VOICE_BYTES, files: 1 } })) {
        if (part.type === "field") {
          if (part.fieldname === "durationSec") durationSec = Number(part.value);
          if (part.fieldname === "language" && typeof part.value === "string" && /^[a-zA-Z-]{2,10}$/.test(part.value)) language = part.value;
          continue;
        }
        mime = part.mimetype || mime;
        const ext = /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "webm";
        path = join(dir, `voice.${ext}`);
        await pipeline(part.file, createWriteStream(path));
        if (part.file.truncated) throw new HttpError(413, "錄音超過大小限制。");
      }
      if (!path || !(await stat(path)).size) throw badRequest("請上傳錄音檔。");
      if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_VOICE_SECONDS)) throw badRequest("錄音長度最多 10 分鐘。");
      try {
        const t = await aiFor(app).transcribe({ audio: { path, mime }, durationSec, language: language ?? "zh-TW", wordTimestamps: false }, { userId: user.id });
        const text = t.segments.map((s) => s.text.trim()).filter(Boolean).join(/^zh/.test(t.language ?? "zh") ? "" : " ");
        return { text, language: t.language, durationSec: t.durationSec };
      } catch (e) {
        throw toHttpError(e);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- AI actions (role writing) → suggestions, streamed

  const study = async (studyId: string) =>
    (await app.db.query<{ title: string; summary_md: string }>("SELECT title, summary_md FROM studies WHERE id=$1", [studyId])).rows[0]!;

  app.post("/notes/:id/ai/draft", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const input = parse(draftInput, request.body ?? {});
    const { user, note } = await editableNote(request, id);
    const template = note.template_id
      ? (await app.db.query<{ name: string; body_md: string; ai_prompt: string }>("SELECT name,body_md,ai_prompt FROM note_templates WHERE id=$1", [note.template_id])).rows[0] ?? null
      : null;
    const content = await liveText(app, note);
    // An instruction that names a part of the note (「把結論那段改成…」「第二節精簡一點」): only that part is rewritten,
    // everything else stays byte for byte.
    const instr = input.instruction ?? "";
    const parts = instr && content.trim() && !wholeNoteAsk(instr) ? mergeRefs(noteRefs(instr, noteOutline(content), content)) : [];
    if (parts.length) {
      if (parts.length > 6) throw badRequest("一次最多修改 6 個段落或章節，請縮小範圍。");
      await streamAction(reply, async (send, signal) => {
        const hunks: { from: number; to: number; before: string; after: string }[] = [];
        for (const part of parts) {
          const before = content.slice(part.from, part.to);
          const meta: { cut?: boolean } = {};
          const budget = Math.min(16000, Math.max(2400, Math.ceil(before.length * 1.6) + 1200));
          let out = await streamChat(app, partMessages({ part: before, label: part.label, instruction: instr, noteTitle: note.title, before: content.slice(0, part.from), after: content.slice(part.to) }), budget, user.id, send, signal, meta);
          if (meta.cut) throw new HttpError(502, `AI 修改${part.label}時輸出被截斷，為避免刪掉內容，這次沒有產生建議；請縮小範圍再試。`);
          if (/^（刪除）$/.test(out.trim())) out = "";
          else {
            const tail = /\s*$/.exec(before)![0];
            out = `${out.replace(/\s+$/, "")}${tail || ""}`;
          }
          hunks.push({ from: part.from, to: part.to, before, after: out });
        }
        const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
          targetType: "note", targetId: note.id, hunks, title: `AI 修改：${parts.map((p) => p.label).join("、")}`.slice(0, 80), source: "ai", actorId: user.id, user,
        });
        send("suggestion", { suggestion });
      });
      return;
    }
    // The whole note is regenerated only when the model sees all of it (no tail proposed as deleted).
    if (content.length > DRAFT_SHOWN) {
      throw badRequest(`這篇筆記有 ${content.length} 字，AI 草擬無法一次重寫整篇。請在指示中指明要改的部分（例如「第二節」「『結論』那段」），或選取文字後使用 AI 改寫。`);
    }
    const [s, related] = [await study(note.study_id), await noteDraftContext(app.db, note.study_id, note.id)];
    await streamAction(reply, async (send, signal) => {
      const meta: { cut?: boolean } = {};
      const budget = Math.min(16000, Math.max(4000, Math.ceil(content.length * 1.6) + 2000));
      const out = await streamChat(app, draftMessages({ study: s, note: { title: note.title, content, event_date: note.event_date }, template, instruction: input.instruction, related }), budget, user.id, send, signal, meta);
      if (meta.cut && content.trim()) throw new HttpError(502, "AI 的輸出被截斷，為避免刪掉筆記後半部，這次沒有產生建議；請指明要改的部分再試。");
      const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
        targetType: "note", targetId: note.id, proposedText: out.endsWith("\n") ? out : `${out}\n`, title: "AI 草擬", source: "ai", actorId: user.id, user,
      });
      send("suggestion", { suggestion });
    });
  });

  app.post("/notes/:id/ai/rewrite", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const input = parse(rewriteInput, request.body);
    const { user, note } = await editableNote(request, id);
    if (input.to <= input.from || !input.before.trim()) throw badRequest("請先選取要處理的文字。");
    const content = await liveText(app, note);
    if (content.slice(input.from, input.to) !== input.before) throw new HttpError(409, "內容已經變更，請重新選取後再試。");
    const context = content.slice(Math.max(0, input.from - 1500), Math.min(content.length, input.to + 1500));
    await streamAction(reply, async (send, signal) => {
      let out = await streamChat(app, rewriteMessages({ selection: input.before, mode: input.mode, instruction: input.instruction, noteTitle: note.title, context }), 2400, user.id, send, signal);
      if (input.before.endsWith("\n") && !out.endsWith("\n")) out += "\n";
      const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
        targetType: "note", targetId: note.id, hunks: [{ from: input.from, to: input.to, before: input.before, after: out }],
        title: input.mode === "bullets" ? "AI 整理成條列" : "AI 改寫", source: "ai", actorId: user.id, user,
      });
      send("suggestion", { suggestion });
    });
  });

  app.post("/notes/:id/ai/continue", async (request, reply) => {
    const { id } = parse(noteParams, request.params);
    const input = parse(continueInput, request.body);
    const { user, note } = await editableNote(request, id);
    const content = await liveText(app, note);
    const at = Math.min(input.at, content.length);
    await streamAction(reply, async (send, signal) => {
      const out = await streamChat(app, continueMessages({ before: content.slice(0, at), after: content.slice(at), noteTitle: note.title, instruction: input.instruction }), 2000, user.id, send, signal);
      const lead = at === 0 || content[at - 1] === "\n" ? "" : "\n\n";
      const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
        targetType: "note", targetId: note.id, hunks: [{ from: at, to: at, before: "", after: `${lead}${out}\n` }], title: "AI 接續撰寫", source: "ai", actorId: user.id, user,
      });
      send("suggestion", { suggestion });
    });
  });
}

/**
 * Root-level (fastify-plugin) so `@fastify/websocket` and `app.collab` are visible to every module registered
 * after it. Route plugins inside get the `/api` prefix explicitly.
 */
export default fp(
  async function notesModule(app: FastifyInstance) {
    await registerCollab(app);
    await app.register(notesRoutes, { prefix: "/api" });
    await app.register(noteTemplates, { prefix: "/api" });
    await app.register(suggestions, { prefix: "/api" });
  },
  { name: "notes-collab" },
);
