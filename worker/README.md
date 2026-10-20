# worker

Runs background jobs from the Postgres `jobs` table (contract: `docs/architecture.md` → "Jobs"):

- `slide_render` (`sourceType` in the payload, default `quarto`; contract and manifest format: `docs/architecture.md` → "Jobs"):
  - `quarto`: download `source.zip` → validate + extract (`src/zip.ts`) → inject the annotate plugin
    (`src/annotate.ts`, assets in `assets/annotate`) → `quarto render --to revealjs --no-execute` (180 s) → a deck whose
    output writes the reserved `_hub/` directory fails → bundle math and fonts locally (`scripts/prepare-pdf.py`) and print
    `slides.pdf` with headless Chrome through puppeteer-core (`src/pdf.ts`). It waits for fonts, images, Reveal's print
    layout and MathJax, blocks any non-`file:` request, and retries once. In the same browser it then loads the deck
    normally at 960 px wide (deck aspect ratio), hides Reveal controls/progress/slide number and the annotate toolbar,
    screenshots the first slide (`_hub/thumbnail.png`), and then walks **every slide** in Reveal order
    (`Reveal.getSlides()`, vertical slides included, `fragments:false` so all fragments show): `Reveal.slide(h,v)`, two
    animation frames + 40 ms, 480 px WebP screenshot (JS dialogs are auto-dismissed); first h1–h3 as title; `aside.notes` (Quarto `::: notes`) collected as
    a DOM tree and serialised in Node (`src/pages.ts`) to plain text and minimal HTML (p/ul/ol/li/strong/em/code/br/a[href],
    text escaped). Capped at 300 slides / 90 s; on any capture failure pages are omitted, the job still succeeds →
    upload the deck's own files to `outputPrefix` (16 in parallel, with Content-Type set). `offline-assets/`
    (MathJax/KaTeX/fonts, ~1.6k files, identical for a given image) goes once to `slides/_shared/<hash>/`, with a
    `.complete` marker written last; later renders skip it (first render ~2 min, later ones ~20 s) → best effort: thumbnail,
    `_hub/pages/<n>-thumb.webp`, `_hub/pages.json`.
  - `pdf`: download `source.pdf` → `pdfinfo` (encrypted/unreadable/0 or > 500 pages fail the job) → `pdftoppm -png`
    with the longer side at 1920 px (1920 px wide for slides) in batches of 10 pages → `cwebp` to `<n>-full.webp` (q85), `<n>-thumb.webp` (480 px, q80) and, for
    page 1, `thumbnail.webp` (960 px); each PNG is deleted right after conversion (tmpfs counts as memory) → upload under
    `_hub/` + manifest. The uploaded PDF itself is the deck's PDF (`pdfKey` = `sourceKey`).
  - `pptx`: download `source.pptx` → read the package with yauzl (`src/pptx.ts`: needs `[Content_Types].xml` +
    `ppt/presentation.xml`, refuses macros and encrypted entries, only the slide/notes XML parts are inflated, ≤ 20 MB
    each) → titles (title placeholder) and speaker notes (`ppt/notesSlides/notesSlideN.xml` body placeholder, mapped to
    slides via `ppt/_rels/presentation.xml.rels` order + each slide's `notesSlide` relationship; hidden slides skipped) →
    `soffice --headless --convert-to pdf` with HOME/TMPDIR/`-env:UserInstallation` in the job directory (240 s timeout;
    the jobs network has no internet) → pages as for `pdf` (notes attached only when the visible slide count equals the
    PDF page count) → `slides.pdf` uploaded to `outputPrefix`. The backend puts the finished version in `review`.
- `media_transcode`: download the upload → ffprobe duration → ffmpeg to 24 kHz mono 48 kbps AAC/M4A
  (`+faststart` for Range playback, progress 0–95 %) → waveform peaks (`src/peaks.ts`): ffmpeg decodes the M4A to
  mono 8 kHz s16le on a pipe, folded while streaming into 1/20 s windows (max |sample|), then into
  N = min(1000, ceil(duration·20)) buckets by max, normalized to [0,1] and rounded to 3 decimals (2.5 h: ~15 s, PCM is
  never buffered). It is returned as `peaks`. On failure it is logged and `peaks` is omitted → upload to `outputKey` →
  delete the upload.

## Runtime model

- The worker connects as `hub_worker`, which can only `SELECT, UPDATE` on `jobs`. Every update is guarded by
  `locked_by`, so a worker that loses its lease cannot overwrite a newer attempt.
- It claims jobs with `FOR UPDATE SKIP LOCKED`. It is woken by `LISTEN jobs_new` and also polls every 2 s.
  `WORKER_CONCURRENCY` slots (default 1).
- It sends a heartbeat every 5 s with the stage and progress, plus an immediate one on each stage change.
  When `cancel_requested` is set, it kills the child process, deletes partial output and marks the job `cancelled`.
- Failures:
  - `JobInputError` (bad ZIP, Quarto/ffmpeg error) fails the job permanently, with the log tail as `error`.
  - Any other error is treated as infrastructure (S3, network). The job is requeued with a backoff of
    15 s·2^(n−1), capped at 10 min, until `max_attempts` is reached.
- Reaper: every 30 s, `running` jobs with a heartbeat older than 60 s are requeued, cancelled or failed.
- SIGTERM: the worker stops claiming and waits up to 20 s. It then aborts any running job and hands it back
  (`queued`, attempt not counted). Compose needs `stop_grace_period` ≥ 30 s.
- Health: a loopback-only HTTP server at `127.0.0.1:8080/health`, checked by the image `HEALTHCHECK`
  (`node dist/healthcheck.js`).

## Environment

`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `WORKER_DB_USER` (default `hub_worker`), `WORKER_DB_PASSWORD`,
`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `WORKER_CONCURRENCY`, `LOG_LEVEL`.
The worker validates these at startup and exits with a list of invalid variables.

## Develop

```bash
npm ci
npm run typecheck
npm test     # unit tests; queue tests also run when TEST_ADMIN_DB_URL / TEST_WORKER_DB_URL are set (see test/queue.test.ts)
docker build --platform linux/amd64 -t hub-worker-dev .
```

The image is amd64-only (upstream Quarto image) and about 3.0 GB (LibreOffice Impress, poppler-utils, webp and the
Liberation/Carlito/Caladea fonts add ~0.42 GB; ~110 MB compressed). It must run with a read-only root and a
tmpfs `/tmp`: `HOME`, the XDG dirs, `DENO_DIR` and `WORK_DIR` all point there.
