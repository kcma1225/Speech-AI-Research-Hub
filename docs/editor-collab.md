# Shared editor, collaboration and suggestions

For modules that edit text in the hub (notes, Quarto deck sources, LaTeX files, study summary). Built by the notes
module (M2); `docs/architecture.md` ("Collaboration", "Suggestions", "Notes") has the routes and tables.

```
browser                                              backend (one process)
CodeEditor.svelte (CodeMirror 6)                     /api/collab  WebSocket (Hocuspocus 4, src/collab/)
  + y-codemirror.next  ── Y.Text "content" ──────────  auth: hub_session cookie + Origin = APP_ORIGIN
  + suggestionReview()  (inline diff)                   per-document authorize() of the doc's namespace
CollabSession (lib/collab)  one shared socket         yjs_docs (Postgres)  ─ materialize() → domain rows
SuggestionReview (lib/components/suggest)  ── REST /api/suggestions ── lib/suggestions (diff, anchors, apply)
```

## 1. Collaborative documents (backend)

A document is named `<prefix>:<rest>`: `note:<noteId>`, `latex:<projectId>:<fileId>`, `deck:<deckId>:<path-id>`…
(`rest` matches `[A-Za-z0-9:_-]{1,200}`; use stable ids, never paths). The text is **always the Y.Text named
`content`** (`TEXT_FIELD` in `src/collab/text.ts`, also what the frontend binds).

Register a namespace once at import time (any module, any order; registration is process-wide):

```ts
import { registerCollabNamespace } from "../collab/registry.js";
registerCollabNamespace({
  prefix: "latex",
  // Every connection, and again every 60 s while it is open. null = refuse; readOnly for non-editors.
  async authorize(db, user /* {id,name,role,is_admin,is_owner} */, rest) { … return { readOnly: !canEdit } },
  // ONLY when the document has no yjs_docs row at all (first open). Return null if the target does not exist.
  async seed(db, rest) { return "initial text" },
  // After each store (debounce 2 s, max 10 s, on unload and at shutdown), inside the transaction that saves the
  // state. Return "gone" if the target was deleted (the state is then dropped).
  async materialize(client, rest, text, { editors, lastActorId }) { … },
});
```

**Never rebuild a Y.Doc from plain text** once state exists: clients that reconnect merge their own copy and the text
duplicates. Rules:
- Create the state when you create the target: `initialState(text)` → `INSERT INTO yjs_docs(name,state,size)`.
- `seed` is a fallback for targets created elsewhere; its result is saved before any client sees it.
- Changes from outside the editor (import, restore, accepted suggestion, AI insert) go through the live document:

```ts
await app.collab.edit("latex:p:f", actorUserId, (doc, ytext) => replaceText(ytext, newText)); // line diff
const text = await app.collab.readDoc(name, (doc) => doc.getText("content").toString());       // live or stored
app.collab.broadcast(name, { type: "compiled", buildId });  // stateless JSON to every client of the doc
app.collab.closeDocument(name);                              // after deleting the target
closeDocumentEverywhere(name);                               // same, from code without `app`
readStoredDoc(db, name, read)                                // any process (ai-worker): stored state only
```

`app.collab` is decorated at the root by `routes/notes.ts`, which also registers `@fastify/websocket` once. A module
that needs its own WebSocket route must be registered **after** notes in `app.ts` and only declare
`{ websocket: true }` (never register `@fastify/websocket` again). `collabFor(app)` returns the same server from
plugins registered earlier.

Security: the upgrade is refused with 403 when `Origin` ≠ `APP_ORIGIN` and 401 without a valid session. Read-only
connections receive updates; the server drops their changes. Removing a member, disabling an account or revoking a
session closes the socket within a minute (the client reconnects with the new rights). Awareness (names, cursors) is
not authenticated: a client could show a fake name in presence, never write without rights.

## 2. Frontend: editor and collaboration

```svelte
<script lang="ts">
  import { openCollab } from "#lib/collab/session.svelte.ts";
  import CodeEditor from "#lib/editor/CodeEditor.svelte";
  import ConnectionStatus from "#lib/collab/ConnectionStatus.svelte";
  import PresenceAvatars from "#lib/collab/PresenceAvatars.svelte";
  const s = openCollab(`latex:${projectId}:${fileId}`, { id: me.id, name: me.name });  // s.destroy() on unmount
  let view = $state(null);
</script>
<PresenceAvatars peers={s.peers} /> <ConnectionStatus session={s} />
<CodeEditor bind:view collab={{ text: s.text, awareness: s.awareness }} readOnly={!canEdit || s.readOnly}
            language={latexLanguage /* Extension; "markdown" (default) | "plain" */} mono label="main.tex" extensions={[...]} />
```

- `CollabSession`: `doc`, `text`, `awareness`, `provider`; reactive `status` (`connecting|connected|offline|denied`),
  `synced`, `readOnly` (granted by the server), `unsynced` (local changes not yet acknowledged), `peers`
  (`{clientId,id,name,color,colorLight}`), `onMessage(fn)` for `broadcast` payloads. All documents of a page share
  one WebSocket. Offline edits stay in memory and merge on reconnect.
