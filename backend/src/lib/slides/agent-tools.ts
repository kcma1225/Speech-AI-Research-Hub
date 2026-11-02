/**
 * Agent tool of the slides module: `suggest_deck_edit` (a suggestion on one text file of a deck's in-app Quarto tree).
 * Imported once by `routes/slides.ts` so it registers at startup. Deck sources keep no version history, so even under
 * autopilot the change stays a pending suggestion the user accepts in the Quarto editor (never applied silently).
 */
import { z } from "zod";
import { registerAgentTool, type AgentToolContext } from "../../agent/tools/registry.js";
import { clip, isUuid, scrub, uuidArg } from "../../agent/tools/util.js";
import { applyHunks } from "../suggestions/diff.js";
import { createSuggestion } from "../suggestions/service.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { loadStudyAccess } from "../studies/access.js";
import { deckPageOfOffset } from "../artifacts/view.js";
import { checkTurnRequirements, turnWords, unmetOf } from "../artifacts/turn-requirements.js";
import { renderDiagnosis } from "./render-followup.js";
import { checkDeckEdit, refusal } from "../artifacts/build-check.js";
import { newBibClaimProblems } from "../artifacts/facts.js";
import { preprintOnly } from "../library/published.js";
import { deckEditorUrl } from "./suggest-target.js";
import { artifactGrounded, UNGROUNDED_TARGET } from "../../workflows/context.js";

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
    "Propose changes to ONE text file of a deck's in-app Quarto source (default: the entry .qmd; read it first with get_deck). Give `content` (the full new file text) or `edits` (exact `before` passages from the current text and their replacement). Keep the Lab-Hub format (fixed YAML, one `## title` per slide, speaker notes in `::: {.notes}`). Page 1 is the cover = the front matter's title / subtitle: change the existing `subtitle:` line (never add a second key of the same name). An edit that would break the build (YAML errors, unclosed blocks) is refused with the reason. Creates a suggestion the user reviews in the Quarto editor; nothing is changed directly. The result lists `pages` (player page numbers the new text lands on), this conversation's `earlier_suggestions` on the file and a `warning` when an earlier edit put similar text on another page (moving content means removing the old copy too).",
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
    // Only the conversation's own deck or one the user named exactly (scenario matrix g22: a search pick was edited).
    if (ctx.source === "agent" && !(await artifactGrounded(ctx.db, ctx.conversationId, ctx.user.id, "deck", file.deck_id))) throw badRequest(UNGROUNDED_TARGET);
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
    // The file as it would be after the edit must still compile (production 61666f10: a second `subtitle:` in the front
    // matter broke the preview after the user accepted it): an edit's own breakage goes back to the model.
    const after = a.content ?? applyHunks(text, hunks!);
    // The edit gate (lib/artifacts/build-check.ts): the deck's rules, then a dry-run render of the tree with this file.
    const check = await checkDeckEdit(ctx.app, { id: file.deck_id }, file.path, text, after, { signal: ctx.signal });
    if (!check.ok) throw badRequest(refusal("簡報", check, "get_deck（只改需要改的那一行；封面副標題是修改既有的 subtitle 行）"));
    const earlier = await earlierSuggestions(ctx, file, after, hunks ?? null);
    const landed = pagesTouched(after, (hunks ?? [{ before: text, after }]).map((h) => addedText(h.before, h.after)));
    // The turn's own requirements on the edited deck (lib/artifacts/turn-requirements.ts): positions, the venue, language…
    const paper = (await ctx.db.query<{ venue: string | null; year: number | null; doi: string | null; arxiv_id: string | null; title: string; first: string | null }>(
      "SELECT p.venue, p.year, p.doi, p.arxiv_id, p.title, p.record->'authors'->0->>'family' AS first FROM decks d JOIN papers p ON p.id=d.paper_id WHERE d.id=$1",
      [file.deck_id],
    )).rows[0] ?? null;
    // What the edit says about its paper's venue needs the library record behind it (lib/artifacts/facts.ts).
    const claims = paper ? newBibClaimProblems(text, after, { venue: paper.venue, year: paper.year, preprint: preprintOnly(paper), title: paper.title, first_author: paper.first }) : [];
    if (claims.length) throw badRequest(refusal("簡報", { ok: false, problems: claims, verified: "static" }, "get_deck（論文出處以文獻庫為準；只有預印本時先用 refresh_paper_metadata 查證）"));
    const isEntry = (await ctx.db.query<{ entry: string }>("SELECT entry FROM deck_source_trees WHERE deck_id=$1", [file.deck_id])).rows[0]?.entry === file.path;
    const turnReqs = isEntry ? checkTurnRequirements(await turnWords(ctx.db, ctx.conversationId), "deck", after, { view: check.view, landed, venue: paper }) : [];
    const unmet = unmetOf(turnReqs);
    const s = await createSuggestion({ db: ctx.db }, {
      targetType: "deck_source", targetId: file.id, proposedText: a.content, hunks, title: a.title || "AI 建議",
      source: "ai", actorId: ctx.user.id, conversationId: ctx.conversationId, user: ctx.user,
    });
    const url = deckEditorUrl(access.study.slug, file.deck_id, file.id);
    return {
      data: {
        suggestion_id: s.id, hunks: s.pending, status: "pending_review", file: { id: file.id, path: file.path }, pages: landed,
        ...(turnReqs.length ? { user_requirements: turnReqs } : {}),
        ...(unmet.length ? { unmet_requirements: unmet.map((r) => `${r.text}：${r.detail}`), unmet_hint: "這個建議已建立，但沒有符合使用者這一輪的要求：再提一個建議修正（或在回答中說明為什麼做不到）。" } : {}),
        ...(earlier.list.length ? { earlier_suggestions: earlier.list } : {}),
        ...(earlier.warning ? { warning: earlier.warning } : {}),
        build_check: check.verified, ...(check.note ? { build_note: check.note } : {}),
      },
      links: [{ label: "在簡報編輯器檢視建議", url: `${url}&suggestion=${s.id}`, kind: "suggestion" }],
    };
  },
});

