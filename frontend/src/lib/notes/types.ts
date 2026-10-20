import type { TagRef } from "#lib/types.ts";

/** Row of `GET /items` (see docs/architecture.md, Notes). */
export type NoteListItem = {
  id: string;
  title: string;
  excerpt: string;
  event_date: string;
  tags: TagRef[];
  has_audio: boolean;
  has_transcript: boolean;
  audio_name: string | null;
  audio_duration_seconds: number | null;
  updated_at: string;
  created_by_name: string | null;
  updated_by_name: string | null;
};

export type NoteMediaJob = { id: string; status: "processing"; stage: string; progress: number; file_name: string; created_at: string };

/** `GET /items/:id` → `{ item }`. */
export type NoteDetail = {
  id: string;
  title: string;
  content: string;
  event_date: string;
  created_at: string;
  updated_at: string;
  created_by: { id: string; name: string | null };
  updated_by: { id: string; name: string | null };
  tags: TagRef[];
  audio: { name: string | null; bytes: number | null; duration_seconds: number | null; url: string } | null;
  audio_peaks: number[] | null;
  transcript: { start: number; end: number; text: string }[] | null;
  transcript_name: string | null;
  media_job: NoteMediaJob | null;
};

/** `GET /media-jobs/:id` → `{ job }`. */
export type MediaJob = {
  id: string;
  item_id: string;
  status: "processing" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number;
  duration_seconds: number | null;
  error: string | null;
  file_name: string;
  created_at: string;
};

/** Extensions accepted by `POST /items/:id/media` (backend `MEDIA_EXTENSIONS`). */
export const MEDIA_ACCEPT = ".mp4,.m4a,.mov,.webm,.mkv,.mp3,.wav,.aac,.ogg,.opus,.flac";

/** Mirrors the backend `markdownExcerpt` so the list can be patched after a save without refetching. */
export function markdownExcerpt(input: string, limit = 120) {
  return input
    .slice(0, 10_000)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** 1:05:09 / 4:07 */
export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Today in Asia/Taipei as YYYY-MM-DD (the backend default for event_date). */
export function todayTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
