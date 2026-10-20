# Architecture (v2)

v2 replaces the v1 MVP (Next.js full-stack + file-based render queue + Overleaf). v1 data is exported with
`scripts/export-legacy.sh` (run on the v1 host) and is **not** migrated; v2 starts from an empty database and bucket.

```
                    :80 / :443  (the only published ports)
                         │
                      nginx ── /api/*  → backend:3000
                         │     /*      → SvelteKit static build (SPA fallback to index.html)
   ┌─────────────────────┴──────────── network "internal" (no published ports) ─┐
   backend  (Node 22, TypeScript, Fastify 5)                                    │
     ├── db      (PostgreSQL 17)                                                │
     └── rustfs  (S3-compatible object storage, bucket $S3_BUCKET)              │
   worker   (Node 22 + Quarto + Chrome + poppler + LibreOffice + ffmpeg)        │
     └── network "jobs" (internal: true, no internet): db + rustfs only         │
   latex-app + latex-compiler (Aldine, profile `latex`, own hostname)           │
     └── network "latex" (internal: true): compiler has no internet             │
```

| Service | Dir | Responsibility |
|---|---|---|
| nginx | `nginx/` | TLS (or behind a TLS proxy: `TRUSTED_PROXIES` → real client IP from X-Forwarded-For), strict rate limit on `/api/auth/login` and `/api/join` (and 60/min on `/api/oidc/token`), serves `frontend/` build, proxies `/api/` |
| frontend | `frontend/` | SvelteKit 2 + Svelte 5, `adapter-static`, SPA (`ssr = false`). Built into the nginx image |
| backend | `backend/` | All HTTP API, auth, RBAC, migrations, file streaming from S3, job enqueue + finalize |
| worker | `worker/` | Claims jobs from Postgres, slide render (Quarto → HTML + PDF + page thumbnails; PDF → pages with poppler; PPTX → PDF with LibreOffice → pages), media transcode (ffmpeg) |
| db | `postgres/` | PostgreSQL 17; `postgres/init/` creates the `hub_worker` role on first init |
| rustfs | — | `rustfs/rustfs:1.0.1`, S3 API on `:9000`, never published |
| latex-app, latex-compiler | `deploy/aldine/` | Optional (`--profile latex`): Aldine collaborative LaTeX on `LATEX_HOSTNAME`. Compiler image adds Noto CJK. See `docs/aldine-evaluation.md` |

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
- CSRF: a global `onRequest` hook rejects POST/PUT/PATCH/DELETE whose `Origin` ≠ `APP_ORIGIN` (403). The only
  exemption is the route `POST /api/oidc/token` (server-to-server from Aldine, client-secret authenticated, never
  reads cookies); matched on the registered route, so no other path or method is affected.
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
| `media/uploads/<uploadId>/source` | raw uploaded media (deleted by worker after transcode, or by finalizer on failure). `uploadId` is a fresh UUID, not the job id (the file is streamed before the job row exists) |
| `media/items/<itemId>/<uploadId>.m4a` | transcoded audio (24 kHz mono 48 kbps AAC, `+faststart`) |
| `slides/<projectId>/<versionId>/source.zip\|pdf\|pptx` | uploaded deck: Quarto ZIP, PDF or PPTX (`slide_versions.source_type`; validated by backend before enqueue). For PDF decks this file is also the PDF download (`pdf_key`) |
| `slides/<projectId>/<versionId>/output/…` | rendered deck. Quarto: entry HTML + its own assets and `slides.pdf`; PPTX: `slides.pdf` (LibreOffice). Versions rendered before pages existed may have `_hub-thumbnail.png` at the root |
| `slides/<projectId>/<versionId>/output/_hub/…` | **reserved, hub-owned** (a deck whose output writes `_hub/` fails): `thumbnail.png` (quarto) / `thumbnail.webp` (pdf/pptx) — 960 px wide first slide, `slide_versions.thumbnail_key`; `pages/<n>-thumb.webp` (480 px wide, every type) and `pages/<n>-full.webp` (longer side 1920 px — 1920 px wide for landscape slides; pdf/pptx only); `pages.json` (page manifest, `slide_versions.manifest_key`). Never served by the deck asset route |
| `slides/<projectId>/<versionId>/output-<suffix>/…` | output of a re-index render (`POST …/reindex`); on success it becomes the version's `output_prefix` and the previous prefix is deleted |
| `slides/_shared/<hash>/…` | `offline-assets/` (MathJax, KaTeX, fonts) shared by every version rendered with the same assets; `.complete` marker written last. Never deleted per version (`slide_versions.shared_prefix`) |
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
type MediaTranscodeResult  = { outputKey: string; bytes: number; durationSeconds: number | null; peaks?: number[] };
// kind = "slide_render"
type SlideSourceType = "quarto" | "pdf" | "pptx";
type SlideRenderPayload = { projectId: string; versionId: string; sourceKey: string; entry: string; outputPrefix: string; sourceType?: SlideSourceType };
type SlideRenderResult  = { entryHtml: string | null; pdfKey: string; quartoVersion: string | null; fileCount: number; sharedPrefix: string | null;
                            thumbnailKey?: string; pageCount?: number; manifestKey?: string; converter?: string };
