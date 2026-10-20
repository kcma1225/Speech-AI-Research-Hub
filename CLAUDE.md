# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Speech-AI Research Hub (v2): a lab collaboration site for weekly meeting slides (Quarto), research notes, recordings with transcripts, and a self-hosted collaborative LaTeX editor (Aldine). User-facing strings are Traditional Chinese (繁體中文); keep that, and keep error responses as `{ "error": "<繁中訊息>" }`.

**`docs/architecture.md` is the contract** (services, jobs lifecycle, object keys, every API route, roles, slide-viewing security). Read it before changing an API, a job payload, or a storage key, and update it in the same change.

## Commands

Full stack (only nginx publishes ports):

```bash
scripts/gen-env.sh                                  # create .env with random secrets (never overwrites)
docker compose up -d --build                        # add --profile latex for Aldine
docker compose logs -f backend worker
docker compose down                                 # never `down -v` unless asked: deletes all data
```

Per service (each has its own `package.json`; run `npm ci` first):

| Dir | Build / check | Tests |
|---|---|---|
| `backend/` | `npm run build`, `npm run typecheck` | `npm test`; one file: `npx vitest run test/notes.test.ts`; one test: `npx vitest run -t "name"` |
| `worker/` | `npm run build`, `npm run typecheck` | `npm test` |
| `frontend/` | `npm run build`, `npm run check` | — |

Integration tests are skipped unless real services are provided. Start throwaway containers and pass URLs:

```bash
docker run -d --rm --name hubtest -e POSTGRES_PASSWORD=pw -p 55440:5432 postgres:17-alpine
docker run -d --rm --name hubtest-s3 -e RUSTFS_ACCESS_KEY=testkey -e RUSTFS_SECRET_KEY=testsecret123 -p 59040:9000 rustfs/rustfs:1.0.1 rustfs
# backend (creates a fresh database + bucket per test file):
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55440/postgres TEST_S3_ENDPOINT=http://127.0.0.1:59040 \
  TEST_S3_ACCESS_KEY=testkey TEST_S3_SECRET_KEY=testsecret123 npm test
# worker queue tests need a database with migrations applied and a hub_worker role:
TEST_ADMIN_DB_URL=postgres://postgres:pw@127.0.0.1:55440/research_hub TEST_WORKER_DB_URL=postgres://hub_worker:<pw>@127.0.0.1:55440/research_hub npm test
```

## Architecture

- **nginx** (`nginx/`): builds the SvelteKit app into its image and serves it (SPA fallback); proxies `/api/` to the backend; renders `LATEX_HOSTNAME` → Aldine only when that env is set. The entrypoint renders templates for HTTP or HTTPS mode. The SPA's inline bootstrap script is allowed by CSP hash computed at build (`csp-hashes.mjs`), not `'unsafe-inline'`.
- **backend** (`backend/`, Fastify 5, ESM with `.js` import suffixes):
  - Each feature is a plugin in `src/routes/*.ts`, registered in `src/app.ts` under `/api`. Domain helpers live in `src/lib/<feature>/`.
  - Every route checks access itself with `requireUser` / `requireEditor` (everyone except professor) / `requireOwner` from `src/lib/auth.ts`, and validates input with zod via `parse()` from `src/lib/http.ts`.
  - A global `onRequest` hook rejects unsafe methods whose `Origin` ≠ `APP_ORIGIN`.
  - Schema: append `migrations/NNNN_*.sql` (applied at startup under an advisory lock; never edit an applied one). `src/bootstrap.ts` creates/re-keys the Owner from `OWNER_PASSWORD`.
  - Files go to RustFS through `src/lib/storage.ts`; canonical keys are in `keys`. Uploads stream via `@fastify/multipart` (container root is read-only; only `/tmp` is writable).
- **jobs** (Postgres `jobs` table, no external queue):
  - The backend enqueues with `enqueueJob(client, …)` inside the domain transaction (`src/jobs/queue.ts`).
  - The worker claims with `SKIP LOCKED`, heartbeats, retries infra errors, and reaps stale jobs.
  - The backend `JobFinalizer` applies finished jobs to domain tables exactly once via `registerFinalizer` (`src/jobs/*-finalizer.ts`), with post-commit callbacks for push and S3 cleanup.
  - Payload/result types are duplicated in `backend/src/jobs/queue.ts` and `worker/src/types.ts`; keep them in sync.
- **worker** (`worker/`): runs as DB role `hub_worker` (only `SELECT, UPDATE ON jobs`) on an internal network without internet. `slide_render` validates and extracts the ZIP, injects the annotate plugin (`assets/annotate`), runs `quarto render`, then prints the PDF with puppeteer + pinned Chrome. `offline-assets/` is uploaded once per content hash to `slides/_shared/<hash>/` (`slide_versions.shared_prefix`). `media_transcode` runs ffmpeg.
- **Slide viewing**: decks render in a sandboxed iframe without `allow-same-origin` (opaque origin, no cookies), so asset URLs carry a capability: an HMAC view token signed with `AUTH_SECRET` (12 h), `public`, or the share key. `src/routes/slide-view.ts` patches deck HTML (in-memory Web Storage shim, Reveal tweak) and sets a sandbox CSP on every asset.
- **Aldine** (profile `latex`, `deploy/aldine/`): must stay on its own hostname, never a subpath of the hub origin. Account creation is behind nginx Basic Auth. Lab members can read each other's projects (accepted risk; see `docs/aldine-evaluation.md`).
- **frontend** (`frontend/`): SvelteKit (adapter-static, `ssr = false`) + Svelte 5 + Tailwind 4. Currently a placeholder; the real UI is pending a design discussion with the user. `npm run dev` proxies `/api` to `127.0.0.1:3000`.

## Other files

- `scripts/`: `export-legacy.sh` (dump v1 data on the v1 host; v2 does not import it), `backup.sh` (pg_dump + bucket mirror + Aldine volumes), `gen-env.sh`.
- `slides/`: sample deck sources and annotate-plugin docs. `slides/_extensions/annotate` must stay identical to `worker/assets/annotate`.
- `skills/labhub-report/`: a Claude skill that turns research output into the professor's Lab-Hub Quarto formats; independent of the app.
- `DESIGN.md` is the superseded v1 design. `PROPOSAL.md` is a pending feature proposal (its memo/task sections were cancelled). `TODO.md` lists pre-production items; Passkey/2FA are not implemented.
