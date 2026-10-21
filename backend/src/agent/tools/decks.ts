/** Read-only deck tools (the slides module may add `suggest_deck_edit` / `generate_deck_draft` via the registry). */
import { z } from "zod";
import { notFound } from "../../lib/http.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { registerAgentTool } from "./registry.js";
import { clip, isUuid, readStudy, scrub, studyRef, uuidArg } from "./util.js";

const deckUrl = (studySlug: string, deckId: string) => `/studies/${encodeURIComponent(studySlug)}/decks/${deckId}`;

registerAgentTool({
  name: "list_decks",
  title: "列出簡報",
  titleEn: "List decks",
  risk: "read",
  description: "List a study's slide decks (progress reports and paper reports) with the active version, its page count and whether the deck has an in-app Quarto source.",
  input: z.object({ study: studyRef }),
  summarize: (a) => `列出研究 ${a.study} 的簡報`,
  async execute(a, ctx) {
    const access = await readStudy(ctx, a.study);
    const rows = (await ctx.db.query<{ id: string; title: string; kind: string; created_by: string; updated_at: string; version: number | null; page_count: number | null; published_at: string | null; has_source: boolean }>(
      `SELECT d.id,d.title,d.kind,d.created_by,d.updated_at,v.version,v.page_count,v.published_at,
              EXISTS (SELECT 1 FROM deck_source_trees t WHERE t.deck_id=d.id) AS has_source
         FROM decks d LEFT JOIN slide_versions v ON v.id=d.active_version_id WHERE d.study_id=$1 ORDER BY d.updated_at DESC LIMIT 50`,
      [access.study.id],
    )).rows;
    return {
      data: { study: { id: access.study.id, slug: access.study.slug, title: access.study.title }, decks: rows.map((d) => ({ id: d.id, title: scrub(d.title), kind: d.kind, kind_label: d.kind === "paper_report" ? "論文報告" : "進度報告", active_version: d.version, pages: d.page_count, published_at: d.published_at, has_source: d.has_source })) },
      untrusted: rows.some((d) => d.created_by !== ctx.user.id),
    };
  },
});

registerAgentTool({
  name: "get_deck",
  title: "讀取簡報",
  titleEn: "Read deck",
  risk: "read",
  description: "Read a deck: title, kind, versions, and (for in-app Quarto decks) the file list and the entry .qmd text (≤ 12 000 characters).",
  input: z.object({ deck_id: uuidArg("Deck") }),
  summarize: () => "讀取簡報",
  async execute(a, ctx) {
    if (!isUuid(a.deck_id)) throw notFound("簡報不存在。");
    const deck = (await ctx.db.query<{ id: string; title: string; kind: string; study_id: string; created_by: string; active_version_id: string | null }>("SELECT id,title,kind,study_id,created_by,active_version_id FROM decks WHERE id=$1", [a.deck_id])).rows[0];
    if (!deck) throw notFound("簡報不存在。");
    const access = await loadStudyAccess(ctx.db, deck.study_id, ctx.user);
    const versions = (await ctx.db.query<{ id: string; version: number; status: string; source_type: string; page_count: number | null; published_at: string | null }>(
      "SELECT id,version,status,source_type,page_count,published_at FROM slide_versions WHERE deck_id=$1 ORDER BY version DESC LIMIT 10",
      [deck.id],
    )).rows;
    const tree = (await ctx.db.query<{ entry: string }>("SELECT entry FROM deck_source_trees WHERE deck_id=$1", [deck.id])).rows[0];
    let source = null;
    let othersWrote = deck.created_by !== ctx.user.id;
    if (tree) {
      const files = (await ctx.db.query<{ id: string; path: string; kind: string; bytes: number; content: string | null; updated_by: string | null }>("SELECT id,path,kind,bytes,CASE WHEN path=$2 THEN content END AS content,updated_by FROM deck_sources WHERE deck_id=$1 ORDER BY path", [deck.id, tree.entry])).rows;
      const entry = files.find((f) => f.path === tree.entry);
      othersWrote ||= files.some((f) => f.updated_by && f.updated_by !== ctx.user.id);
      source = { entry: tree.entry, entry_file_id: entry?.id ?? null, files: files.map((f) => ({ id: f.id, path: f.path, kind: f.kind, bytes: f.bytes })), entry_text: entry?.content ? clip(scrub(entry.content), 12000) : null };
    }
    return {
      data: { deck: { id: deck.id, title: scrub(deck.title), kind: deck.kind, url: deckUrl(access.study.slug, deck.id) }, study: { id: access.study.id, slug: access.study.slug, title: access.study.title }, can_edit: access.canEdit, versions, source },
      untrusted: othersWrote,
      source: `簡報〈${deck.title}〉`,
      links: [{ label: deck.title, url: deckUrl(access.study.slug, deck.id), kind: "deck" }],
    };
  },
});
