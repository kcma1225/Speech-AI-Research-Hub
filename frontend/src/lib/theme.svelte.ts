import { flushSync } from "svelte";
import type { ThemePref } from "./types";

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let pref = $state<ThemePref>(readCached());
let systemDark = $state(media?.matches ?? false);
media?.addEventListener("change", e => transition(() => (systemDark = e.matches), pref === "system"));

// The theme change animates outward from the last pointer press (the control that changed it).
let origin: { x: number; y: number } | null = null;
if (typeof window !== "undefined") window.addEventListener("pointerdown", e => (origin = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });

function readCached(): ThemePref {
  try {
    const v = localStorage.getItem("hub-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const resolveFor = (p: ThemePref): "light" | "dark" => (p === "system" ? (systemDark ? "dark" : "light") : p);
const resolve = () => resolveFor(pref);
const apply = () => (document.documentElement.dataset.theme = resolve());

/**
 * Runs a state change; when it flips light/dark the new theme is revealed as a circle growing from
 * `origin` (View Transitions API), or colours cross-fade briefly where that API is missing.
 * Reduced motion or a hidden tab: instant.
 */
function transition(change: () => void, flips: boolean) {
  const commit = () => {
    change();
    flushSync();
    apply();
  };
  if (!flips || typeof document === "undefined" || reducedMotion?.matches || document.hidden) return commit();
  const root = document.documentElement;
  if (typeof document.startViewTransition !== "function") {
    root.classList.add("theme-fade");
    commit();
    setTimeout(() => root.classList.remove("theme-fade"), 320);
    return;
  }
  const { x, y } = origin ?? { x: innerWidth / 2, y: innerHeight / 2 };
  origin = null;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(commit);
  void vt.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" },
      ),
    )
    .catch(() => {});
}

export const theme = {
  get pref() {
    return pref;
  },
  get resolved(): "light" | "dark" {
    return resolve();
  },
  /** `animate: false` for silent sync (e.g. adopting the account's value on load). */
  set(value: ThemePref, { animate = true }: { animate?: boolean } = {}) {
    try {
      localStorage.setItem("hub-theme", value);
    } catch {}
    if (value === pref) return;
    if (!animate) {
      pref = value;
      apply();
      return;
    }
    transition(() => (pref = value), resolveFor(value) !== resolve());
  },
};

/** Keeps <html data-theme> in sync; call once from the root layout. */
export function syncTheme() {
  $effect(() => {
    document.documentElement.dataset.theme = theme.resolved;
  });
}
