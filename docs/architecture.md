# Architecture (v2)

v2 replaces the v1 MVP (Next.js full-stack + file-based render queue + Overleaf). v1 data is exported with
`scripts/export-legacy.sh` and is **not** migrated; v2 starts from an empty database and bucket.

```
                    :80 / :443  (the only published ports)
                         │
                      nginx ── /api/*  → backend:3000
                         │     /*      → SvelteKit static build (SPA fallback to index.html)
   ┌─────────────────────┴──────────── network "internal" (no published ports) ─┐
   backend  (Node 22, TypeScript, Fastify 5)                                    │
     ├── db      (PostgreSQL 17)                                                │
     └── rustfs  (S3-compatible object storage, bucket $S3_BUCKET)              │
   worker   (Node 22 + Quarto + headless Chrome + ffmpeg)                       │
     └── network "jobs" (internal: true, no internet): db + rustfs only         │
```

| Service | Dir | Responsibility |
|---|---|---|
| nginx | `nginx/` | TLS, rate limit on `/api/auth/`, serves `frontend/` build, proxies `/api/` |
| frontend | `frontend/` | SvelteKit 2 + Svelte 5, `adapter-static`, SPA (`ssr = false`). Built into the nginx image |
| backend | `backend/` | All HTTP API, auth, RBAC, migrations, file streaming from S3, job enqueue + finalize |
| worker | `worker/` | Claims jobs from Postgres, slide render (Quarto → HTML + PDF), media transcode (ffmpeg) |
| db | `postgres/` | PostgreSQL 17; `postgres/init/` creates the `hub_worker` role on first init |
| rustfs | — | `rustfs/rustfs:1.0.1`, S3 API on `:9000`, never published |

## Conventions (backend)

- ESM, `NodeNext` imports with `.js` suffix. Strict TS with `noUncheckedIndexedAccess`.
- Each feature is a Fastify plugin in `backend/src/routes/<name>.ts`, registered in `app.ts` with prefix `/api`.
  Paths inside a plugin are written without `/api` (e.g. `app.get("/items", ...)`).
- Access deps via `app.db` (pg Pool), `app.storage` (`lib/storage.ts`), `app.notifier`, `app.config`.
- Auth helpers in `lib/auth.ts`: `requireUser`, `requireEditor` (not professor), `requireOwner`, `requireRole`.
  **Every route checks access explicitly.** `createSession` / `clearSession` / `audit` live there too.
- Validate all input with zod via `parse(schema, input)` from `lib/http.ts`; throw `HttpError`
  (`badRequest`, `notFound`, `forbidden`, `conflict`) — the error handler replies `{ "error": "<繁中訊息>" }`.
- Responses are JSON objects (never bare arrays), snake_case columns as returned by SQL are fine.
  List endpoints return `{ <plural>: [...] }`. Set `Cache-Control: no-store` on per-user data.
- User-facing messages are Traditional Chinese (繁體中文), matching v1 wording where it exists.
- CSRF: a global `onRequest` hook rejects POST/PUT/PATCH/DELETE whose `Origin` ≠ `APP_ORIGIN` (403).
- Uploads use `@fastify/multipart` (`request.file()`), streamed to S3 via `app.storage.put` — never buffer
  whole files in memory. Enforce the `MAX_*_BYTES` config limits (use `limits.fileSize` and check `file.truncated`).
- Schema changes: add `backend/migrations/NNNN_name.sql` (applied in order at backend start, under an advisory lock).
  Never edit an applied migration.
- Tests: `vitest` in `backend/test/*.test.ts`. Pure logic gets unit tests; route tests use `app.inject()` with a
  real Postgres when `TEST_DATABASE_URL` is set (skipped otherwise).

## Roles

| Role | Notes / tags / media | Slides (create, upload, edit, references, visibility) | Slide reviews | Admin (`/api/users`, `/api/invitations`) |
|---|---|---|---|---|
| owner | read/write | read/write | add; **reply** | yes (Owner cannot be demoted/disabled) |
| admin | read/write | read/write | — | no |
| member | read/write | read/write | — | no |
| professor | read only | read only | **add** | no |

Anonymous visitors may view a slide deck, its references and reviews when the deck is `public_view` or they
hold the share key (capability URL); they can never write.

## Object keys (bucket `$S3_BUCKET`)

Defined in `backend/src/lib/storage.ts` `keys`; the worker receives full keys in job payloads.

