# latex-runner

Compiles LaTeX projects for the built-in editor (spec §10). It claims `latex_compile` jobs from the
Postgres `jobs` table exactly like `worker/` (SKIP LOCKED claim, heartbeat every 5 s, lease guarded by
`locked_by`, retry with backoff for infrastructure errors, reaper for stale leases, graceful hand-back
on SIGTERM), downloads the project snapshot from RustFS, runs `latexmk` inside a per-compile
bubblewrap sandbox and uploads the PDF, SyncTeX, log and `.blg` files.

It is a separate service from `worker/` because of the TeX Live image size, and it claims **only**
`kind = 'latex_compile'` (the worker must likewise claim only its own kinds, see "Coordinator notes").

## Job contract

Types: `backend/src/lib/latex/contract.ts` (source of truth), copied to `src/shared/contract.ts`
by `scripts/sync-shared.sh`; `backend/test/latex-sync.test.ts` fails when the copies drift. The log
parsers and the zh-TW hint table are shared the same way (`log-parser.ts`, `blg-parser.ts`, `hints.ts`).

**Payload** (`jobs.kind = 'latex_compile'`):

```ts
{
  projectId: string;      // [A-Za-z0-9][A-Za-z0-9_-]{0,63} (uuid)
  compileId: string;      // same format
  manifestKey: string;    // must start with latex/<projectId>/
  rootFile: string;       // project-relative .tex/.ltx, e.g. "main.tex"
  compiler: "pdflatex" | "xelatex" | "lualatex";   // from project settings
  outputPrefix: string;   // must start with latex/<projectId>/ and end with "/"
  draft?: boolean;        // one pass, no BibTeX/biber
  haltOnError?: boolean;  // -halt-on-error instead of -f
}
```

**Snapshot manifest** (JSON at `manifestKey`):

```ts
{ version: 1, files: [{ path: "sections/intro.tex", key: "latex/<projectId>/blobs/<sha256>", size?: number, sha256?: string }] }
```