// <outputPrefix>_hub/pages.json (keys relative to outputPrefix)
type PageManifest = { version: 1; sourceType: SlideSourceType; width: number; height: number;
  pages: { index: number /* 1-based */; h?: number; v?: number; title?: string; thumb: string; full?: string; notes?: { text: string; html?: string } }[] };
```

`sourceType` absent = `quarto` (older jobs). `sourceKey` = `slides/<p>/<v>/source.<zip|pdf|pptx>`. `entry` is the QMD path
inside the ZIP (posix, relative, validated) for quarto and `""` otherwise. `outputPrefix` is `…/output/` or, for a re-index,
`…/output-<suffix>/`. `entryHtml` is the entry HTML path relative to `outputPrefix` (null for pdf/pptx: no HTML deck).
`pdfKey` is a full key: `<outputPrefix>slides.pdf` (quarto, pptx) or the uploaded `sourceKey` (pdf). `quartoVersion` and
`sharedPrefix` are null for pdf/pptx; `converter` is LibreOffice's version line (pptx).
`thumbnailKey` (optional) is a full key `<outputPrefix>_hub/thumbnail.png` (quarto) or `_hub/thumbnail.webp` (pdf/pptx), 960 px
wide, deck aspect ratio, first slide; absent when the screenshot failed or the worker is older (older workers wrote
`_hub-thumbnail.png`). `pageCount`/`manifestKey` (`<outputPrefix>_hub/pages.json`) are absent when quarto page capture failed
(the job still succeeds); pdf/pptx always have them. The finalizer ignores `thumbnailKey`/`manifestKey` unless they are plain keys
under the job's output prefix, and `pageCount` unless it is an integer 1–1000. Manifest `width`/`height`: the deck's own slide
size (Reveal `width`/`height` for quarto, page 1 in PDF points for pdf/pptx) — use the ratio only. Quarto pages list every Reveal
slide in order (`h`, `v` only for vertical slides), all fragments shown; `title` = first h1–h3 (quarto) or the title placeholder
(pptx); `notes.text` = plain text (paragraphs separated by blank lines), `notes.html` (quarto only) = minimal HTML with only
`p ul ol li strong em code br a[href http/https/mailto]`, text escaped — **clients must still sanitise it**. PPTX notes come from
`ppt/notesSlides/*` (body placeholder) mapped through the slide relationships; hidden slides are skipped (LibreOffice does not
export them) and notes are dropped when the visible slide count differs from the PDF page count. `peaks` (optional) is the audio waveform: up to 1000 values in [0,1] with 3 decimals; the finalizer
stores it only when it is an array of ≤ 2000 finite numbers in [0,1] (otherwise NULL).

Media stages (shown to users, 繁中): `排隊中` → `分析媒體` → `音訊轉碼` → `上傳結果` → `完成`.
Slide stages: quarto `排隊中` → `解壓縮` → `編譯簡報` → `匯出 PDF` → `上傳結果` → (`產生頁面`) → `完成`; pdf `準備檔案` →
`產生頁面` → `上傳結果` → `完成`; pptx `準備檔案` → `轉換簡報` → `產生頁面` → `上傳結果` → `完成`.

## API

All under `/api`. `→` describes the response body. Unless noted, routes need a session (401 otherwise).

### Identity (`auth.ts`, `users.ts`, `invitations.ts`, `notifications.ts`, `push.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/health`, `/health/ready`, `/config` | public | done (`health.ts`) |
| GET `/auth/accounts?ids=a,b` | public | names for device-remembered account hints → `{accounts:[{id,name}]}` (only enabled users, max 10 ids) |
| GET `/auth/me` | public | `{user: CurrentUser \| null}`; `CurrentUser = {id, name, role, auth_mode, theme, locale: "zh-TW"\|"en", preferences: Preferences}` (preferences with defaults filled in, see below) |
| POST `/auth/login` `{userId?, name?, password}` | public | argon2 verify; 401 on failure; `two_factor` users → 403 (Passkey not implemented); sets session; updates `last_login_at` → `{account:{id,name}}` |
| POST `/auth/logout` | user | clears session |
| PATCH `/auth/profile` `{name?, theme?, locale?, preferences?, currentPassword?, newPassword?}` | user | password change requires current password; revokes other sessions. `preferences` is a deep-partial `Preferences` merged into the stored value (unknown keys / out-of-range values → 400) → `{user: CurrentUser}` |
| GET `/auth/sessions`, DELETE `/auth/sessions/:id` | user | list / revoke own sessions |
| POST `/join` `{token, name, password}` | public | consume invitation atomically (row lock, `use_count < max_uses`, not expired/revoked), create user, session |
| GET `/join/:token` | public | validate token → `{role, expiresAt}` or 404 |
| GET `/users` | owner | all users with role, disabled, last login |
| PATCH `/users/:id` `{role?, disabled?}` | owner | owner cannot be changed; disabling revokes sessions; audit |
| GET `/invitations` | owner | with derived state: active / expired / exhausted / revoked |
| POST `/invitations` `{role, expiresIn: "5m"\|"30m"\|"1h"\|"2h"\|"5h"\|"1d"\|"3d"\|"5d"\|"7d"\|"never", maxUses: 1\|null}` | owner | returns the raw token **once** → `{invitation, token, url}` (`url` = `<APP_ORIGIN>/join/<token>`) |
| DELETE `/invitations/:id` | owner | revoke (soft) |
| GET `/notifications`, DELETE `/notifications` `{id?}` | user | latest 100 / remove one or all |
| GET `/notifications/unread` | user | `{count}` |
| POST `/notifications/read` `{ids?: uuid[]}` | user | mark some or all read |
| GET `/push`, POST `/push` `{subscription}`, DELETE `/push` `{endpoint}` | user | Web Push subscription management; GET → `{enabled, publicKey, subscribed}` |
| POST `/push/test` | user | send a test push |

User preferences (`users.preferences`, `backend/src/lib/preferences.ts`; missing or invalid stored keys read as the default):

```ts
type Preferences = {
  notify: { slideRendered: boolean; mediaTranscoded: boolean; reviews: boolean; replies: boolean }; // all default true
  editor: { fontSize: number /* int 12..22, default 15 */; layout: "split" | "edit" | "preview" /* default "split" */ };
};
```

`notify.*` gates **Web Push only**; in-app notifications are always recorded. Every `Notifier.push/notify` call
names the flag it is gated by (`{ pref, tag }`): slide render finished/failed → `slideRendered`, media transcode
finished/failed → `mediaTranscoded`, new review → `reviews`, reply → `replies`, `/push/test` → none (`pref: null`).

### Notes, tags, media (`items.ts`, `tags.ts`, `slide-tags.ts`, `media.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/items?tags=&q=&limit=&cursor=&audio=` | user | `audio=1` = only notes with a transcoded recording. `tags` omitted = all; `tags=` (empty) = none; ids comma-separated, `none` = untagged. `q` searches title + content (ILIKE). Keyset pagination by (event_date, created_at, id). Each item: id, title, excerpt, event_date, tags, has_audio, has_transcript, audio_name, audio_duration_seconds, updated_at, author names |
| GET `/items/:id` | user | full note incl. content, tags, audio meta, `audio_peaks` (`number[]` or null), transcript cues, active media job |
| POST `/items` `{title, event_date, content?, tagIds?}` | editor | |
| PATCH `/items/:id` | editor | partial update; `updated_by`, `updated_at` |
| DELETE `/items/:id` | editor | also cancels its jobs and deletes its S3 objects (post-commit) |
| PUT `/items/:id/tags` `{tagIds}` | editor | replace tag set |
| POST `/items/:id/transcript` (multipart `.srt`, ≤5 MB) / DELETE | editor | parse SRT → cues `[{start,end,text}]` |
| POST `/items/:id/media` (multipart) | editor | stream to `media/uploads/<jobId>/source`, enqueue `media_transcode` → `{jobId}` (202). Max `MAX_MEDIA_BYTES` |
| GET `/media/:itemId` | user | stream audio from S3 with **Range** support (206), `audio/mp4`, `Accept-Ranges: bytes` |
| GET `/media-jobs` | user | caller's latest 20 media jobs → `{jobs:[{id,item_id,status,stage,progress,duration_seconds,error,file_name,created_at}]}` (status mapped: queued/running → `processing`, succeeded → `completed`) |
| GET `/media-jobs/:id`, DELETE `/media-jobs/:id` | owner of job | status / cancel |
| GET `/tags`, POST `/tags` `{name}`, PATCH `/tags/:id` `{name}`, DELETE `/tags/:id` | GET user, writes editor | names 1–40 chars, unique case-insensitive → 409 on duplicate; deleting a tag never deletes notes. GET includes `count` (usage) |
| same under `/slide-tags` | same | separate tag set for slides |

Finalizer `media_transcode`: on success set `items.audio_*` incl. `audio_peaks` (a new audio replaces the peaks, NULL when the
result has none or they are invalid; delete the previous audio object post-commit),
notify the uploader (`kind:'media'`, url `/recordings/<id>`; failures link to `/notes/<id>`); on failure/cancel delete the upload + partial output.

### Slides (`slides.ts`, `slide-reviews.ts`, `slide-view.ts`)

| Method & path | Access | Notes |
|---|---|---|
| GET `/slides?tags=&q=` | user | `{slides, limits}`: projects with active version, status of latest version, tags, `reference_count`, `review_count`, `author_name` (uploader of the active version, fallback deck creator), `published_at` (active version's publish time or null), `thumbnailUrl` (`/api/slides/<id>/thumbnail?v=<activeVersionId>` or null). `limits = {zipBytes, deckBytes, deckTypes: [".zip",".pdf",".pptx"], referenceBytes}` (`zipBytes` = `deckBytes` = `MAX_SLIDE_ZIP_BYTES`, the limit for every deck upload; `MAX_REFERENCE_BYTES`). `latest_status` may be `review` |
| POST `/slides` (multipart: `title`, `slug`, `entry?`, `public?`, `tagIds?`, file `.zip`/`.pdf`/`.pptx`) | editor | detect + validate the deck (see "Deck uploads"), create project + version 1, upload the file, enqueue render (202) → `{id, slug, versionId, version, jobId, sourceType, entry: string\|null, scan: {files,bytes,qmd}\|null}` |
| GET `/slides/:id` | user | detail: project (incl. `creator_name`), versions (see "Version object"), `activeVersion` (the active **published** version object, also for pdf/pptx decks without a `viewUrl`), references, reviews (see "Review object", + replies, author names), tags, `viewUrl` for active version (null for pdf/pptx), `pdfUrl`, `thumbnailUrl` (same format; null for anonymous by-slug viewers), `permissions {manage, review, reply}`, `limits` (as in the list; not in by-slug) |
| GET `/slides/:id/thumbnail` | user | streams the active version's thumbnail (`thumbnail_key`): `image/png` (quarto) or `image/webp` (pdf/pptx), `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `ETag: "<versionId>"` (`If-None-Match` → 304); 404 when there is no active version, no thumbnail or the object is missing |
| PATCH `/slides/:id` `{title?, slug?, public_view?, tagIds?, rotateShareKey?}` | editor | |
| DELETE `/slides/:id` | editor | cascade + delete S3 prefixes post-commit |
| GET `/slides/:id/versions` → `{versions}`, POST `/slides/:id/versions` (multipart `.zip`/`.pdf`/`.pptx`, `entry?`) | GET user, POST editor | new version → render job (202, same body as POST `/slides` minus `id`/`slug`) |
| PATCH `/slides/:id/versions/:versionId` `{active:true}` | editor | set active (must be published; a `review` version → 404) |
| POST `/slides/:id/versions/:versionId/publish` | editor (the uploader is always an editor) | confirm a `review` version: status → `published`, `published_at` = now, active by the activation rule → `{ok:true, status:"published", active: boolean}`; 404 when the version is not in `review` |
| POST `/slides/:id/versions/:versionId/reindex` | editor | re-render a **published** version into `output-<suffix>/` to (re)build pages, e.g. for versions rendered before pages existed → 202 `{versionId, jobId}`; 404 not published, 409 while its job is queued/running. The deck keeps being served from the old output; on success the finalizer swaps `output_prefix`, `entry_html`, `pdf_key`, thumbnail and page fields (status and `published_at` unchanged) and deletes the old prefix; on failure only the new prefix is deleted. No notification |
| DELETE `/slides/:id/versions/:versionId` | editor | not the active one; deletes S3 objects. Discards a `review` version |
| GET `/slides/:id/status` | user | latest version status `{id,status,version,error,stage,progress}` (`status` may be `review`, then `progress` = 100) |
| POST `/slides/:id/render` | editor | retry the latest failed version (new job, same source type) |
| GET `/slides/:id/versions/:versionId/pages` | user | page manifest (see "Slide pages") of a `published` or `review` version; 404 `此版本沒有頁面資訊。` when it has none |
| GET `/slides/:id/versions/:versionId/pages/:n/:size` (`size` = `thumb`\|`full`) | user | page image (see "Slide pages"); 404 for `n` outside 1..pageCount, unknown size, `full` of a quarto deck, or a missing object |
| POST `/slides/:id/references` (multipart PDF ≤ `MAX_REFERENCE_BYTES`, or JSON `{title,url}`) | editor | first reference becomes default |
| PATCH `/slides/:id/references/:refId` `{title?, isDefault?}`, DELETE | editor | keep exactly one default when any exist |
| POST `/slides/:id/reviews` `{body, page?, versionId?}` | professor (and owner) | → 201 `{review}` (Review object, `replies: []`). `page` (int ≥ 1) refers to the pages of `versionId`, default the active version; the version must be `published`/`review` of this deck (else 404) and have pages with `page ≤ pageCount` (else 400 `此版本沒有頁面資訊…` / `頁碼超出範圍（共 N 頁）。`); `versionId` alone (no page) is stored as given. Notifies the deck creator (`kind:'slide'`, body `<title> 第 N 頁：<text>` for page reviews), never yourself |
| POST `/slides/:id/reviews/:reviewId/replies` `{body}` | owner | notify the review author |
| GET `/slides/by-slug/:slug?key=` | public* | player data: project, active version, `viewUrl`, `pdfUrl`, references, reviews. Version `pagesUrl`s point at the by-slug page routes (with `?key=` when the key granted access) and exist only for `published` versions. *Allowed for a user, `public_view`, a valid `key`, or the `slide_share_<slug>` cookie |
| GET `/slides/pages/:slug/:versionId?key=` | same as by-slug | page manifest of a **published** version; image URLs carry `?key=` when the key granted access |
| GET `/slides/pages/:slug/:versionId/:n/:size?key=` | same as by-slug | page image of a published version |
| GET `/slides/share/:slug/:key` | public | valid key → set httpOnly cookie `slide_share_<slug>` (path `/`, 30 days) and 302 to `/slides/play/<slug>` |
| GET `/slides/view/:slug/:token/:versionId/*` | capability | serve rendered asset from S3 (see "Slide viewing") |
| GET `/slides/pdf/:slug/:versionId` | same as by-slug | stream `slides.pdf` as attachment `<slug>-v<n>.pdf` |
| GET `/slides/reference/:slug/:refId` | same as by-slug | stream PDF inline, or 302 to URL references |

