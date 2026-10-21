/**
 * Document import: validates an uploaded file (extension allow-list, size, Google Magika content-type detection,
 * structural checks) and converts it to Markdown. Pure library: no DB, no storage; callers map DocImportError (an
 * HttpError with `extra.code`) to the response.
 */
import { DocImportError } from "./errors.js";
import { detectContentType, type ContentType } from "./magika.js";
import { finalizeMarkdown, truncateMarkdown } from "./markdown.js";
import type { Extracted } from "./types.js";

export { DocImportError, type DocImportErrorCode } from "./errors.js";
export { detectContentType, MAGIKA_TEXT_LABELS, type ContentType } from "./magika.js";

export const DOC_IMPORT_MAX_BYTES = 30 * 1024 * 1024;
export const DOC_IMPORT_MAX_CHARS = 200_000;

export type DocFormat =
  | "pdf" | "docx" | "doc" | "odt" | "rtf" | "txt" | "markdown" | "html" | "pptx" | "ppt" | "odp" | "epub" | "csv" | "tsv" | "xlsx" | "ods";

/** Magika labels accepted for plain text / Markdown: prose-like text formats (code, markup and scripts are not). */
const PLAIN_TEXT_LABELS = ["txt", "markdown", "rst", "latex", "bib", "srt", "vtt", "csv", "tsv", "ini", "yaml", "toml"];

/**
 * Allowed formats. `labels` are the Magika labels accepted for the extension ("zip" for ZIP containers whose structure
 * is then checked by the extractor; a few labels re-route to another parser, e.g. an RTF saved as .doc).
 */
export const DOC_IMPORT_FORMATS: { format: DocFormat; extensions: string[]; mime: string[]; labels: string[] }[] = [
  { format: "pdf", extensions: [".pdf"], mime: ["application/pdf"], labels: ["pdf"] },
  { format: "docx", extensions: [".docx"], mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], labels: ["docx", "zip", "doc"] },
  { format: "doc", extensions: [".doc"], mime: ["application/msword"], labels: ["doc", "rtf", "docx"] },
  { format: "odt", extensions: [".odt"], mime: ["application/vnd.oasis.opendocument.text"], labels: ["odt", "zip"] },
  { format: "rtf", extensions: [".rtf"], mime: ["application/rtf", "text/rtf"], labels: ["rtf"] },
  { format: "txt", extensions: [".txt", ".text"], mime: ["text/plain"], labels: PLAIN_TEXT_LABELS },
  { format: "markdown", extensions: [".md", ".markdown"], mime: ["text/markdown", "text/x-markdown"], labels: PLAIN_TEXT_LABELS },
  { format: "html", extensions: [".html", ".htm", ".xhtml"], mime: ["text/html", "application/xhtml+xml"], labels: ["html", "xml", "txt", "markdown"] },
  { format: "pptx", extensions: [".pptx"], mime: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], labels: ["pptx", "zip", "ppt"] },
  { format: "ppt", extensions: [".ppt"], mime: ["application/vnd.ms-powerpoint"], labels: ["ppt", "pptx"] },
  { format: "odp", extensions: [".odp"], mime: ["application/vnd.oasis.opendocument.presentation"], labels: ["odp", "zip"] },
  { format: "epub", extensions: [".epub"], mime: ["application/epub+zip"], labels: ["epub", "zip"] },
  { format: "csv", extensions: [".csv"], mime: ["text/csv"], labels: ["csv", "tsv", "txt"] },
  { format: "tsv", extensions: [".tsv", ".tab"], mime: ["text/tab-separated-values"], labels: ["tsv", "csv", "txt"] },
  { format: "xlsx", extensions: [".xlsx"], mime: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], labels: ["xlsx", "zip"] },
  { format: "ods", extensions: [".ods"], mime: ["application/vnd.oasis.opendocument.spreadsheet"], labels: ["ods", "zip"] },
];

/** For `<input accept>`. */
export const DOC_IMPORT_ACCEPT: string = DOC_IMPORT_FORMATS.flatMap((f) => f.extensions).join(",");

/** Magika label that makes a file of this extension be parsed as another format. */
const REROUTE: Partial<Record<DocFormat, Record<string, DocFormat>>> = {
  doc: { rtf: "rtf", docx: "docx" },
  docx: { doc: "doc" },
  pptx: { ppt: "ppt" },
  ppt: { pptx: "pptx" },
};

const TEXT_FORMATS = new Set<DocFormat>(["txt", "markdown", "html", "csv", "tsv"]);