| Key | Content |
|---|---|
| `media/uploads/<jobId>/source` | raw uploaded media (deleted by worker after transcode, or by finalizer on failure) |
| `media/items/<itemId>/<jobId>.m4a` | transcoded audio (24 kHz mono 48 kbps AAC) |
| `slides/<projectId>/<versionId>/source.zip` | uploaded deck ZIP (validated by backend before enqueue) |
| `slides/<projectId>/<versionId>/output/…` | rendered deck: entry HTML + assets, plus `slides.pdf` |
| `references/<projectId>/<referenceId>` | reference PDF |

## Jobs

Table `jobs` (see `migrations/0001_init.sql`). Producer helpers: `backend/src/jobs/queue.ts`.

Lifecycle: `queued → running → succeeded | failed | cancelled`, then the backend **finalizer** applies the
result to domain tables once (`finalized_at`). The worker only ever touches the `jobs` table (DB role
`hub_worker` has `SELECT, UPDATE ON jobs` only) and S3.

1. **Enqueue** (backend): `enqueueJob(client, kind, payload, userId)` inside the same transaction as the
   domain row; it runs `pg_notify('jobs_new', kind)`.
2. **Claim** (worker): `LISTEN jobs_new` + poll every 2 s:
   ```sql
   UPDATE jobs SET status='running', attempts=attempts+1, locked_by=$1, heartbeat_at=now(),
          started_at=coalesce(started_at, now()), stage='starting', error=NULL
    WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=now()
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING *;
   ```
3. **Progress/heartbeat** (worker, every ≤10 s): `UPDATE jobs SET heartbeat_at=now(), stage=$2, progress=$3
   WHERE id=$1 AND locked_by=$4 RETURNING cancel_requested`. If `cancel_requested`, kill the child process,
   clean partial outputs, set `status='cancelled'`.
4. **Finish** (worker): set `status` to `succeeded` (with `result`) or `failed` (with `error`, last 4000 chars
   of logs), `progress`, `finished_at=now()`, then `pg_notify('jobs_finished', id)`. A *retryable* failure
   (infrastructure error, not bad input) with `attempts < max_attempts` instead goes back to
   `status='queued', run_after=now()+backoff`.
5. **Reaper** (worker, every 30 s): running jobs whose `heartbeat_at` is older than 60 s are requeued (or
   failed when attempts are exhausted) — this recovers from worker crashes and restarts.
6. **Finalize** (backend `JobFinalizer`): `registerFinalizer(kind, fn)`; `fn(job, {client, log})` runs in a
   transaction for every finished job (any terminal status) and may return a post-commit callback
   (push notifications, S3 cleanup).

Cancellation (backend): `cancelJob(client, jobId)` cancels queued jobs immediately or flags running ones.

### Payload / result contracts

```ts
// kind = "media_transcode"
type MediaTranscodePayload = { itemId: string; sourceKey: string; outputKey: string; fileName: string };
type MediaTranscodeResult  = { outputKey: string; bytes: number; durationSeconds: number | null };
// kind = "slide_render"
type SlideRenderPayload = { projectId: string; versionId: string; sourceKey: string; entry: string; outputPrefix: string };
type SlideRenderResult  = { entryHtml: string; pdfKey: string; quartoVersion: string; fileCount: number };
```

`entry` is the QMD path inside the ZIP (posix, relative, validated). `entryHtml` is the entry HTML path
relative to `outputPrefix`. `pdfKey` is a full key (`<outputPrefix>slides.pdf`).

Media stages (shown to users, 繁中): `排隊中` → `分析媒體` → `音訊轉碼` → `上傳結果` → `完成`.
Slide stages: `排隊中` → `解壓縮` → `編譯簡報` → `匯出 PDF` → `上傳結果` → `完成`.

## API

All under `/api`. `→` describes the response body. Unless noted, routes need a session (401 otherwise).

