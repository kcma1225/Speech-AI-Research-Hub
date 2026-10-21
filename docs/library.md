# Literature library (`backend/src/lib/library/`)

Pure TypeScript: parsing, export, dedupe, citation keys, display formatting, external search clients and PDF
metadata. No database or routes. The DB layer (`store.ts`, `imports.ts`, `files.ts`, `settings.ts`, `study-export.ts`, `ai.ts`)
and the routes are documented in `docs/architecture.md` "Library".
Import everything from `src/lib/library/index.js`.

## Model

`PaperRecord` follows CSL-JSON semantics (CSL `type` values, CSL names) with camelCase keys and flat dates:
`type, title, authors[{family,given,literal,particle,suffix}], editors, year, month, day, containerTitle, venue,
collectionTitle, volume, issue, pages, publisher, publisherPlace, edition, isbn, issn, doi, arxivId, url, abstract,
keywords[], language, note, ids{s2,s2Corpus,openalex,dblp,acl,pmid,isca}, oaPdfUrl, citeKey, bibtex, extra`.

- `doi` keeps its case for display. Compare and index it with `doiKey()`, which lower-cases it. `arxivId` has no
  version suffix. `pages` uses an en dash. `venue` is a short label (Interspeech, ICASSP, ACL, NeurIPS…) derived from
  the DOI prefix or the container title.
- `citeKey` is the key from the source file. Keys are pinned: we never regenerate an existing key.
- `bibtex` is the original entry text from a `.bib` import, so a round trip loses nothing (`useOriginal`).
- `toCslJson()` / `fromCslJson()` convert to and from real CSL-JSON. Ids that CSL has no field for go in `custom`.

## Import / export

| Format | Import | Export | Implementation |
|---|---|---|---|
| BibTeX / BibLaTeX | `importBibtex` | `exportBibtex`, `recordToBibtex` | `@retorquere/bibtex-parser` (ISC) + our serializer |
| RIS | `importRis` | `exportRis` | our parser (the `ris` npm package is GPL) |
| EndNote XML | `importEndnoteXml` | — | our mapping on `fast-xml-parser` (MIT) |
| CSL-JSON | `importCslJson` | `exportCslJson` | — |
| Zotero RDF | `importZoteroRdf` (best effort) | — | `fast-xml-parser` |
| Zotero Web API v3 | `ZoteroClient.listItems` (`since` for incremental sync) | — | `fetch` |

`importAny(text, {format?, filename?})` detects the format. Every importer returns
`{ format, records, warnings: [{index, key?, message}] }`. Messages are in 繁中. A bad entry is skipped with a warning
and the rest of the file still imports. A file that is unusable as a whole throws `LibraryImportError`. `.enl`/`.enlx`
files are rejected with instructions to export XML or RIS from EndNote.

