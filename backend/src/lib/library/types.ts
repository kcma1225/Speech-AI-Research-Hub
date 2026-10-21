// Internal paper model. It follows CSL-JSON (field meaning and `type` values) but uses
// camelCase keys and flat dates so the rest of the backend can use it directly.
// `toCslJson()` / `fromCslJson()` in csl.ts convert losslessly for the mapped fields.

/** CSL item types we produce. Anything else from an import is mapped to the closest one. */
export type PaperType =
  | "article-journal"
  | "paper-conference"
  | "article" // preprint (arXiv etc.)
  | "book"
  | "chapter"
  | "thesis"
  | "report"
  | "webpage"
  | "dataset"
  | "software"
  | "patent"
  | "manuscript"
  | "speech"
  | "document";

export const PAPER_TYPES: readonly PaperType[] = [
  "article-journal", "paper-conference", "article", "book", "chapter", "thesis", "report",
  "webpage", "dataset", "software", "patent", "manuscript", "speech", "document",
];

/** CSL name. Either `family` (+ `given`) or `literal` (organisations, unsplittable names). */
export interface PaperAuthor {
  family?: string;
  given?: string;
  literal?: string;
  /** e.g. "van der" (CSL non-dropping-particle). Kept separate so citation keys use the bare family name. */
  particle?: string;
  suffix?: string;
}

export interface PaperIds {
  s2?: string; // Semantic Scholar paperId (40 hex)
  s2Corpus?: string; // CorpusId
  openalex?: string; // W123…
  dblp?: string; // conf/interspeech/GulatiQCPZYHWZW20
  acl?: string; // 2020.acl-main.1
  pmid?: string;
  isca?: string; // interspeech_2020/gulati20_interspeech
}

export type SourceName =
  | "openalex" | "s2" | "arxiv" | "crossref" | "acl" | "isca" | "unpaywall" | "zotero" | "grobid" | "pdf";

export interface PaperRecord {
  type: PaperType;
  title: string;
  authors: PaperAuthor[];
  editors?: PaperAuthor[];
  year?: number;
  month?: number;
  day?: number;
  /** Journal, proceedings or book title (CSL `container-title`). */
  containerTitle?: string;
  /** Short venue label for display/filtering, e.g. "Interspeech", "ICASSP", "ACL". */
  venue?: string;
  collectionTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string; // "5036–5040" (en dash) or "e123"
  publisher?: string;
  publisherPlace?: string;
  edition?: string;
  isbn?: string;
  issn?: string;
  doi?: string; // normalized, lower-case, no prefix
  arxivId?: string; // normalized, no version, e.g. "2005.08100" or "cs/0601001"
  url?: string;
  abstract?: string;
  keywords?: string[];
  language?: string;
  note?: string;
  ids?: PaperIds;
  /** Best known open-access PDF URL (not downloaded). */
  oaPdfUrl?: string;
  /** Citation key from the source file, if any (kept, never regenerated). */
  citeKey?: string;
  /** Original BibTeX entry text when imported from .bib, so a round trip loses nothing. */
  bibtex?: string;
  /** Unmapped source fields worth keeping (lower-case BibTeX/RIS field → value). */
  extra?: Record<string, string>;
}

export type ImportFormat = "bibtex" | "ris" | "endnote-xml" | "csl-json" | "zotero-rdf";

export interface ImportWarning {
  /** 0-based entry index in the source (-1 = whole file). */
  index: number;
  /** Source cite key / record id when known. */
  key?: string;
  /** 繁中 message for the UI. */
  message: string;
}

export interface ImportResult {
  format: ImportFormat;
  records: PaperRecord[];
  warnings: ImportWarning[];
}

/** Thrown for unusable input (wrong format, unparseable file). Message is 繁中. */
export class LibraryImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryImportError";
  }
}
