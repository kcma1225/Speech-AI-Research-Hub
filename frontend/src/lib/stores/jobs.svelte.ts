import { api } from "#lib/api.ts";
import { ALL_KINDS, emitChanged, type ChangeKind } from "#lib/changes.ts";
import type { ActiveJob } from "#lib/types.ts";

let jobs = $state<ActiveJob[]>([]);
/** Browser-side uploads still sending bytes (no server job exists yet); shown first in the tray. */
let uploads = $state<ActiveJob[]>([]);
let nextUpload = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

const onVisible = () => !document.hidden && poll();

/** Background jobs → the data they write (a finished one makes open lists reload, even with no chat open). */
const JOB_KINDS: Record<string, ChangeKind[]> = {
  ai_workflow: ALL_KINDS,
  ai_library_import: ["papers"],
  ai_slides_generate: ["decks"],
  ai_meeting_transcribe: ["meetings"],
  ai_meeting_analyze: ["meetings", "notes", "tasks"],
  slide_render: ["decks"],
  latex_compile: ["latex"],
};
const isActive = (j: ActiveJob) => j.status === "queued" || j.status === "running";

/** Jobs that were active in the previous poll and are not any more. */
export function announceFinished(prev: ActiveJob[], next: ActiveJob[]) {
  const kinds = new Set<ChangeKind>();
  for (const p of prev) {
    if (!isActive(p)) continue;
    const n = next.find((j) => j.id === p.id);
    if (!n || !isActive(n)) for (const k of JOB_KINDS[p.kind] ?? []) kinds.add(k);
  }
  if (kinds.size) emitChanged([...kinds]);
}

async function poll() {
  clearTimeout(timer);
  if (!started) return;
  try {
    const next = (await api.get<{ jobs: ActiveJob[] }>("/jobs/active")).jobs;
    announceFinished(jobs, next);
    jobs = next;
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
