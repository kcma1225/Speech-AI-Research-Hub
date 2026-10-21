/**
 * Slides layout review (「AI 檢查排版與設計」, role `slides`). Images come from
 *  - the editor's preview: a `slide_preview` job with `shots: true` writes `<outputPrefix>_hub/shots/<n>.webp`
 *    (1280 px, ≤ 20 slides) + `_hub/shots.json`; or
 *  - a published/review version: `_hub/pages/<n>-full.webp` (pdf/pptx, 1920 px) or `<n>-thumb.webp` (quarto, 480 px).
 * The deck's in-app source (entry .qmd + small style files) is sent with line numbers so fixes map to the source.
 */
import type { Queryable } from "../../db.js";
import type { AiPlatform } from "../../ai/platform/platform.js";
import { LABHUB_RULES } from "../slides/templates.js";
import { listFiles, loadTree } from "../slides/sources.js";
import { pageImageKey } from "../slides/pages.js";
import type { Storage } from "../storage.js";
import { imageFromBuffer, numbered, runReview, SLIDE_CATEGORIES, type LayoutReview, type ReviewImage, type SourceFile } from "./review.js";

export const MAX_REVIEW_SLIDES = 20;

export type CaptureState = {
  state: "none" | "capturing" | "ready" | "failed";
  preview_id: string | null;
  /** Revision the screenshots show, and the tree's current revision (stale when they differ). */
  revision: number | null;
  current_revision: number | null;
  count: number;
  total: number | null;
  truncated: boolean;
  stage: string | null;
  progress: number | null;
  error: string | null;
};

type ShotRow = { id: string; revision: number; status: string; output_prefix: string; error: string | null; job_status: string | null; stage: string | null; progress: number | null; result: { shots?: { count?: number; total?: number; truncated?: boolean; error?: string } } | null };

async function newestShotPreview(db: Queryable, deckId: string): Promise<ShotRow | null> {
  return (await db.query<ShotRow>(
    `SELECT p.id,p.revision,p.status,p.output_prefix,p.error,j.status AS job_status,j.stage,j.progress,j.result
       FROM deck_previews p JOIN jobs j ON j.id=p.job_id
      WHERE p.deck_id=$1 AND (j.payload->>'shots')::boolean IS TRUE ORDER BY p.created_at DESC LIMIT 1`,
    [deckId],
  )).rows[0] ?? null;
}

export async function captureState(db: Queryable, deckId: string): Promise<CaptureState> {
  const tree = await loadTree(db, deckId);
  const row = await newestShotPreview(db, deckId);
  const base = { current_revision: tree?.revision ?? null, total: null, truncated: false, stage: null, progress: null, error: null };
  if (!row) return { ...base, state: "none", preview_id: null, revision: null, count: 0 };
  const shots = row.result?.shots;
  if (row.status === "queued") return { ...base, state: "capturing", preview_id: row.id, revision: row.revision, count: 0, stage: row.stage, progress: row.progress };
  if (row.status === "ready" && (shots?.count ?? 0) > 0) {
    return { ...base, state: "ready", preview_id: row.id, revision: row.revision, count: shots!.count!, total: shots!.total ?? null, truncated: Boolean(shots!.truncated) };
  }
  const error = row.status === "cancelled" ? "已由較新的預覽取代，請重新擷取。" : shots?.error ?? row.error ?? "無法擷取投影片畫面。";
  return { ...base, state: "failed", preview_id: row.id, revision: row.revision, count: 0, error };
}

/** Text source files the model may cite (entry first; style files only when small). */
async function deckSources(db: Queryable, deckId: string): Promise<{ files: SourceFile[]; entry: string | null }> {
  const tree = await loadTree(db, deckId);
  if (!tree) return { files: [], entry: null };
  const all = await listFiles(db, deckId, true);
  const files: SourceFile[] = [];
  for (const f of all as Array<{ id: string; path: string; kind: string; content?: string | null }>) {
    if (f.kind !== "text" || typeof f.content !== "string") continue;
    if (f.path === tree.entry || (/\.(s?css)$/i.test(f.path) && f.content.length < 6000)) files.push({ id: f.id, path: f.path, text: f.content });
  }
  files.sort((a, b) => (a.path === tree.entry ? -1 : b.path === tree.entry ? 1 : a.path.localeCompare(b.path)));
  return { files, entry: tree.entry };
}