ZIP validation (backend, before upload, from a temp file using yauzl; the worker re-validates while
extracting): only these extensions `.qmd .md .css .scss .yml .yaml .png .jpg .jpeg .gif .svg .webp .pdf .bib
.csl .json .js .woff .woff2 .ttf .otf .txt .csv .mp4 .webm .mp3 .wav .m4a`; ≤2000 files, ≤500 MB uncompressed,
≤100 MB per file, depth ≤12, no absolute paths / `..` / backslashes / NUL, no symlinks, no `.env*`; junk directories
are skipped (see "Behaviour notes"). Entry: explicit `entry` if given and present, else root
`index.qmd`, else the only `.qmd`; otherwise 400 asking for the entry path.

Deck uploads (`lib/slides/source.ts`, by extension + magic bytes; one file ≤ `MAX_SLIDE_ZIP_BYTES` for every type):
`.zip` → `quarto` (PK magic + ZIP validation below); `.pdf` → `pdf` (`%PDF-`); `.pptx` → `pptx` (PK magic, OOXML package with
`[Content_Types].xml` and `ppt/presentation.xml`, no `vbaProject.bin` or macroEnabled content type, no encrypted entries,
≤ 10 000 entries). Extension/content mismatch → 415 `檔案內容與副檔名不符。`; OLE file named `.pptx` (encrypted or legacy) → 400
`簡報已加密或為舊版格式…`; `.pptm/.ppsm/.potm` → 400 `不支援含巨集的簡報…`; `.ppt/.pps/.pot` → 400 `不支援舊版 .ppt…`; anything
else → 400. The worker re-checks (PDF via `pdfinfo`: encrypted/unreadable/> 500 pages fail the job).

