/** Note tools (notes module helpers: lib/notes/store.ts, lib/suggestions/service.ts). */
import { z } from "zod";
import { transaction } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { createNote, disconnectNotes, findNote, forgetNoteDocs, listNotes, NOTE_KINDS, noteDocName, noteUrl, type NoteKind } from "../../lib/notes/store.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { applySuggestionNow, createSuggestion } from "../../lib/suggestions/service.js";
import { locate } from "../../lib/suggestions/diff.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, dateArg, editStudy, isUuid, readStudy, scrub, studyRef, studyTarget, taipeiToday, uuidArg } from "./util.js";

const NOTE_MISSING = "筆記不存在。";

async function noteWithAccess(ctx: AgentToolContext, id: string) {
  if (!isUuid(id)) throw notFound(NOTE_MISSING);
  const note = await findNote(ctx.db, id);
  if (!note) throw notFound(NOTE_MISSING);
  const access = await loadStudyAccess(ctx.db, note.study_id, ctx.user);
  return { note, access };
}

async function liveText(ctx: AgentToolContext, noteId: string, fallback: string) {
  const collab = ctx.app.collab;
  if (!collab) return fallback;
  return (await collab.readDoc(noteDocName(noteId), (doc) => doc.getText("content").toString())) ?? fallback;
}

/** Someone other than the caller created or edited the note. */
async function othersWrote(ctx: AgentToolContext, noteId: string, createdBy: string | null) {
  if (createdBy !== ctx.user.id) return true;
  const r = await ctx.db.query("SELECT 1 FROM note_versions WHERE note_id=$1 AND actor_id IS DISTINCT FROM $2 LIMIT 1", [noteId, ctx.user.id]);
  return (r.rowCount ?? 0) > 0;
}

registerAgentTool({
  name: "list_notes",
  title: "列出筆記",
  titleEn: "List notes",
  risk: "read",
  description: "List a study's notes (newest first) with id, title, date, kind, author and a short excerpt. `q` filters by keyword.",
  input: z.object({ study: studyRef, q: z.string().max(100).optional(), kind: z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]).optional(), limit: z.number().int().min(1).max(50).optional() }),
  summarize: (a) => (a.q ? `在研究 ${a.study} 搜尋筆記「${a.q}」` : `列出研究 ${a.study} 的筆記`),
  async execute(a, ctx) {
    const access = await readStudy(ctx, a.study);
    const { notes, search_mode } = await listNotes(ctx.db, access.study.id, { q: a.q, kind: a.kind, limit: a.limit ?? 20 });
    return {
      data: {
        study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
        search_mode,
        notes: notes.slice(0, a.limit ?? 20).map((n) => ({ id: n.id, title: n.title, date: n.event_date, kind: n.kind, author: n.creator_name, excerpt: clip(scrub(n.excerpt), 160), pending_suggestions: n.pending_suggestions })),
      },
      untrusted: notes.some((n) => n.created_by !== ctx.user.id || (n.updated_by && n.updated_by !== ctx.user.id)),
    };
  },
});

registerAgentTool({
  name: "get_note",
  title: "讀取筆記",
  titleEn: "Read note",
  risk: "read",
  description: "Read a note's live Markdown text (≤ 12 000 characters per call; use `offset` to continue). Includes its study and whether the user can edit it.",
  input: z.object({ note_id: uuidArg("Note"), offset: z.number().int().min(0).optional() }),
  summarize: () => "讀取筆記",
  async execute(a, ctx) {
    const { note, access } = await noteWithAccess(ctx, a.note_id);
    const text = scrub(await liveText(ctx, note.id, note.content_md));
    const offset = a.offset ?? 0;
    const chunk = text.slice(offset, offset + 12000);
    return {
      data: {
        note: { id: note.id, title: note.title, date: note.event_date, kind: note.kind, author: note.creator_name, url: noteUrl(access.study.slug, note.id) },
        study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
        can_edit: access.canEdit,
        length: text.length,
        offset,
        content_md: chunk,
        ...(offset + chunk.length < text.length ? { more: `還有 ${text.length - offset - chunk.length} 字，請用 offset=${offset + chunk.length} 繼續讀取` } : {}),
      },
      untrusted: await othersWrote(ctx, note.id, note.created_by),
      source: `${note.creator_name ?? "成員"}的筆記〈${note.title}〉`,
      links: [{ label: note.title, url: noteUrl(access.study.slug, note.id), kind: "note" }],
    };
  },
});

