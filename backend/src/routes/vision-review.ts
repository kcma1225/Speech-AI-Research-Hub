/**
 * 「AI 檢查排版」: vision layout reviews of slides (role `slides`) and LaTeX PDFs (role `writing`).
 * Only available while the role's route can take images (`ai.capabilities(role).vision`); otherwise 422
 * `vision_unavailable` (the UI hides the button and shows a hint instead). Reviews are returned, not stored;
 * fixes become suggestions only when the user asks (`…/suggest`).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiFor } from "../ai/platform/index.js";
import { badRequest, conflict, HttpError, notFound, parse } from "../lib/http.js";
import type { LatexDiagnostic } from "../lib/latex/contract.js";
import { findCompile } from "../lib/latex-projects/service.js";
import { findFile, isGeneratedBib, liveText } from "../lib/latex-projects/store.js";
import { requireDeckEditor } from "../lib/slides/access.js";
import { enqueuePreview } from "../lib/slides/preview.js";
import { fileById, loadTree } from "../lib/slides/sources.js";
import "../lib/slides/suggest-target.js";
import { createSuggestion } from "../lib/suggestions/service.js";
import { latexReviewContext, MAX_LATEX_PAGES, reviewLatex } from "../lib/vision/latex.js";
import { decodeClientImage, MAX_TOTAL_IMAGE_BYTES, requireVision } from "../lib/vision/review.js";
import { captureState, MAX_REVIEW_SLIDES, previewImages, reviewSlides, versionImages } from "../lib/vision/slides.js";
import { editableProject } from "./latex-shared.js";

const deckParams = z.object({ id: z.uuid() });
const pageList = z.array(z.number().int().min(1).max(1000)).max(MAX_REVIEW_SLIDES).optional();
const slideReviewInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("preview"), pages: pageList }),
  z.object({ source: z.literal("version"), versionId: z.uuid(), pages: pageList }),
]);
const fixInput = z.object({
  file_id: z.uuid(),
  find: z.string().min(1).max(2000),
  replace: z.string().max(4000),
  title: z.string().trim().max(120).optional(),
});
const latexReviewInput = z.object({
  compile_id: z.uuid(),
  pages: z
    .array(
      z.object({
        page: z.number().int().min(1).max(5000),
        image: z.string().min(16).max(3_000_000),
        sources: z.array(z.object({ path: z.string().min(1).max(300), from: z.number().int().min(1), to: z.number().int().min(1) })).max(20).optional(),
      }),
    )
    .min(1)
    .max(MAX_LATEX_PAGES),
});

/** Offsets of `find` in `text`; 409 unless it occurs exactly once (the source changed since the review). */
function locate(text: string, find: string) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw conflict("原始碼已經變更，找不到要修改的段落；請重新檢查排版。");
  return { from: at, to: at + find.length };
}