/** Binary/executable content: never a document, whatever the extension. */
const NOT_DOCUMENT = new Set([
  "unknown", "pebin", "elf", "macho", "coff", "dex", "javabytecode", "pythonbytecode", "wasm", "msi", "apk", "crx", "deb",
  "rpm", "dmg", "lnk", "cab", "iso", "squashfs", "pickle", "pytorch", "onnx", "npy", "npz", "h5", "sqlite", "pdb",
]);

const LABEL_NAMES: Record<string, string> = {
  zip: "ZIP 壓縮檔", rar: "RAR 壓縮檔", sevenzip: "7-Zip 壓縮檔", gzip: "gzip 壓縮檔", tar: "tar 封存檔", xz: "xz 壓縮檔",
  bzip: "bzip2 壓縮檔", png: "PNG 圖片", jpeg: "JPEG 圖片", gif: "GIF 圖片", webp: "WebP 圖片", bmp: "BMP 圖片", tiff: "TIFF 圖片",
  svg: "SVG 圖片", ico: "圖示檔", psd: "Photoshop 檔", html: "HTML 網頁", xml: "XML 檔", json: "JSON 資料", pdf: "PDF 文件",
  docx: "Word 文件 (.docx)", doc: "Word 97–2003 文件 (.doc)", xlsx: "Excel 試算表 (.xlsx)", xls: "Excel 97–2003 試算表 (.xls)",
  pptx: "PowerPoint 簡報 (.pptx)", ppt: "PowerPoint 97–2003 簡報 (.ppt)", odt: "OpenDocument 文字文件", ods: "OpenDocument 試算表",
  odp: "OpenDocument 簡報", epub: "EPUB 電子書", rtf: "RTF 文件", mp3: "MP3 音訊", wav: "WAV 音訊", flac: "FLAC 音訊", ogg: "Ogg 音訊",
  mp4: "MP4 影片", webm: "WebM 影片", mkv: "MKV 影片", pebin: "Windows 執行檔", elf: "Linux 執行檔", macho: "macOS 執行檔",
  msi: "Windows 安裝檔", apk: "Android 安裝檔", javascript: "JavaScript 程式碼", python: "Python 程式碼", shell: "Shell 指令碼",
  batch: "批次檔", powershell: "PowerShell 指令碼", php: "PHP 程式碼", css: "CSS 樣式表", unknown: "無法辨識的二進位資料",
};

export const describeLabel = (label: string) => LABEL_NAMES[label] ?? label;

export type ImportedDocument = {
  filename: string;
  format: DocFormat;
  detected: { label: string; score: number };
  title: string | null;
  markdown: string;
  chars: number;
  truncated: boolean;
  pages?: number;
  warnings: string[];
};

const FORMAT_LIST = "PDF、Word（.docx/.doc）、PowerPoint（.pptx/.ppt）、Excel（.xlsx）、OpenDocument（.odt/.odp/.ods）、RTF、EPUB、HTML、Markdown、純文字、CSV/TSV";

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 || (dot === 0 && base.length > 1) ? base.slice(dot).toLowerCase() : "";
}

/** The format for a file name (null when the extension is not importable). */
export function formatForFilename(filename: string): DocFormat | null {
  const ext = extensionOf(filename);
  return DOC_IMPORT_FORMATS.find((f) => f.extensions.includes(ext))?.format ?? null;
}

function cleanFilename(filename: string): string {
  return (filename.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255) || "document";
}

const legacyXls = () => new DocImportError(415, "legacy_format", "舊版 Excel (.xls) 請先另存為 .xlsx 或 CSV。");

/** Magika on the raw bytes; for text formats in a non-UTF-8 encoding, on the text re-encoded as UTF-8. */
async function detect(bytes: Uint8Array, format: DocFormat): Promise<ContentType> {
  const raw = await detectContentType(bytes);
  if (!TEXT_FORMATS.has(format) || raw.isText || raw.label === "empty") return raw;
  const { decodeText } = await import("./text.js");
  const decoded = decodeText(bytes);
  if (decoded.encoding === "utf-8") return raw;
  const controls = (decoded.text.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) ?? []).length;
  if (controls > decoded.text.length * 0.005) return raw;
  return detectContentType(new TextEncoder().encode(decoded.text));
}

