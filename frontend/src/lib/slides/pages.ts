import DOMPurify from "dompurify";
import { api } from "#lib/api.ts";
import type { PageManifest, SlidePage } from "./types.ts";

// Manifests are immutable per URL (a re-index changes the image URLs, not the manifest URL's meaning
// for that render), so keep them for the session; failed loads are not cached.
const manifests = new Map<string, Promise<PageManifest>>();

/** Loads a version's page manifest from its `pagesUrl` (`/api/…`, may carry `?key=`). */
export function loadManifest(pagesUrl: string): Promise<PageManifest> {
  let pending = manifests.get(pagesUrl);
  if (!pending) {
    pending = api.get<PageManifest>(pagesUrl.replace(/^\/api/, ""));
    pending.catch(() => manifests.delete(pagesUrl));
    manifests.set(pagesUrl, pending);
  }
  return pending;
}

/** Forget a cached manifest (after a re-index or publish). */
export const dropManifest = (pagesUrl: string) => void manifests.delete(pagesUrl);

/** Page whose Reveal indices match `h`/`v` (a missing `v` in the manifest means 0). */
export function pageAt(manifest: PageManifest | null, h: number, v = 0): SlidePage | null {
  return manifest?.pages.find(p => (p.h ?? -1) === h && (p.v ?? 0) === v) ?? null;
}

/**
 * Speaker notes HTML. The backend already filters it, but the deck is user-authored: sanitise again
 * and only keep plain formatting (no images, forms, styles or event handlers).
 */
export function notesHtml(page: SlidePage | null | undefined): string | null {
  const html = page?.notes?.html;
  if (!html) return null;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "code", "pre", "ul", "ol", "li", "blockquote", "a", "span", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_DATA_ATTR: false,
  });
}

// Last viewed page per deck version (per browser). Storage may be unavailable (private mode, sandbox).
const posKey = (deck: string, versionId: string) => `hub-slide-pos:${deck}:${versionId}`;
export function readPosition(deck: string, versionId: string): number | null {
  try {
    const n = Number(localStorage.getItem(posKey(deck, versionId)));
    return Number.isInteger(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}
export function writePosition(deck: string, versionId: string, page: number) {
  try {
    localStorage.setItem(posKey(deck, versionId), String(page));
  } catch {}
}

/** Starts fetching an image so the next navigation shows it instantly. */
const preloaded = new Set<string>();
export function preload(url: string | undefined) {
  if (!url || preloaded.has(url)) return;
  preloaded.add(url);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
}

/** Speaker window URL (Hub origin, outside the app shell). `key` keeps share-link access working. */
export function speakerUrl(slug: string, versionId: string, page: number, key?: string | null) {
  const query = new URLSearchParams({ v: versionId, p: String(page) });
  if (key) query.set("key", key);
  return `/slides/play/${encodeURIComponent(slug)}/speaker?${query}`;
}

/** Opens (or focuses) the speaker window for a deck. Returns false when a popup blocker refused it. */
let speakerWindow: { win: Window; versionId: string } | null = null;
export function openSpeaker(slug: string, versionId: string, page: number, key?: string | null): boolean {
  // Re-pressing S focuses the open window instead of reloading it (which would reset its timer).
  if (speakerWindow && !speakerWindow.win.closed && speakerWindow.versionId === versionId) {
    speakerWindow.win.focus();
    return true;
  }
  const win = window.open(speakerUrl(slug, versionId, page, key), `hub-speaker-${slug}`, "popup,width=1280,height=800");
  if (!win) return false;
  speakerWindow = { win, versionId };
  win.focus();
  return true;
}