ZIP validation (backend, before upload, from a temp file using yauzl; the worker re-validates while
extracting): only these extensions `.qmd .md .css .scss .yml .yaml .png .jpg .jpeg .gif .svg .webp .pdf .bib
.csl .json .js .woff .woff2 .ttf .otf .txt .csv .mp4 .webm .mp3 .wav .m4a`; ≤2000 files, ≤500 MB uncompressed,
≤100 MB per file, depth ≤12, no absolute paths / `..` / backslashes / NUL, no symlinks, no `.env*`; junk directories
are skipped (see "Behaviour notes"). Entry: explicit `entry` if given and present, else root
`index.qmd`, else the only `.qmd`; otherwise 400 asking for the entry path.

Finalizer `slide_render`: on success set `entry_html`, `pdf_key`, `quarto_version`, `shared_prefix`, `thumbnail_key`,
`page_count`, `manifest_key`; quarto/pdf → `published` (`published_at` = now) and active unless a newer version is already
active, notify uploader `簡報編譯完成`; **pptx → `review`** (not active, no `published_at`), notify uploader
`簡報轉換完成，請確認` (`kind:'slide'`, pref `slideRendered`). On failure set `status='failed'`, `error`, clear thumbnail/page
fields; delete the partial output prefix post-commit. Re-index jobs (job `outputPrefix` ≠ version `output_prefix`): see `…/reindex`.

