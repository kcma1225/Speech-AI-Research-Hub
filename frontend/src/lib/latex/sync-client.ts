import type { Rect } from "./synctex.ts";

/** Main-thread handle of the SyncTeX worker (one per editor page). */
export class SyncClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private key: string | null = null;

  private ensure() {
    if (!this.worker) {
      this.worker = new Worker(new URL("./synctex.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error ?? "synctex"));
      };
    }
    return this.worker;
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ensure().postMessage({ ...msg, id });
    });
  }

  /** Loads the SyncTeX of a compile (`key` = compile id); later lookups refer to it. */
  async load(key: string, url: string) {
    this.key = key;
    await this.call({ type: "load", key, url });
  }
  get loadedKey() {
    return this.key;
  }
  forward(file: string, line: number) {
    if (!this.key) return Promise.resolve([] as Rect[]);
    return this.call<Rect[]>({ type: "forward", key: this.key, file, line });
  }
  inverse(page: number, x: number, y: number) {
    if (!this.key) return Promise.resolve(null);
    return this.call<{ file: string; line: number } | null>({ type: "inverse", key: this.key, page, x, y });
  }
  /** Source line ranges of a PDF page (AI layout review). */
  pageSources(page: number) {
    if (!this.key) return Promise.resolve([] as Array<{ path: string; from: number; to: number }>);
    return this.call<Array<{ path: string; from: number; to: number }>>({ type: "page", key: this.key, page });
  }
  destroy() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
