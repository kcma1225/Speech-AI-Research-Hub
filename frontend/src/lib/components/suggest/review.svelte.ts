import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { api } from "#lib/api.ts";
import { setHunks } from "./extension.ts";
import type { LiveHunk, Suggestion } from "./types.ts";

const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** Current range of an anchored hunk in `doc` (same rules as the backend's resolveRange/placeAnchored). */
export function placeHunk(doc: Y.Doc, text: string, h: { start?: string; end?: string; before: string; from: number; to: number }): { from: number; to: number } | null {
  if (!h.start || !h.end) {
    return text.slice(h.from, h.to) === h.before ? { from: h.from, to: h.to } : null;
  }
  try {
    const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(h.start)), doc);
    const e = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(h.end)), doc);
    if (!s || !e) return null;
    if (!h.before) return s.index >= e.index ? { from: e.index, to: e.index } : null;
    if (e.index < s.index) return null;
    return text.slice(s.index, e.index) === h.before ? { from: s.index, to: e.index } : null;
  } catch {
    return null;
  }
}

/**
 * Pending suggestions of one target, kept in sync with the editor:
 * - positions come from the Yjs anchors against the live `doc` (recomputed on every change), so hunks follow
 *   everyone's typing and turn stale (「內容已變更」) the moment their text is edited;
 * - `refresh()` reloads from the API (call it on the collab `{type:"suggestions"}` message);
 * - decisions go to the API; the server applies them in the shared document, so the change arrives through Yjs.
 *
 *   const review = new SuggestionReview({ targetType: "note", targetId, doc: session.doc, text: session.text });
 *   extensions: [suggestionReview(review.actions(labels))]; review.attach(view);
 */
export class SuggestionReview {
  list = $state<Suggestion[]>([]);
  canReview = $state(false);
  loaded = $state(false);
  busy = $state(false);
  error = $state<string | null>(null);
  /** Live placement of every pending hunk (also the side list's source). */
  live = $state<LiveHunk[]>([]);
  focus = $state<string | null>(null);
  private view: EditorView | null = null;
  private frame = 0;
  private unobserve: (() => void) | null = null;

  constructor(
    readonly opts: {
      targetType: string;
      targetId: string;
      /** Yjs document + text the anchors refer to (collaborative targets). */
      doc?: Y.Doc;
      text?: Y.Text;
      /** Plain-text targets: current text. */
      getText?: () => string;
      onError?: (message: string) => void;
    },
  ) {
    if (opts.text) {
      const observer = () => this.schedule();
      opts.text.observe(observer);
      this.unobserve = () => opts.text!.unobserve(observer);
    }
  }

  get pendingCount() {
    return this.live.filter(h => !h.stale).length;
  }

  async refresh() {
    try {
      const r = await api.get<{ suggestions: Suggestion[]; permissions: { review: boolean } }>(
        `/suggestions?target_type=${encodeURIComponent(this.opts.targetType)}&target_id=${encodeURIComponent(this.opts.targetId)}`,
      );
      this.list = r.suggestions;
      this.canReview = r.permissions.review;
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loaded = true;
      this.recompute();
    }
  }

  attach(view: EditorView | null) {
    this.view = view;
    this.recompute();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.recompute();
    });
  }

  recompute() {
    const text = this.opts.text ? this.opts.text.toString() : (this.opts.getText?.() ?? "");
    const live: LiveHunk[] = [];
    for (const s of this.list) {
      for (const h of s.hunks) {
        if (h.status !== "pending") continue;
        const at = this.opts.doc ? placeHunk(this.opts.doc, text, h) : text.slice(h.from, h.to) === h.before ? { from: h.from, to: h.to } : null;
        // Stale hunks are drawn where they were last known (server-side `current`, else the original offset).
        const fallback = h.current ?? { from: Math.min(h.from, text.length), to: Math.min(h.from, text.length) };
        live.push({ suggestionId: s.id, hunkId: h.id, from: (at ?? fallback).from, to: (at ?? fallback).to, before: h.before, after: h.after, stale: !at, title: s.title, author: s.creator_name });
      }
    }
    live.sort((a, b) => a.from - b.from);
    this.live = live;
    this.view?.dispatch({ effects: setHunks.of({ hunks: live, focus: this.focus }) });
  }

  setFocus(hunkId: string | null) {
    this.focus = hunkId;
    this.recompute();
  }

  private async run(path: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await api.post<{ suggestion: Suggestion; applied: number; skipped: number }>(path);
      this.list = this.list.map(s => (s.id === r.suggestion.id ? r.suggestion : s)).filter(s => s.status === "pending");
      this.recompute();
      return r;
    } catch (e) {
      this.opts.onError?.((e as Error).message);
      await this.refresh();
    } finally {
      this.busy = false;
    }
  }

  accept = (h: Pick<LiveHunk, "suggestionId" | "hunkId">) => this.run(`/suggestions/${h.suggestionId}/hunks/${h.hunkId}/accept`);
  reject = (h: Pick<LiveHunk, "suggestionId" | "hunkId">) => this.run(`/suggestions/${h.suggestionId}/hunks/${h.hunkId}/reject`);
  acceptAll = (suggestionId: string) => this.run(`/suggestions/${suggestionId}/accept-all`);
  rejectAll = (suggestionId: string) => this.run(`/suggestions/${suggestionId}/reject-all`);

  /** Actions for the CodeMirror extension (`suggestionReview(review.actions(labels))`). */
  actions(labels: { accept: string; reject: string; stale: string; by: (h: LiveHunk) => string }) {
    return { accept: (h: LiveHunk) => void this.accept(h), reject: (h: LiveHunk) => void this.reject(h), labels, canReview: () => this.canReview };
  }

  destroy() {
    this.unobserve?.();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.view = null;
  }
}