### Identity (`auth.ts`, `users.ts`, `invitations.ts`, `notifications.ts`, `push.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/health`, `/health/ready`, `/config` | public | done (`health.ts`) |
| GET `/auth/accounts?ids=a,b` | public | names for device-remembered account hints → `{accounts:[{id,name}]}` (only enabled users, max 10 ids) |
| GET `/auth/me` | public | `{user: CurrentUser \| null}` |
| POST `/auth/login` `{userId?, name?, password}` | public | argon2 verify; 401 on failure; `two_factor` users → 403 (Passkey not implemented); sets session; updates `last_login_at` → `{account:{id,name}}` |
| POST `/auth/logout` | user | clears session |
| PATCH `/auth/profile` `{name?, theme?, currentPassword?, newPassword?}` | user | password change requires current password; revokes other sessions |
| GET `/auth/sessions`, DELETE `/auth/sessions/:id` | user | list / revoke own sessions |
| POST `/join` `{token, name, password}` | public | consume invitation atomically (row lock, `use_count < max_uses`, not expired/revoked), create user, session |
| GET `/join/:token` | public | validate token → `{role, expiresAt}` or 404 |
| GET `/users` | owner | all users with role, disabled, last login |
| PATCH `/users/:id` `{role?, disabled?}` | owner | owner cannot be changed; disabling revokes sessions; audit |
| GET `/invitations` | owner | with derived state: active / expired / exhausted / revoked |
| POST `/invitations` `{role, expiresIn: "5m"\|"30m"\|"1h"\|"2h"\|"5h"\|"1d"\|"3d"\|"5d"\|"7d"\|"never", maxUses: 1\|null}` | owner | returns the raw token **once** → `{invitation, token, url}` |
| DELETE `/invitations/:id` | owner | revoke (soft) |
| GET `/notifications`, DELETE `/notifications` `{id?}` | user | latest 100 / remove one or all |
| GET `/notifications/unread` | user | `{count}` |
| POST `/notifications/read` `{ids?: uuid[]}` | user | mark some or all read |
| GET `/push`, POST `/push` `{subscription}`, DELETE `/push` `{endpoint}` | user | Web Push subscription management; GET → `{enabled, publicKey, subscribed}` |
| POST `/push/test` | user | send a test push |

### Notes, tags, media (`items.ts`, `tags.ts`, `slide-tags.ts`, `media.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/items?tags=&q=&limit=&cursor=` | user | `tags` omitted = all; `tags=` (empty) = none; ids comma-separated, `none` = untagged. `q` searches title + content (ILIKE). Keyset pagination by (event_date, created_at, id). Each item: id, title, excerpt, event_date, tags, has_audio, has_transcript, updated_at, author names |
| GET `/items/:id` | user | full note incl. content, tags, audio meta, transcript cues, active media job |
| POST `/items` `{title, event_date, content?, tagIds?}` | editor | |
| PATCH `/items/:id` | editor | partial update; `updated_by`, `updated_at` |
| DELETE `/items/:id` | editor | also cancels its jobs and deletes its S3 objects (post-commit) |
| PUT `/items/:id/tags` `{tagIds}` | editor | replace tag set |
| POST `/items/:id/transcript` (multipart `.srt`, ≤5 MB) / DELETE | editor | parse SRT → cues `[{start,end,text}]` |
| POST `/items/:id/media` (multipart) | editor | stream to `media/uploads/<jobId>/source`, enqueue `media_transcode` → `{jobId}` (202). Max `MAX_MEDIA_BYTES` |
| GET `/media/:itemId` | user | stream audio from S3 with **Range** support (206), `audio/mp4`, `Accept-Ranges: bytes` |
| GET `/media-jobs` | user | caller's latest 20 media jobs → `{jobs:[{id,item_id,status,stage,progress,duration_seconds,error,file_name,created_at}]}` (status mapped: queued/running → `processing`, succeeded → `completed`) |
| GET `/media-jobs/:id`, DELETE `/media-jobs/:id` | owner of job | status / cancel |
| GET `/tags`, POST `/tags` `{name}`, PATCH `/tags/:id` `{name}`, DELETE `/tags/:id` | GET user, writes editor | names 1–40 chars, unique case-insensitive → 409 on duplicate; deleting a tag never deletes notes. GET includes `item_count` |
| same under `/slide-tags` | same | separate tag set for slides |

Finalizer `media_transcode`: on success set `items.audio_*` (delete the previous audio object post-commit),
notify the uploader (`kind:'media'`, url `/items/<id>`); on failure/cancel delete the upload + partial output.

