import { open } from "node:fs/promises";
import yauzl from "yauzl";
import { badRequest, HttpError } from "../http.js";
import type { SlideSourceType } from "../../jobs/queue.js";
import { chooseEntry, scanZip, type ZipScan } from "./zip-validate.js";

/** Object-key extension of the stored upload per source type (`keys.slideSource`). */
export const SOURCE_EXTENSIONS = { quarto: "zip", pdf: "pdf", pptx: "pptx" } as const satisfies Record<SlideSourceType, string>;
export const SOURCE_CONTENT_TYPES: Record<SlideSourceType, string> = {
  quarto: "application/zip",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** PPTX package limits checked before upload (the worker re-checks while reading). */
export const PPTX_LIMITS = { entries: 10_000, totalBytes: 2 * 1024 * 1024 * 1024, contentTypesBytes: 1024 * 1024 };

export type DetectedDeck =
  | { sourceType: "quarto"; entry: string; scan: ZipScan }
  | { sourceType: "pdf" | "pptx"; entry: ""; scan: null };

const MAGIC = { zip: "504b0304", pdf: "255044462d", ole: "d0cf11e0" } as const;
const mismatch = () => new HttpError(415, "檔案內容與副檔名不符。");

async function head(path: string, bytes = 8) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Detects and validates an uploaded deck by extension + magic bytes: `.zip` (Quarto, full ZIP validation and
 * entry choice), `.pdf`, `.pptx` (OOXML package with `[Content_Types].xml` + `ppt/presentation.xml`, no macros,
 * not encrypted). `.pptm`/`.ppsm`/`.potm` (macros) and legacy `.ppt` are refused with a hint. Throws HttpError.
 */
export async function detectDeck(file: { path: string; filename: string }, entryField: string | undefined, maxBytes: number): Promise<DetectedDeck> {
  const name = file.filename.toLowerCase();
  const magic = await head(file.path);
  if (name.endsWith(".zip")) {
    if (!magic.startsWith(MAGIC.zip)) throw mismatch();
    const scan = await scanZip(file.path);
    return { sourceType: "quarto", entry: chooseEntry(scan.qmd, entryField), scan };
  }
  if (name.endsWith(".pdf")) {
    if (!magic.startsWith(MAGIC.pdf)) throw mismatch();
    return { sourceType: "pdf", entry: "", scan: null };
  }
  if (name.endsWith(".pptx")) {
    if (magic.startsWith(MAGIC.ole)) throw badRequest("簡報已加密或為舊版格式，請移除密碼並另存為 .pptx。");
    if (!magic.startsWith(MAGIC.zip)) throw mismatch();
    await scanPptx(file.path);
    return { sourceType: "pptx", entry: "", scan: null };
  }
  if (/\.(pptm|ppsm|potm)$/.test(name)) throw badRequest("不支援含巨集的簡報，請另存為 .pptx。");
  if (/\.(ppt|pps|pot)$/.test(name)) throw badRequest("不支援舊版 .ppt，請另存為 .pptx。");
  throw badRequest(`請選擇 ${Math.floor(maxBytes / 1024 / 1024)} MB 以下的 ZIP、PDF 或 PPTX 檔案。`);
}

/** Checks the OOXML package structure of a PPTX without extracting it. */
export function scanPptx(path: string): Promise<void> {
  const invalid = () => badRequest("檔案不是有效的 PPTX 簡報。");
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
      if (error || !zip) return reject(invalid());
      let entries = 0;
      let bytes = 0;
      let contentTypes: string | null = null;
      let presentation = false;
      const fail = (cause: unknown) => {
        zip.close();
        reject(cause instanceof HttpError ? cause : invalid());
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (contentTypes === null || !presentation) return reject(invalid());
        if (/macroEnabled/i.test(contentTypes)) return reject(badRequest("不支援含巨集的簡報，請另存為 .pptx。"));
        resolve();
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          entries += 1;
          bytes += entry.uncompressedSize;
          if (entries > PPTX_LIMITS.entries || bytes > PPTX_LIMITS.totalBytes) throw badRequest("PPTX 超過檔案數量或容量限制。");
          if (entry.isEncrypted()) throw badRequest("PPTX 不可加密。");
          if (/(^|\/)vbaProject\.bin$/i.test(entry.fileName)) throw badRequest("不支援含巨集的簡報，請另存為 .pptx。");
          if (entry.fileName === "ppt/presentation.xml") presentation = true;
          if (entry.fileName !== "[Content_Types].xml") return zip.readEntry();
          if (entry.uncompressedSize > PPTX_LIMITS.contentTypesBytes) throw invalid();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail(invalid());
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", () => fail(invalid()));
            stream.on("end", () => {
              contentTypes = Buffer.concat(chunks).toString("utf8");
              zip.readEntry();
            });
          });
        } catch (cause) {
          fail(cause);
        }
      });
      zip.readEntry();
    });
  });
}
