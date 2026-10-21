import { importBibtex } from "./bibtex.js";
import { importCslJson } from "./csl.js";
import { importEndnoteXml } from "./endnote.js";
import { importRis } from "./ris.js";
import { LibraryImportError, type ImportFormat, type ImportResult } from "./types.js";
import { importZoteroRdf } from "./zotero-rdf.js";

/** Guess the format from content (and optionally the file name). */
export function detectFormat(text: string, filename?: string): ImportFormat | undefined {
  const ext = filename?.toLowerCase().split(".").pop();
  const head = text.replace(/^﻿/, "").slice(0, 4000).trimStart();
  if (ext === "enl" || ext === "enlx") return undefined;
  if (head.startsWith("[") || head.startsWith("{")) return "csl-json";
  if (/^<\?xml[\s\S]*?<rdf:RDF|^<rdf:RDF/.test(head) || (ext === "rdf" && head.startsWith("<"))) return "zotero-rdf";
  if (/^(<\?xml[^>]*>\s*)?<xml>\s*<records>/.test(head) || (head.startsWith("<") && /<records>\s*<record>/.test(head))) return "endnote-xml";
  if (/^TY {2}- /m.test(head)) return "ris";
  if (/@[a-zA-Z]+\s*[{(]/.test(head)) return "bibtex";
  if (ext === "bib" || ext === "bibtex") return "bibtex";
  if (ext === "ris") return "ris";
  if (ext === "json") return "csl-json";
  return undefined;
}

/** Import any supported file. Throws LibraryImportError (繁中) when the format is unknown or unusable. */
export function importAny(text: string, opts: { format?: ImportFormat; filename?: string } = {}): ImportResult {
  const ext = opts.filename?.toLowerCase().split(".").pop();
  if (ext === "enl" || ext === "enlx") {
    throw new LibraryImportError("不支援 EndNote 資料庫檔（.enl/.enlx），請在 EndNote 用「File → Export」匯出 XML 或 RIS 後再匯入");
  }
  const format = opts.format ?? detectFormat(text, opts.filename);
  switch (format) {
    case "bibtex":
      return importBibtex(text);
    case "ris":
      return importRis(text);
    case "endnote-xml":
      return importEndnoteXml(text);
    case "csl-json":
      return importCslJson(text);
    case "zotero-rdf":
      return importZoteroRdf(text);
    default:
      throw new LibraryImportError("無法判斷檔案格式，支援 BibTeX、RIS、EndNote XML、CSL-JSON、Zotero RDF");
  }
}
