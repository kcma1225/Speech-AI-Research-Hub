/**
 * Deep links to the card that waits for the user (shell 「N 個 Agent 執行中」 overview, notifications, the jobs tray):
 * `/assistant/<conversationId>?focus=workflow:<runId>` (workflow plan / question card) or `?focus=toolcall:<id>`
 * (ask_user question card, consent card). The chat scrolls to the card and pulses it once. `?workflow=<runId>` is
 * the older spelling of `focus=workflow:<runId>`. Runs without a conversation open `/assistant/workflows?run=<id>`.
 */

export type FocusTarget = { type: "workflow" | "toolcall"; id: string };

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** `URL` or SvelteKit's read-only `page.url`. */
type UrlLike = { readonly href: string; readonly searchParams: { get(name: string): string | null } };

/** `workflow:<id>` / `toolcall:<id>` → target; anything else → null. */
export function parseFocus(value: string | null | undefined): FocusTarget | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at < 0) return null;
  const type = value.slice(0, at);
  const id = value.slice(at + 1);
  if ((type !== "workflow" && type !== "toolcall") || !ID.test(id)) return null;
  return { type, id };
}

export const focusKey = (target: FocusTarget) => `${target.type}:${target.id}`;

/** The focus requested by a URL (`?focus=` first, then the `?workflow=` alias). */
export function focusFromUrl(url: UrlLike): FocusTarget | null {
  const direct = parseFocus(url.searchParams.get("focus"));
  if (direct) return direct;
  const wf = url.searchParams.get("workflow");
  return wf && ID.test(wf) ? { type: "workflow", id: wf } : null;
}

/** The same URL without the focus parameters (after the card was shown, so a reload does not jump again). */
export function withoutFocus(url: UrlLike): URL {
  const next = new URL(url.href);
  next.searchParams.delete("focus");
  next.searchParams.delete("workflow");
  return next;
}

/** Run id requested on /assistant/workflows (`?run=`, or the older `?id=`). */
export function runFromUrl(url: UrlLike): string | null {
  const v = url.searchParams.get("run") ?? url.searchParams.get("id");
  return v && ID.test(v) ? v : null;
}

/** Where a run's primary button leads, and its label key, by what the run waits for. */
export type RunAction = "approve_plan" | "answer" | "review" | null;
export const ACTION_LABEL = {
  approve_plan: "agentRuns.go.approvePlan",
  answer: "agentRuns.go.answer",
  review: "agentRuns.go.review",
} as const;

/** Minimal element surface used by `findFocusTarget` (keeps it testable without a DOM). */
type Root = { querySelector(selector: string): unknown };

/**
 * The element to scroll to inside `root`: the card marked `data-focus-key="<key>"`, narrowed to its
 * `[data-focus-target]` part when it has one (a workflow card's plan editor or open question).
 */
export function findFocusTarget<E>(root: Root, target: FocusTarget): E | null {
  const card = root.querySelector(`[data-focus-key="${focusKey(target)}"]`) as (E & Root) | null;
  if (!card) return null;
  return ((card.querySelector("[data-focus-target]") as E | null) ?? card) as E;
}

/**
 * Waits (polling, the card may load lazily) for the target, then calls `found`. Resolves `false` when it never
 * appears within `timeoutMs`. `cancelled()` stops the wait (the view changed).
 */
export async function waitForFocus<E>(
  root: Root,
  target: FocusTarget,
  opts: { timeoutMs?: number; intervalMs?: number; cancelled?: () => boolean; found: (el: E) => void; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const timeout = opts.timeoutMs ?? 8000;
  const interval = opts.intervalMs ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited <= timeout; waited += interval) {
    if (opts.cancelled?.()) return false;
    const el = findFocusTarget<E>(root, target);
    if (el) {
      opts.found(el);
      return true;
    }
    await sleep(interval);
  }
  return false;
}

/** Scrolls `el` into view inside `scroller` (or the page) and pulses a ring around it once. */
export function revealAndPulse(el: HTMLElement, scroller: HTMLElement | null, reduceMotion: boolean) {
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
  } else {
    // No inner scroll (e.g. the page itself scrolls on phones): scroll the page.
    el.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }
  el.setAttribute("data-focus-pulse", "");
  const ring = "0 0 0 3px color-mix(in oklab, var(--pill-butter-ink, #a16207) 55%, transparent)";
  const none = "0 0 0 0 transparent";
  const anim = typeof el.animate === "function"
    ? el.animate(
        reduceMotion ? [{ boxShadow: ring }, { boxShadow: ring }] : [{ boxShadow: none }, { boxShadow: ring }, { boxShadow: none }, { boxShadow: ring }, { boxShadow: none }],
        { duration: reduceMotion ? 2400 : 2200, easing: "ease-in-out" },
      )
    : null;
  const done = () => el.removeAttribute("data-focus-pulse");
  if (anim) anim.onfinish = done;
  else setTimeout(done, 2400);
  // Keyboard users land on the card too (without scrolling again).
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}
