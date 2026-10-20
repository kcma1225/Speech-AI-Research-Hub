import { api } from "#lib/api.ts";
import type { ActiveJob } from "#lib/types.ts";

let jobs = $state<ActiveJob[]>([]);
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

async function poll() {
  clearTimeout(timer);
  try {
    jobs = (await api.get<{ jobs: ActiveJob[] }>("/jobs/active")).jobs;
  } catch {
    // Keep the last known list; the next tick retries.
  }
  const busy = jobs.some(j => j.status === "queued" || j.status === "running");
  timer = setTimeout(poll, document.hidden ? 60_000 : busy ? 3_000 : 20_000);
}

export const jobsStore = {
  get jobs() {
    return jobs;
  },
  get running() {
    return jobs.filter(j => j.status === "queued" || j.status === "running");
  },
  start() {
    if (started) return;
    started = true;
    document.addEventListener("visibilitychange", () => !document.hidden && poll());
    void poll();
  },
  /** Call after enqueueing something so the footer picks it up immediately. */
  refresh: () => poll(),
};