Every `key` must be below `latex/<projectId>/` (a manifest cannot pull another project's blobs).
Paths: forward slashes, no `..`/`.` segments, not absolute, no segment starting with `-`, not under
`.out/` (the build directory), ≤ 255 bytes, no file/folder name clash. Limits: `LATEX_MAX_FILES`
(2000) files, `LATEX_MAX_PROJECT_MB` (300) MB. `sha256`, when given, is verified after download.

**Result** (`jobs.result`). A LaTeX error is **not** a job failure: the job succeeds with
`status: "failure"` (or `partial`) and the parsed errors.

```ts
{
  status: "success" | "partial" | "failure" | "timeout",
  // success = PDF and no errors; partial = PDF despite errors (-f); failure = no PDF; timeout = killed
  pdfKey: string | null,        // <outputPrefix>output.pdf
  synctexKey: string | null,    // <outputPrefix>output.synctex.gz
  logKey: string | null,        // <outputPrefix>output.log (truncated to 5 MB: first 1 MB + last 4 MB)
  blgKey: string | null,        // <outputPrefix>output.blg (BibTeX or biber)
  stdoutKey: string | null,     // <outputPrefix>latexmk.txt (latexmk/engine console output)
  durationMs: number,
  pdfBytes: number | null,
  compiler: "pdflatex" | "xelatex" | "lualatex",
  errors: LatexDiagnostic[],    // ≤ 100
  warnings: LatexDiagnostic[],  // ≤ 200: warnings, then bad boxes
  warningCount: number,         // totals before truncation
  badBoxCount: number,
  retriedAfterStaleAux?: true   // errors in .aux/.toc/.bcf → .out wiped and compiled again once
}

LatexDiagnostic = {
  severity: "error" | "warning" | "badbox" | "info",
  source: "latex" | "bibtex" | "biber" | "latexmk",
  file: string | null,          // project-relative; "<texmf>/…" for TeX Live files; ".out/…" for generated files
  line: number | null,
  message: string,              // raw message (container paths stripped)
  context?: string,             // "l.12 \foo" lines
  token?: string,               // offending control sequence for "Undefined control sequence"
  generated?: true,
  code?: string, title_zh?: string, hint_zh?: string   // from hints.ts (40 common messages)
}
```

The job **fails** (`status = 'failed'`, `error` = 繁中 message) only for bad input: invalid payload,
unsafe path, foreign key, missing manifest/blob, hash mismatch, size limits, root file not in the
snapshot. Anything else (S3/DB errors, sandbox failure) is retried up to `max_attempts`. On
cancel/failure/shutdown the runner deletes everything under `outputPrefix`.

Stage labels: 準備檔案 → 編譯中 → 上傳結果 → 完成.

## How a compile runs

1. Per-project cache `WORK_DIR/projects/<projectId>/src` (mode 0700). Sync by manifest: download only
   files whose key changed (or whose size/mtime changed since the last sync), delete files that left
   the snapshot (and any symlink or special file). `.out/` survives for incremental latexmk builds and
   is wiped when the compiler or root file changes. LRU eviction beyond `LATEX_CACHE_PROJECTS` (16).
   Compiles of one project are serialized.
2. Stale outputs (`<root>.pdf/.log/.blg/.synctex.gz`) are deleted so an old PDF is never reported.
3. `latexmk -norc -pdf|-xelatex|-lualatex -interaction=nonstopmode -file-line-error -synctex=1
   -no-shell-escape -outdir=.out -f|-halt-on-error [-e '$max_repeat=1' -e '$bibtex_use=0'] ./<root>`
   from the project root (like Overleaf). `-norc` ignores `latexmkrc` files in the project (they are
   Perl). latexmk runs BibTeX or biber automatically.
4. Limits: `prlimit --as=2 GiB --cpu=150 s --fsize=200 MB --nproc=256 --core=0 --nofile=1024`, wall
   clock `LATEX_TIMEOUT_SECONDS` (120 s) then SIGKILL of the process group.
5. Logs are parsed (`log-parser.ts`, `blg-parser.ts`), hints attached, outputs uploaded. A BibTeX/
   biber crash that leaves no usable `.blg` is taken from latexmk's "Collected error summary" and
   reported as an error (`code: bib-tool-failed`), so the build is `partial`, not `success`.

TeX settings baked into `texmf.cnf`: `shell_escape = f`, `openout_any = p`, `max_print_line = 10000`.
minted, `\write18`, EPS conversion and anything else needing shell escape do not work by design.

## Isolation

Each compile runs in **bubblewrap** (`src/sandbox.ts`) as the unprivileged runner uid with new user,
mount, pid, ipc, uts, cgroup and **network** namespaces (no interfaces besides an unconfigured `lo`).
The sandbox sees only:

| Path | Access |
|---|---|
| `/work` | the project's own `src` dir, read-write |
| `/usr` (TeX Live, perl, Noto CJK) | read-only |
| `/etc/fonts`, `/var/cache/fontconfig`, `/opt/par` (biber) | read-only |
| `/tmp` | private tmpfs |
| `/dev` | minimal (null, zero, urandom, tty…) |

There is no `/proc`, no `/etc/passwd`, no `/app` (runner code), no other project and no environment
from the runner (`--clearenv`: database and S3 credentials never reach TeX). kpathsea's
`openin_any = a` therefore cannot read anything sensitive, which also fixes Aldine's cross-project read.

Inside the sandbox a seccomp filter (`src/seccomp-bpf.ts`, passed with `--seccomp 3`) blocks new
namespaces (clone with `CLONE_NEW*`, unshare, setns), every mount syscall, ptrace, bpf, perf,
keyrings, io_uring and module loading; clone3 returns ENOSYS so glibc falls back to clone.

**Why a custom seccomp profile.** Docker's default profile forbids `clone(CLONE_NEWUSER)`/`unshare`
and `mount` without `CAP_SYS_ADMIN`, so bwrap cannot start ("No permissions to create a new
namespace"). `seccomp.json` is Docker's default profile (moby/profiles, Apache-2.0) plus an
unconditional allow for `clone, unshare, setns, mount, umount, umount2, pivot_root, mount_setattr,
open_tree, move_mount` (generated by `scripts/gen-seccomp.py`). The container still drops **all**
capabilities and sets `no-new-privileges`, so these calls only take effect inside a new user
namespace; the trade-off is the extra kernel attack surface of unprivileged user namespaces for the
runner process itself (TeX inside the sandbox cannot use them, see the filter above).
`bwrap --disable-userns` is not used because it needs a writable `/proc/sys`, which Docker mounts
read-only; the inner seccomp filter replaces it. No `privileged`, no `CAP_SYS_ADMIN`, no
`apparmor=unconfined` and no `systempaths=unconfined` are needed (Docker host here has no AppArmor;
on AppArmor hosts that restrict unprivileged user namespaces, see "Fallback").

The runner refuses to start if the sandbox self-check fails (`src/self-check.ts`, which starts an
empty sandbox in a temp dir under `/tmp`).
`LATEX_SANDBOX=none` disables isolation for local development only.

**Fallback (not implemented, only if user namespaces are unavailable on the host):** one uid per
concurrency slot + 0700 project dirs owned by the supervisor (needs CAP_CHOWN/SETUID/SETGID/FOWNER).

## Image

`Dockerfile`: `texlive/texlive:latest-medium` (TL 2026, pinned digest) + `tlmgr install` from the dated
`tlnet-archive/2026/10/19` snapshot: `collection-latexextra collection-pictures collection-bibtexextra
collection-publishers collection-langcjk fandol zhlipsum zhnumber hyphen-chinese luatexja`.
collection-latexextra drags in collection-fontsextra (~1.7 GB); its members are removed again except
the fonts paper classes use (libertine, newtx, inconsolata, txfonts, fontawesome5, TeX Gyre, STIX2,
Libertinus, XCharter, New Computer Modern, Source Code Pro), as are ConTeXt, TeXworks and tlcockpit.
Only `/usr/local/texlive` (1.8 GB) is copied into `node:22.23.3-bookworm-slim` (pinned digest) +
`perl fontconfig fonts-noto-cjk bubblewrap` (+ `haranoaji`, luatexja's default fonts), dropping the
base image's Java/GTK/Mesa. Caches built into the image and linked into each sandbox (symlink farm,
`withParCache()` in `src/sandbox.ts`), so they are not rebuilt per compile: biber's PAR cache
(`/opt/par`, ~90 s otherwise) and the luaotfload font-name database + LuaTeX font caches for Noto CJK
(> 60 s otherwise).

Covers: IEEEtran, acmart, ctex/xeCJK/luatexja, biblatex + biber, bibtex/natbib, tikz/pgfplots,
algorithm2e/algorithmicx, booktabs, siunitx, hyperref, cleveref, Noto Serif/Sans CJK TC. Interspeech's
`Interspeech.cls` and ICASSP's `spconf.sty` are not in TeX Live: upload them into the project.

**Measured:** image `hub-latex-runner:dev` = 1.06 GB compressed content, 3.5 GB on disk (`docker
images` DISK USAGE, which counts content + unpacked layers); TeX Live tree 1.8 GB. Typical compile
times in the sandbox (cold project cache, 2 slots): article ~6–15 s, IEEE paper with BibTeX ~20 s,
中文碩士論文 with biber ~30 s, LuaLaTeX + luatexja ~25 s.

## Compose service (proposed; coordinator merges into compose.yaml)

```yaml
  latex-runner:
    build: ./latex-runner
    image: hub-latex-runner:${HUB_VERSION:-dev}
    restart: unless-stopped
    depends_on:
      db: { condition: service_healthy }
      rustfs: { condition: service_healthy }
    environment:
      DATABASE_HOST: db
      DATABASE_NAME: research_hub
      WORKER_DB_USER: hub_worker
      WORKER_DB_PASSWORD: ${WORKER_DB_PASSWORD}
      S3_ENDPOINT: http://rustfs:9000
      S3_BUCKET: ${S3_BUCKET:-hub}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      LATEX_CONCURRENCY: 2
      LATEX_TIMEOUT_SECONDS: 120
      WORK_DIR: /var/latex
    volumes:
      - latex_cache:/var/latex          # per-project build caches only; safe to delete
    tmpfs:
      - /tmp:size=512m,mode=1777
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
      - seccomp=./latex-runner/seccomp.json
    mem_limit: 5g                        # 2 slots × 2 GiB RLIMIT_AS + runner
    pids_limit: 512
    networks: [jobs]                     # internal network with db + rustfs only, no internet

volumes:
  latex_cache:
```

The `latex_cache` volume must be writable by uid 1001 (the image creates nothing there; Docker
initialises a new named volume from the image path, so add `RUN mkdir -p /var/latex && chown
1001:1001 /var/latex` — already in the Dockerfile).

## Development

```bash
npm ci && npm run typecheck && npm test           # unit tests (seccomp filter, cache, payload)
scripts/sync-shared.sh                            # after editing backend/src/lib/latex/{contract,hints,*-parser}.ts
docker build -t hub-latex-runner:dev .
LATEX_E2E_IMAGE=hub-latex-runner:dev TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:55440/postgres \
  TEST_S3_ENDPOINT=http://127.0.0.1:59040 TEST_S3_ACCESS_KEY=testkey TEST_S3_SECRET_KEY=testsecret123 \
  npx vitest run test/e2e.test.ts               # LATEX_E2E_FIXTURES=../backend/test/latex-fixtures refreshes parser fixtures
```
