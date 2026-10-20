# worker

Runs background jobs from the Postgres `jobs` table (contract: `docs/architecture.md` → "Jobs"):

- `slide_render`: download `source.zip` → validate + extract (`src/zip.ts`) → inject the annotate plugin
  (`src/annotate.ts`, assets in `assets/annotate`) → `quarto render --to revealjs --no-execute` (180 s) →
  bundle math and fonts locally (`scripts/prepare-pdf.py`) and print `slides.pdf` with headless Chrome
  through puppeteer-core (`src/pdf.ts`). It waits for fonts, images, Reveal's print layout and MathJax,
  blocks any non-`file:` request, and retries once → upload the deck's own files to `outputPrefix` (16 in parallel, with Content-Type set). `offline-assets/`
  (MathJax/KaTeX/fonts, ~1.6k files, identical for a given image) goes once to `slides/_shared/<hash>/`, with a
  `.complete` marker written last; later renders skip it (first render ~2 min, later ones ~20 s).
- `media_transcode`: download the upload → ffprobe duration → ffmpeg to 24 kHz mono 48 kbps AAC/M4A
  (`+faststart` for Range playback, progress 0–95 %) → upload to `outputKey` → delete the upload.

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

The image is amd64-only (upstream Quarto image) and about 2.4 GB. It must run with a read-only root and a
tmpfs `/tmp`: `HOME`, the XDG dirs, `DENO_DIR` and `WORK_DIR` all point there.
