/**
 * PDF page → JPEG for vision models (agent `view_paper_pages`). Uses poppler's `pdftoppm` (Alpine package
 * `poppler-utils` in the backend image): a plain native binary built for baseline x86-64, so it runs on the
 * production CPU without AVX — unlike pdf.js rendering, which needs `@napi-rs/canvas` (prebuilt with AVX; removed
 * from the image). Work happens in a private directory under /tmp (the only writable path in the container).
 * Page sizes come from pdf.js (no canvas needed for that).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../http.js";

const run = promisify(execFile);

export type PageRenderRequest = {
  page: number;
  /** Output width in pixels. */
  width: number;
  /** Vertical crop as fractions of the page height (0 = top). */
  crop?: { top: number; bottom: number };
};
export type PageRenderer = (pdf: Buffer, req: PageRenderRequest[]) => Promise<Buffer[]>;

export const MAX_PAGE_WIDTH = 1400;

/** Page sizes in PDF points (index 0 = page 1). */
export async function pdfPageSizes(pdf: Buffer, pages: number[]): Promise<{ numPages: number; sizes: Map<number, { w: number; h: number }> }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  try {
    const doc = await task.promise;
    const sizes = new Map<number, { w: number; h: number }>();
    for (const p of pages) {
      if (p < 1 || p > doc.numPages) continue;
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      sizes.set(p, { w: vp.width, h: vp.height });
      page.cleanup();
    }
    return { numPages: doc.numPages, sizes };
  } catch {
    throw new HttpError(422, "PDF 損毀或無法解析。");
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** poppler renderer: one `pdftoppm -singlefile` call per request, ≤ 20 s each. */
export const popplerRenderer: PageRenderer = async (pdf, reqs) => {
  const dir = await mkdtemp(join(tmpdir(), "hub-pages-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf);
    const { sizes } = await pdfPageSizes(pdf, reqs.map((r) => r.page));
    const out: Buffer[] = [];
    for (const [i, r] of reqs.entries()) {
      const size = sizes.get(r.page);
      if (!size) throw new HttpError(400, `沒有第 ${r.page} 頁。`);
      const width = Math.max(200, Math.min(MAX_PAGE_WIDTH, Math.round(r.width)));
      const height = Math.round((width * size.h) / size.w);
      const args = ["-f", String(r.page), "-l", String(r.page), "-singlefile", "-jpeg", "-jpegopt", "quality=82", "-scale-to-x", String(width), "-scale-to-y", String(height)];
      if (r.crop) {
        const y = Math.max(0, Math.floor(r.crop.top * height));
        const h = Math.max(20, Math.min(height - y, Math.ceil((r.crop.bottom - r.crop.top) * height)));
        args.push("-x", "0", "-y", String(y), "-W", String(width), "-H", String(h));
      }
      const base = join(dir, `p${i}`);
      try {
        await run("pdftoppm", [...args, input, base], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(503, "伺服器沒有安裝頁面轉圖工具（poppler），暫時無法檢視頁面。");
        throw new HttpError(422, `第 ${r.page} 頁轉成圖片失敗。`);
      }
      out.push(await readFile(`${base}.jpg`));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

let renderer: PageRenderer = popplerRenderer;
export const renderPdfPages: PageRenderer = (pdf, reqs) => renderer(pdf, reqs);
/** Tests: swap the renderer (null = poppler). */
export const setPageRenderer = (r: PageRenderer | null) => {
  renderer = r ?? popplerRenderer;
};
