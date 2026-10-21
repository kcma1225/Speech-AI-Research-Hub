/**
 * Read tools that give the assistant context it used to lack (QA audit, 2026-10-21):
 * - `get_deck_reviews`: professors' per-page comments on decks (the agent used to say "no comments" while there were);
 * - `get_study_bibtex`: the study's real BibTeX (cite keys as LaTeX uses them) instead of the model typing entries;
 * - `get_recent_activity`: the study timeline (「這週做了什麼」) instead of a dozen list_* calls.
 */
import { z } from "zod";
import { badRequest, notFound } from "../../lib/http.js";
import { exportStudyBibtex } from "../../lib/library/study-export.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { registerAgentTool } from "./registry.js";
import { clip, isUuid, readStudy, scrub, studyRef, taipeiToday, uuidArg } from "./util.js";

const deckUrl = (studySlug: string, deckId: string) => `/studies/${encodeURIComponent(studySlug)}/decks/${deckId}`;

registerAgentTool({
  name: "get_deck_reviews",
  title: "讀取簡報評論",
  titleEn: "Read deck reviews",
  risk: "read",
  description:
    "Read the review comments on slide decks (mostly the advisor's feedback), with page number, deck version, author, date and replies. Give `deck_id` for one deck, or `study` for the latest comments on all of that study's decks.",
  input: z.object({
    deck_id: uuidArg("Deck").optional(),
    study: studyRef.optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20 (newest first)"),
  }),
  summarize: (a) => (a.deck_id ? "讀取簡報評論" : `讀取研究 ${a.study ?? ""} 的簡報評論`),
  async execute(a, ctx) {
    let studyId: string;
    let deckId: string | null = null;
    if (a.deck_id) {
      if (!isUuid(a.deck_id)) throw notFound("簡報不存在。");
      const deck = (await ctx.db.query<{ study_id: string }>("SELECT study_id FROM decks WHERE id=$1", [a.deck_id])).rows[0];
      if (!deck) throw notFound("簡報不存在。");
      studyId = deck.study_id;
      deckId = a.deck_id;
    } else if (a.study) studyId = (await readStudy(ctx, a.study)).study.id;
    else throw badRequest("請提供 deck_id 或 study。");
    const access = await loadStudyAccess(ctx.db, studyId, ctx.user);
    const reviews = (await ctx.db.query<{ id: string; deck_id: string; deck: string; body: string; page: number | null; version: number | null; author: string; author_id: string; role: string; created_at: string }>(
      `SELECT r.id,r.deck_id,d.title AS deck,r.body,r.page,v.version,u.name AS author,r.author_id,u.role,to_char(r.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS created_at
         FROM slide_reviews r JOIN decks d ON d.id=r.deck_id JOIN users u ON u.id=r.author_id LEFT JOIN slide_versions v ON v.id=r.version_id
        WHERE d.study_id=$1 AND ($2::uuid IS NULL OR r.deck_id=$2) ORDER BY r.created_at DESC LIMIT $3`,
      [studyId, deckId, a.limit ?? 20],
    )).rows;
    const replies = reviews.length
      ? (await ctx.db.query<{ review_id: string; body: string; author: string; author_id: string }>(
          "SELECT p.review_id,p.body,u.name AS author,p.author_id FROM slide_review_replies p JOIN users u ON u.id=p.author_id WHERE p.review_id=ANY($1::uuid[]) ORDER BY p.created_at",
          [reviews.map((r) => r.id)],
        )).rows
      : [];
    return {
      data: {
        study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
        reviews: reviews.map((r) => ({
          deck_id: r.deck_id, deck: scrub(r.deck), page: r.page, version: r.version, author: r.author, author_role: r.role === "professor" ? "教授" : "學生", at: r.created_at,
          body: clip(scrub(r.body), 1500),
          replies: replies.filter((p) => p.review_id === r.id).map((p) => ({ author: p.author, body: clip(scrub(p.body), 600) })),
        })),
        ...(reviews.length ? {} : { note: "這些簡報目前沒有評論。" }),
      },
      untrusted: reviews.some((r) => r.author_id !== ctx.user.id) || replies.some((p) => p.author_id !== ctx.user.id),
      source: "簡報評論",
      links: deckId ? [{ label: reviews[0]?.deck ?? "簡報", url: deckUrl(access.study.slug, deckId), kind: "deck" as const }] : [],
    };
  },
});

