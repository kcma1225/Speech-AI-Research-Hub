# CRUD / lifecycle audit (2026-10-21)

Every entity, what each lifecycle operation has on the backend (route) and in the SPA (UI), and what is still open.
✅ = route + UI, 🔧 = fixed in this pass, ⛔ = no route (intentional or open), ⚠️ = open gap.
Rules kept: everyone reads, only study owner/member edit study content (professors/advisors comment and review),
authors edit/delete their own comments, admins are system-only (accounts, invitations, models, templates, settings).

Cross-cutting fix 🔧: `ConfirmDialog` swallowed errors thrown by `onConfirm`; callers that did not toast (study delete,
member remove/leave/transfer, task delete, meeting/media/transcript/feedback delete, LaTeX project delete, memory delete,
MCP revoke) failed silently. The dialog now toasts the error unless the caller already did.

## Studies

| Entity | Create | Read | Update / rename | Delete | Other lifecycle | Gaps / notes |
|---|---|---|---|---|---|---|
| Study | ✅ `/studies/new`, interview | ✅ | ✅ title inline + 設定 | ✅ owner, confirm (errors 🔧) | archive/unarchive ✅ (no confirm, reversible); transfer ✅ | — |
| Stage | ✅ | ✅ | ✅ rename, reorder, set current, complete | 🔧 confirm + toast (was one click) | — | — |
| Milestone | ✅ | ✅ | ✅ | ✅ confirm | done toggle ✅ | — |
| Task | ✅ | ✅ | ✅ status/assignee | ✅ confirm (errors 🔧) | agent undo ✅ | — |
| Member | ✅ owner | ✅ | ✅ role | ✅ remove/leave (errors 🔧) | transfer ✅ | — |
| Stage templates (admin) | ⛔ | read in create | ⛔ | ⛔ | — | ⚠️ no admin route/UI; only seeded data |

## Notes and suggestions

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Note | ✅ | ✅ | ✅ title/date (editor) | ✅ editor menu; 🔧 also ⋯ in the notes list | export ✅ | ⛔ duplicate, move to another study (no route) |
| Note template (user) | ✅ 存成我的範本 | ✅ | ⚠️ PATCH exists, no UI | ✅ confirm | — | edit UI missing |
| Note template (system) | ⚠️ route (admin), no UI | ✅ | ⚠️ no UI | ⚠️ no UI | — | admin template editor missing |
| Note version | ✅ | ✅ | — | ⛔ | restore ✅ confirm | deleting versions not offered (history is an audit trail) |
| Suggestion | ✅ | ✅ | accept/reject ✅ | ⛔ | — | ⚠️ the author cannot withdraw their own pending suggestion |
| Study summary | ✅ | ✅ | ✅ + import as suggestion | — | — | — |

## Slides

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Deck | ✅ upload / editor / AI | ✅ | ✅ title, slug, public, paper | 🔧 deck page ⋯ menu + 簡報 card ⋯ (was buried in 資訊 and went to `/slides`); returns to the study's 簡報 tab; backend now also cancels AI draft jobs, cleans workflow artifacts, records `deck_deleted` | share key rotate ✅ | — |
| Version | ✅ upload / publish | ✅ | set active ✅, publish review ✅, re-index ✅ | ✅ not the active one (delete the deck instead), confirm | retry ✅ | — |
| Reference | ✅ | ✅ | ✅ default | ✅ (no confirm; small) | — | — |
| Source file (Quarto editor) | ✅ | ✅ | ✅ rename | ✅ not the entry | AI edit → suggestion ✅ | — |
| Review (professor) | ✅ | ✅ | 🔧 author edits (`PATCH …/reviews/:id`, 「已編輯」) | 🔧 author deletes (+ replies), confirm | — | — |
| Reply (study member) | ✅ | ✅ | 🔧 author edits | 🔧 author deletes, confirm | — | — |

