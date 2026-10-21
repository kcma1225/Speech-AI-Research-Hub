/**
 * Polls `tick` every `interval` ms while `active()` is true and the document is visible. Ticks never overlap: a
 * `kick()` during a running tick queues exactly one more. Becoming visible again kicks immediately.
 */
export class LivePoller {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #queued = false;
  #onVisible = () => {
    if (!this.#doc?.hidden) void this.kick();
  };
  readonly #doc: Document | null;

  constructor(
    private readonly tick: () => Promise<unknown>,
    private readonly opts: { interval: number; active?: () => boolean; doc?: Document | null },
  ) {
    this.#doc = opts.doc === undefined ? (typeof document === "undefined" ? null : document) : opts.doc;
  }

  get running() {
    return this.#timer !== undefined;
  }

  /** True when a tick would run now. */
  canRun() {
    return !this.#doc?.hidden && (this.opts.active?.() ?? true);
  }

  /** Starts the timer; returns the matching stop function. */
  start() {
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => void this.kick(), this.opts.interval);
      this.#doc?.addEventListener("visibilitychange", this.#onVisible);
    }
    return () => this.stop();
  }

  stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#queued = false;
    this.#doc?.removeEventListener("visibilitychange", this.#onVisible);
  }

  /** Runs a tick now (if allowed); errors are swallowed — the next tick retries. */
  async kick(): Promise<void> {
    if (!this.canRun()) return;
    if (this.#running) {
      this.#queued = true;
      return;
    }
    this.#running = true;
    try {
      await this.tick();
    } catch {
      /* next tick retries */
    } finally {
      this.#running = false;
      if (this.#queued) {
        this.#queued = false;
        void this.kick();
      }
    }
  }
}

/** Structural equality for API payloads (plain JSON): lets a refetch keep object identity when nothing changed. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
