/**
 * Agent tool of the slides module: `suggest_deck_edit` (a suggestion on one text file of a deck's in-app Quarto tree).
 * Imported once by `routes/slides.ts` so it registers at startup. Deck sources keep no version history, so even under
 * autopilot the change stays a pending suggestion the user accepts in the Quarto editor (never applied silently).
 */
import { z } from "zod";
import { registerAgentTool, type AgentToolContext } from "../../agent/tools/registry.js";
import { clip, isUuid, scrub, uuidArg } from "../../agent/tools/util.js";
import { createSuggestion } from "../suggestions/service.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { loadStudyAccess } from "../studies/access.js";
import { deckEditorUrl } from "./suggest-target.js";

type DeckFile = { id: string; path: string; kind: string; content: string | null; deck_id: string; title: string; study_id: string };

async function deckFile(ctx: AgentToolContext, a: { deck_id: string; file_id?: string; path?: string }) {
  if (!isUuid(a.deck_id)) throw notFound("簡報不存在。");
  const deck = (await ctx.db.query<{ id: string; title: string; study_id: string }>("SELECT id,title,study_id FROM decks WHERE id=$1", [a.deck_id])).rows[0];
  if (!deck) throw notFound("簡報不存在。");
  const access = await loadStudyAccess(ctx.db, deck.study_id, ctx.user);
  if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能修改這份簡報。`);
  const tree = (await ctx.db.query<{ entry: string }>("SELECT entry FROM deck_source_trees WHERE deck_id=$1", [deck.id])).rows[0];
  if (!tree) throw badRequest("這份簡報沒有平台內的 Quarto 原始檔（可能是上傳的 PDF / PowerPoint）。");
  const byId = a.file_id && isUuid(a.file_id);
  const file = (await ctx.db.query<DeckFile>(
    `SELECT f.id,f.path,f.kind,f.content,f.deck_id,$2::text AS title,$3::uuid AS study_id FROM deck_sources f
      WHERE f.deck_id=$1 AND ${byId ? "f.id=$4" : "f.path=$4"}`,
    [deck.id, deck.title, deck.study_id, byId ? a.file_id : (a.path ?? tree.entry)],
  )).rows[0];
  if (!file) throw notFound("簡報中沒有這個檔案。");
  if (file.kind !== "text") throw badRequest("只能修改文字檔。");
  return { file, access };
}

registerAgentTool({
  name: "suggest_deck_edit",
  title: "建議修改簡報",
  titleEn: "Suggest deck edit",
  risk: "write",
  suggests: true,
  description:
    "Propose changes to ONE text file of a deck's in-app Quarto source (default: the entry .qmd; read it first with get_deck). Give `content` (the full new file text) or `edits` (exact `before` passages from the current text and their replacement). Keep the Lab-Hub format (fixed YAML, one `## title` per slide, speaker notes in `::: {.notes}`). Creates a suggestion the user reviews in the Quarto editor; nothing is changed directly.",
  input: z.object({
    deck_id: uuidArg("Deck"),
    file_id: uuidArg("Source file").optional(),
    path: z.string().max(200).optional().describe("File path in the deck source, e.g. index.qmd (default: the entry file)"),
    content: z.string().max(200000).optional(),
    edits: z.array(z.object({ before: z.string().min(1).max(20000).describe("Exact current text (must appear once)"), after: z.string().max(20000) })).max(30).optional(),
    title: z.string().max(80).optional().describe("Short label, e.g. 補上實驗結果"),
  }),
  summarize: (a) => `建議修改簡報${a.path ? ` ${a.path}` : ""}${a.title ? `：${a.title}` : ""}${a.edits ? `（${a.edits.length} 處）` : ""}`,
  async target(a, ctx) {
    const { file, access } = await deckFile(ctx, a);
    return { studyId: access.study.id, studySlug: access.study.slug, label: `${file.title} · ${file.path}`, url: deckEditorUrl(access.study.slug, file.deck_id, file.id) };
  },
  async execute(a, ctx) {
    const { file, access } = await deckFile(ctx, a);
    if (a.content === undefined && !a.edits?.length) throw badRequest("請提供 content 或 edits。");
    const text = file.content ?? "";
    let hunks: { from: number; to: number; before: string; after: string }[] | undefined;
    if (a.content === undefined) {
      hunks = a.edits!.map((e) => {
        const at = text.indexOf(e.before);
        if (at < 0) throw conflict(`檔案中找不到這段文字：「${clip(scrub(e.before), 40)}」，請先用 get_deck 讀取目前內容。`);
        if (text.indexOf(e.before, at + 1) >= 0) throw badRequest(`這段文字出現多次，請提供更長的段落：「${clip(scrub(e.before), 40)}」`);
        return { from: at, to: at + e.before.length, before: e.before, after: e.after };
      });
    }
    const s = await createSuggestion({ db: ctx.db }, {
      targetType: "deck_source", targetId: file.id, proposedText: a.content, hunks, title: a.title || "AI 建議",
      source: "ai", actorId: ctx.user.id, conversationId: ctx.conversationId, user: ctx.user,
    });
    const url = deckEditorUrl(access.study.slug, file.deck_id, file.id);
    return {
      data: { suggestion_id: s.id, hunks: s.pending, status: "pending_review", file: { id: file.id, path: file.path } },
      links: [{ label: "在簡報編輯器檢視建議", url: `${url}&suggestion=${s.id}`, kind: "suggestion" }],
    };
  },
});

export const slideAgentToolsRegistered = true;