## Library

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Lab paper | ✅ | ✅ | ✅ metadata sheet | ✅ admin / unused adder, confirm; 🔧 `/library/<id>` now navigates away after delete | fetch PDF ✅ | — |
| Paper PDF file | ✅ upload/replace | ✅ | — | 🔧 「移除這個 PDF」 (route existed, no UI) | — | — |
| Study paper | ✅ | ✅ | ✅ status/tags/notes/cite key | ✅ remove from study (detail), confirm | export ✅ | row-level remove in the table not offered |
| Import batch | ✅ | preview ✅ | confirm ✅ | cancel ✅ (wizard close) | — | ⚠️ PDF batches abandoned in AddPaperSheet are left (purged after a day); no import history UI |
| Zotero connection | via import `remember` | ✅ | — | ✅ (no confirm) | — | — |

## Meetings

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Meeting | ✅ | ✅ | ✅ | ✅ creator/admin, confirm (errors 🔧) | — | not on list cards |
| Media / recording | ✅ | ✅ | — | ✅ confirm, 🔧 success toast | — | — |
| Transcript | ✅ upload / ASR / live | ✅ | choose current ✅ | ✅ confirm (errors 🔧) | export ✅ | — |
| ASR / analysis job | ✅ start/retry | ✅ | — | — | 🔧 「停止」 (cancel route existed, no UI) | — |
| Feedback | ✅ | ✅ | ✅ own | ✅ own, confirm (errors 🔧) | — | — |
| Study draft | AI | ✅ | ✅ edit | dismiss ✅ | confirm ✅, reopen dismissed ✅ | ⛔ un-confirm (the note/tasks it created stay; delete them directly) |

## LaTeX

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Project | ✅ template / ZIP | ✅ | ✅ settings; 🔧 rename from the card ⋯ | ✅ settings; 🔧 card ⋯, success/error toasts | ZIP export ✅ (also card ⋯ 🔧) | ⛔ duplicate (import the exported ZIP instead) |
| File / section | ✅ | ✅ | ✅ rename, retitle, reorder | ✅ confirm | — | — |
| Version | ✅ | ✅ | — | ⛔ | restore ✅ (auto backup) | version delete not offered |
| Compile | ✅ | ✅ | — | cancel ✅ | AI fix ✅ | — |

## Assistant and workflows

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| Conversation | ✅ | ✅ | ✅ rename | ✅ confirm | branches ✅ | — |
| Memory | ✅ | ✅ | ✅ | ✅ one / all, confirm; 🔧 toasts | export ✅ | — |
| MCP token | ✅ | ✅ | — | ✅ revoke, confirm; 🔧 toast | — | — |
| Upload (attachment) | ✅ | ✅ | — | ✅ while unsent (kept once referenced, by design) | — | — |
| Workflow run | ✅ | ✅ | approve/revise/pause/resume/cancel ✅ | ✅ finished runs (expanded card on `/assistant/workflows`) | publish ✅ | ⚠️ delete only in the expanded card, not in chat cards |

## Identity and administration

| Entity | Create | Read | Update | Delete | Other | Gaps |
|---|---|---|---|---|---|---|
| User (admin) | via invitation | ✅ | ✅ role, names, username | ⛔ by design: disable keeps authorship | disable/enable ✅ (revokes sessions); 🔧 **password reset link** (one-time, expiring, revokes sessions, audited; `/reset/<token>`) | — |
| Own account | — | ✅ | ✅ name, password, theme, locale | — | sessions list/revoke ✅ | ⛔ "sign out all other devices" (password change does it) |
| Invitation | ✅ | ✅ | — | ✅ revoke, confirm | — | — |
| Notification | system | ✅ | mark read ✅ | 🔧 clear all now asks first; single delete has a route but no UI | — | ⚠️ per-item delete UI |
| Push subscription | ✅ | ✅ | — | ✅ toggle | test ✅ | — |
| Markdown image | ✅ upload | ✅ | — | ⛔ (removed with the study; drafts swept after 24 h) | — | ⚠️ images removed from a note stay until the study is deleted |
| AI account / group / embedding space | ✅ | ✅ | ✅ | ✅ confirm | test/sync ✅ | — |
| AI model profile | ✅ | ✅ | ✅ | 🔧 confirm (was one click) | — | bulk visibility route unused |
| Role binding | ✅ | ✅ | ✅ | unbind (no confirm, reversible) | — | — |
| Library settings | — | ✅ | ✅ | — | — | — |
