import { ApiError } from "#lib/api.ts";
import { notifyArtifactChanged, refFromArtifact } from "#lib/agent/viewer.ts";
import { workflowsApi } from "./api.ts";
import { applyEvent, emptyState, type WorkflowState } from "./reduce.ts";
import { ACTIVE, type Artifact, type Workflow } from "./types.ts";

const EVENT_TYPES = ["workflow", "step", "activity", "verdict", "artifact", "log"] as const;

/** Announces an artifact to the assistant's document viewer (window event + the viewer store when it is loaded). */
export function announceArtifact(a: Artifact, workflowId: string, mode: "open" | "changed") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("hub:artifact", { detail: { ...a, source: "workflow", workflowId, mode } }));
  if (mode === "changed") {
    const r = refFromArtifact(a);
    if (r) notifyArtifactChanged(r.ref, { focus: r.focus });
  }
}

/**
 * One workflow run in the browser: GET once, then (only while it is active) the SSE event log from `resumeFrom`.
 * Events are batched per animation frame; `artifact` events that arrive live are forwarded to the viewer panel.
 */
export class WorkflowSession {
  state = $state<WorkflowState>(emptyState());
  loading = $state(true);
  error = $state<string | null>(null);
  /** The run no longer exists (deleted): the card says so quietly instead of showing an error. */
  gone = $state(false);
  live = $state(false);
  private source: EventSource | null = null;
  private queue: { type: string; data: Record<string, unknown> }[] = [];
  private frame = 0;
  private last = 0;
  private closed = false;

  constructor(readonly id: string) {}

  get workflow() {
    return this.state.workflow;
  }
  get steps() {
    return this.state.steps;
  }
  get active() {
    return !!this.state.workflow && ACTIVE.includes(this.state.workflow.status);
  }

  async load() {
    this.error = null;
    try {
      const d = await workflowsApi.get(this.id);
      if (this.closed) return;
      this.state = { ...this.state, workflow: d.workflow, steps: d.steps };
      this.last = d.resumeFrom;
      this.sync();
    } catch (e) {
      this.error = (e as Error).message;
      this.gone = e instanceof ApiError && e.status === 404;
    } finally {
      this.loading = false;
    }
  }

  /** Applies a command's response (the SSE stream confirms it later). */
  setWorkflow(w: Workflow | null) {
    if (w) this.state = { ...this.state, workflow: w };
    this.sync();
  }

  /** Connects while active; disconnects when the run is finished or waits without work. */
  private sync() {
    if (this.closed) return;
    if (this.active && !this.source) this.connect();
    else if (!this.active && this.source) this.disconnect();
  }

  private connect() {
    if (typeof EventSource !== "function") return;
    const es = new EventSource(`/api/workflows/${this.id}/events?after=${this.last}`);
    this.source = es;
    es.onopen = () => (this.live = true);
    es.onerror = () => (this.live = false);
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        const ev = e as MessageEvent;
        const seq = Number(ev.lastEventId);
        if (seq && seq <= this.last) return;
        if (seq) this.last = seq;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (type === "artifact" && data.artifact) announceArtifact(data.artifact as Artifact, this.id, "changed");
        this.queue.push({ type, data });
        if (!this.frame) this.frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => this.flush()) : (setTimeout(() => this.flush(), 16) as unknown as number);
      });
    }
  }

  private flush() {
    this.frame = 0;
    let s = this.state;
    for (const q of this.queue.splice(0)) s = applyEvent(s, q.type, q.data);
    this.state = s;
    this.sync();
  }

  private disconnect() {
    this.source?.close();
    this.source = null;
    this.live = false;
  }

  destroy() {
    this.closed = true;
    this.disconnect();
    if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
  }
}
