import type { TagRef } from "#lib/types.ts";

/** One SRT cue; times in seconds. */
export type Cue = { start: number; end: number; text: string };

/** Row of `GET /items?audio=1`. */
export type RecordingSummary = {
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

export type MediaJob = { id: string; status: "processing"; stage: string | null; progress: number | null; file_name: string | null; created_at: string };

/** `GET /items/:id` (the fields the recordings pages use). */
export type RecordingDetail = {
  id: string;
  title: string;
  content: string;
  event_date: string;
  created_at: string;
  updated_at: string;
  created_by: { id: string | null; name: string | null };
  updated_by: { id: string | null; name: string | null };
  tags: TagRef[];
  audio: { name: string | null; bytes: number | null; duration_seconds: number | null; url: string } | null;
  audio_peaks: number[] | null;
  transcript: Cue[] | null;
  transcript_name: string | null;
  media_job: MediaJob | null;
};

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Index of the cue playing at `time` (or the last one that started before it), -1 before the first. Cues are sorted. */
export function cueIndexAt(cues: Cue[], time: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
