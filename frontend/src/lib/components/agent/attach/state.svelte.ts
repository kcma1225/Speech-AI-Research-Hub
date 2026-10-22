import { t } from "#lib/i18n.svelte.ts";
import { isContextChip, keyOf, MAX_ATTACHMENTS, refOf, type Attachment, type ChipItem } from "./types.ts";
import { attachFormats, checkFile, removeUpload, uploadFile, type Formats } from "./api.ts";

/** `progress` 0–1 while a pending upload sends bytes (null = waiting in line / size unknown). */
export type DraftItem = ChipItem & { key: string; pending?: boolean; error?: string; progress?: number | null };

/**
 * Attachments of the message being written: chips above the composer. Uploads need a conversation (created on
 * demand by `ensureConversation`) and show a spinner chip until the server has validated them.
 */
export class AttachDraft {
  items = $state<DraftItem[]>([]);
  /** Abort handles of pending uploads (removing a pending chip cancels its upload). */
  #aborts = new Map<string, AbortController>();

  constructor(private readonly ensureConversation: () => Promise<string>) {}

  get count() {
    return this.items.length;
  }
  get full() {
    return this.items.length >= MAX_ATTACHMENTS;
  }
  get busy() {
    return this.items.some((i) => i.pending);
  }
  /** Refs of the ready items (sent with the message). */
  get refs() {
    return this.items.filter((i) => !i.pending && !i.error && !isContextChip(i.kind)).map((i) => refOf(i as Attachment));
  }
  /** 「#」 study / task chips (sent as page context, see `contextWithRefs`). */
  get contextRefs() {
    return this.items.flatMap((i) => (isContextChip(i.kind) ? [{ kind: i.kind, id: i.id, studyId: i.study?.id ?? null }] : []));
  }
  has(kind: string, id: string) {
    return this.items.some((i) => i.key === keyOf({ kind, id }));
  }
  find(kind: string, id: string) {
    return this.items.find((i) => i.key === keyOf({ kind, id }));
  }

  /** Adds (or replaces, e.g. another deck version) one item; false when the message is full. */
  add(a: ChipItem): boolean {
    const key = keyOf(a);
    const at = this.items.findIndex((i) => i.key === key);
    if (at >= 0) {
      this.items[at] = { ...a, key };
      return true;
    }
    if (this.full) return false;
    this.items.push({ ...a, key });
    return true;
  }

  toggle(a: Attachment): boolean {
    if (this.has(a.kind, a.id)) {
      this.remove(keyOf(a));
      return true;
    }
    return this.add(a);
  }

  remove(key: string) {
    const item = this.items.find((i) => i.key === key);
    this.items = this.items.filter((i) => i.key !== key);
    this.#aborts.get(key)?.abort();
    // An upload nobody sent yet is deleted on the server (kept when a sent message uses it).
    if (item?.kind === "upload" && !item.pending && !item.error) void removeUpload(item.id).catch(() => undefined);
  }

  clear() {
    for (const c of this.#aborts.values()) c.abort();
    this.items = [];
  }

  #patch(key: string, patch: Partial<DraftItem> | ((i: DraftItem) => DraftItem)) {
    const at = this.items.findIndex((i) => i.key === key);
    if (at < 0) return false;
    this.items[at] = typeof patch === "function" ? patch(this.items[at]!) : { ...this.items[at]!, ...patch };
    return true;
  }

  /** Uploads files one after another; errors stay as a red chip with the server's message. */
  async upload(files: File[]) {
    let conversationId: string;
    const room = MAX_ATTACHMENTS - this.items.length;
    const list = files.slice(0, Math.max(0, room));
    if (!list.length) return { skipped: files.length };
    try {
      conversationId = await this.ensureConversation();
    } catch (e) {
      return { error: (e as Error).message, skipped: 0 };
    }
    let formats: Formats | null = null;
    try {
      formats = await attachFormats();
    } catch {
      // Unknown limits: let the server decide.
    }
    // Chips appear at once (queued at 0%), then upload one after another.
    const queue = list.map((file) => {
      const key = `pending:${crypto.randomUUID()}`;
      const bad = formats ? checkFile(file, formats) : null;
      const item: DraftItem = { key, kind: "upload", id: key, title: file.name, study: null, url: null, upload_kind: file.type.startsWith("image/") ? "image" : "document" };
      this.items.push(bad ? { ...item, error: t(bad.key, { size: bad.size ?? "" }) } : { ...item, pending: true, progress: null });
      return bad ? null : { key, file };
    });
    for (const job of queue) {
      if (!job) continue;
      const { key, file } = job;
      if (!this.items.some((i) => i.key === key)) continue; // cancelled while queued
      const ctrl = new AbortController();
      this.#aborts.set(key, ctrl);
      this.#patch(key, { progress: 0 });
      try {
        const r = await uploadFile(conversationId, file, { signal: ctrl.signal, onProgress: (f) => this.#patch(key, { progress: f }) });
        const a = r.attachment;
        const ready: DraftItem = { key: keyOf({ kind: "upload", id: a.id }), kind: "upload", id: a.id, title: a.title, study: null, url: a.url, mime: a.mime, upload_kind: a.upload_kind };
        // Cancelled after the server already stored it: delete it there too.
        if (!this.#patch(key, () => ready)) void removeUpload(a.id).catch(() => undefined);
      } catch (e) {
        if ((e as Error).name !== "AbortError") this.#patch(key, (i) => ({ ...i, pending: false, progress: undefined, error: (e as Error).message || t("attach.uploadFailed") }));
      } finally {
        this.#aborts.delete(key);
      }
    }
    return { skipped: files.length - list.length };
  }
}
