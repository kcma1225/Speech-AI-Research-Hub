/**
 * Document viewer of the assistant (「文件檢視器」): contract + pure helpers. The reactive store lives in
 * `viewer-state.svelte.ts`; import everything from here.
 *
 * Contract for other modules (e.g. the workflow engine's `artifact` events):
 *
 *   import { openArtifact, refreshArtifact, notifyArtifactChanged, closeViewer, viewer } from "#lib/agent/viewer.ts";
 *   openArtifact({ kind: "deck", id }, { focus: { page: 3 } });         // user intent: show it now
 *   notifyArtifactChanged({ kind: "note", id }, { focus: { suggestionId } }); // an AI write touched it: refresh if shown,
 *                                                                          // else auto-open (unless the user turned that off)
 *   refreshArtifact({ kind: "latex_project", id });                     // reload it if it is shown (no opening)
 *   closeViewer();
 *
 * `ArtifactRef` matches the workflow event's `artifact: {kind, id, url, version?}`; `url` alone (any hub link of a
 * note / deck / paper / meeting / LaTeX project / upload) is enough when `kind`/`id` are unknown — see `refFromArtifact`.
 * Viewers only load what the signed-in user can read through the normal API (no new data exposure).
 */
import type { Message, ToolCall } from "./types.ts";
import { viewer } from "./viewer-state.svelte.ts";

export type ArtifactKind = "deck" | "note" | "paper" | "meeting" | "latex_project" | "latex_file" | "upload";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["deck", "note", "paper", "meeting", "latex_project", "latex_file", "upload"];

export type ArtifactRef = {
  kind: ArtifactKind;
  id: string;
  /** `latex_file`: its project. */
  project_id?: string;
  /** Deck: a slide_versions id or number (published player); other kinds ignore it. */
  version?: string | number;
  url?: string;
  title?: string;
};

/** Where to look inside the artifact. Viewers ignore what does not apply to them. */
export type ArtifactFocus = {
  /** 1-based page (paper / LaTeX PDF / deck page or slide). */
  page?: number;
  /** LaTeX / deck source file. */
  fileId?: string;
  /** A suggestion to show (note / LaTeX / deck source). */
  suggestionId?: string;
  /** Meeting transcript time in seconds. */
  time?: number;
  /** 1-based source line. */
  line?: number;
};
export type ArtifactHighlight = { text?: string; from?: number; to?: number };
export type OpenOptions = {
  focus?: ArtifactFocus;
  highlight?: ArtifactHighlight | string;
  /** Opened by an AI action, not by the user (phones keep the chat tab; respects the auto-open setting). */
  auto?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Stable key of what a viewer shows: a LaTeX file opens its project (focused on the file). */
export function normalizeRef(ref: ArtifactRef): { ref: ArtifactRef; focus: ArtifactFocus } {
  if (ref.kind === "latex_file" && ref.project_id) {
    return { ref: { kind: "latex_project", id: ref.project_id, ...(ref.title ? { title: ref.title } : {}) }, focus: { fileId: ref.id } };
  }
  return { ref, focus: {} };
}
export const artifactKey = (ref: ArtifactRef) => {
  const n = normalizeRef(ref).ref;
  return `${n.kind}:${n.id}`;
};
export const sameArtifact = (a: ArtifactRef | null | undefined, b: ArtifactRef | null | undefined) => !!a && !!b && artifactKey(a) === artifactKey(b);

/**
 * Hub link → artifact (+ focus from the query: `file`, `suggestion`, `t`, `p`/`page`). Accepts paths or absolute URLs
 * of this origin; anything else → null.
 */
export function artifactFromUrl(href: string, origin = typeof location !== "undefined" ? location.origin : "http://hub.invalid"): { ref: ArtifactRef; focus: ArtifactFocus } | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const q = url.searchParams;
  const focus: ArtifactFocus = {};
  const file = q.get("file");
  if (isUuid(file)) focus.fileId = file;
  const suggestion = q.get("suggestion");
  if (isUuid(suggestion)) focus.suggestionId = suggestion;
  const page = Number(q.get("p") ?? q.get("page"));
  if (Number.isInteger(page) && page > 0) focus.page = page;
  const time = Number(q.get("t"));
  if (q.get("t") !== null && Number.isFinite(time) && time >= 0) focus.time = time;
  const path = url.pathname;
  let ref: ArtifactRef | null = null;
  if (parts[0] === "studies" && parts[1] && isUuid(parts[3])) {
    if (parts[2] === "notes") ref = { kind: "note", id: parts[3] };
    else if (parts[2] === "decks") ref = { kind: "deck", id: parts[3] };
    else if (parts[2] === "latex") ref = { kind: "latex_project", id: parts[3] };
  } else if (parts[0] === "slides" && isUuid(parts[1]) && parts.length === 2) ref = { kind: "deck", id: parts[1] };
  else if (parts[0] === "library" && isUuid(q.get("paper"))) ref = { kind: "paper", id: q.get("paper")! };
  else if (parts[0] === "library" && isUuid(parts[1])) ref = { kind: "paper", id: parts[1] };
  else if (parts[0] === "meetings" && isUuid(parts[1]) && parts.length === 2) ref = { kind: "meeting", id: parts[1] };
  else if (parts[0] === "api" && parts[1] === "agent" && parts[2] === "uploads" && isUuid(parts[3]) && parts.length === 4) ref = { kind: "upload", id: parts[3] };
  if (!ref) return null;
  return { ref: { ...ref, url: path + url.search }, focus };
}

