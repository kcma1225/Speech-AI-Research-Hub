// Literature library: pure helpers (no DB, no routes). See docs/library.md.
export * from "./types.js";
export * from "./normalize.js";
export { importBibtex, exportBibtex, recordToBibtex, escapeBibtex, type BibtexExportOptions } from "./bibtex.js";
export { importRis, exportRis } from "./ris.js";
export { importEndnoteXml } from "./endnote.js";
export { importCslJson, exportCslJson, fromCslJson, toCslJson, type CslItem, type CslName } from "./csl.js";
export { importZoteroRdf } from "./zotero-rdf.js";
export { importAny, detectFormat } from "./import.js";
export { compareRecords, findDuplicates, mergeRecords, dedupeRecords, type MatchLevel, type MatchResult, type MatchOptions, type DuplicateCandidate } from "./dedupe.js";
export { generateCiteKey, uniqueCiteKey, assignCiteKeys, keyAuthor, keyShortTitle, romanize, CITE_KEY_RE } from "./citekey.js";
export { formatApa, formatIeee, formatCitation, type CitationStyle } from "./format.js";
export { RateLimiter, SourceError, sharedLimiter, DEFAULT_LIMITS, assertPublicUrl, type RateLimitOptions, type LimiterName } from "./http.js";
export { downloadPdf, extractPdfText, extractIdentifiers, isPdf, type DownloadedPdf, type DownloadPdfOptions, type PdfTextResult, type PdfIdentifiers } from "./pdf.js";
export { GrobidClient, type GrobidOptions } from "./grobid.js";
export { OpenAlexClient, openAlexWorkToRecord, type OpenAlexWork, type OpenAlexOptions } from "./sources/openalex.js";
export { SemanticScholarClient, s2PaperToRecord, type S2Paper, type S2Options } from "./sources/semantic-scholar.js";
export { ArxivClient, parseArxivAtom, arxivQuery } from "./sources/arxiv.js";
export { CrossrefClient, crossrefWorkToRecord, type CrossrefWork } from "./sources/crossref.js";
export { UnpaywallClient } from "./sources/unpaywall.js";
export { AclAnthologyClient, parseAclId } from "./sources/acl.js";
export { IscaArchiveClient, parseIscaIndex, type IscaIndexEntry } from "./sources/isca.js";
export { ZoteroClient, type ZoteroItem, type ZoteroKeyInfo, type ZoteroLibraryRef, type ZoteroOptions } from "./sources/zotero.js";
export type { SearchOptions, SourceOptions } from "./sources/common.js";
export {
  createLibraryService, parseIdentifier, DEFAULT_SEARCH_SOURCES,
  type LibraryConfig, type LibraryService, type PaperSearchOptions, type PaperSearchResult, type PaperSearchHit,
  type SearchSource, type ResolveResult, type ParsedIdentifier, type IdentifierKind, type OpenAccessPdf, type PdfImportResult,
} from "./service.js";