**Version object** (in `/slides/:id`, `/slides/:id/versions`, by-slug):
```ts
{ id, version, status: "queued"|"rendering"|"review"|"published"|"failed", sourceType: "quarto"|"pdf"|"pptx",
  stage, progress, error, source_name, entry_qmd /* "" for pdf/pptx */, quarto_version, created_at, uploader_name,
  published_at /* null unless published */, is_active, viewUrl /* published quarto only */, pdfUrl /* published */,
  hasThumbnail, pageCount: number | null, pagesUrl: string | null }
```
`pageCount`/`pagesUrl` are null for versions without a manifest (rendered before pages existed, or quarto capture failed —
the frontend falls back to the deck itself / the PDF) and for `review` versions in by-slug responses.

**Review object**: `{ id, body, created_at, author, author_id, page: number | null, versionId: string | null, replies }`
(`versionId` becomes null when that version is deleted; `page` is kept).

### Slide pages (`slide-pages.ts`, `lib/slides/pages.ts`)

Manifest response (`…/pages` routes), `Cache-Control: private, max-age=300`:
```ts
{ version: 1, versionId, sourceType, width, height, pageCount,
  pages: { index, h?, v?, title?, thumb: string /* URL */, full?: string /* URL, pdf/pptx only */, notes?: { text, html? } }[] }
```
`thumb`/`full` are URLs of the same family as the manifest route (session or by-slug, `?key=` repeated when the share key
in the query granted access). Speaker notes are included for everyone who may view the deck — including anonymous viewers
of public decks and share-key holders (accepted: notes are part of the deck the author published). Page images: WebP,
`Content-Type: image/webp`, `Cache-Control: private, max-age=31536000, immutable` (version-scoped and never rewritten; after a
re-index the manifest's image URLs carry `?r=<suffix>` of the new `output-<suffix>/` prefix, so cached images of the previous
render are never reused — always take image URLs from the manifest), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`. Keys are derived from the
page number (`<output_prefix>_hub/pages/<n>-<size>.webp`), never from client input. Images cached while a deck was public stay
in that browser's cache after it is made private.

### UI support (`dashboard.ts`, `search.ts`, `jobs.ts`)

All three need a session and reply with `Cache-Control: no-store`.

**GET `/dashboard`** →
```ts
{ stats: { slides, notes, recordings, pendingReviews, slidesThisWeek, notesThisWeek },   // ints
  latestSlide: { id, title, slug, version, authorName, publishedAt, tags: {id,name}[], thumbnailUrl, reviewCount } | null,
  activity: { kind: "slide_version"|"note"|"recording"|"review"|"reply", id, title, url, actor: {id,name} | null, at }[],
  pendingReviews: { reviewId, slideId, slideTitle, excerpt, authorName, createdAt }[],
  recentNotes: { id, title, excerpt, updatedAt, tags: {id,name}[], hasAudio }[] }