### Slides (`slides.ts`, `slide-reviews.ts`, `slide-view.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/slides?tags=&q=` | user | projects with active version, status of latest version, tags, reference count |
| POST `/slides` (multipart: `title`, `slug`, `entry?`, `public?`, file `.zip`) | editor | validate ZIP (see below), create project + version 1, upload zip, enqueue render (202) |
| GET `/slides/:id` | user | detail: project, versions, references, reviews (+ replies, author names), tags, `viewUrl` for active version |
| PATCH `/slides/:id` `{title?, slug?, public_view?, tagIds?, rotateShareKey?}` | editor | |
| DELETE `/slides/:id` | editor | cascade + delete S3 prefixes post-commit |
| GET `/slides/:id/versions`, POST `/slides/:id/versions` (multipart zip, `entry?`) | GET user, POST editor | new version → render job |
| PATCH `/slides/:id/versions/:versionId` `{active:true}` | editor | set active (must be published) |
| DELETE `/slides/:id/versions/:versionId` | editor | not the active one; deletes S3 objects |
| GET `/slides/:id/status` | user | latest version status `{id,status,version,error,stage,progress}` |
| POST `/slides/:id/render` | editor | retry the latest failed version (new job) |
| POST `/slides/:id/references` (multipart PDF ≤ `MAX_REFERENCE_BYTES`, or JSON `{title,url}`) | editor | first reference becomes default |
| PATCH `/slides/:id/references/:refId` `{title?, isDefault?}`, DELETE | editor | keep exactly one default when any exist |
| POST `/slides/:id/reviews` `{body}` | professor (and owner) | notify editors? — notify the deck creator (`kind:'slide'`) |
| POST `/slides/:id/reviews/:reviewId/replies` `{body}` | owner | notify the review author |
| GET `/slides/by-slug/:slug?key=` | public* | player data: project, active version, `viewUrl`, `pdfUrl`, references, reviews. *Allowed for a user, `public_view`, a valid `key`, or the `slide_share_<slug>` cookie |
| GET `/slides/share/:slug/:key` | public | valid key → set httpOnly cookie `slide_share_<slug>` (path `/`, 30 days) and 302 to `/slides/play/<slug>` |
| GET `/slides/view/:slug/:token/:versionId/*` | capability | serve rendered asset from S3 (see "Slide viewing") |
| GET `/slides/pdf/:slug/:versionId` | same as by-slug | stream `slides.pdf` as attachment `<slug>-v<n>.pdf` |
| GET `/slides/reference/:slug/:refId` | same as by-slug | stream PDF inline, or 302 to URL references |

ZIP validation (backend, before upload, from a temp file using yauzl; the worker re-validates while
extracting): only these extensions `.qmd .md .css .scss .yml .yaml .png .jpg .jpeg .gif .svg .webp .pdf .bib
.csl .json .js .woff .woff2 .ttf .otf .txt .csv .mp4 .webm .mp3 .wav .m4a`; ≤2000 files, ≤500 MB uncompressed,
≤100 MB per file, depth ≤12, no absolute paths / `..` / backslashes / NUL, no symlinks, no `.git`,
`node_modules`, `__MACOSX`, `.env*`, `_site`, `.quarto`. Entry: explicit `entry` if given and present, else root
`index.qmd`, else the only `.qmd`; otherwise 400 asking for the entry path.

Finalizer `slide_render`: on success mark version `published`, set `entry_html`, `pdf_key`, `quarto_version`
and make it active unless a newer version is already active; notify uploader (`kind:'slide'`). On failure set
`status='failed'`, `error`; delete the partial output prefix post-commit.

### Slide viewing

The SPA embeds the deck in `<iframe sandbox="allow-scripts allow-pointer-lock allow-presentation">` (no
`allow-same-origin`), so the iframe has an opaque origin and sends no cookies. Authorisation is by path
capability `:token`, one of:
- `t.<unixExpiry>.<hmac>`: HMAC-SHA256(`AUTH_SECRET`, `slide-view|<projectId>|<versionId>|<expiry>`),
  base64url, 12 h TTL — issued by `/slides/:id` and `/slides/by-slug/:slug` as `viewUrl`;
- `public` when the project is `public_view`;
- the project's share key.

Asset rules (ported from v1 `app/app/slides/view/[slug]/[key]/[versionId]/[[...asset]]/route.ts`): empty path →
entry HTML; reject `slides.pdf`, `pdf.log`, `offline-assets/licenses/*`, any `..`/`.`/backslash/NUL; HTML gets the
in-memory Web Storage shim, the `scrollActivationWidth:0` Reveal patch and the 44 px touch-target CSS; every
response carries the sandbox CSP, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`.
