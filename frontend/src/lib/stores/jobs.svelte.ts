import { api } from "#lib/api.ts";
import type { ActiveJob } from "#lib/types.ts";

let jobs = $state<ActiveJob[]>([]);
/** Browser-side uploads still sending bytes (no server job exists yet); shown first in the tray. */
let uploads = $state<ActiveJob[]>([]);
let nextUpload = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

const onVisible = () => !document.hidden && poll();

async function poll() {
  clearTimeout(timer);
  if (!started) return;
  try {
    jobs = (await api.get<{ jobs: ActiveJob[] }>("/jobs/active")).jobs;
  } catch {
    // Keep the last known list; the next tick retries.
  }
  const busy = jobs.some(j => j.status === "queued" || j.status === "running");
  if (!started) return;
  timer = setTimeout(poll, document.hidden ? 60_000 : busy ? 3_000 : 20_000);
}

export const jobsStore = {
  get jobs() {
    return uploads.length ? [...uploads, ...jobs] : jobs;
  },
  get running() {
    return this.jobs.filter(j => j.status === "queued" || j.status === "running");
  },
  /**
   * Show a browser upload in the tray (kind `upload`, stage `uploading`) until it finishes. `progress(fraction)` updates
   * the bar; `done()` removes the entry (the server job, if any, takes over after `refresh()`).
   */
  trackUpload(label: string, url: string | null = null) {
    const id = `upload-${nextUpload++}`;
    uploads = [...uploads, { id, kind: "upload", status: "running", stage: "uploading", progress: 0, label, url, updatedAt: new Date().toISOString() }];
    let last = -1;
    return {
      progress(fraction: number) {
        const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
        if (pct === last) return;
        last = pct;
        uploads = uploads.map(u => (u.id === id ? { ...u, progress: pct } : u));
      },
      done() {
        uploads = uploads.filter(u => u.id !== id);
      },
    };
  },
  start() {
    if (started) return;
    started = true;
    document.addEventListener("visibilitychange", onVisible);
    void poll();
  },
  /** On logout: stop polling and forget the previous account's jobs. */
  stop() {
    started = false;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    jobs = [];
    uploads = [];
  },
  /** Call after enqueueing something so the footer picks it up immediately. */
  refresh: () => poll(),
};