async function findTemplate(ctx: AgentToolContext, ref: string | undefined) {
  if (!ref) return null;
  const rows = (await ctx.db.query<{ id: string; name: string; kind: NoteKind; body_md: string }>(
    `SELECT id,name,kind,body_md FROM note_templates WHERE (scope='system' OR owner_id=$1)
       AND (id::text=$2 OR name=$2 OR kind=$2) ORDER BY (id::text=$2) DESC, (name=$2) DESC, scope='user' DESC, position LIMIT 1`,
    [ctx.user.id, ref],
  )).rows;
  if (!rows[0]) throw badRequest(`找不到範本「${ref}」。可用：研究筆記、實驗筆記、閱讀筆記、會議筆記，或 research / experiment / reading / meeting。`);
  return rows[0];
}

registerAgentTool({
  name: "create_note",
  title: "建立筆記",
  titleEn: "Create note",
  risk: "write",
  description: "Create a new note in a study the user is a member of, optionally from a template (template name, id or kind: research, experiment, reading, meeting). Without content the template skeleton is used.",
  input: z.object({
    study: studyRef,
    title: z.string().trim().min(1).max(200).optional(),
    template: z.string().max(80).optional().describe("Template name, id, or kind (research|experiment|reading|meeting)"),
    content_md: z.string().max(100000).optional(),
    event_date: dateArg.optional(),
  }),
  summarize: (a) => `建立筆記「${a.title ?? a.template ?? "新筆記"}」${a.template ? `（範本：${a.template}）` : ""}`,
  target: async (a, ctx) => studyTarget(await editStudy(ctx, a.study)),
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    const template = await findTemplate(ctx, a.template);
    const date = a.event_date ?? taipeiToday();
    const title = (a.title ?? `${template?.name ?? "筆記"} ${date}`).slice(0, 200);
    const id = await transaction(ctx.db, async (client) => {
      const locked = await loadStudyAccess(client, access.study.id, ctx.user, { forUpdate: true });
      if (!locked.canEdit) throw notFound("研究不存在。");
      return createNote(client, {
        studyId: locked.study.id, studySlug: locked.study.slug, title, templateId: template?.id ?? null, kind: template?.kind ?? "custom",
        contentMd: a.content_md ?? template?.body_md ?? "", eventDate: date, actorId: ctx.user.id, author: "ai",
      });
    });
    const url = noteUrl(access.study.slug, id);
    const stamp = (await ctx.db.query<{ stamp: string }>("SELECT updated_at::text || '#' || version AS stamp FROM notes WHERE id=$1", [id])).rows[0]?.stamp;
    return { data: { note: { id, title, url } }, links: [{ label: title, url, kind: "note" }], ...(stamp ? { undo: { kind: "note" as const, id, stamp } } : {}) };
  },
});

