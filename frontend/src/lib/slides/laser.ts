/**
 * Mirrored laser pointer (speaker view → player). Positions travel as fractions of the slide's own box
 * (Reveal's configured width × height, or the page image), never as pixels, so a point lands on the same
 * spot of the slide whatever the size and aspect ratio of either window.
 */
export type Box = { left: number; top: number; width: number; height: number };
/** Reveal's configured slide size and its current scale inside the frame. */
export type RevealFit = { width: number; height: number; scale: number };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** A `width × height` page fitted inside `box` like `object-fit: contain` (centred, letterboxed). */
export function containBox(box: Box, width: number, height: number): Box {
  if (!positive(width) || !positive(height) || box.width <= 0 || box.height <= 0) return box;
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

/**
 * The slide inside a frame running a Reveal deck: Reveal centres its slides element (configured size)
 * in the viewport and scales it (`translate(-50%,-50%) scale(s)`). Before the deck has reported its
 * size, fall back to fitting the page size (manifest) with no margin.
 */
export function revealSlideBox(frame: Box, fit: RevealFit | null, fallback: { width: number; height: number } | null): Box {
  if (fit) {
    const w = fit.width * fit.scale;
    const h = fit.height * fit.scale;
    return { left: frame.left + (frame.width - w) / 2, top: frame.top + (frame.height - h) / 2, width: w, height: h };
  }
  return fallback ? containBox(frame, fallback.width, fallback.height) : frame;
}

/** Client point → slide fraction; null outside the slide (letterbox bars, margins). */
export function toSlide(box: Box, clientX: number, clientY: number): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** Slide fraction → point in the same coordinate space as `box`. */
export function fromSlide(box: Box, x: number, y: number) {
  return { x: box.left + x * box.width, y: box.top + y * box.height };
}

/**
 * Collects the answers to `getComputedSlideSize` and `getScale` (Reveal postMessage callbacks, untrusted:
 * the deck is user-authored). Returns true when the fit changed.
 */
export function revealFitTracker() {
  let size: { width: number; height: number } | null = null;
  let scale: number | null = null;
  return {
    get fit(): RevealFit | null {
      return size && scale ? { ...size, scale } : null;
    },
    /** Methods to ask the deck for (after `ready` and every `resize`). */
    methods: ["getComputedSlideSize", "getScale"] as const,
    onCallback(method: unknown, result: unknown): boolean {
      if (method === "getScale") {
        if (!positive(result) || result > 100 || result === scale) return false;
        scale = result;
        return true;
      }
      if (method === "getComputedSlideSize") {
        const r = result as { width?: unknown; height?: unknown } | null;
        if (!r || typeof r !== "object" || !positive(r.width) || !positive(r.height) || r.width > 100_000 || r.height > 100_000) return false;
        if (size && size.width === r.width && size.height === r.height) return false;
        size = { width: r.width, height: r.height };
        return true;
      }
      return false;
    },
    reset() {
      size = null;
      scale = null;
    },
  };
}
export type RevealFitTracker = ReturnType<typeof revealFitTracker>;