const SYSTEM = `你是實驗室投影片的版面與設計審閱者。你會看到 Quarto revealjs 簡報每一頁的截圖（依序標示頁碼）以及原始碼。
只依截圖上實際看到的畫面判斷版面與設計：
- overflow：文字、表格、圖片或公式超出投影片範圍或被裁切
- crowding：一頁內容太多、行距太擠、該拆頁
- contrast：文字與背景對比不足、顏色難以辨識
- alignment：對齊、間距、圖文排列不一致
- font_size：字太小（投影片寬 1280px 時，內文小於約 20px、表格小於約 16px 就算太小）
- consistency：與 Lab-Hub 格式不一致（每頁「## 標題」、固定頁數與標題、講稿放在 ::: {.notes}）
不要評論研究內容是否正確，不要要求加主題或大量 CSS。修正以原始碼的最小修改表達，例如拆成兩頁、刪減文字、加 {.smaller}、
調整圖片寬度 {width="60%"}、表格改用較少欄位。講稿（notes）不會顯示在截圖上，不要因此回報缺漏；截圖刻意隱藏了 revealjs 的控制鈕、進度條與頁碼（slide-number），也不要回報。`;

export async function reviewSlides(
  platform: AiPlatform,
  db: Queryable,
  storage: Storage,
  deck: { id: string; kind: "progress" | "paper_report"; title: string },
  images: ReviewImage[],
  opts: { userId: string; truncated?: boolean; note?: string; signal?: AbortSignal; maxTokens?: number },
): Promise<LayoutReview> {
  const { files } = await deckSources(db, deck.id);
  const sources = files.map((f) => `<資料 檔案="${f.path}">\n${numbered(f.text, 1, Number.POSITIVE_INFINITY, f === files[0] ? 24_000 : 4000)}\n</資料>`).join("\n\n");
  const context = [
    `簡報：〈${deck.title}〉（${deck.kind === "paper_report" ? "論文報告" : "進度報告"}），共送出 ${images.length} 頁截圖。`,
    LABHUB_RULES[deck.kind],
    opts.note ?? "",
    sources ? `原始碼（每行前面是行號，find 不要包含行號）：\n${sources}` : "這份簡報沒有線上原始碼（上傳的 PDF/PPTX 或 ZIP），find/replace 一律用 null，只給文字建議。",
  ].filter(Boolean).join("\n\n");
  return runReview(platform, "slides", { system: SYSTEM, context, categories: SLIDE_CATEGORIES, images, files, truncated: opts.truncated, userId: opts.userId, signal: opts.signal, maxTokens: opts.maxTokens });
}

