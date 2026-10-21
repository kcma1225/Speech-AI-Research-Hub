/**
 * Deck pages and layout reviews for the assistant:
 *  - `get_deck_pages` (read): page titles + speaker notes of a deck's rendered version (any type: Quarto, uploaded
 *    PDF/PPTX), and page images for the model when it can see them;
 *  - `review_deck_layout` / `review_latex_layout` (read): the existing vision layout review (「AI 檢查排版」,
 *    `lib/vision/*`) as a tool. Findings only: fixes come back as find/replace proposals that the assistant may turn into
 *    suggestions with `suggest_deck_edit` / `latex_suggest_edit` (the user still decides).
 */
import { z } from "zod";
import { aiFor } from "../../ai/platform/index.js";
import { badRequest, forbidden, HttpError, notFound } from "../../lib/http.js";
import { findCompile } from "../../lib/latex-projects/service.js";
import { findProject, isGeneratedBib } from "../../lib/latex-projects/store.js";
import { renderPdfPages, pdfPageSizes } from "../../lib/library/page-images.js";
import { pageImageKey } from "../../lib/slides/pages.js";
import { enqueuePreview } from "../../lib/slides/preview.js";
import { loadStudyAccess } from "../../lib/studies/access.js";
import { latexReviewContext, MAX_LATEX_PAGES, reviewLatex } from "../../lib/vision/latex.js";
import { imageFromBuffer, requireVision, type LayoutReview } from "../../lib/vision/review.js";
import { captureState, MAX_REVIEW_SLIDES, previewImages, reviewSlides, versionImages } from "../../lib/vision/slides.js";
import type { ToolImage } from "../images.js";
import { registerAgentTool, type AgentToolContext } from "./registry.js";
import { clip, isUuid, scrub, uuidArg } from "./util.js";

type DeckRow = { id: string; title: string; kind: "progress" | "paper_report"; study_id: string; created_by: string; active_version_id: string | null };
type VersionRow = { id: string; version: number; status: string; output_prefix: string; page_count: number | null; source_type: string; manifest_key: string | null; created_by: string | null };
const deckUrl = (slug: string, id: string) => `/studies/${encodeURIComponent(slug)}/decks/${id}`;

