import { flushSync } from "svelte";
import type { Locale } from "./types";
import { messages, type MessageKey } from "./messages";

let current = $state<Locale>(readCached());

function readCached(): Locale {
  try {
    return localStorage.getItem("hub-locale") === "en" ? "en" : "zh-TW";
  } catch {
    return "zh-TW";
  }
}

export const i18n = {
  get locale() {
    return current;
  },
  /** `animate: false` for silent sync (adopting the account's value on load). */
  set(locale: Locale, { animate = true }: { animate?: boolean } = {}) {
    try {
      localStorage.setItem("hub-locale", locale);
    } catch {}
    const root = document.documentElement;
    const commit = () => {
      current = locale;
      flushSync();
      root.lang = locale === "en" ? "en" : "zh-Hant";
    };
    const still = !animate || locale === current || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) return commit();
    // Old text lifts and blurs out while the new text settles in (styles: `.vt-locale` in app.css).
    if (typeof document.startViewTransition !== "function") {
      root.classList.add("locale-fade");
      commit();
      setTimeout(() => root.classList.remove("locale-fade"), 400);
      return;
    }
    root.classList.add("vt-locale");
    document.startViewTransition(commit).finished.finally(() => root.classList.remove("vt-locale"));
  },
};

/** Translates a key; `{name}` placeholders are filled from `vars`. Reactive on the current locale. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text: string = messages[current][key] ?? messages["zh-TW"][key] ?? key;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

const rtf = { "zh-TW": new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" }), en: new Intl.RelativeTimeFormat("en", { numeric: "auto" }) };

/** "3 分鐘前" / "3 minutes ago"; falls back to a date after a week. */
export function relativeTime(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  const f = rtf[current];
  if (abs < 45) return f.format(0, "second");
  if (abs < 3600) return f.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return f.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return f.format(Math.round(seconds / 86400), "day");
  return formatDate(iso);
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat(current, { timeZone: "Asia/Taipei", ...opts }).format(new Date(iso));
}