/** Screenshots of a ready shot preview (pages 1..count, optionally a subset). */
export async function previewImages(storage: Storage, outputPrefix: string, count: number, pages?: number[]): Promise<{ images: ReviewImage[]; titles: Map<number, string> }> {
  const manifest = await storage.getBuffer(`${outputPrefix}_hub/shots.json`).then((b) => (b ? (JSON.parse(b.toString("utf8")) as { pages?: Array<{ index: number; title?: string }> }) : null)).catch(() => null);
  const titles = new Map((manifest?.pages ?? []).filter((p) => p.title).map((p) => [p.index, p.title!]));
  const wanted = (pages?.length ? pages : Array.from({ length: count }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= count).slice(0, MAX_REVIEW_SLIDES);
  const images: ReviewImage[] = [];
  for (const n of wanted) {
    const buf = await storage.getBuffer(`${outputPrefix}_hub/shots/${n}.webp`);
    const img = buf ? imageFromBuffer(n, buf, titles.get(n)) : null;
    if (img) images.push(img);
  }
  return { images, titles };
}

/** Page images of a rendered version (full size for pdf/pptx, thumbnails for quarto). */
export async function versionImages(storage: Storage, version: { output_prefix: string; page_count: number | null; source_type: string; manifest_key: string | null }, pages?: number[]) {
  const count = version.page_count ?? 0;
  const size = version.source_type === "quarto" ? "thumb" : "full";
  const manifest = version.manifest_key
    ? await storage.getBuffer(version.manifest_key).then((b) => (b ? (JSON.parse(b.toString("utf8")) as { pages?: Array<{ index: number; title?: string }> }) : null)).catch(() => null)
    : null;
  const titles = new Map((manifest?.pages ?? []).filter((p) => p.title).map((p) => [p.index, p.title!]));
  const wanted = (pages?.length ? pages : Array.from({ length: count }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= count);
  const truncated = wanted.length > MAX_REVIEW_SLIDES;
  const images: ReviewImage[] = [];
  for (const n of wanted.slice(0, MAX_REVIEW_SLIDES)) {
    const buf = await storage.getBuffer(pageImageKey(version.output_prefix, n, size));
    const img = buf ? imageFromBuffer(n, buf, titles.get(n)) : null;
    if (img) images.push(img);
  }
  return { images, truncated, lowRes: size === "thumb" };
}

/**
 * One bounded visual self-check for AI drafts (`ai_slides_generate`, only when role `slides` has vision): reviews the
 * preview screenshots and applies the verified fixes of clear overflow / crowding / tiny-font problems to the entry
 * text. Returns the patched entry (or null when nothing applies). Never throws: the draft is fine without it.
 */
export async function visualSelfFix(
  platform: AiPlatform,
  db: Queryable,
  storage: Storage,
  deck: { id: string; kind: "progress" | "paper_report"; title: string },
  previewId: string,
  opts: { userId: string; signal?: AbortSignal; log?: { warn: (o: object, m: string) => void } },
): Promise<{ text: string; applied: number } | null> {
  try {
    if (!(await platform.capabilities("slides")).vision) return null;
    const row = (await db.query<{ output_prefix: string; result: { shots?: { count?: number } } | null }>(
      "SELECT p.output_prefix, j.result FROM deck_previews p JOIN jobs j ON j.id=p.job_id WHERE p.id=$1 AND p.status='ready'",
      [previewId],
    )).rows[0];
    const count = row?.result?.shots?.count ?? 0;
    if (!row || !count) return null;
    const { images } = await previewImages(storage, row.output_prefix, count);
    if (!images.length) return null;
    const review = await reviewSlides(platform, db, storage, deck, images, {
      userId: opts.userId,
      signal: opts.signal,
      maxTokens: 4000,
      note: "這是 AI 剛產生的草稿的自我檢查：只回報明顯超出版面、太擠或字太小的頁面，並一定附上 find/replace 的最小修改（例如刪減條列、加 {.smaller}）；其他問題不用列。",
    });
    const tree = await loadTree(db, deck.id);
    const entry = tree ? (await listFiles(db, deck.id, true)).find((f) => f.path === tree.entry) : undefined;
    if (!entry || typeof entry.content !== "string") return null;
    const fixes = review.issues
      .filter((i) => i.fix && i.fix.file_id === entry.id && ["overflow", "crowding", "font_size"].includes(i.category) && i.severity !== "low")
      .map((i) => ({ ...i.fix!, at: entry.content!.indexOf(i.fix!.find) }))
      .filter((f) => f.at >= 0)
      .sort((a, b) => a.at - b.at);
    let text = "";
    let cursor = 0;
    let applied = 0;
    for (const f of fixes) {
      if (f.at < cursor) continue; // overlapping edits: keep the first
      text += entry.content.slice(cursor, f.at) + f.replace;
      cursor = f.at + f.find.length;
      applied++;
    }
    if (!applied) return null;
    return { text: text + entry.content.slice(cursor), applied };
  } catch (err) {
    opts.log?.warn({ err }, "slides visual self-check skipped");
    return null;
  }
}