```
- `recordings` = notes with audio. "This week" = since Monday 00:00 Asia/Taipei: `slidesThisWeek` counts versions
  published this week, `notesThisWeek` notes created this week.
- A version's publish time is `slide_versions.published_at` (set when it becomes `published`; fallback: its job's `finished_at`, then upload time). `latestSlide` = the project whose
  active version was published most recently; `authorName` = uploader of that version (fallback: deck creator).
- `pendingReviews` items also carry `page: number | null` (the review's page). `pendingReviews` (max 5, newest first) and `stats.pendingReviews` = reviews without any reply: for the Owner (the only
  one who replies) all of them, for everyone else those on decks they created. `excerpt` = plain text, ≤ 120 chars.
- `activity`: latest 10 across kinds, newest first. `id` is the event row's own id (version, note, transcode job, review,
  reply); `url` is the SPA path: `/slides/<projectId>` (slide_version, review, reply; `title` = deck title, plus
  ` v<n>` for slide_version), `/notes/<id>` (note created), `/recordings/<itemId>` (successful transcode).
- `recentNotes`: 6 most recently updated notes.

**GET `/search?q=`** (`q` trimmed, 1–100 chars, else 400) → `{ slides: {id,title,slug}[], notes: {id,title,excerpt,hasAudio}[],
tags: {id,name,kind:"note"|"slide"}[] }`. Case-insensitive substring match (ILIKE with `\`, `%`, `_` escaped) on deck
title/slug, note title/content, and tag names of both namespaces; max 6 per list, newest first (`updated_at` for decks and
notes, `created_at` for tags).

**GET `/jobs/active`** → `{ jobs: { id, kind:"slide_render"|"media_transcode", status:"queued"|"running"|"succeeded"|"failed"|"cancelled",
stage, progress, label, url, updatedAt }[] }`: the caller's jobs that are queued/running or finished in the last 10 minutes,
max 10, newest first. `stage` is the worker's 繁中 stage; the raw values `queued`/`starting`/`cancelled` written by the
database/backend are shown as `排隊中`/`準備中`/`已取消`. `progress` is 100 once succeeded. `label` = `<deck title> v<n>`
or the note title (fallback: upload file name, `已刪除的簡報`/`已刪除的筆記`); `url` = `/slides/<projectId>` or
`/notes/<itemId>`, null when the target was deleted. `updatedAt` = latest of created/started/heartbeat/finished.

### OIDC provider for Aldine (`oidc.ts`, `lib/oidc/`)

The hub is the OpenID Connect provider for one first-party client, Aldine (authorization code flow, no consent
screen). Off (every route 404) unless `LATEX_OIDC_CLIENT_ID` and `LATEX_OIDC_CLIENT_SECRET` (≥ 32 chars) are set and a
redirect URI is known: `LATEX_OIDC_REDIRECT_URIS` (comma-separated, exact match) or else
`<LATEX_URL>/api/auth/oauth/oidc/callback`. **Issuer = `<APP_ORIGIN>/api/oidc`** (Aldine's `OIDC_ISSUER`; it
fetches discovery server-side and requires https). Requirements read from Aldine 0.12.3: `docs/aldine-evaluation.md`.

| Method & path | Access | Notes |
|---|---|---|
| GET `/oidc/.well-known/openid-configuration` | public | discovery: `code` only, `S256`, `ES256`, auth methods `client_secret_basic`/`client_secret_post`, scopes `openid profile email`, `authorization_response_iss_parameter_supported: true` |
| GET `/oidc/jwks` | public | `{keys:[{kty:"EC",crv:"P-256",x,y,kid,use:"sig",alg:"ES256"}]}` |
| GET `/oidc/authorize?client_id&redirect_uri&response_type=code&scope&state&nonce&code_challenge&code_challenge_method&prompt` | session | unknown `client_id`/`redirect_uri` → 400 `{error}` (never redirected). Other errors redirect with `error`, `error_description`, `state`, `iss`. `scope` must contain `openid`; PKCE optional, but when sent it must be `S256`. No session → 302 `/login?next=<this URL>` (`prompt=none` → `error=login_required`). Session → one-time code (random 32 bytes, stored as sha256, **60 s**, bound to client, redirect_uri, user, scope, nonce, challenge) → 302 `<redirect_uri>?code&state&iss` |
| POST `/oidc/token` (form) | client secret | **exempt from the Origin check**. `client_secret_basic` or `_post` (not both; constant-time compare) else 401 `invalid_client`. `grant_type=authorization_code`; the code is consumed atomically (`DELETE … RETURNING`, so reuse fails) and must be unexpired, same client and redirect_uri; a code with a challenge needs the matching `code_verifier`, a code without one rejects a verifier; disabled users fail. → `{access_token, token_type:"Bearer", expires_in:300, id_token, scope}`, `Cache-Control: no-store`; audit `oidc_sign_in`. Errors: RFC 6749 `{error:<code>, error_description:<繁中>}` |
| GET `/oidc/userinfo` | Bearer access token | same user claims as the ID token; 401 `invalid_token` (+ `WWW-Authenticate`) otherwise. Aldine only calls it when the ID token lacks email/name (never, today) |

- ID token (ES256, `kid` = RFC 7638 thumbprint, 300 s): `iss`, `aud` = client id, `sub` = hub user id, `iat`, `exp`,
  `nonce` (when sent); scope `profile` → `name`, `preferred_username` (hub name); scope `email` →
  `email` = `<hub user id>@users.speech-ai-hub.invalid`, `email_verified: true`. Hub users have no email; Aldine needs
  one for admins (`ALDINE_ADMIN_EMAILS`) and collaborator invites. The synthetic address is stable across renames,
  `.invalid` cannot receive mail, and Aldine never links an SSO identity to a password account with the same email.
- Signing key: generated on first use (P-256), private key stored as PKCS#8 PEM in `oidc_signing_keys` (only the backend
  reads it; it is in DB backups), public JWK published. Rotation: insert a new active key, set the old one
  `active=false` and keep it published until issued ID tokens expire (minutes), then delete it.
- All roles may sign in (professors included); disabled users get neither a code nor tokens. Access tokens live 5 min;
  disabling a hub user does **not** end an existing Aldine session (up to 30 days; remove it from Aldine's
  `sessions.json` if needed). No logout propagation, no role sync.
- The login page treats `next` values starting with `/api/oidc/authorize?` as a full-page navigation (other `next`
  values stay SPA routes); `next` must be a same-origin path (no `//`, no backslash).

