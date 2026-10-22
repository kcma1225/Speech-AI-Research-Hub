/**
 * Resizable two-pane workspaces (Quarto source editor ↔ preview, LaTeX editor ↔ PDF): the ratio of the
 * first pane, clamped, remembered per viewer in localStorage (a convenience only: every access may throw).
 */
export type SplitLimits = { min: number; max: number };
export const DEFAULT_LIMITS: SplitLimits = { min: 0.25, max: 0.75 };

export function clampRatio(value: number, limits: SplitLimits = DEFAULT_LIMITS): number {
  if (!Number.isFinite(value)) return (limits.min + limits.max) / 2;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Ratio of a pointer position inside the container (left edge → 0, right edge → 1). */
export function ratioAt(clientX: number, left: number, width: number, limits: SplitLimits = DEFAULT_LIMITS): number {
  if (width <= 0) return clampRatio(0.5, limits);
  return clampRatio((clientX - left) / width, limits);
}

/** Keyboard on the separator: arrows move by 2 % (10 % with Shift), Home/End jump to the limits. Null when the key does nothing. */
export function ratioForKey(key: string, current: number, shift = false, limits: SplitLimits = DEFAULT_LIMITS): number | null {
  const step = shift ? 0.1 : 0.02;
  switch (key) {
    case "ArrowLeft":
      return clampRatio(current - step, limits);
    case "ArrowRight":
      return clampRatio(current + step, limits);
    case "Home":
      return limits.min;
    case "End":
      return limits.max;
    default:
      return null;
  }
}

const PREFIX = "hub.split.";

export function loadRatio(key: string, fallback: number, limits: SplitLimits = DEFAULT_LIMITS): number {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? clampRatio(value, limits) : fallback;
  } catch {
    return fallback;
  }
}

export function saveRatio(key: string, value: number): void {
  try {
    localStorage.setItem(PREFIX + key, value.toFixed(3));
  } catch {
    /* private mode / blocked storage: the ratio just isn't remembered */
  }
}

/** A remembered on/off flag (collapsed panes). */
export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