export default async function visionReview(app: FastifyInstance) {
  const platform = () => aiFor(app);

  // ---------------------------------------------------------------- slides

  app.get("/slides/:id/ai/layout-review/capture", async (request) => {
    const { id } = parse(deckParams, request.params);
    await requireDeckEditor(request, id);
    return { capture: await captureState(app.db, id) };
  });

  /** Queues a preview of the current revision with screenshots (reuses one that already has them). */
  app.post("/slides/:id/ai/layout-review/capture", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const { user } = await requireDeckEditor(request, id);
    if (!(await loadTree(app.db, id))) throw notFound("這份簡報還沒有平台內的原始檔。");
    await requireVision(platform(), "slides");
    const r = await enqueuePreview(app.db, app.storage, id, user.id, { shots: true });
    return reply.code(r.reused ? 200 : 202).send({ capture: await captureState(app.db, id) });
  });

  /** One screenshot of the newest shot preview (thumbnails in the review panel). */
  app.get("/slides/:id/ai/layout-review/shots/:n", async (request, reply) => {
    const { id, n } = parse(z.object({ id: z.uuid(), n: z.coerce.number().int().min(1).max(MAX_REVIEW_SLIDES) }), request.params);
    await requireDeckEditor(request, id);
    const cap = await captureState(app.db, id);
    if (cap.state !== "ready" || n > cap.count) throw notFound("找不到這一頁的截圖。");
    const row = (await app.db.query<{ output_prefix: string }>("SELECT output_prefix FROM deck_previews WHERE id=$1", [cap.preview_id])).rows[0];
    const buf = row ? await app.storage.getBuffer(`${row.output_prefix}_hub/shots/${n}.webp`) : null;
    if (!buf) throw notFound("找不到這一頁的截圖。");
    return reply
      .header("Content-Type", "image/webp")
      .header("Cache-Control", "private, max-age=300")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(buf);
  });

  app.post("/slides/:id/ai/layout-review", async (request) => {
    const { id } = parse(deckParams, request.params);
    const input = parse(slideReviewInput, request.body);
    const { user, project } = await requireDeckEditor(request, id);
    await requireVision(platform(), "slides");
    let images;
    let truncated = false;
    let note: string | undefined;
    let source: Record<string, unknown>;
    if (input.source === "preview") {
      const cap = await captureState(app.db, id);
      if (cap.state !== "ready") throw new HttpError(409, "請先擷取投影片畫面。", { code: "capture_required" });
      const row = (await app.db.query<{ output_prefix: string }>("SELECT output_prefix FROM deck_previews WHERE id=$1", [cap.preview_id])).rows[0];
      if (!row) throw new HttpError(409, "請先擷取投影片畫面。", { code: "capture_required" });
      ({ images } = await previewImages(app.storage, row.output_prefix, cap.count, input.pages));
      truncated = cap.truncated;
      if (cap.truncated) note = `簡報共 ${cap.total ?? "?"} 頁，只擷取了前 ${cap.count} 頁。`;
      source = { type: "preview", preview_id: cap.preview_id, revision: cap.revision, stale: cap.revision !== cap.current_revision };
    } else {
      const version = (await app.db.query<{ id: string; version: number; status: string; output_prefix: string; page_count: number | null; source_type: string; manifest_key: string | null }>(
        "SELECT id,version,status,output_prefix,page_count,source_type,manifest_key FROM slide_versions WHERE deck_id=$1 AND id=$2",
        [id, input.versionId],
      )).rows[0];
      if (!version || (version.status !== "published" && version.status !== "review")) throw notFound("找不到這個版本。");
      if (!version.page_count) throw badRequest("此版本沒有頁面資訊，請先重新產生頁面。");
      const r = await versionImages(app.storage, version, input.pages);
      images = r.images;
      truncated = r.truncated;
      const notes: string[] = [];
      if (r.truncated) notes.push(`簡報共 ${version.page_count} 頁，只送出前 ${MAX_REVIEW_SLIDES} 頁。`);
      if (r.lowRes) notes.push("截圖是 480px 寬的縮圖，太小的字可能看不清楚；只回報確定的問題。");
      note = notes.join("") || undefined;
      source = { type: "version", version_id: version.id, version: version.version, source_type: version.source_type };
    }
    if (!images.length) throw badRequest("找不到頁面圖片，請重新擷取。");
    const review = await reviewSlides(platform(), app.db, app.storage, { id: project.id, kind: project.kind, title: project.title }, images, { userId: user.id, truncated, note });
    return { review, source };
  });

  app.post("/slides/:id/ai/layout-review/suggest", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const input = parse(fixInput, request.body);
    const { user } = await requireDeckEditor(request, id);
    const file = await fileById(app.db, id, input.file_id);
    if (!file || file.kind !== "text" || typeof file.content !== "string") throw notFound("檔案不存在。");
    const { from, to } = locate(file.content, input.find);
    const suggestion = await createSuggestion({ db: app.db }, {
      targetType: "deck_source", targetId: file.id, hunks: [{ from, to, before: input.find, after: input.replace }],
      title: `AI 排版：${(input.title ?? "修正版面").slice(0, 60)}`, source: "ai", actorId: user.id, user,
    });
    return reply.code(201).send({ suggestion });
  });

  // ---------------------------------------------------------------- LaTeX

  app.post("/latex/:id/ai/layout-review", { bodyLimit: Math.ceil(MAX_TOTAL_IMAGE_BYTES * 1.4) + 200_000 }, async (request) => {
    const { id } = parse(deckParams, request.params);
    const input = parse(latexReviewInput, request.body, "請選擇要檢查的頁面。");
    const { user, project } = await editableProject(request, id);
    const compile = await findCompile(app.db, id, input.compile_id);
    if (!compile) throw notFound("找不到這次編譯。");
    await requireVision(platform(), "writing");
    const images = input.pages.map((p) => decodeClientImage(p.page, p.image));
    const result = (compile.result ?? {}) as { errors?: LatexDiagnostic[]; warnings?: LatexDiagnostic[] };
    const { context, files } = await latexReviewContext(app.db, app.collab, project, input.pages, [...(result.warnings ?? []), ...(result.errors ?? [])]);
    // The generated bibliography is rewritten before each compile: never suggest edits to it.
    const editable = files.filter((f) => !isGeneratedBib({ ...project, path: f.path }));
    const review = await reviewLatex(platform(), { context, files: editable, images, userId: user.id });
    return { review };
  });

  app.post("/latex/:id/ai/layout-review/suggest", async (request, reply) => {
    const { id } = parse(deckParams, request.params);
    const input = parse(fixInput, request.body);
    const { user, project } = await editableProject(request, id);
    const file = await findFile(app.db, id, input.file_id);
    if (!file || file.kind !== "text") throw notFound("檔案不存在。");
    if (isGeneratedBib({ ...project, path: file.path })) throw badRequest("這個檔案由文獻庫自動產生。");
    const text = await liveText(app.db, app.collab, file);
    const { from, to } = locate(text, input.find);
    const suggestion = await createSuggestion({ db: app.db, collab: app.collab }, {
      targetType: "latex_file", targetId: file.id, hunks: [{ from, to, before: input.find, after: input.replace }],
      title: `AI 排版：${(input.title ?? "修正版面").slice(0, 60)}`, source: "ai", actorId: user.id, user,
    });
    return reply.code(201).send({ suggestion });
  });
}