async function extract(format: DocFormat, bytes: Uint8Array): Promise<Extracted> {
  switch (format) {
    case "pdf":
      return (await import("./pdf.js")).extractPdf(bytes);
    case "docx":
      return (await import("./office.js")).extractDocx(bytes);
    case "doc":
      return (await import("./office.js")).extractDoc(bytes);
    case "odt":
    case "odp":
    case "ods":
      return (await import("./odf.js")).extractOdf(bytes, format);
    case "pptx":
      return (await import("./ooxml.js")).extractPptx(bytes);
    case "xlsx":
      return (await import("./ooxml.js")).extractXlsx(bytes);
    case "ppt":
      return (await import("./ppt.js")).extractPpt(bytes);
    case "epub":
      return (await import("./epub.js")).extractEpub(bytes);
    case "rtf":
      return (await import("./rtf.js")).parseRtf(bytes);
    case "html": {
      const { decodeText } = await import("./text.js");
      const { htmlToMarkdown } = await import("./html.js");
      const warnings = new Set<string>();
      const r = htmlToMarkdown(decodeText(bytes).text, warnings);
      return { ...r, warnings: [...warnings] };
    }
    case "txt":
    case "markdown":
    case "csv":
    case "tsv": {
      const t = await import("./text.js");
      const text = t.decodeText(bytes).text;
      if (format === "txt") return t.extractTxt(text);
      if (format === "markdown") return t.extractMarkdown(text);
      return t.extractDelimited(text, format === "tsv" ? "\t" : t.sniffCsvDelimiter(text));
    }
  }
}

/** Plain-text title from the first Markdown heading. */
function headingTitle(md: string): string | null {
  const m = /^#{1,6} +(.+)$/m.exec(md);
  return m ? m[1]!.replace(/\\([\\`*_[\]<>#|.+\-!])/g, "$1").trim() || null : null;
}

/**
 * Validates and converts one uploaded document. Throws DocImportError (415/413/422 with `extra.code`) for files that
 * are not importable; never returns raw HTML.
 */
export async function importDocument(bytes: Uint8Array, filename: string, opts: { maxChars?: number } = {}): Promise<ImportedDocument> {
  const ext = extensionOf(filename);
  if (ext === ".xls") throw legacyXls();
  const declared = formatForFilename(filename);
  if (!declared) throw new DocImportError(415, "unsupported_format", `不支援這種檔案格式。可匯入：${FORMAT_LIST}。`);
  if (bytes.byteLength > DOC_IMPORT_MAX_BYTES) throw new DocImportError(413, "too_large", "檔案超過 30 MB。");
  if (bytes.byteLength === 0) throw new DocImportError(422, "empty", "檔案裡沒有可匯入的文字。");

  // A password-protected OOXML file is an OLE container (EncryptedPackage); say so instead of "content mismatch".
  if (declared === "docx" || declared === "xlsx" || declared === "pptx") {
    const { isEncryptedOoxml } = await import("./office.js");
    if (isEncryptedOoxml(bytes)) throw new DocImportError(422, "encrypted", "檔案有密碼保護或已加密，無法匯入。", "請先移除密碼或另存一份未加密的檔案。");
  }

  const detected = await detect(bytes, declared);
  if (detected.label === "empty") throw new DocImportError(422, "empty", "檔案裡沒有可匯入的文字。");
  const spec = DOC_IMPORT_FORMATS.find((f) => f.format === declared)!;
  if (!spec.labels.includes(detected.label)) {
    if (detected.label === "xls" && (declared === "xlsx" || declared === "ods")) throw legacyXls();
    if (NOT_DOCUMENT.has(detected.label)) {
      throw new DocImportError(415, "not_document", "這不是可匯入的文件檔。", `偵測到：${describeLabel(detected.label)}`);
    }
    throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", `偵測到：${describeLabel(detected.label)}`);
  }
  const format = REROUTE[declared]?.[detected.label] ?? declared;

  let result: Extracted;
  try {
    result = await extract(format, bytes);
  } catch (error) {
    if (error instanceof DocImportError) throw error;
    throw new DocImportError(422, "corrupt", "檔案損毀或無法解析。");
  }

  const max = Math.max(1, Math.min(Math.floor(opts.maxChars ?? DOC_IMPORT_MAX_CHARS), DOC_IMPORT_MAX_CHARS));
  const full = finalizeMarkdown(result.markdown);
  if (!/[\p{L}\p{N}]/u.test(full)) {
    throw new DocImportError(422, "empty", "檔案裡沒有可匯入的文字。", format === "pdf" ? "掃描版 PDF 需要先做文字辨識 (OCR)。" : undefined);
  }
  const { text: markdown, truncated } = truncateMarkdown(full, max);
  const warnings = [...result.warnings];
  if (truncated) warnings.push(`內容超過 ${max.toLocaleString("en-US")} 字，只匯入前 ${markdown.length.toLocaleString("en-US")} 字。`);
  const rawTitle = (result.title ?? headingTitle(markdown) ?? "").replace(/\s+/g, " ").trim();
  return {
    filename: cleanFilename(filename),
    format,
    detected: { label: detected.label, score: Math.round(detected.score * 1000) / 1000 },
    title: rawTitle ? rawTitle.slice(0, 200) : null,
    markdown,
    chars: markdown.length,
    truncated,
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    warnings,
  };
}
