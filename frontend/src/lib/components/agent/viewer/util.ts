/** Small helpers shared by the document viewers. */

/** First changed index of a Y.Text delta (`[{retain}, {insert|delete}]…`), or null when nothing changed. */
export function firstChange(delta: { retain?: number; insert?: unknown; delete?: number }[]): number | null {
  let at = 0;
  for (const op of delta) {
    if (op.retain !== undefined && op.insert === undefined && op.delete === undefined) {
      at += op.retain;
      continue;
    }
    return at;
  }
  return null;
}

/** 1-based line of a character offset. */
export function lineAt(text: string, pos: number): number {
  let line = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Rendered Markdown (`data-line` blocks): the block that contains `line` (the last one starting at or before it). */
export function blockForLine(root: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = -1;
  for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const n = Number(el.dataset.line);
    if (n <= line && n >= bestLine) {
      best = el;
      bestLine = n;
    }
  }
  return best;
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Briefly highlights an element (CSS class `viewer-hl`, see LiveText). */
export function flashElement(el: Element) {
  el.classList.remove("viewer-hl");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("viewer-hl");
  setTimeout(() => el.classList.remove("viewer-hl"), 1800);
}

/**
 * Polls `fn` every `ms` while the tab is visible (and immediately when it becomes visible again). Returns a stop
 * function; `fn` may return a different delay for the next round (e.g. faster while a render runs).
 */
export function poll(fn: () => Promise<number | void> | number | void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return schedule(ms);
    running = true;
    let next: number | void = undefined;
    try {
      next = await fn();
    } catch {
      // keep polling
    } finally {
      running = false;
    }
    schedule(typeof next === "number" ? next : ms);
  };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(run, delay);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") schedule(0);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  schedule(ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

export const fmtClock = (s: number) => {
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

/** Waits (≤ `ms`) until a pdf.js page placeholder `[data-page=n]` exists inside `host` (PdfViewer lays them out after load). */
export async function whenPdfPage(host: HTMLElement | null, n: number, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (host?.querySelector(`[data-page="${n}"]`)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}
