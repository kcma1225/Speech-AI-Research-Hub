import { t } from "#lib/i18n.svelte.ts";
import { keyOf, MAX_ATTACHMENTS, refOf, type Attachment } from "./types.ts";
import { removeUpload, uploadFile } from "./api.ts";

export type DraftItem = Attachment & { key: string; pending?: boolean; error?: string };

/**
 * Attachments of the message being written: chips above the composer. Uploads need a conversation (created on
 * demand by `ensureConversation`) and show a spinner chip until the server has validated them.
 */
export class AttachDraft {
  items = $state<DraftItem[]>([]);

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
    return this.items.filter((i) => !i.pending && !i.error).map(refOf);
  }
  has(kind: string, id: string) {
    return this.items.some((i) => i.key === keyOf({ kind, id }));
  }
  find(kind: string, id: string) {
    return this.items.find((i) => i.key === keyOf({ kind, id }));
  }

  /** Adds (or replaces, e.g. another deck version) one item; false when the message is full. */
  add(a: Attachment): boolean {
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
    // An upload nobody sent yet is deleted on the server (kept when a sent message uses it).
    if (item?.kind === "upload" && !item.pending && !item.error) void removeUpload(item.id).catch(() => undefined);
  }

  clear() {
    this.items = [];
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
    for (const file of list) {
      const key = `pending:${crypto.randomUUID()}`;
      this.items.push({ key, kind: "upload", id: key, title: file.name, study: null, url: null, pending: true, upload_kind: file.type.startsWith("image/") ? "image" : "document" });
      try {
        const r = await uploadFile(conversationId, file);
        const a = r.attachment;
        const at = this.items.findIndex((i) => i.key === key);
        const ready: DraftItem = { key: keyOf({ kind: "upload", id: a.id }), kind: "upload", id: a.id, title: a.title, study: null, url: a.url, mime: a.mime, upload_kind: a.upload_kind };
        if (at >= 0) this.items[at] = ready;
      } catch (e) {
        const at = this.items.findIndex((i) => i.key === key);
        if (at >= 0) this.items[at] = { ...this.items[at]!, pending: false, error: (e as Error).message || t("attach.uploadFailed") };
      }
    }
    return { skipped: files.length - list.length };
  }
}