async function loadDeck(ctx: AgentToolContext, id: string, edit = false) {
  if (!isUuid(id)) throw notFound("簡報不存在。");
  const deck = (await ctx.db.query<DeckRow>("SELECT id,title,kind,study_id,created_by,active_version_id FROM decks WHERE id=$1", [id])).rows[0];
  if (!deck) throw notFound("簡報不存在。");
  const access = await loadStudyAccess(ctx.db, deck.study_id, ctx.user);
  if (edit && !access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能檢查這份簡報。`);
  return { deck, access };
}

/** The version to show: the given one, else the active one, else the newest rendered one. */
async function pickVersion(ctx: AgentToolContext, deck: DeckRow, versionId?: string): Promise<VersionRow | null> {
  const cols = "id,version,status,output_prefix,page_count,source_type,manifest_key,created_by";
  if (versionId) {
    if (!isUuid(versionId)) throw notFound("找不到這個版本。");
    return (await ctx.db.query<VersionRow>(`SELECT ${cols} FROM slide_versions WHERE deck_id=$1 AND id=$2`, [deck.id, versionId])).rows[0] ?? null;
  }
  if (deck.active_version_id) {
    const v = (await ctx.db.query<VersionRow>(`SELECT ${cols} FROM slide_versions WHERE id=$1`, [deck.active_version_id])).rows[0];
    if (v?.page_count) return v;
  }
  return (await ctx.db.query<VersionRow>(`SELECT ${cols} FROM slide_versions WHERE deck_id=$1 AND status IN ('published','review') AND page_count IS NOT NULL ORDER BY version DESC LIMIT 1`, [deck.id])).rows[0] ?? null;
}

const vision = (ctx: AgentToolContext) => (ctx.vision ? ctx.vision().catch(() => false) : Promise.resolve(false));

registerAgentTool({
  name: "get_deck_pages",
  title: "讀取簡報頁面",
  titleEn: "Read deck pages",
  risk: "read",
  mcp: false,
  description:
    "Read a deck's rendered pages (also uploaded PDF/PowerPoint decks): page titles and speaker notes. With `images` (≤ 4 page numbers) the page images are attached when you can see images — use it to read figures, tables or slide layout. Use get_deck for the Quarto source instead.",
  input: z.object({
    deck_id: uuidArg("Deck"),
    version_id: uuidArg("Version").optional(),
    from: z.number().int().min(1).max(1000).optional().describe("First page (default 1); up to 40 pages per call"),
    images: z.array(z.number().int().min(1).max(1000)).max(4).optional(),
  }),
  summarize: (a) => `讀取簡報頁面${a.images?.length ? `（看第 ${a.images.join("、")} 頁）` : ""}`,
  async execute(a, ctx) {
    const { deck, access } = await loadDeck(ctx, a.deck_id);
    const v = await pickVersion(ctx, deck, a.version_id);
    if (!v || !v.page_count) throw new HttpError(409, "這份簡報還沒有可讀的頁面（尚未上傳或還在轉檔）；Quarto 原始檔請用 get_deck。");
    const manifest = v.manifest_key ? await ctx.app.storage.getBuffer(v.manifest_key).then((b) => (b ? JSON.parse(b.toString("utf8")) : null)).catch(() => null) : null;
    const pages: Array<{ index: number; title?: string; notes?: { text?: string } }> = Array.isArray(manifest?.pages) ? manifest.pages : [];
    const from = a.from ?? 1;
    const slice = pages.filter((p) => p.index >= from).slice(0, 40);
    const list = slice.map((p) => ({ page: p.index, title: p.title ? scrub(p.title) : null, notes: p.notes?.text ? clip(scrub(p.notes.text), 800) : null }));
    const next = pages.find((p) => p.index > (slice.at(-1)?.index ?? from)) ? (slice.at(-1)?.index ?? from) + 1 : null;
    let images: ToolImage[] | undefined;
    let imageNote = "";
    if (a.images?.length) {
      if (!(await vision(ctx))) imageNote = "（目前的模型無法看圖，沒有附上頁面圖片。）";
      else {
        const size = v.source_type === "quarto" ? "thumb" : "full";
        images = [];
        for (const n of a.images.filter((n) => n <= v.page_count!)) {
          const buf = await ctx.app.storage.getBuffer(pageImageKey(v.output_prefix, n, size));
          if (buf) images.push({ mediaType: "image/webp", data: buf, label: `第 ${n} 頁` });
        }
        imageNote = images.length ? `附上第 ${a.images.join("、")} 頁的圖片${size === "thumb" ? "（480px 縮圖，小字可能看不清）" : ""}。` : "（找不到頁面圖片。）";
      }
    }
    return {
      data: { deck: { id: deck.id, title: scrub(deck.title), url: deckUrl(access.study.slug, deck.id) }, version: v.version, source_type: v.source_type, page_count: v.page_count, pages: list, next_from: next, images: images?.length ?? 0 },
      text: `${JSON.stringify({ deck: scrub(deck.title), version: v.version, source_type: v.source_type, page_count: v.page_count, pages: list, next_from: next })}\n${imageNote}`,
      images,
      untrusted: deck.created_by !== ctx.user.id || (!!v.created_by && v.created_by !== ctx.user.id),
      source: `簡報〈${clip(deck.title, 40)}〉`,
      links: [{ label: deck.title, url: deckUrl(access.study.slug, deck.id), kind: "deck" }],
    };
  },
});

/** Compact review for the model (fixes keep file ids so they can become suggestions). */
function reviewText(r: LayoutReview, intro: string) {
  return `${intro}\n${JSON.stringify({
    summary: r.summary,
    truncated: r.truncated,
    issues: r.issues.map((i) => ({ page: i.page, severity: i.severity, category: i.category, title: i.title, detail: i.detail, suggestion: i.suggestion, fix: i.fix ? { file_id: i.fix.file_id, path: i.fix.path, find: i.fix.find, replace: i.fix.replace } : null })),
  })}\n這些是建議；要修改時用 suggest_* 工具產生建議讓使用者確認，不要直接改。`;
}

registerAgentTool({
  name: "review_deck_layout",
  title: "檢查簡報排版",
  titleEn: "Review deck layout",
  risk: "read",
  mcp: false,
  description:
    "Vision layout review of a deck (overflow, crowding, contrast, tiny fonts, Lab-Hub format) like the editor's 「AI 檢查排版」. source \"preview\" (default for in-app Quarto decks) screenshots the current source (may take up to ~2 minutes the first time); \"version\" reviews the rendered version (uploaded PDF/PPTX decks). Returns findings and verified find/replace fixes — propose them with suggest_deck_edit, never apply silently.",
  input: z.object({ deck_id: uuidArg("Deck"), source: z.enum(["preview", "version"]).optional(), pages: z.array(z.number().int().min(1).max(1000)).max(MAX_REVIEW_SLIDES).optional() }),
  summarize: () => "用 AI 檢查簡報排版",
  async execute(a, ctx) {
    const { deck, access } = await loadDeck(ctx, a.deck_id, true);
    const platform = aiFor(ctx.app);
    await requireVision(platform, "slides");
    const hasTree = (await ctx.db.query("SELECT 1 FROM deck_source_trees WHERE deck_id=$1", [deck.id])).rowCount;
    const source = a.source ?? (hasTree ? "preview" : "version");
    let images;
    let truncated = false;
    let note: string | undefined;
    if (source === "preview") {
      if (!hasTree) throw badRequest("這份簡報沒有平台內的原始檔，請用 source \"version\"。");
      let cap = await captureState(ctx.db, deck.id);
      if (cap.state !== "ready" || cap.revision !== cap.current_revision) {
        await enqueuePreview(ctx.db, ctx.app.storage, deck.id, ctx.user.id, { shots: true });
        const deadline = Date.now() + 150_000;
        do {
          if (ctx.signal?.aborted) throw new HttpError(499, "已中止。");
          await new Promise((r) => setTimeout(r, 2000));
          cap = await captureState(ctx.db, deck.id);
        } while (cap.state === "capturing" && Date.now() < deadline);
      }
      if (cap.state !== "ready") throw new HttpError(409, cap.state === "failed" ? `擷取投影片畫面失敗：${cap.error ?? ""}` : "投影片畫面還在擷取中，請稍後再試。");
      const row = (await ctx.db.query<{ output_prefix: string }>("SELECT output_prefix FROM deck_previews WHERE id=$1", [cap.preview_id])).rows[0];
      if (!row) throw new HttpError(409, "找不到投影片截圖，請再試一次。");
      ({ images } = await previewImages(ctx.app.storage, row.output_prefix, cap.count, a.pages));
      truncated = cap.truncated;
      if (cap.truncated) note = `簡報共 ${cap.total ?? "?"} 頁，只擷取了前 ${cap.count} 頁。`;
    } else {
      const v = await pickVersion(ctx, deck);
      if (!v?.page_count) throw new HttpError(409, "這份簡報還沒有已轉檔的版本。");
      const r = await versionImages(ctx.app.storage, v, a.pages);
      images = r.images;
      truncated = r.truncated;
      note = [r.truncated ? `簡報共 ${v.page_count} 頁，只送出前 ${MAX_REVIEW_SLIDES} 頁。` : "", r.lowRes ? "截圖是 480px 寬的縮圖，只回報確定的問題。" : ""].join("") || undefined;
    }
    if (!images.length) throw new HttpError(409, "找不到頁面圖片。");
    const review = await reviewSlides(platform, ctx.db, ctx.app.storage, { id: deck.id, kind: deck.kind, title: deck.title }, images, { userId: ctx.user.id, truncated, note, signal: ctx.signal });
    return {
      data: { deck: { id: deck.id, title: scrub(deck.title) }, source, pages: review.pages, summary: review.summary, issues: review.issues.length, high: review.issues.filter((i) => i.severity === "high").length },
      text: reviewText(review, `簡報〈${scrub(deck.title)}〉的排版檢查（${source === "preview" ? "目前原始碼的預覽" : "已轉檔的版本"}）：`),
      untrusted: deck.created_by !== ctx.user.id,
      source: `簡報〈${clip(deck.title, 40)}〉`,
      links: [{ label: deck.title, url: deckUrl(access.study.slug, deck.id), kind: "deck" }],
    };
  },
});

registerAgentTool({
  name: "review_latex_layout",
  title: "檢查論文排版",
  titleEn: "Review LaTeX layout",
  risk: "read",
  mcp: false,
  description:
    "Vision layout review of a LaTeX project's latest successful PDF (overfull boxes, figures/tables, spacing, CJK typesetting, margins). `pages`: up to 6 PDF page numbers (default the first 4). Returns findings and verified find/replace fixes — propose them with latex_suggest_edit, never apply silently.",
  input: z.object({ project_id: uuidArg("LaTeX project"), compile_id: uuidArg("Compile").optional(), pages: z.array(z.number().int().min(1).max(5000)).max(MAX_LATEX_PAGES).optional() }),
  summarize: (a) => `用 AI 檢查論文排版${a.pages?.length ? `（第 ${a.pages.join("、")} 頁）` : ""}`,
  async execute(a, ctx) {
    if (!isUuid(a.project_id)) throw notFound("LaTeX 專案不存在。");
    const project = await findProject(ctx.db, a.project_id);
    if (!project) throw notFound("LaTeX 專案不存在。");
    const access = await loadStudyAccess(ctx.db, project.study_id, ctx.user);
    if (!access.canEdit) throw forbidden(`你不是〈${access.study.title}〉的成員，不能檢查這份論文。`);
    const platform = aiFor(ctx.app);
    await requireVision(platform, "writing");
    const compileId = a.compile_id && isUuid(a.compile_id)
      ? a.compile_id
      : (await ctx.db.query<{ id: string }>("SELECT id FROM latex_compiles WHERE project_id=$1 AND pdf_key IS NOT NULL ORDER BY created_at DESC LIMIT 1", [project.id])).rows[0]?.id;
    const compile = compileId ? await findCompile(ctx.db, project.id, compileId) : null;
    if (!compile?.pdf_key) throw new HttpError(409, "這份論文還沒有成功編譯出 PDF，請先編譯。");
    const pdf = await ctx.app.storage.getBuffer(compile.pdf_key);
    if (!pdf) throw notFound("找不到編譯後的 PDF。");
    const { numPages } = await pdfPageSizes(pdf, []);
    const wanted = (a.pages?.length ? a.pages : [1, 2, 3, 4]).filter((n) => n <= numPages).slice(0, MAX_LATEX_PAGES);
    if (!wanted.length) throw badRequest(`這份 PDF 只有 ${numPages} 頁。`);
    const rendered = await renderPdfPages(pdf, wanted.map((page) => ({ page, width: 1200 })));
    const images = rendered.map((buf, i) => imageFromBuffer(wanted[i]!, buf)).filter((x): x is NonNullable<typeof x> => !!x);
    const result = (compile.result ?? {}) as { errors?: never[]; warnings?: never[] };
    const { context, files } = await latexReviewContext(ctx.db, ctx.app.collab, project, wanted.map((page) => ({ page })), [...(result.warnings ?? []), ...(result.errors ?? [])]);
    const editable = files.filter((f) => !isGeneratedBib({ ...project, path: f.path }));
    const review = await reviewLatex(platform, { context, files: editable, images, userId: ctx.user.id, signal: ctx.signal });
    return {
      data: { project: { id: project.id, title: scrub(project.title) }, pages: review.pages, summary: review.summary, issues: review.issues.length, high: review.issues.filter((i) => i.severity === "high").length },
      text: reviewText(review, `論文〈${scrub(project.title)}〉第 ${wanted.join("、")} 頁（共 ${numPages} 頁）的排版檢查：`),
      untrusted: true,
      source: `論文〈${clip(project.title, 40)}〉`,
    };
  },
});
