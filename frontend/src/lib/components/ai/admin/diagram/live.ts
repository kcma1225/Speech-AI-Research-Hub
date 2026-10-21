import { prefersReducedMotion } from "svelte/motion";

/** A route counts as "flowing" (animated connector) when it was used this recently. */
export const RECENT_MS = 60_000;

export const recentlyUsed = (iso: string | null | undefined, now: number) => Boolean(iso) && now - new Date(iso!).getTime() < RECENT_MS;

/**
 * Svelte action: a short ring pulse on the element whenever `value` changes (never on first render, never under
 * reduced motion). Used on bricks and function blocks when their live numbers move.
 */
export function pulseOnChange(node: HTMLElement, value: unknown) {
  let last = value;
  return {
    update(next: unknown) {
      if (next === last) return;
      last = next;
      if (prefersReducedMotion.current || typeof node.animate !== "function") return;
      node.animate(
        [
          { boxShadow: "0 0 0 0 color-mix(in oklab, var(--success) 45%, transparent)" },
          { boxShadow: "0 0 0 7px color-mix(in oklab, var(--success) 0%, transparent)" },
        ],
        { duration: 900, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
    },
  };
}