/** A workflow / tool `artifact` payload → ref (kind + id when known, else parsed from `url`). */
export function refFromArtifact(a: { kind?: string; id?: string; url?: string; version?: string | number; project_id?: string; title?: string } | null | undefined): { ref: ArtifactRef; focus: ArtifactFocus } | null {
  if (!a) return null;
  if (a.kind && (ARTIFACT_KINDS as readonly string[]).includes(a.kind) && a.id) {
    const parsed = a.url ? artifactFromUrl(a.url) : null;
    const ref: ArtifactRef = { kind: a.kind as ArtifactKind, id: a.id };
    if (a.project_id) ref.project_id = a.project_id;
    if (a.version !== undefined) ref.version = a.version;
    if (a.url) ref.url = a.url;
    if (a.title) ref.title = a.title;
    return { ref, focus: parsed && sameArtifact(parsed.ref, ref) ? parsed.focus : {} };
  }
  if (a.url) {
    const parsed = artifactFromUrl(a.url);
    if (parsed && a.title) parsed.ref.title = a.title;
    return parsed;
  }
  return null;
}

/** One document the conversation touched, newest last. `write` = an AI write (suggestion, edit, creation) touched it. */
export type ConversationArtifact = { ref: ArtifactRef; title: string; write: boolean; at: string; focus: ArtifactFocus; source: "attachment" | "tool" };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/** Refs a tool call touched: arguments by convention, the resolved target, result links and result data. */
export function artifactsOfCall(call: Pick<ToolCall, "tool" | "args" | "target" | "result" | "risk" | "status">): { ref: ArtifactRef; focus: ArtifactFocus; title?: string }[] {
  const out: { ref: ArtifactRef; focus: ArtifactFocus; title?: string }[] = [];
  const add = (ref: ArtifactRef | null | undefined, focus: ArtifactFocus = {}, title?: string) => {
    if (!ref) return;
    const i = out.findIndex((x) => sameArtifact(x.ref, ref));
    if (i >= 0) {
      out[i] = { ...out[i]!, focus: { ...out[i]!.focus, ...focus }, title: out[i]!.title ?? title };
      return;
    }
    out.push({ ref, focus, title });
  };
  const a = call.args ?? {};
  const data = obj(call.result?.data);
  const suggestionId = str(data?.suggestion_id);
  const sFocus: ArtifactFocus = suggestionId && isUuid(suggestionId) ? { suggestionId } : {};
  const pages = Array.isArray(a.pages) ? (a.pages as unknown[]).filter((n): n is number => typeof n === "number" && n > 0) : [];
  const regions = Array.isArray(a.regions) ? (a.regions as unknown[]).map((r) => obj(r)?.page).filter((n): n is number => typeof n === "number" && n > 0) : [];
  const page = pages[0] ?? regions[0];
  if (isUuid(a.note_id)) add({ kind: "note", id: a.note_id }, sFocus);
  if (isUuid(a.paper_id)) add({ kind: "paper", id: a.paper_id }, page ? { page } : {});
  if (isUuid(a.deck_id)) add({ kind: "deck", id: a.deck_id }, typeof a.page === "number" ? { page: a.page } : {});
  if (isUuid(a.meeting_id)) add({ kind: "meeting", id: a.meeting_id });
  if (isUuid(a.project_id)) add({ kind: "latex_project", id: a.project_id }, { ...(isUuid(a.file_id) ? { fileId: a.file_id } : {}), ...sFocus });
  if (isUuid(a.attachment_id)) add({ kind: "upload", id: a.attachment_id });
  // Result data (creations: the id only exists after the call).
  const note = obj(data?.note);
  if (isUuid(note?.id)) add({ kind: "note", id: note.id as string }, sFocus, str(note?.title));
  const deck = obj(data?.deck);
  if (isUuid(deck?.id)) add({ kind: "deck", id: deck.id as string }, {}, str(deck?.title));
  // Target and links (deck sources, LaTeX files, meetings…).
  if (call.target?.url) {
    const p = artifactFromUrl(call.target.url);
    if (p) add(p.ref, { ...p.focus, ...sFocus });
  }
  for (const link of call.result?.links ?? []) {
    const p = artifactFromUrl(link.url);
    if (p) add(p.ref, p.focus, link.kind === "suggestion" ? undefined : link.label);
  }
  return out;
}

