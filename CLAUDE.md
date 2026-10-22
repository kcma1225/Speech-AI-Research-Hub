# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Speech-AI Research Hub (v3): an agentic workspace for master's students organised around **studies** (研究): each study has stages, milestones, tasks, collaborative notes, a literature library, slide decks (progress / paper reports), meetings (recordings → transcripts → per-study AI drafts) and LaTeX papers, plus an AI assistant with consent-gated tools. `docs/v3-spec.md` holds the product decisions; vendor research is in `docs/research/`. User-facing strings are Traditional Chinese (繁體中文); keep that, and keep error responses as `{ "error": "<繁中訊息>" }`.

**`docs/architecture.md` is the contract** (services, jobs lifecycle, object keys, every API route, roles, AI platform, slide-viewing security). Read it before changing an API, a job payload, or a storage key, and update it in the same change.

## Commands

Full stack (only nginx publishes ports):

```bash
scripts/gen-env.sh                                  # create .env with random secrets (never overwrites)
docker compose up -d --build
scripts/staging.sh up|down|ps|logs|reset            # separate v3 staging stack (project hubv3, 127.0.0.1:18090)
docker compose logs -f backend worker
docker compose down                                 # never `down -v` unless asked: deletes all data
```

Per service (each has its own `package.json`; run `npm ci` first):

| Dir | Build / check | Tests |
|---|---|---|
| `backend/` | `npm run build`, `npm run typecheck` | `npm test`; one file: `npx vitest run test/notes.test.ts`; one test: `npx vitest run -t "name"` |
| `worker/` | `npm run build`, `npm run typecheck` | `npm test` |
| `frontend/` | `npm run build`, `npm run check` | — |
| `latex-runner/` | `npm run build` | `npm test` (e2e needs the image; see its README) |

Integration tests are skipped unless real services are provided. Start throwaway containers and pass URLs:

```bash
docker run -d --rm --name hubtest -e POSTGRES_PASSWORD=pw -p 55440:5432 pgvector/pgvector:0.8.7-pg17
docker run -d --rm --name hubtest-s3 -e RUSTFS_ACCESS_KEY=testkey -e RUSTFS_SECRET_KEY=testsecret123 -p 59040:9000 rustfs/rustfs:1.0.1 rustfs
# backend (creates a fresh database + bucket per test file):
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55440/postgres TEST_S3_ENDPOINT=http://127.0.0.1:59040 \
  TEST_S3_ACCESS_KEY=testkey TEST_S3_SECRET_KEY=testsecret123 npm test
# worker queue tests need a database with migrations applied and a hub_worker role:
TEST_ADMIN_DB_URL=postgres://postgres:pw@127.0.0.1:55440/research_hub TEST_WORKER_DB_URL=postgres://hub_worker:<pw>@127.0.0.1:55440/research_hub npm test
```

## Architecture

- **nginx** (`nginx/`): builds the SvelteKit app into its image and serves it (SPA fallback); proxies `/api/` to the backend, with WebSocket upgrade on `/api/collab` and meeting live captions and unbuffered SSE for AI streams. The entrypoint renders templates for HTTP or HTTPS mode. The SPA's inline bootstrap script is allowed by CSP hash computed at build (`csp-hashes.mjs`), not `'unsafe-inline'`.
- **backend** (`backend/`, Fastify 5, ESM with `.js` import suffixes):
  - Each feature is a plugin in `src/routes/*.ts`, registered in `src/app.ts` under `/api`. Domain helpers live in `src/lib/<feature>/`.
  - Every route checks access itself: `requireUser` / `requireAdmin` from `src/lib/auth.ts`, and per study `loadStudyAccess` / `requireStudyEditor` / `requireStudyManager` from `src/lib/studies/access.ts` (everyone reads every study; members edit; professors comment). Validate input with zod via `parse()` from `src/lib/http.ts`.
  - A global `onRequest` hook rejects unsafe methods whose `Origin` ≠ `APP_ORIGIN` (exemptions: `POST /api/oidc/token`, `POST /api/mcp` — bearer-token only).
  - AI: code asks the platform for a **role** (`assistant|writing|slides|analysis|fast|embedding|asr|asr_live`) via `ai.*` in `src/ai/platform/`, never a model. Providers/routes/role bindings live in the DB (admin UI `/admin/models`), never in env. A role that is unavailable shows 「維護中」 (frontend `AiGate`) and the rest of the app keeps working.
  - Agent tools register with `registerAgentTool` (`src/agent/tools/registry.ts`); edits to existing content are suggestions (`createSuggestion`), collaborative docs go through `app.collab` (Yjs; never rebuild a doc from text).
  - Schema: append `migrations/NNNN_*.sql` (applied at startup under an advisory lock; never edit an applied one). `src/bootstrap.ts` creates/re-keys the initial admin from `ADMIN_NAME`/`ADMIN_PASSWORD` (legacy `OWNER_*` fallback). Admin accounts (`role=admin`) are system-only: `workspaceGuard` in `src/lib/auth.ts` refuses them on every workspace API route (allowlist `ADMIN_ALLOWED`).
  - Files go to RustFS through `src/lib/storage.ts`; canonical keys are in `keys`. Uploads stream via `@fastify/multipart` (container root is read-only; only `/tmp` is writable).