### Slide viewing

The SPA embeds the deck in `<iframe sandbox="allow-scripts allow-pointer-lock allow-presentation">` (no
`allow-same-origin`), so the iframe has an opaque origin and sends no cookies. Authorisation is by path
capability `:token`, one of:
- `t.<unixExpiry>.<hmac>`: HMAC-SHA256(`AUTH_SECRET`, `slide-view|<projectId>|<versionId>|<expiry>`),
  base64url, 12 h TTL — issued by `/slides/:id` and `/slides/by-slug/:slug` as `viewUrl`;
- `public` when the project is `public_view`;
- the project's share key.

Asset rules (ported from v1 `app/app/slides/view/[slug]/[key]/[versionId]/[[...asset]]/route.ts`): empty path →
entry HTML; reject `slides.pdf`, `pdf.log`, `offline-assets/licenses/*`, `_hub/*`, any `..`/`.`/backslash/NUL; HTML gets the
in-memory Web Storage shim, the hub bridge (below), the `scrollActivationWidth:0,postMessage:true,postMessageEvents:true`
Reveal patch and the 44 px touch-target CSS; every
response carries the sandbox CSP, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Vary: Origin`; requests with `Origin: null` (CORS-mode loads such as web fonts from the
opaque-origin sandbox) also get `Access-Control-Allow-Origin: null` — the path capability is the authorisation.

Parent ↔ deck messaging (quarto decks only; pdf/pptx decks have no HTML deck and are shown from page images):
- Reveal's postMessage API is on: the parent may `iframe.contentWindow.postMessage(JSON.stringify({method:"slide", args:[h,v]}), "*")`
  (any Reveal API method). With `postMessageEvents`, Reveal posts its events to the parent as **JSON strings**
  `{"namespace":"reveal","eventName":"slidechanged","state":{indexh,indexv,indexf,…}}` (also `ready`, `fragmentshown`, …).
- Hub bridge (injected in `<head>`, only when embedded): pressing `s` or `f` without modifiers (outside form fields /
  contenteditable) posts the **object** `{namespace:"hub", type:"speaker"}` / `{namespace:"hub", type:"fullscreen"}` to the
  parent and stops the key from reaching Reveal, so Reveal's own notes popup and fullscreen never open.
- The deck's origin is opaque (`event.origin === "null"`), so the parent cannot authenticate messages by origin: it must
  check `event.source === iframe.contentWindow` and treat every message as untrusted input (the deck is user-authored).

Frontend player (`frontend/src/lib/components/slides/SlidePlayer.svelte`): pdf/pptx versions are drawn from the manifest's
page images, quarto decks in the iframe above; both get the same counter, thumbnails (review counts per page), keyboard,
swipe, fullscreen and a remembered position (`localStorage` `hub-slide-pos:<slug>:<versionId>`). `S` opens the speaker
window `/slides/play/<slug>/speaker?v=<versionId>&p=<page>[&key=]` (Hub origin, outside the app shell, loads through the
by-slug routes, so published versions only). Player and speaker window sync through `BroadcastChannel`
`hub-slides:<slug>:<versionId>` with `{type:"page",page}`, `{type:"step",dir}` (speaker → player; quarto decks step through
fragments), `{type:"hello"}` and `{type:"bye"}`, each carrying `from: "player"|"speaker"`. The speaker window shows quarto
decks in a second sandboxed iframe with `?receiver` (the annotate plugin stays off) and Reveal reconfigured to no
fragments/controls/keyboard.

## Behaviour notes (as built)

- A deck has no active version until its first render publishes; a newer published version becomes active
  unless an even newer one already is. Failed/cancelled renders notify the uploader too.
- `POST /items`: `event_date` optional (defaults to today in Asia/Taipei); list returns `nextCursor`.
- Invitation revoke is soft (`revoked_at`); logout always clears the cookie, even without a valid session.
- ZIP junk (`__MACOSX`, `.DS_Store`, `Thumbs.db`, `.git`, `node_modules`, `_site`, `.quarto`) is skipped by both the
  backend validator and the worker (Finder-made ZIPs work); `.env*`, symlinks, unsafe paths, encrypted entries,
  duplicate names (worker) and disallowed types are rejected.
- `GET /api/config` → `{ latexUrl, pushPublicKey }` (`latexUrl` = `LATEX_ORIGIN`, null when unset).
- Migrations: `0001_init` (schema), `0002_slide_shared_assets` (`slide_versions.shared_prefix`), `0003_ui_prefs`
  (`users.locale` `zh-TW`|`en`, `users.preferences` jsonb, `slide_versions.thumbnail_key`, `items.audio_peaks` jsonb array),
  `0004_oidc` (`oidc_signing_keys`, `oidc_codes`, `oidc_access_tokens`), `0005_slide_pages` (`slide_versions.source_type`,
  `page_count`, `manifest_key`, `published_at` (backfilled), status `review`; `slide_reviews.page`, `version_id`).
- There is no "remove audio" route: audio (and its peaks) only changes when a new transcode replaces it or the note is
  deleted. A failed render clears the version's `thumbnail_key`, `page_count` and `manifest_key`.

## Aldine (LaTeX) security model

Accepted by the user (2026-10-20): accounts are lab members only, and any Aldine user can read other projects'
files (upstream limitation). Sign-in is by hub SSO (see "OIDC provider for Aldine"; `LATEX_SSO_ONLY=1` turns off
Aldine's password login/registration), so the hub decides who gets an account. Password registration additionally
stays behind nginx Basic Auth (`owner` / `LATEX_REGISTER_PASSWORD`). Aldine admins: `LATEX_ADMIN_EMAILS` with the
Owner's synthetic email.

Two mounts (nginx `entrypoint.sh`): `LATEX_HOSTNAME` (own hostname, isolated by the same-origin policy; preferred)
or `LATEX_PATH` (e.g. `/latex` on the hub origin). **The deployment at speech-ai-hub.gugulu.tw uses `LATEX_PATH=/latex`,
accepted by the user on 2026-10-20** to avoid an extra DNS name/proxy route. Consequence: Aldine's scripts share the
hub origin, so an XSS in Aldine could call `/api` as the signed-in hub user and pass the Origin check. Mitigations
in path mode: nginx strips `hub_session` from the Cookie header sent to Aldine (`$latex_cookie` map), registration
stays behind Basic Auth, and accounts are lab members only. Moving to `LATEX_HOSTNAME` later removes the risk.