/** Tools that change a document without being `write` by risk (none today); reads never auto-open. */
export const isWriteCall = (call: Pick<ToolCall, "risk" | "tool">) => call.risk !== "read" && call.tool !== "remember";

/** Everything this conversation attached or touched through tools (deduplicated; newest last). */
export function conversationArtifacts(messages: Pick<Message, "id" | "seq" | "attachments" | "created_at">[], calls: Pick<ToolCall, "tool" | "args" | "target" | "result" | "risk" | "status" | "message_id" | "created_at" | "finished_at">[]): ConversationArtifact[] {
  const seqOf = new Map(messages.map((m) => [m.id, m.seq]));
  type Item = ConversationArtifact & { seq: number };
  const items: Item[] = [];
  for (const m of messages) {
    for (const att of m.attachments ?? []) {
      const ref: ArtifactRef = { kind: att.kind, id: att.id, ...(att.project_id ? { project_id: att.project_id } : {}), ...(att.version ? { version: att.version } : {}), ...(att.url ? { url: att.url } : {}), title: att.title };
      const n = normalizeRef(ref);
      items.push({ ref: n.ref, focus: n.focus, title: att.title, write: false, at: m.created_at, source: "attachment", seq: m.seq });
    }
  }
  for (const c of calls) {
    if (c.status !== "done") continue;
    const write = isWriteCall(c);
    for (const a of artifactsOfCall(c)) {
      const n = normalizeRef(a.ref);
      items.push({ ref: n.ref, focus: { ...n.focus, ...a.focus }, title: a.title ?? "", write, at: c.finished_at ?? c.created_at, source: "tool", seq: seqOf.get(c.message_id) ?? Number.MAX_SAFE_INTEGER });
    }
  }
  items.sort((x, y) => x.seq - y.seq || x.at.localeCompare(y.at));
  const byKey = new Map<string, Item>();
  for (const it of items) {
    const key = artifactKey(it.ref);
    const prev = byKey.get(key);
    if (prev) byKey.delete(key);
    byKey.set(key, { ...it, title: it.title || prev?.title || "", write: it.write || !!prev?.write });
  }
  return [...byKey.values()].map(({ seq: _seq, ...rest }) => rest);
}

/**
 * Page citations in an assistant answer (`p. 5`, `p.5`, `pp. 4–6`, `第 5 頁`): `[start, end, page]` of each match.
 * Used to turn them into chips that open the cited paper at that page.
 */
const CITE = /(?:\bpp?\.\s?(\d{1,4})(?:\s?[-–—]\s?\d{1,4})?|第\s?(\d{1,4})\s?頁)/g;
export function findPageCites(text: string): { start: number; end: number; page: number }[] {
  const out: { start: number; end: number; page: number }[] = [];
  for (const m of text.matchAll(CITE)) {
    const page = Number(m[1] ?? m[2]);
    if (page > 0 && page < 5000) out.push({ start: m.index!, end: m.index! + m[0].length, page });
  }
  return out;
}

/** The paper an assistant message talks about: the last paper attached or read up to that message. */
export function paperBefore(messages: Pick<Message, "id" | "seq" | "attachments">[], calls: Pick<ToolCall, "message_id" | "args" | "status" | "tool" | "target" | "result" | "risk">[], messageId: string): string | null {
  const seqOf = new Map(messages.map((m) => [m.id, m.seq]));
  const limit = seqOf.get(messageId);
  if (limit === undefined) return null;
  let best: { seq: number; id: string } | null = null;
  const consider = (seq: number, id: string) => {
    if (seq <= limit && (!best || seq >= best.seq)) best = { seq, id };
  };
  for (const m of messages) for (const a of m.attachments ?? []) if (a.kind === "paper") consider(m.seq, a.id);
  for (const c of calls) {
    if (c.status !== "done") continue;
    const seq = seqOf.get(c.message_id);
    if (seq === undefined) continue;
    for (const a of artifactsOfCall(c)) if (a.ref.kind === "paper") consider(seq, a.ref.id);
  }
  return (best as { seq: number; id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------- store API (see viewer-state.svelte.ts)

export { viewer };
export const openArtifact = (ref: ArtifactRef, opts: OpenOptions = {}) => viewer.openArtifact(ref, opts);
export const refreshArtifact = (ref: ArtifactRef, opts: { focus?: ArtifactFocus } = {}) => viewer.refreshArtifact(ref, opts);
export const notifyArtifactChanged = (ref: ArtifactRef, opts: { focus?: ArtifactFocus } = {}) => viewer.changed(ref, opts);
export const closeViewer = () => viewer.closeViewer();
