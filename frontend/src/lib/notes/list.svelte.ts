import { api } from "#lib/api.ts";
import type { TagRef } from "#lib/types.ts";
import { markdownExcerpt, type NoteListItem } from "./types.ts";

const PAGE = 30;

/** Notes list shared by the notes layout (list pane) and the note page (patches rows after edits). */
class NotesList {
  items = $state<NoteListItem[]>([]);
  nextCursor = $state<string | null>(null);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  q = $state("");
  /** Selected tag ids; `none` = untagged. Empty = no filter. */
  tags = $state<string[]>([]);
  #seq = 0;

  #query(cursor?: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (this.q.trim()) params.set("q", this.q.trim());
    if (this.tags.length) params.set("tags", this.tags.join(","));
    if (cursor) params.set("cursor", cursor);
    return `/items?${params}`;
  }

  /** Reloads from the first page; stale responses are dropped. */
  async reload() {
    const seq = ++this.#seq;
    this.loading = true;
    this.error = null;
    try {
      const result = await api.get<{ items: NoteListItem[]; nextCursor: string | null }>(this.#query());
      if (seq !== this.#seq) return;
      this.items = result.items;
      this.nextCursor = result.nextCursor;
      this.loaded = true;
    } catch (e) {
      if (seq === this.#seq) this.error = (e as Error).message;
    } finally {
      if (seq === this.#seq) this.loading = false;
    }
  }

  async more() {
    if (!this.nextCursor || this.loading) return;
    const seq = this.#seq;
    this.loading = true;
    try {
      const result = await api.get<{ items: NoteListItem[]; nextCursor: string | null }>(this.#query(this.nextCursor));
      if (seq !== this.#seq) return;
      const known = new Set(this.items.map(item => item.id));
      this.items = [...this.items, ...result.items.filter(item => !known.has(item.id))];
      this.nextCursor = result.nextCursor;
    } catch (e) {
      if (seq === this.#seq) this.error = (e as Error).message;
    } finally {
      if (seq === this.#seq) this.loading = false;
    }
  }

  /** Applies a saved note to its row (keeps the list order by event date, newest first). */
  patch(id: string, fields: { title?: string; content?: string; event_date?: string; tags?: TagRef[]; updated_at?: string; updated_by_name?: string | null; has_audio?: boolean; has_transcript?: boolean; audio_name?: string | null; audio_duration_seconds?: number | null }) {
    const { content, ...rest } = fields;
    this.items = this.items
      .map(item => (item.id === id ? { ...item, ...rest, ...(content !== undefined ? { excerpt: markdownExcerpt(content) || item.audio_name || "" } : {}) } : item))
      .sort((a, b) => (a.event_date === b.event_date ? 0 : a.event_date < b.event_date ? 1 : -1));
  }

  remove(id: string) {
    this.items = this.items.filter(item => item.id !== id);
  }
}

export const notesList = new NotesList();