registerAgentTool({
  name: "suggest_note_edit",
  title: "建議修改筆記",
  titleEn: "Suggest note edit",
  risk: "write",
  suggests: true,
  description:
    "Propose changes to an existing note. Give either `content_md` (the full new text; it is diffed paragraph by paragraph) or `edits` (exact `before` passages from the current text and their replacement). Creates a suggestion the user reviews in the note editor; nothing is changed directly.",
  input: z.object({
    note_id: uuidArg("Note"),
    content_md: z.string().max(200000).optional(),
    edits: z.array(z.object({ before: z.string().min(1).max(20000).describe("Exact current text to replace (must appear once)"), after: z.string().max(20000) })).max(30).optional(),
    title: z.string().max(80).optional().describe("Short label, e.g. 整理實驗結果"),
  }),
  summarize: (a) => `建議修改筆記${a.title ? `：${a.title}` : ""}${a.edits ? `（${a.edits.length} 處）` : ""}`,
  async target(a, ctx) {
    const { note, access } = await noteWithAccess(ctx, a.note_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能修改這篇筆記。`);
    return { studyId: access.study.id, studySlug: access.study.slug, label: `${access.study.title} · ${note.title}`, url: noteUrl(access.study.slug, note.id) };
  },
  async execute(a, ctx) {
    const { note, access } = await noteWithAccess(ctx, a.note_id);
    if (a.content_md === undefined && !a.edits?.length) throw badRequest("請提供 content_md 或 edits。");
    let hunks: { from: number; to: number; after: string; before: string }[] | undefined;
    if (a.content_md === undefined) {
      const text = await liveText(ctx, note.id, note.content_md);
      hunks = a.edits!.map((e) => {
        const first = text.indexOf(e.before);
        if (first < 0) throw conflict(`筆記中找不到這段文字：「${clip(e.before, 40)}」，請先用 get_note 讀取目前內容。`);
        if (text.indexOf(e.before, first + 1) >= 0) throw badRequest(`這段文字在筆記中出現多次，請提供更長的段落：「${clip(e.before, 40)}」`);
        const at = locate(text, { from: first, to: first + e.before.length, before: e.before, after: e.after }) ?? { from: first, to: first + e.before.length };
        return { from: at.from, to: at.to, before: e.before, after: e.after };
      });
    }
    const input = {
      targetType: "note", targetId: note.id, proposedText: a.content_md, hunks, title: a.title || "AI 建議",
      source: "ai" as const, actorId: ctx.user.id, conversationId: ctx.conversationId, user: ctx.user,
    };
    const deps = { db: ctx.db, collab: ctx.app.collab ?? null };
    const url = noteUrl(access.study.slug, note.id);
    if (ctx.autopilot && ctx.source === "agent") {
      const r = await applySuggestionNow(deps, { ...input, source: "autopilot" });
      return { data: { applied: r.applied, suggestion_id: r.suggestion.id, note: { id: note.id, title: note.title } }, links: [{ label: "已自動套用 · 到版本紀錄復原", url: `${url}?versions=1`, kind: "suggestion" }] };
    }
    const s = await createSuggestion(deps, input);
    return {
      data: { suggestion_id: s.id, hunks: s.pending, status: "pending_review", note: { id: note.id, title: note.title } },
      links: [{ label: "在筆記中檢視建議", url: `${url}?suggestion=${s.id}`, kind: "suggestion" }],
    };
  },
});

registerAgentTool({
  name: "delete_note",
  title: "刪除筆記",
  titleEn: "Delete note",
  risk: "destructive",
  description: "Permanently delete a note (its versions and suggestions too). Always asks the user.",
  input: z.object({ note_id: uuidArg("Note") }),
  summarize: () => "刪除筆記",
  async target(a, ctx) {
    const { note, access } = await noteWithAccess(ctx, a.note_id);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能刪除這篇筆記。`);
    const versions = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM note_versions WHERE note_id=$1", [note.id])).rows[0]?.n ?? 0;
    return { studyId: access.study.id, studySlug: access.study.slug, label: `${access.study.title} · ${note.title}（${versions} 個版本）`, url: noteUrl(access.study.slug, note.id) };
  },
  async execute(a, ctx) {
    const { note, access } = await noteWithAccess(ctx, a.note_id);
    if (!access.canEdit) throw forbidden("只有研究成員可以修改。");
    await transaction(ctx.db, async (client) => {
      await forgetNoteDocs(client, [note.id]);
      await client.query("DELETE FROM notes WHERE id=$1", [note.id]);
    });
    disconnectNotes([note.id]);
    return { data: { deleted: true, title: note.title } };
  },
});
