/**
 * LaTeX layout review (「AI 檢查排版」, role `writing`): the editor renders ≤ 6 PDF pages to images with pdf.js and
 * maps each page to source line ranges with SyncTeX; here the ranges become numbered source excerpts, the compile's
 * bad-box / float warnings of those files are added, and every text `.tex` file is kept for verifying fixes.
 */
import type { Queryable } from "../../db.js";
import type { AiPlatform } from "../../ai/platform/platform.js";
import type { CollabServer } from "../../collab/server.js";
import type { LatexDiagnostic } from "../latex/contract.js";
import { listFiles, liveText } from "../latex-projects/store.js";
import { LATEX_CATEGORIES, numbered, runReview, type LayoutReview, type ReviewImage, type SourceFile } from "./review.js";

export const MAX_LATEX_PAGES = 6;
export type PageSource = { path: string; from: number; to: number };

const SYSTEM = `你是 LaTeX 學術論文的排版審閱者。你會看到編譯後 PDF 的幾頁截圖，以及這些頁面對應的原始碼片段（含行號）與編譯警告。
只依截圖上實際看到的畫面判斷排版：
- overfull：文字、公式、網址或表格超出版心（對照 Overfull \\hbox 警告）
- figure：圖表浮動位置不佳（離引用太遠、單獨成頁、留下大片空白）、圖太大或太小、圖說位置
- table：表格超出版心、欄位太擠、線條或對齊混亂
- spacing：多餘的空白、段落或標題間距不一致、孤行寡行
- cjk：中文排版（標點擠壓、行首標點、中英文混排間距、字型混用）
- margins：頁邊界、頁首頁尾、頁碼
- consistency：標題、圖表標號、引用格式前後不一致
不評論研究內容、文法或用字。修正以原始碼的最小修改表達，例如 \\resizebox{\\linewidth}{!}{…}、改用 tabularx、調整浮動參數 [htbp]、
\\url 斷行、\\sloppy 段落、把長公式改成 multline。修正只能用前導區已載入的套件（清單附在下面）；需要新套件時，find/replace
仍只改內文，並在 suggestion 寫明要在主檔加哪一行 \\usepackage。截圖頁碼是 PDF 的實體頁碼。`;

/**
 * Builds the prompt context. `sources` (from SyncTeX, per page) are clipped to ±8 lines and 24 000 characters in
 * total; without them only the warnings and the file list are sent (fixes still verify against every file).
 */
export async function latexReviewContext(
  db: Queryable,
  collab: CollabServer | null | undefined,
  project: { id: string; title: string; root_file: string; compiler: string },
  pages: Array<{ page: number; sources?: PageSource[] }>,
  diagnostics: LatexDiagnostic[],
): Promise<{ context: string; files: SourceFile[] }> {
  const rows = (await listFiles(db, project.id)).filter((f) => f.kind === "text" && /\.(tex|ltx|cls|sty)$/i.test(f.path)).slice(0, 80);
  const files: SourceFile[] = [];
  for (const f of rows) files.push({ id: f.id, path: f.path, text: await liveText(db, collab, f) });
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Merge page ranges per file.
  const ranges = new Map<string, Array<[number, number]>>();
  for (const p of pages) {
    for (const s of p.sources ?? []) {
      if (!byPath.has(s.path)) continue;
      const list = ranges.get(s.path) ?? [];
      list.push([Math.max(1, s.from - 8), s.to + 8]);
      ranges.set(s.path, list);
    }
  }
  let budget = 24_000;
  const excerpts: string[] = [];
  for (const [path, list] of ranges) {
    list.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    for (const [from, to] of merged) {
      if (budget <= 0) break;
      const text = numbered(byPath.get(path)!.text, from, to, Math.min(budget, 8000));
      budget -= text.length;
      excerpts.push(`<資料 檔案="${path}" 行="${from}-${to}">\n${text}\n</資料>`);
    }
  }
  const relevant = new Set(ranges.keys());
  const warnings = diagnostics
    .filter((d) => d.file && !d.generated && (relevant.size === 0 || relevant.has(d.file)) && /overfull|underfull|float|too large|specifier/i.test(d.message))
    .slice(0, 40)
    .map((d) => `- ${d.file}:${d.line ?? "?"} ${d.message.slice(0, 200)}`);
  const pageMap = pages.map((p) => `第 ${p.page} 頁：${p.sources?.length ? p.sources.map((s) => `${s.path} 第 ${s.from}–${s.to} 行`).join("、") : "（無 SyncTeX 對應）"}`);
  const root = byPath.get(project.root_file)?.text ?? "";
  const packages = [...root.matchAll(/^\s*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/gm)].flatMap((m) => m[1]!.split(",").map((x) => x.trim())).filter(Boolean);
  const docclass = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/.exec(root)?.[1];
  const context = [
    `論文專案〈${project.title}〉（主檔 ${project.root_file}，${project.compiler}${docclass ? `，文件類別 ${docclass}` : ""}）。`,
    `已載入的套件：${packages.length ? [...new Set(packages)].slice(0, 80).join("、") : "（沒有）"}`,
    `頁面與原始碼對應（SyncTeX）：\n${pageMap.join("\n")}`,
    warnings.length ? `相關編譯警告：\n${warnings.join("\n")}` : "這些頁面沒有相關的版面警告。",
    excerpts.length ? `原始碼片段（每行前面是行號，find 不要包含行號）：\n${excerpts.join("\n\n")}` : `原始碼檔案：${files.map((f) => f.path).join("、")}（沒有片段時 find/replace 用 null）。`,
  ].join("\n\n");
  return { context, files };
}

export async function reviewLatex(
  platform: AiPlatform,
  input: { context: string; files: SourceFile[]; images: ReviewImage[]; userId: string; signal?: AbortSignal },
): Promise<LayoutReview> {
  return runReview(platform, "writing", { system: SYSTEM, context: input.context, categories: LATEX_CATEGORIES, images: input.images, files: input.files, userId: input.userId, signal: input.signal });
}