- **jobs** (Postgres `jobs` table, no external queue):
  - The backend enqueues with `enqueueJob(client, …)` inside the domain transaction (`src/jobs/queue.ts`).
  - The worker claims with `SKIP LOCKED`, heartbeats, retries infra errors, and reaps stale jobs.
  - The backend `JobFinalizer` applies finished jobs to domain tables exactly once via `registerFinalizer` (`src/jobs/*-finalizer.ts`), with post-commit callbacks for push and S3 cleanup.
  - Payload/result types are duplicated in `backend/src/jobs/queue.ts` and `worker/src/types.ts`; keep them in sync.
- **ai-worker** (backend image, `dist/ai-worker/main.js`): claims `ai_*` jobs (transcription, meeting analysis, slide drafts, library imports, search/embedding indexing) registered with `registerAiJob`; has internet; `llm_unavailable` pauses with backoff and auto-resumes.
- **latex-runner** (`latex-runner/`): claims only `latex_compile`; TeX Live + CJK fonts; each compile runs in a bubblewrap sandbox (custom seccomp profile), internal network only. Contract in `latex-runner/README.md`; shared types in `backend/src/lib/latex/`.
- **worker** (`worker/`): claims only its own kinds (`slide_render`, `slide_preview`, `media_transcode`); runs as DB role `hub_worker` (only `SELECT, UPDATE ON jobs`) on an internal network without internet. `slide_render` validates and extracts the ZIP, injects the annotate plugin (`assets/annotate`), runs `quarto render`, then prints the PDF with puppeteer + pinned Chrome. `offline-assets/` is uploaded once per content hash to `slides/_shared/<hash>/` (`slide_versions.shared_prefix`). The same job also handles PDF decks (poppler → WebP pages) and PPTX decks (LibreOffice headless → PDF → pages, notes from the PPTX XML; lands in status `review`); every type writes page images + `pages.json` under the reserved `<outputPrefix>_hub/`. `media_transcode` runs ffmpeg.
- **Slide viewing**: decks render in a sandboxed iframe without `allow-same-origin` (opaque origin, no cookies), so asset URLs carry a capability: an HMAC view token signed with `AUTH_SECRET` (12 h), `public`, or the share key. `src/routes/slide-view.ts` patches deck HTML (in-memory Web Storage shim, Reveal tweak) and sets a sandbox CSP on every asset.
- **OIDC provider** (`src/routes/oidc.ts`, `src/lib/oidc/`): generic, one first-party client from `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_REDIRECT_URIS` (off when unset); kept for future MCP OAuth. The v2 Aldine LaTeX editor it used to serve has been removed.
- **frontend** (`frontend/`): SvelteKit (adapter-static, `ssr = false`) + Svelte 5 + Tailwind 4, custom UI components only (`src/lib/components/ui/`), zh-TW + English via per-module `src/lib/i18n/<module>.ts` merged in `messages.ts`, RWD required. Study tabs are registered in `src/lib/components/study/tabs/registry.ts`. Shared CodeMirror/Yjs/suggestion pieces: `docs/editor-collab.md`. `npm run dev` proxies `/api` to `127.0.0.1:3000`.

## Other files

- `scripts/`: `export-legacy.sh` (dump v1 data on the v1 host; v2 does not import it), `backup.sh` (pg_dump + bucket mirror), `gen-env.sh`.
- `slides/`: sample deck sources and annotate-plugin docs. `slides/_extensions/annotate` must stay identical to `worker/assets/annotate`.
- `skills/labhub-report/`: a Claude skill that turns research output into the professor's Lab-Hub Quarto formats; independent of the app.
- `docs/ai-providers.md`, `docs/ai-asr-oauth.md`, `docs/library.md`, `docs/editor-collab.md`: library/module references.
- `DESIGN.md` is the superseded v1 design. `PROPOSAL.md` is a pending feature proposal (its memo/task sections were cancelled). `TODO.md` lists pre-production items; Passkey/2FA are not implemented.
