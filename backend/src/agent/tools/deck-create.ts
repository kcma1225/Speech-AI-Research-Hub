/**
 * `create_deck` (write): a new in-app Quarto deck (paper report or progress report) in a study, plus an AI draft
 * (`ai_slides_generate`, role `slides`) built from the paper's full text / the study's progress and the structure the
 * user agreed on in the chat (`instructions`). Same rules as POST /slides + POST /slides/:id/ai/generate.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../../db.js";
import { aiFor } from "../../ai/platform/index.js";
import { SLIDES_GENERATE_JOB, type SlidesGeneratePayload } from "../../ai-jobs/slides/generate.js";
import { enqueueJob } from "../../jobs/queue.js";
import { badRequest, notFound } from "../../lib/http.js";

const isForeignKeyViolation = (error: unknown) => (error as { code?: string })?.code === "23503";
import { newShareKey, type SlideProject } from "../../lib/slides/access.js";
import { freeSlug } from "../../lib/slides/create.js";
import { progressTitle, taipeiToday } from "../../lib/slides/templates.js";
import { getPaper } from "../../lib/library/store.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { registerAgentTool } from "./registry.js";
import { clip, editStudy, isUuid, studyRef, studyTarget, uuidArg } from "./util.js";

export const deckUrl = (studySlug: string, deckId: string) => `/studies/${encodeURIComponent(studySlug)}/decks/${deckId}`;

/** Tests: whether role `slides` can take a draft (default: AI status ok/degraded). */
let slidesReady: ((app: import("fastify").FastifyInstance) => Promise<boolean>) | null = null;
export const setSlidesReady = (fn: typeof slidesReady) => {
  slidesReady = fn;
};

async function slidesAvailable(app: import("fastify").FastifyInstance) {
  if (slidesReady) return slidesReady(app);
  const st = (await aiFor(app).status()).roles.slides?.state;
  return st === "ok" || st === "degraded";
}

registerAgentTool({
  name: "create_deck",
  title: "建立簡報",
  titleEn: "Create deck",
  risk: "write",
  description:
    "Create a new slide deck in a study the user is a member of and (by default) start a quick one-shot AI draft in the background. For building a full deck (verified outline, per-page writing, render and checks) use start_workflow instead; use this only for an empty deck (generate:false) or when the user explicitly asks for a quick draft. kind \"paper_report\" needs `paper_id` (a library paper; the draft uses its full text); kind \"progress\" uses the study's progress. " +
    "Put the slide structure agreed with the user (page titles + key points, language, emphasis) in `instructions`. Returns the deck URL and the draft's job_id; the draft takes a minute or two and the user is notified when it is done (the chat shows its live status).",
  input: z.object({
    study: studyRef,
    kind: z.enum(["paper_report", "progress"]),
    paper_id: uuidArg("Paper").optional(),
    title: z.string().trim().min(1).max(160).optional(),
    instructions: z.string().trim().max(2000).optional().describe("Structure and wishes for the AI draft"),
    generate: z.boolean().optional().describe("Default true: start the AI draft"),
  }),
  summarize: (a) => `建立${a.kind === "paper_report" ? "論文報告" : "進度報告"}簡報${a.title ? `「${clip(a.title, 40)}」` : ""}${a.generate === false ? "" : "並產生 AI 草稿"}`,
  target: async (a, ctx) => studyTarget(await editStudy(ctx, a.study)),
  async execute(a, ctx) {
    const access = await editStudy(ctx, a.study);
    if (a.kind === "paper_report" && !a.paper_id) throw badRequest("論文報告需要指定文獻（paper_id）。");
    const paper = a.paper_id ? (isUuid(a.paper_id) ? await getPaper(ctx.db, a.paper_id) : null) : null;
    if (a.paper_id && !paper) throw notFound("文獻不存在。");
    const date = taipeiToday();
    const title = clip(a.title ?? (a.kind === "paper_report" ? paper!.title : progressTitle(access.study.title, date)), 160);
    const generate = a.generate !== false;
    const ready = generate ? await slidesAvailable(ctx.app) : false;
    const { initSource } = await import("../../routes/slide-sources.js");
    const deckId = randomUUID();
    const slug = await freeSlug(ctx.db, title, date);
    let jobId: string | null = null;
    try {
      jobId = await transaction(ctx.db, async (client) => {
        const locked = await loadStudyAccess(client, access.study.id, ctx.user, { forUpdate: true });
        if (!locked.canEdit) throw badRequest("你已經不是這個研究的成員。");
        const project = (await client.query<SlideProject>(
          `INSERT INTO decks(id,study_id,kind,paper_id,metadata,title,slug,public_view,share_key,created_by,updated_by) VALUES($1,$2,$3,$4,'{}',$5,$6,false,$7,$8,$8) RETURNING *`,
          [deckId, access.study.id, a.kind, paper?.id ?? null, title, slug, newShareKey(), ctx.user.id],
        )).rows[0]!;
        await initSource(ctx.app, client, project, a.kind, ctx.user);
        await client.query("UPDATE studies SET activity_at=now() WHERE id=$1", [access.study.id]);
        if (!ready) return null;
        const payload: SlidesGeneratePayload = { deckId, userId: ctx.user.id, mode: a.kind, ...(a.instructions ? { instructions: a.instructions } : {}), fileName: `AI 草稿：${title}` };
        return enqueueJob(client, SLIDES_GENERATE_JOB, payload, ctx.user.id, 2);
      });
    } catch (e) {
      if (isForeignKeyViolation(e)) throw notFound("文獻不存在。");
      throw e;
    }
    const url = deckUrl(access.study.slug, deckId);
    const draft = !generate ? "not_requested" : jobId ? "queued" : "slides_unavailable";
    return {
      data: { deck: { id: deckId, title, kind: a.kind, url }, draft, job_id: jobId },
      text: JSON.stringify({
        deck_id: deckId, url, draft,
        job_id: jobId,
        message: draft === "queued" ? "簡報已建立，AI 草稿正在背景產生（約一兩分鐘；聊天中的工作狀態會即時更新）。完成或失敗時使用者會收到通知；完整且能編譯的草稿會自動發布為第 1 版，否則可在簡報頁預覽後按「發布」。草稿完成前不要用 suggest_deck_edit 改寫或續寫（會被草稿覆蓋）。" : draft === "slides_unavailable" ? "簡報已建立，但 AI 簡報生成目前維護中，沒有產生草稿；使用者可以之後在簡報頁按「AI 產生草稿」。" : "簡報已建立（空白範本）。",
      }),
      links: [{ label: title, url, kind: "deck" }],
    };
  },
});
