import { api } from "#lib/api.ts";

/** One entry of `GET /api/workflows/active` (backend/src/workflows/active.ts). */
export type ActiveAgentRun = {
  kind: "workflow" | "assistant";
  id: string;
  title: string;
  objective: string | null;
  status: string;
  needs_you: boolean;
  conversation_id: string | null;
  study: { id: string; slug: string; title: string } | null;
  current: { role: string | null; text: string } | null;
  progress: { done: number; total: number } | null;
  plan: { done: number; total: number; current: string | null } | null;
  step: { step: number; max: number } | null;
  budget_pct: number | null;
  tokens: number;
  artifacts: { kind: string; id: string; url: string; title: string }[];
  started_at: string;
  updated_at: string;
};

let runs = $state<ActiveAgentRun[]>([]);
let loaded = $state(false);
let error = $state<string | null>(null);
let open = false;
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Poll cadence: 5 s while the overview is open, 15 s while something runs, 60 s idle; paused while the tab is hidden. */
function schedule() {
  clearTimeout(timer);
  if (!started || document.hidden) return;
  timer = setTimeout(poll, open ? 5_000 : runs.length ? 15_000 : 60_000);
}
async function poll() {
  clearTimeout(timer);
  if (!started) return;
  try {
    runs = (await api.get<{ runs: ActiveAgentRun[] }>("/workflows/active")).runs;
    error = null;
  } catch (e) {
    error = (e as Error).message;
  }
  loaded = true;
  schedule();
}
const onVisible = () => (document.hidden ? clearTimeout(timer) : void poll());

export const agentActivity = {
  get runs() {
    return runs;
  },
  get loaded() {
    return loaded;
  },
  get error() {
    return error;
  },
  get needsYou() {
    return runs.filter((r) => r.needs_you).length;
  },
  start() {
    if (started || typeof document === "undefined") return;
    started = true;
    document.addEventListener("visibilitychange", onVisible);
    void poll();
  },
  stop() {
    started = false;
    clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    runs = [];
  },
  /** The overview popover/sheet is open: poll faster (and refresh now). */
  setOpen(v: boolean) {
    open = v;
    if (v) void poll();
    else schedule();
  },
  refresh: () => poll(),
};
