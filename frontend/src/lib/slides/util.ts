import { api, ApiError } from "#lib/api.ts";
import type { Tone } from "#lib/components/ui/Pill.svelte";
import type { SlideStatus, VersionStatus } from "./types.ts";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_LIMITS = { zipBytes: 200 * 1024 * 1024, deckBytes: 200 * 1024 * 1024, deckTypes: [".zip", ".pdf", ".pptx"], referenceBytes: 50 * 1024 * 1024 };

/** ASCII slug from a title; Chinese-only titles fall back to `slides-<date>`. */
export function slugify(title: string): string {
  const base = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (base) return base;
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  return `slides-${d}`;
}

/** Multipart POST with upload progress (fetch has none). Rejects with ApiError carrying the backend message. */
export function uploadForm<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "Network error"));
    xhr.onload = () => {
      let data: { error?: string } | null = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error ?? (xhr.status === 413 ? "413" : xhr.statusText)));
    };
    xhr.send(form);
  });
}

/** The backend asks for an entry with "…請指定入口檔：a.qmd、b.qmd"; returns the candidates, or null. */
export function entryCandidates(message: string): string[] | null {
  const i = message.indexOf("請指定入口檔");
  if (i < 0) return null;
  const list = message.slice(i).split(/[：:]/)[1] ?? "";
  return list.split("、").map(s => s.trim()).filter(Boolean);
}

/** Polls GET /slides/:id/status until the latest version settles (published, review or failed). Returns a stop function. */
export function watchStatus(id: string, onUpdate: (status: SlideStatus) => void, intervalMs = 1500): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const status = await api.get<SlideStatus>(`/slides/${id}/status`);
      if (stopped) return;
      onUpdate(status);
      if (!isBusy(status.status)) return;
    } catch {
      if (stopped) return;
    }
    timer = setTimeout(tick, document.hidden ? 5000 : intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export const statusTone: Record<VersionStatus, Tone> = { queued: "butter", rendering: "sky", review: "lilac", published: "mint", failed: "rose" };
export const isBusy = (s: VersionStatus | null | undefined) => s === "queued" || s === "rendering";

// eslint-disable-next-line no-control-regex
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Clipboard write that also works on plain-http origins (no async clipboard API there). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  return ok;
}

export const absoluteUrl = (path: string) => new URL(path, location.origin).toString();

export function formatBytes(n: number) {
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${Math.round(n / (1 << 20))} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
