/** Job contracts shared with the backend. Keep in sync with backend/src/jobs/queue.ts. */
export type JobKind = "media_transcode" | "slide_render";

export type MediaTranscodePayload = { itemId: string; sourceKey: string; outputKey: string; fileName: string };
/** `peaks`: waveform overview, ≤1000 values in [0,1] (3 decimals); omitted when it could not be computed. */
export type MediaTranscodeResult = { outputKey: string; bytes: number; durationSeconds: number | null; peaks?: number[] };
/** Kind of uploaded deck: a Quarto ZIP, a PDF, or a PowerPoint file converted with LibreOffice. */
export type SlideSourceType = "quarto" | "pdf" | "pptx";
/**
 * `sourceType` absent means `quarto` (jobs queued before PDF/PPTX support). `sourceKey` is
 * `slides/<p>/<v>/source.zip|pdf|pptx`; `entry` is the QMD path for quarto and "" otherwise.
 * `outputPrefix` is `slides/<p>/<v>/output/` or, for a re-index, `slides/<p>/<v>/output-<suffix>/`.
 */
export type SlideRenderPayload = {
  projectId: string;
  versionId: string;
  sourceKey: string;
  entry: string;
  outputPrefix: string;
  sourceType?: SlideSourceType;
};
/**
 * `entryHtml`: entry HTML relative to `outputPrefix` (quarto), null for pdf/pptx (no HTML deck).
 * `pdfKey`: full key of the downloadable PDF (`<outputPrefix>slides.pdf`; for pdf decks the uploaded `sourceKey`).
 * `quartoVersion`: null for pdf/pptx. `sharedPrefix`: where `offline-assets/` of this render is stored
 * (content-addressed, shared across versions); null for pdf/pptx.
 * `thumbnailKey`: full key of the 960 px wide deck thumbnail of the first slide
 * (`<outputPrefix>_hub/thumbnail.png` for quarto, `_hub/thumbnail.webp` for pdf/pptx); omitted when it failed.
 * `pageCount` / `manifestKey`: number of pages and full key of `<outputPrefix>_hub/pages.json`
 * (see PageManifest); omitted when page capture failed (quarto only — pdf/pptx fail the job instead).
 * `converter`: LibreOffice version used for pptx.
 */
export type SlideRenderResult = {
  entryHtml: string | null;
  pdfKey: string;
  quartoVersion: string | null;
  fileCount: number;
  sharedPrefix: string | null;
  thumbnailKey?: string;
  pageCount?: number;
  manifestKey?: string;
  converter?: string;
};

/** Speaker notes of one page: plain text (paragraphs separated by blank lines) and, for quarto, minimal HTML. */
export type PageNotes = { text: string; html?: string };
/** One page in `pages.json`. `thumb`/`full` are keys relative to the version's output prefix. */
export type PageEntry = { index: number; h?: number; v?: number; title?: string; thumb: string; full?: string; notes?: PageNotes };
/** `<outputPrefix>_hub/pages.json`. `width`/`height`: the deck's slide size in its own units (use the ratio). */
export type PageManifest = { version: 1; sourceType: SlideSourceType; width: number; height: number; pages: PageEntry[] };

export type ClaimedJob = {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

/** Stage labels shown to users. */
export const STAGES = {
  queued: "排隊中",
  analyze: "分析媒體",
  transcode: "音訊轉碼",
  extract: "解壓縮",
  render: "編譯簡報",
  pdf: "匯出 PDF",
  prepare: "準備檔案",
  convert: "轉換簡報",
  pages: "產生頁面",
  upload: "上傳結果",
  done: "完成",
  failed: "失敗",
  cancelled: "已取消",
} as const;