BibTeX export escapes `& % $ # _ { } ~ ^ \`, braces words that must keep their case (`{ASR}`), writes
organisations and unsplittable CJK names as `{{王小明}}`, and leaves CJK as UTF-8, so the project needs
XeLaTeX/LuaLaTeX with xeCJK/ctex. `ascii: true` turns accented Latin into accent macros (`M{\"u}ller`).
`abstract: false` is the default.

## Dedupe

`compareRecords(a, b)` returns `{level, reason, score}`:
- `same`: an identifier matches (DOI, arXiv, S2, OpenAlex, ACL, DBLP, PMID, ISCA). Safe to merge.
- `likely`: the normalized titles are identical, |Δyear| ≤ 1, and the first-author surnames match.
- `possible`: title similarity ≥ 0.93 and the first authors are compatible. Show these as 「可能重複」 and never merge
  them automatically.
- Two different publisher DOIs (for example the journal and conference versions) are never `same` or `likely`.

`normalizeTitle` applies NFKC, case folding, accent stripping and LaTeX/HTML/punctuation stripping.
`trigramSimilarity` gives the same value as Postgres `pg_trgm` `similarity()`, so SQL can prefilter with
`title_norm % $1` and JS confirms. CJK titles use character bigrams. `mergeRecords(primary, other)` fills missing
fields, prefers the richer author list and abstract, unions ids and keywords, keeps the primary's key, and upgrades
a preprint to its published version. `dedupeRecords(list)` groups search results.

## Citation keys

`generateCiteKey` = `auth.lower + year + shorttitle(1)`, e.g. `gulati2020conformer`.
- Particles and accents are dropped (`van der Berg` → `berg`).
- Chinese names and titles go through pinyin (`pinyin-pro`, MIT), with surname readings and fixes for traditional
  characters (`王小明` → `wang`, `單` → `shan`).
- Scripts without a romanizer fall back to `zh` plus a 6-hex hash. A record with no author gets `anon`.
- `uniqueCiteKey(base, taken)` adds a, b, … z, aa (case-insensitive). `assignCiteKeys(records, existingKeys)` keeps
  valid pinned keys and generates the rest. Pass in the target project's `.bib` keys.

`formatApa` / `formatIeee` / `formatCitation(r, style)` give plain display strings. They are not citeproc, which
avoids its CPAL/AGPL license.

## Search clients

`createLibraryService(config)` returns `{ clients, searchPapers, resolveIdentifier, findOpenAccessPdf,
extractPdfRecord, downloadPdf }`.

- `config`: `{ contactEmail, unpaywallEmail (default contactEmail), openalexApiKey, s2ApiKey, grobidUrl, timeoutMs }`. Tests also use `baseUrls`,
  `limiters` and `allowPrivateDownloads`.
- Build it from `system_settings` and rebuild it when a key changes. Rate limiters are process-wide per source
  (`sharedLimiter`), so a rebuild does not reset them.

| Source | Limit (token bucket / concurrency) | Notes |
|---|---|---|
| OpenAlex | 10/s, 3 | `api_key` param. Search is skipped without a key. Singleton lookups are free. Reads `X-RateLimit-*-USD` and stops searching when the remaining daily budget is below $0.02. |
| Semantic Scholar | 1/s, 1 | `x-api-key`. Search is skipped without a key. |
| arXiv | 1 per 3 s, 1 | Atom API. Also used for title matching (`matchTitle`). |
| Crossref | 3/s, 3 | `mailto` + User-Agent with the contact email (polite pool). |
| Unpaywall | 5/s, 2 | Needs `contactEmail`. |
| ACL Anthology | 1/s | No search API, so `searchPapers` reports it as skipped. Resolves ids through `<id>.bib`, PDF at `<id>.pdf`. |
| ISCA Archive | 1 per 2 s | Parses the yearly index page (~1 MB, cached 24 h) for title search and lookup. The paper page gives BibTeX, DOI and abstract. Not in the default sources. |
| Zotero | 2/s | Obeys `Backoff` / `Retry-After`. |

All requests retry 429/5xx up to twice and honor `Retry-After`. Failures throw `SourceError(source, status, 繁中)`.

- `searchPapers(q, {sources = [openalex, s2, arxiv, crossref], limit = 20, yearFrom, yearTo, venues})` returns
  `{hits: [{record, sources}], errors, skipped}`. It interleaves results by rank across sources, then dedupes. One
  failing source does not fail the search.
- `resolveIdentifier(input)` accepts a DOI, an arXiv id, an ACL id, an OpenAlex W-id, an S2 id, or any of their URLs
  (`parseIdentifier`). A DOI goes to Crossref, enriched by OpenAlex (free), with the ACL `.bib` as a fallback.
  Returns `null` when nothing is found.
- `findOpenAccessPdf(record)` tries, in order: arXiv, ACL Anthology, ISCA Archive, Unpaywall, OpenAlex
  `best_oa_location`, S2 `openAccessPdf`, and finally an arXiv title match (for closed venues such as ICASSP). It
  returns `{url, source, license?, arxivId?}` or `null` (UI: 「無開放全文」). Downloaded PDFs are for private lab use
  only and are never served publicly.
- `downloadPdf(url, {maxBytes = 50 MB, timeoutMs = 60 s})` checks every redirect hop against private addresses
  (SSRF), checks the content type, checks for the `%PDF-` magic and enforces the size limit. The private-address check
  runs before the request, so DNS rebinding between the check and the fetch is not covered.

## PDF metadata

`extractPdfText(buf)` uses `pdfjs-dist` (Apache-2.0, Node legacy build). It reads the first 2 pages, the last page,
the Info dictionary and XMP, and guesses the title from the largest font on page 1. `extractIdentifiers` finds
a DOI and/or an arXiv id. An arXiv DOI counts as the arXiv id, not as the publisher DOI.

`extractPdfRecord(buf)` tries, in order:
1. The DOI found in the PDF, resolved with `resolveIdentifier`.
2. The arXiv id found in the PDF, looked up on arXiv.
3. A Crossref bibliographic match on the guessed title, accepted at similarity ≥ 0.9.
4. GROBID `processHeaderDocument`, when `grobidUrl` is set.
5. The title guess alone.

It returns `{record, method, identifiers, titleGuess, warnings}`. `GrobidClient.processReferences` returns a PDF's
reference list as records. GROBID requests BibTeX output (`Accept: application/x-bibtex`).

## Tests

`backend/test/library-*.test.ts`, with fixtures in `backend/test/library-fixtures/`. The fixtures include API
response shapes and Chinese entries. The source tests run against a local mock HTTP server.
`LIBRARY_LIVE=1 npx vitest run test/library-live.test.ts` makes about 5 real calls to arXiv and Crossref.
`LIBRARY_CONTACT_EMAIL` sets the mailto.
