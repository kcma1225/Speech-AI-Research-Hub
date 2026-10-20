import type { ThemePref } from "./types";

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
let pref = $state<ThemePref>(readCached());
let systemDark = $state(media?.matches ?? false);
media?.addEventListener("change", e => (systemDark = e.matches));

function readCached(): ThemePref {
  try {
    const v = localStorage.getItem("hub-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const theme = {
  get pref() {
    return pref;
  },
  get resolved(): "light" | "dark" {
    return pref === "system" ? (systemDark ? "dark" : "light") : pref;
  },
  set(value: ThemePref) {
    pref = value;
    try {
      localStorage.setItem("hub-theme", value);
    } catch {}
  },
};

/** Keeps <html data-theme> in sync; call once from the root layout. */
export function syncTheme() {
  $effect(() => {
    document.documentElement.dataset.theme = theme.resolved;
  });
}