- Presence colours: `userColor(userId)` (same pastel tones as avatars, `var(--pill-<tone>-ink)`), so cursor labels
  read in light and dark.
- `CodeEditor` (`lib/editor/`): CodeMirror 6 with our theme (`theme.ts`, CSS tokens, follows dark mode), soft wrap,
  search, history (Yjs undo manager in collaborative mode), Markdown shortcuts Mod-B/I/K/E/Shift-M, IME-safe (no
  input handlers). Without `collab` it is a controlled editor (`bind:value`). `collab`, `language`, `extensions` are
  read at mount (re-key to change); `readOnly`, `fontSize`, `mono` are live.
- Toolbar primitives: `ToolbarButton.svelte` (≥ 40 px on touch), `MarkdownTools.svelte` (format buttons for a view),
  `markdown-commands.ts` (`md.bold(view, placeholder)`, `prefixLines`, `wrap`, `insertText`).

## 3. Suggestions

Table `suggestions` (architecture.md). A suggestion has hunks `{id, from, to, before, after, status}`; Yjs targets
also store `start`/`end` (base64 `Y.RelativePosition`: start = first replaced char, assoc 0; end = last replaced
char, assoc −1). A pending hunk is **stale** when the text between its anchors ≠ `before` (someone edited that
paragraph): it can only be rejected. Hunks are paragraph/line granular (line diff); the UI shows a word diff inside
(`Intl.Segmenter` for Chinese).

Register a target type (notes registers `note`; `study_summary` is registered too, plain text):

```ts
import { registerSuggestionTarget } from "../lib/suggestions/targets.js";
registerSuggestionTarget({
  type: "latex_file",
  async resolve(db, targetId) { return { studyId, docName: `latex:${p}:${f}`, title: "chapter2.tex", url: `/studies/${slug}/papers/${p}?file=${f}`, version: null } },
  async canEdit(db, user, target) { return isStudyEditor },
  // Plain-text targets instead of docName: readText(db, id) / writeText(client, id, text, actorId)
  async afterApply(client, targetId, { text, accepted, source, actorId, suggestion }) { /* versions, activity */ },
});
```

Server API (`lib/suggestions/service.ts`, deps `{ db: app.db, collab: app.collab }`):

```ts
createSuggestion(deps, { targetType, targetId, proposedText /* full text, diffed against the live text */
  | hunks: [{ from, to, after, before? /* checked → 409 when it differs */ }], title, source: "user"|"ai"|"autopilot",
  actorId, conversationId?, user? /* checks canEdit → 403 */ })            → SuggestionView  (400 when nothing changes)
decideSuggestion(deps, { suggestionId, hunkIds: string[] | "all", decision: "accept"|"reject", actorId, user? })
                                                                           → { suggestion, applied, skipped }
applySuggestionNow(deps, createInput)   // autopilot: create + accept all; versions tagged autopilot (restorable)
listSuggestions(deps, type, id, status?) / getSuggestion(deps, id) / canReview(deps, user, type, id)
deleteSuggestionsOf(client, type, id)   // when the target is deleted
```

Accepting applies hunks in one server-side Yjs transaction (`collab.edit`), so every editor sees the change; the
target's `afterApply` runs in the same DB transaction (notes: a version 「接受 AI 建議 · N 處」). Creating or deciding
broadcasts `{type:"suggestions", id}` on the document. `createSuggestion` works in any process (reads the stored
state without collab); deciding needs the backend's collab server for Yjs targets. Agent tools: `suggest_*` →
`createSuggestion({ …, source: "ai", conversationId })`; under autopilot `applySuggestionNow`.

REST: `GET /api/suggestions?target_type&target_id&status`, `GET /api/suggestions/:id`, `POST /api/suggestions`,
`POST /api/suggestions/:id/hunks/:hunkId/accept|reject`, `POST /api/suggestions/:id/accept-all|reject-all`.

Frontend (`lib/components/suggest/`):

```ts
const review = new SuggestionReview({ targetType: "latex_file", targetId, doc: s.doc, text: s.text, onError: toast });
// CodeMirror: strike-through + green insert + 接受/拒絕 inline, Alt-]/Alt-[ navigate, Alt-Enter / Alt-Backspace
const extensions = [suggestionReview(review.actions({ accept, reject, stale, by: (h) => "…" }))];
$effect(() => review.attach(view));  s.onMessage(m => m.type === "suggestions" && review.refresh()); review.refresh();
```
`<SuggestionPanel {review} onReveal={(h) => revealHunk(view, h)} />` is the side list (全部接受 / 全部拒絕, 剩 N 處,
stale = 內容已變更). Positions are recomputed from the anchors on every Yjs change, so hunks move with other people's
typing. For plain-text targets pass `getText` instead of `doc`/`text`. `WordDiff.svelte` renders one hunk.

AI streaming helper for actions that end in a suggestion: `postAiStream(path, body, { onDelta, signal })`
(`lib/components/notes/ai-stream.ts`): SSE events `delta {text}`, `suggestion {suggestion}`, `error {error, code?,
hint?}`, `done`. nginx does not buffer `/api/ai/`, `/api/agent/` and `/api/notes/<id>/ai/`; other SSE routes should set
`X-Accel-Buffering: no`.