registerAgentTool({
  name: "get_study_bibtex",
  title: "取得研究的 BibTeX",
  titleEn: "Get study BibTeX",
  risk: "read",
  description:
    "The study's reading list as BibTeX, exactly as the hub exports it (study cite keys, the same keys LaTeX projects use in \\cite). Optionally only some papers (paper_ids). Use it instead of writing BibTeX entries yourself; long output is better offered as the download link.",
  input: z.object({ study: studyRef, paper_ids: z.array(uuidArg("Paper")).max(200).optional() }),
  summarize: (a) => `取得研究 ${a.study} 的 BibTeX`,
  async execute(a, ctx) {
    const access = await readStudy(ctx, a.study);
    const ids = a.paper_ids?.filter(isUuid);
    const { bibtex, keys, count } = await exportStudyBibtex(ctx.db, access.study.id, { paperIds: ids?.length ? ids : undefined });
    const download = `/api/studies/${encodeURIComponent(access.study.slug)}/papers/export?format=bibtex`;
    const text = scrub(bibtex);
    return {
      data: {
        study: { id: access.study.id, slug: access.study.slug, title: access.study.title },
        count, cite_keys: keys, download_url: download,
        bibtex: clip(text, 10000),
        ...(text.length > 10000 ? { note: "BibTeX 太長已截斷；請給使用者下載連結。" } : {}),
        ...(count ? {} : { note: "這個研究的文獻庫是空的。" }),
      },
      untrusted: count > 0,
      source: "文獻資料",
      links: count ? [{ label: "下載 BibTeX（.bib）", url: download, kind: "paper" as const }] : [],
    };
  },
});

const ACTIVITY_ZH: Record<string, string> = {
  study_created: "建立研究", study_renamed: "重新命名研究", stage_changed: "切換階段", milestone_done: "完成里程碑", task_done: "完成待辦", deck_published: "發布簡報", member_added: "加入成員",
  note_created: "建立筆記", paper_added: "加入文獻", papers_imported: "匯入文獻", summary_suggestion_applied: "更新研究簡述", latex_project_created: "建立 LaTeX 專案",
  meeting_confirmed: "確認會議紀錄",
};

registerAgentTool({
  name: "get_recent_activity",
  title: "查看最近動態",
  titleEn: "Recent activity",
  risk: "read",
  description:
    "The study timeline (tasks done, notes created, decks published, papers added, stage/milestone changes, meetings confirmed…) for one study, or across the user's own studies. Default: the last 7 days. Use it for 「這週做了什麼」「最近有什麼進展」; read the items themselves with get_note / get_deck etc. when details matter.",
  input: z.object({
    study: studyRef.optional().describe("Omit = all studies the user is a member of"),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("From this date (YYYY-MM-DD, Taipei); default 7 days ago"),
    actor: z.enum(["me", "anyone"]).optional().describe("Only the user's own actions (default anyone)"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  summarize: (a) => (a.study ? `查看研究 ${a.study} 的最近動態` : "查看我的研究最近動態"),
  async execute(a, ctx) {
    const studyId = a.study ? (await readStudy(ctx, a.study)).study.id : null;
    const since = a.since ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date(Date.now() - 7 * 86400_000));
    const rows = (await ctx.db.query<{ kind: string; title: string; url: string | null; actor: string | null; actor_id: string | null; at: string; study_id: string; study: string; slug: string }>(
      `SELECT a.kind,a.title,a.url,u.name AS actor,a.actor_id,to_char(a.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS at,s.id AS study_id,s.title AS study,s.slug
         FROM study_activity a JOIN studies s ON s.id=a.study_id LEFT JOIN users u ON u.id=a.actor_id
        WHERE a.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Taipei')
          AND (${studyId ? "a.study_id=$2" : "EXISTS (SELECT 1 FROM study_members m WHERE m.study_id=a.study_id AND m.user_id=$2)"})
          AND ($3::uuid IS NULL OR a.actor_id=$3)
        ORDER BY a.created_at DESC LIMIT $4`,
      [since, studyId ?? ctx.user.id, a.actor === "me" ? ctx.user.id : null, a.limit ?? 50],
    )).rows;
    return {
      data: {
        since, until: taipeiToday(),
        items: rows.map((r) => ({ at: r.at, study: r.study, study_slug: r.slug, kind: r.kind, kind_label: ACTIVITY_ZH[r.kind] ?? r.kind, title: clip(scrub(r.title), 200), actor: r.actor, url: r.url ?? undefined })),
        ...(rows.length ? {} : { note: "這段期間沒有動態紀錄（筆記內容的編輯不會出現在動態裡，可用 list_notes 查看）。" }),
      },
      untrusted: rows.some((r) => r.actor_id !== ctx.user.id),
      source: "研究動態",
    };
  },
});

export const contextReadToolsRegistered = true;
