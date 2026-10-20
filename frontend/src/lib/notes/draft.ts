/** Unsaved editor state kept in localStorage per note (per browser only; best effort). */
export type NoteDraft = { title: string; content: string; event_date: string; tagIds: string[]; base: string; savedAt: number };

const key = (id: string) => `hub-note-draft:${id}`;

export function readDraft(id: string): NoteDraft | null {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<NoteDraft>;
    if (typeof value.title !== "string" || typeof value.content !== "string" || typeof value.event_date !== "string") return null;
    return { title: value.title, content: value.content, event_date: value.event_date, tagIds: Array.isArray(value.tagIds) ? value.tagIds.filter(x => typeof x === "string") : [], base: String(value.base ?? ""), savedAt: Number(value.savedAt ?? 0) };
  } catch {
    return null;
  }
}

export function writeDraft(id: string, draft: Omit<NoteDraft, "savedAt">) {
  try {
    localStorage.setItem(key(id), JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {}
}

export function clearDraft(id: string) {
  try {
    localStorage.removeItem(key(id));
  } catch {}
}
