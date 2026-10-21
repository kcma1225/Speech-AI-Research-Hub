# Research: built-in LaTeX editor, literature library, paper search

Status: research input for a spec. Written 2026-10-21 on branch `v3-study`.
Scope: replace Aldine (`deploy/aldine/`, `docs/aldine-evaluation.md`) with an editor built into our SvelteKit
frontend (Svelte 5, Tailwind 4) and Fastify backend, with Overleaf-style real-time collaboration, plus a lab
literature library and paper search.

**License rule.** Aldine is AGPL-3.0-only (<https://github.com/trahloff/Aldine/blob/main/LICENSE>). We studied
its source (tag v0.12.3, commit `7556360`) to learn its architecture. Nothing below is copied code. The
implementation must be written from these notes and from library docs, not from Aldine files. The same
applies to any other AGPL project named below (Overleaf, `codemirror-lang-latex` ≥ 0.5, Zotero translation
server).

Licenses were read from the npm registry `latest` metadata on 2026-10-21 unless noted otherwise.

---

## Part A: LaTeX editor

### A1. How Aldine 0.12.3 is built

Aldine is an npm workspace with three apps: `apps/web` (React 19 + Vite), `apps/server` (Fastify 5 + tsx),
and `apps/compiler` (a dependency-free Node HTTP wrapper around `latexmk`).

| Concern | What Aldine does | Files studied |
|---|---|---|
| Editor | CodeMirror 6 (`@codemirror/view`, `state`, `language`, `autocomplete`, `search`, `commands`) with `codemirror-lang-latex@^0.4.1` (MIT at that version). It also ships an optional "visual" mode built from CM decorations, KaTeX and MathLive. | `apps/web/src/components/CodePane.tsx`, `editor/visual/*` |
| Collaboration | Yjs 13 + `y-codemirror.next` (`yCollab`, shared undo manager) on the client. On the server, `@hocuspocus/provider` talks to `@hocuspocus/server` 2.x over a `/collab` WebSocket. There is one `Y.Doc` per **file**, named `projectId::branch::path`, with the text in `Y.Text('content')`. Hocuspocus is configured with `debounce: 1500`, `maxDebounce: 8000`. `onAuthenticate` checks the session or token once at connect time. `onConnect` marks protected projects `readOnly`. Awareness carries cursors and names. An optional Redis extension supports multi-node. | `apps/server/src/collab.ts`, `CodePane.tsx` |
| Persistence | The plain file on disk (inside a git worktree) is the source of truth for compile and git. A separate Yjs binary snapshot per doc (`Y.encodeStateAsUpdate`, sha1-named `.ybin` outside the worktree) preserves CRDT identity across server restarts. The code comments name the trap: reseeding a doc from plain text after a restart creates new operations, and a reconnecting client then **merges** its old copy and duplicates the whole document. On load, if disk ≠ snapshot (a git pull, merge or revert changed it), the doc is replaced with the disk text inside a transaction and a new snapshot is written. A sha1 of the last written text skips redundant disk writes, which would otherwise trigger `latexmk` churn. | `collab.ts` (`onLoadDocument`, `writeDocToDisk`, `refreshBranchDocsFromDisk`) |
| Files and history | Each project is a git repo, and each branch is a `git worktree` (`simple-git`, Apache-2.0/MIT). Edits are autocommitted on a 20 s debounce per project and branch. Agent (MCP) writes are committed separately so that authorship is never mixed. Project metadata lives in JSON files by default, or in Postgres for multi-node. Optional GitHub, GitLab and Gitea sync. Output goes to `.aldine-out/`, excluded from git. | `store.ts`, `gitops.ts` |
| Compile pipeline | The server flushes open Yjs docs to disk, then calls `POST compiler:4020/compile {projectDir, rootFile, engine}`. The compiler shares the `/data` volume, so no files are transferred. It runs `latexmk -pdf|-pdfxe|-pdflua -interaction=nonstopmode -f -file-line-error -synctex=1 -cd -outdir=.aldine-out ./<root>`. `-f` keeps going after errors so that bibtex and reruns still happen and `\cite` does not turn into `[?]`. A failing log that points into `.aux` or `.bcf` triggers one recovery: delete the aux files and rebuild. A "draft" mode runs `$max_repeat=1; $bibtex_use=0` for fast auto-typeset. A sentinel file's mtime decides whether the PDF, `.blg` and `.synctex.gz` are fresh or left over from an earlier run. At most 2 compiles run at once, with a 120 s wall clock enforced by SIGKILL on the process group (`detached: true`). The root filename is rejected if any path segment starts with `-`, because latexmk would read `-pdflatex=<cmd>` as an option and run it. | `apps/compiler/server.js`, `apps/server/src/compile.ts` |
| Sandbox | TeX Live 2026 `scheme-medium` plus pictures, latexextra, bibtexextra, publishers and several language collections (about 4.3 GB on disk according to its Dockerfile; 7.96 GB uncompressed as measured in our evaluation). It uses **restricted** shell-escape (`tlmgr conf texmf shell_escape p`) and sets `openin_any=p` / `openout_any=p`. In compose the compiler is on an `internal: true` network with `cap_drop: ALL`, `no-new-privileges`, `mem_limit: 2g` and `pids_limit: 256`. **Weakness:** every project shares one `/data` volume, so one project can read another (our evaluation reproduced this with `\verbatiminput`). Setting `openin_any=p` does not prevent it, because kpathsea's `in_name_ok` checks "for reading, as of 2026, always return true without checking anything" and `openin_any` is now ignored (<https://www.tug.org/texinfohtml/kpathsea.html>). Isolation has to come from the filesystem. | `apps/compiler/Dockerfile`, `docker-compose.yml` |
| SyncTeX | This runs on the server through the CLI. Forward: `synctex view -i line:col:input -o out.pdf`. Inverse: `synctex edit -o page:x:y:out.pdf`. The `Page:/x:/y:/h:/v:/W:/H:/Input:/Line:` records are parsed from stdout. Input paths are made relative to the project, because latexmk `-cd` makes TeX record paths relative to the root file's directory and inverse search returns `…/./ch1.tex`. A `compileId` is sent with each lookup, and the server returns 409 when the PDF on screen comes from a different run than the `.synctex.gz` on disk. UI: double-click in the PDF for inverse search; Cmd+J for forward search. | `server.js` (`synctex`), `Editor.tsx`, `PdfPane.tsx` |
| Log parsing | A custom parser. It reads `file:line: msg` lines (from `-file-line-error`). For `! …` errors it searches the next lines for `l.<n>`, splits the source line at the error position, and takes the last control sequence as the offending token (TeX does not name it in "Undefined control sequence"). It also collects `LaTeX/Package/Class … Warning … on input line N` and Over/Underfull boxes. The `.blg` file is parsed separately. Bibtex reports `---line N of file x.bib`. Biber reports `ERROR - …`, and its paths point to a temporary `.utf8` copy, so the real `.bib` name and line have to be recovered from that path. Errors located in generated files (`.bbl`, `.aux`) are relabelled and lose their link. Duplicate rows are removed. When nothing else explains a failure, latexmk's "Collected error summary" is used. | `server.js` (`parseLog`, `parseBibLog`, `latexmkFailure`) |
| Autocomplete | `codemirror-lang-latex` provides command and environment completion. Aldine adds `\cite{…}` completion (a regex covering `\cite*`, `\citep`, `\autocite`, optional args) backed by a server-side BibTeX index (key, type, author, title, year) cached for 15 s. It also adds `\ref{…}` completion from a label index, and a hover tooltip on cite keys. After a key is accepted, the cursor skips past the auto-closed `}`. | `editor/latexExtras.ts`, `server/src/bib.ts`, `indexes.ts` |
| File tree | Built from a flat list `{path, type, size, binary}`. It supports drag-and-drop or picker upload (base64 over JSON) with a confirmation before replacing a file. Binary files **cannot be opened** in the editor: there is no image preview. The root file is detected from `\documentclass` outside comments, then `\begin{document}`, then conventional names (`main`, `paper`, `thesis`…), then shallowest path, then smallest file. | `FileTree.tsx`, `root.ts`, `detect.ts` |
| PDF preview | `pdfjs-dist` 4.x renders one canvas per page with virtualization and devicePixelRatio scaling, using bundled cMaps for CJK. There is no text layer. The highlight flash comes from forward SyncTeX. | `PdfPane.tsx` |
| References | DOI is resolved through `doi.org` content negotiation (BibTeX). arXiv IDs go to `export.arxiv.org/api/query`. Search goes to OpenAlex `/works?search=` (with `mailto=aldine@localhost`, which is now meaningless; see C3). Zotero import uses Web API v3 with a user key and paginated `format=biblatex`. The BibTeX is sanitized: `month = June` becomes a macro, `&`/`%` are escaped, and HTML entities are unescaped. | `references.ts`, `zotero.ts` |

Ideas worth reimplementing: per-file Y.Doc; never reseed from text; materialize text only when it changed;
`-f` with full error lists; stale-aux recovery; `.blg` parsing with biber path remapping; reject root names that start with `-`;
a `compileId` guard on SyncTeX; root-file heuristic.
Things to do differently: per-project filesystem isolation in the compiler; a PDF text layer; image and PDF
preview in the file tree; Postgres + S3 instead of git + JSON files; hub auth instead of OIDC.

### A2. Recommended design

```
browser (SvelteKit)                     backend (Fastify)                  latex-compiler (new container)
 CodeMirror 6 + y-codemirror.next  ⇄ WS /api/latex/collab (Hocuspocus 4,
 Hocuspocus provider                     in-process, handleConnection)
 PDF.js viewer + text layer                │ store Y state → Postgres (bytea)
 SyncTeX worker (client-side)              │ materialize text → S3 (content-addressed)
                                           │ POST /api/latex/projects/:id/compile
                                           └─ enqueueJob('latex_compile')  ──→  claims job (hub_worker role,
                                              JobFinalizer → latex_builds      network "jobs": db + rustfs only)
                                              ← pg_notify / push to clients     sync files from S3 → per-project dir
                                                                                latexmk (no shell-escape) → PDF,
                                                                                synctex.gz, log, errors.json → S3
```

#### Editor: CodeMirror 6

- Use `@codemirror/*` 6.x (MIT). Mount an `EditorView` from a Svelte 5 attachment (`{@attach}`) or `onMount`. No wrapper package is needed. Theme with `EditorView.theme` reading the Tailwind 4 CSS variables so that dark mode follows our tokens.
- **LaTeX language: watch the license.** `codemirror-lang-latex` was **MIT up to 0.4.1 (2026-04-26)** and is
  **AGPL-3.0-or-later from 0.5.0 (2026-08-02)**. The current release is 0.6.1 (repo `texlyre/codemirror-lang-latex`, LICENSE is AGPL-3.0). `lezer-latex` is also AGPL-3.0-or-later. Options, in order:
  1. Pin `codemirror-lang-latex@0.4.1` exactly (MIT; Aldine's THIRD-PARTY-NOTICES also lists it as MIT), vendor it if we need fixes, and never upgrade without re-checking the license.
  2. Use the `stex` legacy mode from `@codemirror/legacy-modes` (MIT) through `StreamLanguage`. It gives highlighting only: no tree, so folding and outline need our own regex pass.
  3. Write our own Lezer grammar (`@lezer/generator`, MIT). This is the long-term option. A full LaTeX grammar is not feasible, but a "lexical" grammar (commands, groups, math, environments, comments, verbatim) is enough for highlighting, folding, outline and completion context.
- BibTeX files: `codemirror-lang-bib` 0.2.4 (MIT), or the `@codemirror/legacy-modes` stex/text fallback.
- Completions (our own code): commands and environments from a static list. `@unified-latex/unified-latex-ctan` (MIT) has macro signatures for common packages and can be used as a data source. Also `\cite` completion from the project `.bib` index plus the lab library (Part B), `\ref`/`\eqref`/`\cref` from a label index, `\input`/`\include`/`\includegraphics` path completion from the file tree, and snippets for `begin`/`end`.
- Optional parsing in the backend (outline, labels, word count): `@unified-latex/unified-latex-util-parse` (MIT) or `latex-utensils` 7.0.0 (MIT).

#### Collaboration: Yjs + Hocuspocus

| Package | Version | License | Note |
|---|---|---|---|
| `yjs` | 13.6.33 | MIT | Stay on 13.x. 14.0 is in rc (`@y/y` 14.0.0-rc.*) and `y-codemirror.next` peers on `yjs ^13.5.6`. |
| `y-codemirror.next` | 0.3.6 | MIT | `yCollab(ytext, awareness, { undoManager })`, remote cursors and selections. |
| `y-protocols` | 1.0.7 | MIT | Awareness. |
| `@hocuspocus/server` / `provider` | 4.7.1 | MIT | Peer `yjs ^13.6.8`. v4 exposes `handleConnection(ws, request: Request, context)`, so it can sit behind `@fastify/websocket` (MIT) in our backend. Hooks: `onAuthenticate`, `onConnect` (`connection.readOnly`), `onLoadDocument`, `onStoreDocument` with `debounce`/`maxDebounce`, `onChange`, `afterUnloadDocument`. |
| `@hocuspocus/extension-database` | 4.7.1 | MIT | `fetch`/`store` callbacks, which can be backed by Postgres. |
| `y-websocket` (client) 3.1.0, `@y/websocket-server` 0.1.5 | — | MIT | The alternative. The server package depends on `yjs ^14.0.0-7` (pre-release), which mismatches y-codemirror.next. **Prefer Hocuspocus.** |

Design decisions:
- **Unit of sync: one `Y.Doc` per text file**, named `latex:<projectId>:<fileId>`. Use a stable file id, not the path, so that a rename does not orphan the document. Binary files are not in Yjs.
- **Auth:** the WebSocket at `/api/latex/collab` is same-origin, so the browser sends the `hub_session` cookie. In `onAuthenticate`, verify the session, **check `Origin === APP_ORIGIN`** (cross-site WebSocket hijacking; our global `onRequest` Origin hook does not cover WebSocket upgrades of GET requests), then check project membership. Professors and viewers connect with `readOnly`. Access is only checked at connect time, so membership changes and account deactivation must close existing connections (Aldine has a `closeProjectConnections` for this).
- **Persistence (Postgres):** table `latex_docs(file_id PK, state bytea, state_vector bytea, updated_at)`. `onStoreDocument` writes `Y.encodeStateAsUpdate(doc)` (debounce about 2 s, maxDebounce about 10 s). On load, always apply the stored state. **Never reseed from text** unless no state exists (first import). For changes that come from outside (ZIP import, restoring a version), compute a diff and apply it as Y operations to the live doc, or replace the content inside a transaction. Do not create a fresh doc.
- **Materialized text:** after each store, if the sha256 of the text changed, put it in S3 as a content-addressed blob (`latex/<projectId>/blobs/<sha256>`) and update `latex_files.content_hash`. Compile and download then never touch Yjs.
- **History (replaces git):** a `latex_versions` row (a manifest of path → hash) on every compile, on an explicit "save version", and on idle. Blobs are deduplicated by hash. Restore means applying the manifest through the diff path above. Git import and export (zip or `git bundle`) can come later with `isomorphic-git` (MIT).
- Scale: one Hocuspocus instance runs inside the backend process. That is fine for a lab. Keep the doc-name scheme Redis-friendly (`@hocuspocus/extension-redis`, MIT) in case we ever need it.
- nginx: add WebSocket Upgrade headers on `/api/latex/collab` and a long `proxy_read_timeout`.

#### Project files in S3

- `latex_projects(id, name, owner_id, root_file_id, engine, bib_tool, created_at, …)`, `latex_members(project_id, user_id, role)`, `latex_files(id, project_id, path, kind text|binary, content_hash, size, updated_at)` with `UNIQUE(project_id, path)`.
- Text files live in Yjs plus a materialized blob. Binary files are streamed through `@fastify/multipart` straight to S3 (`latex/<projectId>/blobs/<sha256>`), with a size cap (Aldine: 60 MB ZIP, 81 MB request).
- ZIP import (Overleaf export) reuses the slide ZIP validation rules: path traversal, symlinks, total size, file count. Use the root-file heuristic from A1.
- File tree UI: rename, move, delete, upload, drag-and-drop. **Preview** images (png/jpg/svg rendered as `<img>` from a signed URL; serve SVG with a sandbox CSP), PDFs (a PDF.js single-file viewer), and `.eps` (show it as unsupported).
- Add the keys to `storage.ts` `keys` and to `docs/architecture.md` in the same change.

#### Compile service

**Image.** Today `deploy/aldine/compiler.Dockerfile` is `FROM ghcr.io/trahloff/aldine-compiler:0.12.3`. That
image is TeX Live 2026 scheme-medium plus collections, Node.js, and Aldine's AGPL `server.js`. Our Dockerfile adds only
`fonts-noto-cjk fonts-noto-cjk-extra` and `fc-cache -f`. **We must not build on it.** It ships AGPL code, and we
replace that code anyway. New `latex-compiler/Dockerfile`:
- `FROM texlive/texlive:latest-medium@sha256:…` (Island of TeX images, <https://hub.docker.com/r/texlive/texlive>, pinned by digest), then `tlmgr install` the collections we need: `collection-latexextra collection-pictures collection-bibtexextra collection-publishers collection-langchinese collection-langcjk` (ctex, xeCJK). Point `tlmgr` at a dated `texlive.info/tlnet-archive/YYYY/MM/DD` snapshot so builds are reproducible. This is a general tlmgr practice, not Aldine code. Alternatively use `latest-full` (about 9 GB) and skip `tlmgr`.
- Install `fonts-noto-cjk` and `fonts-noto-cjk-extra` (SIL OFL 1.1) for `Noto Serif/Sans CJK TC`. Optionally add 教育部標準楷書/宋體 (CC BY-ND 3.0 TW), which ships unmodified.
- Node 22 for the job runner, the same base as `worker/`. Run `biber --version` at build time to warm biber's PAR cache, which costs about 90 s on first run (Aldine documents this; it is a property of biber).
- Licenses: TeX Live is a collection of free licenses (LPPL, GPL, etc.; <https://tug.org/texlive/copying.html>). latexmk is GPL-2.0 and synctex is MIT-style. We only execute them as separate programs, so they do not affect our code license.

**Dispatch.** Add a new job kind `latex_compile` in the existing `jobs` table, claimed by a separate
`latex-compiler` service. It runs as DB role `hub_worker` on network `jobs` (db + rustfs, no internet). We keep it separate from `worker/` because of the 4–9 GB image.
LISTEN/NOTIFY makes the claim nearly immediate. Payload: `{projectId, buildId, rootPath, engine, files: [{path, hash}], draft}`.
Result: `{ok, pdfKey, synctexKey, logKey, errors[], pages, durationMs}`. Keep the types in sync in
`backend/src/jobs/queue.ts` and the compiler. A finalizer writes `latex_builds` and notifies clients over the
collab socket (an awareness-style stateless message) or SSE. Coalesce requests: one queued compile per project, and a newer request supersedes a queued one.

**Isolation (fixes Aldine's cross-project read).**
1. Keep a per-project working directory in the container (`/work/<projectId>`, a volume or tmpfs) so that latexmk incremental builds stay fast. Sync it from S3 by hash: download only changed blobs and delete files that were removed.
2. Run each compile as a **dedicated unprivileged uid per concurrency slot** (for example 20001, 20002). The supervisor chowns the project directory to the slot uid and sets mode 0700. Idle project directories are owned by the supervisor uid with mode 0700, so a compile cannot open another project's tree. This needs only `CAP_CHOWN`, `CAP_SETUID`, `CAP_SETGID`, `CAP_FOWNER` (all other capabilities dropped).
   The alternative is `bubblewrap` (LGPL-2.0+) with a mount namespace that exposes only `/work/<projectId>` and the read-only TeX tree. That is stronger, but it needs user namespaces, which Docker's default seccomp profile blocks, so it would require a custom seccomp profile.
3. Do not rely on `openin_any`: reading is always allowed (kpathsea, see A1). Writes outside the project are still blocked by `openout_any=p`.
4. **Shell-escape off:** pass `-no-shell-escape` explicitly and set `shell_escape = f` in `texmf.cnf`. Restricted mode (`p`) would allow whitelisted tools (epstopdf, bibtex, `latexminted` for minted 3). Turn it on only if users need EPS or minted, and record the decision.
5. Limits: per process group, `prlimit --as=2G --cpu=…`, `RLIMIT_FSIZE` (for example 200 MB, which stops runaway `\write`), and `RLIMIT_NPROC`. Wall clock 60–120 s with SIGKILL to the group (spawn `detached`, kill `-pid`). Container `mem_limit 2g`, `pids_limit 256`, `read_only` root with tmpfs `/tmp`, `cap_drop: ALL` plus the four capabilities above, `no-new-privileges`, internal network only. Run at most 2 compiles at once.
6. Validate the root path: relative, no `..`, and no segment starting with `-`. Pass it as `./<path>`. Engine is an enum: `pdflatex|xelatex|lualatex`. The engine comes **from project settings**, not from `% !TEX program`. Read the magic comment only as a hint in the UI.
7. Strip absolute container paths from the logs we return. Do not include more than about 200 KB of log.

**latexmk invocation** (own wording of standard flags): `latexmk -<engine-flag> -interaction=nonstopmode -file-line-error -synctex=1 -f -no-shell-escape -cd -outdir=.out ./<root>`.
Add `-halt-on-error` as a project option. In draft mode, pass `-e '$max_repeat=1; $bibtex_use=0'`.
Use XeLaTeX as the default for new projects with a Traditional Chinese template (`\usepackage[fontset=none]{ctex}` + `\setCJKmainfont{Noto Serif CJK TC}`). Mark the `.out` directory as owned by the build, and implement stale-aux recovery: on errors located in `.aux`/`.bcf`, delete `aux bcf bbl blg run.xml toc out fls fdb_latexmk` and rerun once.

**BibTeX and biblatex:** latexmk picks bibtex or biber automatically (`$bibtex_use = 2` deletes the `.bbl` only when it can be regenerated). Projects can choose `natbib`/BibTeX (IEEEtran, Interspeech's template, ACL's `acl_natbib.bst`) or biblatex/biber. Read the `.blg` for errors as in A1.

#### PDF preview: PDF.js

- `pdfjs-dist` 6.4.299 (Apache-2.0). Use `pdfjs-dist/web/pdf_viewer.mjs` (`PDFViewer`, `EventBus`, `PDFLinkService`), which gives the **text layer** (search and select), annotation links, and lazy page rendering. Copy `cmaps/` and `standard_fonts/` into the static build for CJK. The worker comes from self, so the CSP needs no `unsafe-eval` (check `isEvalSupported: false`).
- Serve the PDF from `/api/latex/builds/:id/pdf` with `Content-Type: application/pdf` and a range request. Keep the scroll position across recompiles: restore page and offset after loading the new document.

#### SyncTeX

- **Recommended: client-side.** Download `<build>.synctex.gz` (usually 0.1–2 MB), decompress with `DecompressionStream('gzip')` in a Web Worker, parse it, and run forward and inverse lookups locally. That gives zero round-trips and works while the compiler is busy. LaTeX-Workshop has an MIT TypeScript implementation that can serve as reference (<https://github.com/James-Yu/LaTeX-Workshop/tree/master/src/locate/synctex>, MIT). `synctex-js` 1.0.0 (MIT) also exists but is unmaintained.
- Fallback: run the `synctex view`/`synctex edit` CLI in the compiler as a short job, as Aldine does. Normalize paths: make them project-relative and collapse `/./`.
- Tie every lookup to the `buildId` whose PDF is on screen.
- UI: double-click in the PDF for inverse search; Ctrl/Cmd+Enter or a toolbar button for forward search, with a highlight rectangle from `h, v, W, H`.

#### Log parsing

There is no maintained MIT npm package. Overleaf's parser is AGPL. **Write our own parser** in the compiler (it is pure and unit-testable). The LaTeX-Workshop parsers are MIT and can serve as reference: `src/parse/parser/latexlog.ts`, `bibtexlog.ts`, `biberlog.ts` (<https://github.com/James-Yu/LaTeX-Workshop>, MIT).
Cover these cases:
- `file:line:` errors.
- `!` errors with `l.<n>` context and the offending token.
- `LaTeX/Package/Class Warning … on input line N`, including multi-line wraps. Set `max_print_line=10000` in the environment to avoid TeX's 79-column wrapping.
- Over/Underfull boxes.
- Undefined references and citations.
- `.blg` errors, mapping biber's temporary `.utf8` path back to the real `.bib`.
- latexmk's "Collected error summary".
- Remove duplicates, relabel errors in generated files, and translate common messages into a 繁中 hint table (keep the raw message alongside).

#### Library licenses (Part A)

| Library | License | Use |
|---|---|---|
| @codemirror/* 6.x, @lezer/* | MIT | editor |
| codemirror-lang-latex **0.4.1** | MIT (0.5+ is AGPL, avoid) | LaTeX language |
| @codemirror/legacy-modes 6.5.5 | MIT | stex fallback |
| codemirror-lang-bib 0.2.4 | MIT | .bib highlighting |
| yjs 13.6.33, y-protocols 1.0.7, y-codemirror.next 0.3.6, lib0 | MIT | CRDT |
| @hocuspocus/server, provider, extension-database 4.7.1 | MIT | sync server |
| @fastify/websocket, ws 8.22 | MIT | WebSocket |
| pdfjs-dist 6.4.299 | Apache-2.0 | PDF preview |
| @unified-latex/* 1.8.4, latex-utensils 7.0.0 | MIT | LaTeX parsing (server, optional) |
| katex 0.19 / mathlive 0.111 (optional math preview) | MIT | math hover |
| isomorphic-git 1.44.3 (later) | MIT | git export |
| @fastify/websocket 11.3.4 | MIT | WS in Fastify |
| better-sqlite3, rdflib, pinyin-pro (Part B) | MIT | .enl probe, Zotero RDF, CJK keys |
| TeX Live, latexmk (GPL-2), biber (Artistic-2), synctex | various free | executed in container |
| Noto CJK fonts | OFL-1.1 | Chinese |
| bubblewrap (optional) | LGPL-2.0+ | sandbox |

---

## Part B: Literature library

### B1. Formats and parsers

| Format | Import | Export | JS library (license) | Notes |
|---|---|---|---|---|
| BibTeX / BibLaTeX | yes | yes | `@retorquere/bibtex-parser` 12.1.10 (**ISC**; the parser Better BibTeX uses: handles `@string`, crossref, LaTeX→Unicode, name parsing). `citation-js` 0.9.0 with `@citation-js/plugin-bibtex` (MIT). `biblatex-csl-converter` 3.6.0 (**LGPL-3.0**, Fidus Writer). `bibtex-tidy` 1.15.1 (MIT) for formatting and cleaning on export. | Keep the original entry text, so a round trip loses nothing. |
| RIS | yes | yes | `@citation-js/plugin-ris` 0.9.0 (MIT), `astrocite-ris` 0.16.4 (MIT), `biblatex-csl-converter` | The `ris` npm package is GPL-3.0; avoid it. |
| EndNote XML | yes | optional | `biblatex-csl-converter` (LGPL-3.0; explicitly supports EndNote XML). Otherwise our own mapping on `fast-xml-parser` 5.11 (MIT). | This is the format to tell EndNote users to export. |
| EndNote tagged (.enw) | yes | — | `@citation-js/plugin-enw` 0.4.0 (MIT), `biblatex-csl-converter` | |
| EndNote `.enl` / `.enlx` | **not for v1** | — | none | Proprietary and undocumented. Newer versions store the data in SQLite (`<lib>.Data/sdb/sdb.eni`; PRONOM fmt/1683, fmt/1684: <https://pronom.nationalarchives.gov.uk/fmt/1684.xml>), and older ones use a binary format. Reading it would mean reverse-engineering the schema with `better-sqlite3` (MIT) on a copy, and attachments sit in `.Data/PDF/`. The schema varies by version. **Recommend:** ask users to export EndNote XML or RIS, with an illustrated 繁中 help step. `.enlx` is a ZIP of `.enl` + `.Data`; only the PDFs inside would be easy to salvage. |
| CSL-JSON | yes | yes | `@citation-js/core` + `plugin-csl` (MIT) | **Use CSL-JSON as our internal canonical item schema.** It is what Zotero, citeproc and Crossref (`application/vnd.citationstyles.csl+json`) speak. |
| Zotero RDF | yes | — | No dedicated JS library. Parse the RDF/XML with `fast-xml-parser` (MIT) or `rdflib` (MIT). Attachments in the export folder are linked by relative path. | Lower priority: users can export BibTeX or CSL-JSON from Zotero instead. |
| Zotero Web API v3 | yes (sync) | optional (write) | Plain `fetch`. `GET /users/<id>/items?format=csljson|biblatex|bibtex|ris&limit=100&start=…`, header `Zotero-API-Key`, `Zotero-API-Version: 3`, incremental `?since=<version>` with `Last-Modified-Version`. Obey `Backoff` and `Retry-After` (no published numeric limits). Docs: <https://www.zotero.org/support/dev/web_api/v3/basics>, <https://www.zotero.org/support/dev/web_api/v3/syncing>. | Store per-user keys encrypted with `AUTH_SECRET`. Group libraries for a lab-wide collection. |
| Formatted citations | — | yes | `citeproc` (citeproc-js) 2.4.63 is **CPAL-1.0 OR AGPL-1.0**, which needs a decision. `@citation-js/plugin-csl` bundles citeproc-js, so the same applies. | Only needed if we render bibliographies in the hub. LaTeX projects do not need it. |
| Many formats via server | yes | — | Zotero translation server (**AGPL-3.0**) as an unmodified separate container | Possible later. Running it unmodified as a network service keeps our code separate, but the AGPL network clause applies to that service. |

Recommendation: CSL-JSON is the internal model. Use `@retorquere/bibtex-parser` for .bib import, `citation-js` for
RIS, ENW and CSL conversions, and `bibtex-tidy` plus our own serializer for export. Add `biblatex-csl-converter` only if
EndNote XML is required in v1. LGPL is acceptable when it is used as an unmodified server-side npm dependency.

### B2. Deduplication

Normalize first, then match in tiers:
1. **Identifiers:** DOI (lowercase, strip `https://doi.org/` and `doi:` prefixes, trim trailing punctuation), arXiv ID (drop the `vN` suffix; handle old `cs/0601001` IDs), PMID, ISBN-13, OpenAlex `W…`, Semantic Scholar `paperId`/`CorpusId`, DBLP key, ACL Anthology ID. An exact match on any identifier means the same work. arXiv preprints and conference versions (ICASSP DOI vs arXiv) are linked as **versions** of one work rather than merged blindly. OpenAlex and S2 `externalIds` provide the link.
2. **Normalized title + year:** NFKC, casefold, strip LaTeX braces and accents (`unicode2latex` in reverse via the parser), remove punctuation and stopwords, collapse whitespace. Exact match plus |Δyear| ≤ 1 plus a matching first-author surname means a duplicate.
3. **Fuzzy:** trigram or Jaro-Winkler similarity over the normalized title, ≥ 0.93, plus a first-author match. Postgres `pg_trgm` (`similarity()`, GIN index) suits this, so no JS library is needed. Show candidates as "可能重複" for manual merge; never merge automatically.
Merge policy: keep the richest field set, and keep the user's citation key if one exists.

### B3. PDF metadata extraction

Pipeline (worker, no internet; lookups in the backend):
1. Look for a DOI or arXiv ID in the XMP or Info dictionary (`pdfjs-dist` `getMetadata()`, or `unpdf` 1.9.1 MIT, or `pdf-parse` 2.4.5 Apache-2.0). Then search the first-page and last-page text for a DOI (`10\.\d{4,9}/[-._;()/:A-Z0-9]+`, case-insensitive) or an arXiv stamp (`arXiv:\d{4}\.\d{4,5}`). An ISCA DOI `10.21437/Interspeech.YYYY-NNNN` usually appears in the footer.
2. If an ID is found, resolve it. Crossref `/works/<doi>` (singleton, cheap) or OpenAlex `/works/doi:<doi>` (cost 0 per singleton, verified) give CSL-JSON-like metadata. arXiv goes to the API.
3. If no ID is found, use the largest-font line on page 1 as a title guess (PDF.js text items carry font size). Query Crossref `query.bibliographic=<title + first author>&rows=3` or OpenAlex `search` (costs credits), and accept the result when title similarity is ≥ 0.9. Otherwise ask the user to confirm.
4. **GROBID** (<https://github.com/kermitt2/grobid>, Apache-2.0, Docker `grobid/grobid` or `lfoppiano/grobid`) gives much better header and reference extraction (`/api/processHeaderDocument`, TEI XML). It is Java, needs 2–4 GB of RAM, and the deep-learning image is large. It is optional: run it as an internal-only container in a profile and use it when an ID lookup fails, or to extract reference lists. CERMINE is AGPL; avoid it.

### B4. Citation keys (Better BibTeX-style)

Better BibTeX (MIT, <https://github.com/retorquere/zotero-better-bibtex>) uses the default formula
`auth.lower + shorttitle(3,3) + year` and adds a letter postfix (a, b, c…) on a clash
(<https://retorque.re/zotero-better-bibtex/citing/>). Reimplement our own small version:
- `auth`: first author's family name. Strip particles ("van", "de") following BBT's convention. Transliterate with NFKD and drop combining marks.
  For CJK names, use pinyin (`pinyin-pro` 3.29.5, MIT) or fall back to the romanized name in the record. Otherwise use the author ID.
- `shorttitle(3,3)`: the first 3 non-stopwords of the title, CamelCased.
- `year`.
- Clash postfix `a`, `b`, … checked against the library **and** the target project's `.bib`. Keys are **pinned** once assigned: never regenerated silently, because existing `\cite` would break.
Allowed characters: `[A-Za-z0-9_:-]`. Make the formula configurable per lab later.

### B5. Library ↔ LaTeX project bridge

The editor's `\cite` completion searches the lab library as well as the project `.bib`. Accepting an item that is
not in the project appends it to the project's chosen `.bib` file through the same Yjs path, so collaborators see it.
An optional "managed bib" mode regenerates `refs.bib` from a project collection on each compile.

---

## Part C: Paper search APIs

Facts below were checked on 2026-10-20/21 against official pages and live calls from our server.

| API | Auth / limits | Useful for | PDF | Terms |
|---|---|---|---|---|
| **arXiv API** `export.arxiv.org/api/query` (Atom) | No key. **At most 1 request every 3 seconds, one connection**, across all our machines (<https://info.arxiv.org/help/api/tou.html>). | ID lookup, title search (`ti:"…"`), category feeds (`cs.CL`, `eess.AS`, `cs.SD`) | `https://arxiv.org/pdf/<id>`. Link to it; **don't re-serve PDFs** unless the paper's license allows it. Storing copies for personal or research use is allowed. | Metadata is CC0. Do not imply endorsement. Queue our calls through one rate-limited client. |
| **Semantic Scholar Graph API** `api.semanticscholar.org/graph/v1` | Without a key, everyone shares a pool. Our unauthenticated test got **HTTP 429 immediately**, so treat a key as required. A key (free, request form at <https://www.semanticscholar.org/product/api>) starts at **1 RPS on all endpoints**, header `x-api-key`. | `/paper/search` (relevance, offset+limit), `/paper/search/bulk` (token paging, filters incl. `openAccessPdf`, `venue`, `year`), `POST /paper/batch` (up to 500 IDs), `/paper/search/match` (title→best match), citations/references, recommendations | Field `openAccessPdf {url, status, license}`. | API License Agreement (<https://www.semanticscholar.org/product/api/license>): attribution, no resale. Use the S2AG datasets for bulk work. |
| **OpenAlex** `api.openalex.org` | **Changed in 2026: usage-based pricing.** Without a key, a request shares a **$0.10/day budget per IP** (the live response says so in `meta.notice`). A **free key** (`api_key=…`, from openalex.org/settings/api) gets **$1/day**, resetting at midnight UTC. Paid prepaid and annual plans exist. Observed costs: a singleton `/works/doi:…` cost **$0 (0 credits)** and a `search` cost **$0.001 (10 credits)**, reported in the `X-RateLimit-Cost-USD` and `X-RateLimit-Credits-Used` headers and `meta.cost_usd`. Rate: 10 req/s without a key, 30 with a free key. `mailto` (the old polite pool) is no longer mentioned in the docs (<https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication>, updated 2026-10-15; <https://help.openalex.org/access/pricing/>). | The broadest index: venues (Interspeech, ICASSP), authors, institutions, concepts, `cited_by`, `best_oa_location.pdf_url`, `open_access.oa_status`. Singleton lookups are free, which makes OpenAlex a good resolver. | `best_oa_location.pdf_url`. OpenAlex also caches 50M+ OA PDFs and TEI (`has_content`, `content_urls`), as a paid or bulk add-on. | Data is CC0. Sanitize titles and abstracts before display (the docs warn they are unsanitized). Do not use Aldine's `mailto=aldine@localhost` pattern. |
| **Crossref REST** `api.crossref.org` | Limits changed on 1 Dec 2025 (<https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/>). **Polite** pool (`mailto=` or a `User-Agent` with an email): singleton 10 req/s with concurrency 3, list 3 req/s with concurrency 3. **Public** pool: singleton 5/s, list 1/s, concurrency 1. Verified live headers: `x-api-pool: polite-single`, `x-rate-limit-limit: 10`, `x-concurrency-limit: 3`. Metadata Plus (paid token) offers more. | DOI → metadata (`/works/<doi>`, or `doi.org` content negotiation for BibTeX or CSL-JSON), `query.bibliographic` matching, ICASSP and ACL DOIs | Sometimes a `link[]` to the publisher's TDM URL, usually behind a paywall. | Metadata is effectively open (facts, CC0). Abstracts belong to the publishers. Send `mailto=<lab address>`. |
| **DBLP** `dblp.org/search/publ/api?q=&format=json&h=&f=` | No key. 429 with `Retry-After` when overloaded. **Observed 2026-10-21: both `dblp.org` and `dblp.uni-trier.de` answered our curl with an Anubis bot challenge (HTTP 202, HTML)**, so live API use from the server is unreliable. Use the monthly XML dump (`dblp.org/xml/release/`) or the SPARQL endpoint `sparql.dblp.org`, which answered 200. | Clean CS venue metadata: Interspeech, ICASSP, ACL, NeurIPS, ICLR all indexed with BibTeX (`/rec/<key>.bib`) | Links only (`ee` field) | Data is CC0 (<https://dblp.org/db/about/copyright.html>; page is behind the same bot challenge). |
| **ACL Anthology** `aclanthology.org` | No API. Use static files: `anthology.bib.gz` (refreshed daily; `Last-Modified 2026-10-19` observed) and the metadata XML on GitHub (`acl-org/acl-anthology`, code Apache-2.0). Python lib `acl-anthology`. | Every ACL, EMNLP, NAACL, EACL, TACL, CL paper, plus workshops | Direct PDF `https://aclanthology.org/<id>.pdf` | Papers since 2016 are CC BY 4.0 (older ones vary) (<https://aclanthology.org/faq/copyright/>). Redistribution with attribution is allowed for CC BY items. |
| **Papers with Code** | **Shut down in July 2025.** The domain redirects to Hugging Face "Trending Papers". The old `/api/v1` is not a supported replacement. The last data dump is at `github.com/paperswithcode/paperswithcode-data` (frozen). | Do not integrate. Hugging Face Papers (`huggingface.co/api/papers/...`) is an unofficial option for code links. | — | — |
| **Unpaywall** `api.unpaywall.org/v2/<doi>?email=` | Email required, **100,000 calls/day** (<https://unpaywall.org/products/api>). Rebuilt in May 2025 (OurResearch, now under OpenAlex; <https://blog.openalex.org/major-update-to-unpaywall-database>). `oa_locations.evidence` and `updated` are deprecated. | DOI → OA status and best PDF. Same data as OpenAlex's `best_oa_location`, so it is redundant if we use OpenAlex, but free and keyless. | `best_oa_location.url_for_pdf` | Data is CC0. |
| **OpenReview** `api2.openreview.net` | Python client `openreview-py` (MIT). **Observed 2026-10-21: anonymous `/notes` requests return `403 ChallengeRequiredError`**, so we would need an account token (`POST /login`). | ICLR (all years), NeurIPS (reviews and accepted papers since 2021), TMLR | `https://openreview.net/pdf?id=<id>` | Respect the terms of use. Fetch with a logged-in lab service account, at low rates. |

### C2. Which source gives PDFs for our venues

Spot checks (2026-10-21):

| Venue | Publisher / DOI prefix | Open PDF? | Best source |
|---|---|---|---|
| **Interspeech** | ISCA, `10.21437/Interspeech.YYYY-N` | **Yes, all open** at the ISCA Archive (`https://www.isca-archive.org/interspeech_2020/gulati20_interspeech.pdf` returned 200 `application/pdf`) | OpenAlex and Unpaywall pointed the Conformer paper to **arXiv** (`best_oa_location`), not ISCA. Derive the ISCA archive URL from the paper page (`isca-archive.org/interspeech_YYYY/<key>_interspeech.html`, which has BibTeX and DOI), or crawl the yearly index. DBLP `ee` links also point there. |
| **ICASSP** | IEEE, `10.1109/ICASSP…` | **No** (OpenAlex and Unpaywall: `closed`, tested on Wav2vec-Switch, ICASSP 2022) | arXiv preprint by title match: the arXiv API `ti:"…"` found `2110.04934`. S2 `externalIds.ArXiv` links versions. IEEE Xplore's API needs a key and does not give PDFs. |
| **ACL / EMNLP / NAACL** | ACL, `10.18653/v1/…` | **Yes** (Unpaywall `hybrid`, `aclanthology.org/<id>.pdf`) | ACL Anthology |
| **NeurIPS** | `proceedings.neurips.cc` | **Yes** (proceedings are open; no DOI for most years) | NeurIPS proceedings site and OpenReview (2021+). DBLP/OpenAlex for metadata. |
| **ICLR** | OpenReview only | **Yes** | OpenReview (needs a login token now). arXiv as fallback. |

Recommended resolver chain for "find the PDF": a user-uploaded PDF, then a venue-specific open source (ISCA archive,
ACL Anthology, NeurIPS proceedings, OpenReview), then OpenAlex `best_oa_location.pdf_url` (free singleton), then an S2
`openAccessPdf`, then an arXiv title match, and finally show "無開放全文" with the DOI landing page.
**Download PDFs into our S3 only for private lab use.** Do not expose them publicly from the hub (arXiv and S2 terms).

### C3. Implementation notes

- All outbound calls go from the **backend** (which has internet). The worker and compiler stay offline. Wrap each provider in a client with a token bucket matching the limits above: arXiv 1 per 3 s and 1 connection, S2 1 RPS, Crossref polite 3 concurrent, OpenAlex at most 10/s plus a daily-budget guard that reads `X-RateLimit-Remaining-USD`.
- Cache responses in Postgres (`paper_lookup_cache(provider, key, body jsonb, fetched_at)`) for 7–30 days. Singleton lookups are often repeated.
- Config (`.env`): `OPENALEX_API_KEY`, `S2_API_KEY`, `CONTACT_EMAIL` (for the Crossref `mailto`, the Unpaywall `email` and the User-Agent), `OPENREVIEW_USER`/`OPENREVIEW_PASSWORD` (optional). The search UI degrades gracefully when a key is missing.
- Search UX: run one query fanned out to OpenAlex (broad) and S2 (ML-strong, gives `tldr` and `openAccessPdf`), dedupe with B2, and filter by venue chips (Interspeech, ICASSP, ACL, NeurIPS, ICLR). arXiv is used for "new in eess.AS / cs.CL" feeds.

---

## Open questions for the spec

1. LaTeX grammar: pin MIT `codemirror-lang-latex@0.4.1`, or invest in our own Lezer grammar?
2. Compiler isolation: uid-per-slot (simpler) or bubblewrap with a custom seccomp profile (stronger)?
3. Restricted shell-escape for EPS and minted, or fully off as requested?
4. Is citeproc-js (CPAL/AGPL) acceptable if we want formatted bibliographies in the hub?
5. Should GROBID be included in v1, or come later?
6. Migration from Aldine: export each Aldine project as a ZIP (or use its git repo) and import it through the ZIP importer. Aldine's Yjs state is not reused.