registerAgentTool({
  name: "get_deck_render_error",
  title: "讀取簡報編譯錯誤",
  titleEn: "Read deck build error",
  risk: "read",
  description: "Why a deck's preview does not compile: the newest preview's status and error log, the structural problems of the current entry file (YAML errors such as a key written twice, unclosed ::: / ``` blocks; with line numbers) and the suggestions applied since the last preview that compiled (title, by ai / user, conversation). Use it when a deck fails to compile, then fix the cause with suggest_deck_edit.",
  input: z.object({ deck_id: uuidArg("Deck") }),
  summarize: () => "讀取簡報編譯錯誤",
  async execute(a, ctx) {
    if (!isUuid(a.deck_id)) throw notFound("簡報不存在。");
    const deck = (await ctx.db.query<{ study_id: string }>("SELECT study_id FROM decks WHERE id=$1", [a.deck_id])).rows[0];
    if (!deck) throw notFound("簡報不存在。");
    await loadStudyAccess(ctx.db, deck.study_id, ctx.user);
    const d = await renderDiagnosis(ctx.db, a.deck_id);
    if (!d) throw notFound("簡報不存在。");
    const mine = d.changes.filter((c) => c.conversation_id && c.conversation_id === ctx.conversationId);
    return {
      data: {
        ...d,
        ...(mine.length ? { from_this_conversation: mine.map((c) => c.title) } : {}),
        hint: d.status !== "failed" ? "最新的預覽沒有編譯失敗。" : d.problems.length ? "problems 列出的通常就是原因：照行號修正那一行。" : "原始檔沒有結構問題：看 error 的訊息（常見：引用不存在的檔案、diagram／chart 語法、Quarto 擴充）。",
      },
      links: [{ label: "開啟簡報編輯器", url: `/studies/${d.deck.study_slug}/decks/${d.deck.id}/edit` }],
    };
  },
});

