import { api } from "#lib/api.ts";
import type { ActiveJob } from "#lib/types.ts";

let jobs = $state<ActiveJob[]>([]);
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
    return jobs;
  },
  get running() {
    return jobs.filter(j => j.status === "queued" || j.status === "running");
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
  },
  /** Call after enqueueing something so the footer picks it up immediately. */
  refresh: () => poll(),
};