/** The player's page (the cover is 1) holding offset `at` of a deck source (the shared view's numbering). */
export const pageAt = (text: string, at: number) => deckPageOfOffset(text, at);

/** Pages an edit's new text lands on (located in the file after the edit). */
export function pagesTouched(after: string, added: string[]): number[] {
  const out = new Set<number>();
  for (const a of added) {
    const t = a.trim();
    if (!t) continue;
    const at = after.indexOf(t);
    if (at >= 0) out.add(pageAt(after, at));
  }
  return [...out].sort((x, y) => x - y);
}

const bigramSet = (s: string) => {
  const t = s.toLowerCase().replace(/[\s*_`>#:|：，,。.、()（）「」-]+/g, "");
  const g = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
  return g;
};
/** Dice similarity of two snippets' character bigrams. */
export function snippetSimilarity(a: string, b: string): number {
  const x = bigramSet(a);
  const y = bigramSet(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

/** What an edit adds: `after` without the prefix / suffix it shares with `before`. */
export function addedText(before: string, after: string): string {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  let j = 0;
  while (j < before.length - i && j < after.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j++;
  return after.slice(i, after.length - j).trim();
}

type EarlierRow = { id: string; title: string; status: string; created_at: string; hunks: { before: string; after: string; status: string }[] };

/**
 * This conversation's earlier suggestions on the same file (production 61666f10: the venue went on page 2, the user said
 * 「第一頁不是第二頁」, the cover got it too and page 2 kept it). Each with where its added text sits now; `warning` when
 * the new edit adds what an earlier, still-present edit added on another page — the old copy has to go in this edit.
 */
async function earlierSuggestions(ctx: AgentToolContext, file: DeckFile, after: string, hunks: { from: number; before: string; after: string }[] | null) {
  if (!ctx.conversationId) return { list: [], warning: null as string | null };
  const rows = (await ctx.db.query<EarlierRow>(
    `SELECT id, title, status, created_at, hunks FROM suggestions
      WHERE created_by_conversation=$1 AND target_type='deck_source' AND target_id=$2 AND source='ai'
      ORDER BY created_at DESC LIMIT 8`,
    [ctx.conversationId, file.id],
  )).rows;
  const current = file.content ?? "";
  const added = (hunks ?? [{ before: current, after }]).map((h) => addedText(h.before, h.after)).filter((x) => x.length >= 8);
  const newPages = pagesTouched(after, added);
  let warning: string | null = null;
  const list = rows.map((r) => {
    const live = r.hunks.filter((h) => h.status !== "rejected").map((h) => addedText(h.before, h.after)).filter((x) => x.length >= 8 && current.includes(x));
    const pages = [...new Set(live.map((x) => pageAt(current, current.indexOf(x))))].sort((x, y) => x - y);
    for (const x of live) {
      const page = pageAt(current, current.indexOf(x));
      // Still there after this edit, like what this edit adds, and on a page this edit does not touch.
      if (!warning && after.includes(x) && newPages.length && !newPages.includes(page) && added.some((y) => snippetSimilarity(x, y) >= 0.5)) {
        warning = `你先前的建議「${r.title}」已經在第 ${page} 頁加了相似的內容（「${clip(scrub(x), 50)}」），這次又加在第 ${newPages.join("、")} 頁：如果使用者是要「搬到」新位置，要再提一個建議把第 ${page} 頁那段刪掉；兩處都要的話，回覆時說清楚。`;
      }
    }
    return { id: r.id, title: r.title, status: r.status === "pending" ? "pending_review" : r.status, pages_with_its_text: pages };
  });
  return { list, warning };
}

export const slideAgentToolsRegistered = true;
