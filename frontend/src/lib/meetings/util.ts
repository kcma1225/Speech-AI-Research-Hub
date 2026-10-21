import { formatDate } from "#lib/i18n.svelte.ts";
import type { MessageKey } from "#lib/messages.ts";
import type { Tone } from "#lib/components/ui/Pill.svelte";
import type { DraftStatus, JobInfo, MeetingDetail, MeetingStatus, Segment, SpeakerMapEntry } from "./types.ts";

export const STATUS_LABEL: Record<MeetingStatus, MessageKey> = {
  draft: "meet.status.draft",
  recorded: "meet.status.recorded",
  processing: "meet.status.processing",
  transcribed: "meet.status.transcribed",
  analyzing: "meet.status.analyzing",
  review: "meet.status.review",
  done: "meet.status.done",
};
export const STATUS_TONE: Record<MeetingStatus, Tone> = {
  draft: "stone",
  recorded: "sky",
  processing: "sky",
  transcribed: "lilac",
  analyzing: "lilac",
  review: "butter",
  done: "mint",
};
export const DRAFT_LABEL: Record<DraftStatus, MessageKey> = { pending: "meet.draft.pending", confirmed: "meet.draft.confirmed", dismissed: "meet.draft.dismissed" };
export const DRAFT_TONE: Record<DraftStatus, Tone> = { pending: "butter", confirmed: "mint", dismissed: "stone" };

/** "10月20日 週二 14:00" style, Asia/Taipei. */
export const meetingDate = (iso: string) => formatDate(iso, { month: "short", day: "numeric", weekday: "short" });
export const meetingTime = (iso: string) => formatDate(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
export const meetingDateTime = (iso: string) => formatDate(iso, { year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** `YYYY-MM-DD` and `HH:mm` of an instant in Asia/Taipei (for the form fields). */
export function taipeiParts(iso: string | Date) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
}
/** Asia/Taipei date + time (UTC+8, no DST) → ISO instant. */
export const taipeiIso = (date: string, time: string) => new Date(`${date}T${time || "00:00"}:00+08:00`).toISOString();

export const jobActive = (job: JobInfo) => Boolean(job && (job.status === "queued" || job.status === "running"));

/** Something is still being produced (media conversion, ASR, analysis) → keep polling. */
export const isBusy = (d: MeetingDetail) => jobActive(d.jobs.transcribe) || jobActive(d.jobs.analyze) || d.media.some(m => m.status === "processing");

/** Speaker colours: stable per label order (pastel pill tones). */
const SPEAKER_TONES: Tone[] = ["sky", "peach", "mint", "lilac", "butter", "rose"];
export function speakerInfo(segments: Segment[], map: SpeakerMapEntry[]) {
  const byLabel = new Map(map.map(m => [m.speaker_label, m]));
  const info = new Map<string, { name: string; tone: Tone; mapped: boolean; index: number }>();
  for (const s of segments) {
    if (!s.speaker || info.has(s.speaker)) continue;
    const n = info.size;
    const entry = byLabel.get(s.speaker);
    const mapped = entry?.user_name ?? entry?.name ?? null;
    info.set(s.speaker, { name: mapped ?? "", tone: SPEAKER_TONES[n % SPEAKER_TONES.length]!, mapped: Boolean(mapped), index: n + 1 });
  }
  return info;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const MEDIA_ACCEPT = ".mp4,.mkv,.webm,.mov,.m4v,.m4a,.mp3,.wav,.ogg,.oga,.opus,.flac,.aac,audio/*,video/*";
export const TRANSCRIPT_ACCEPT = ".srt,.vtt,.txt,.docx";
export const FEEDBACK_ACCEPT = ".txt,.md,.docx,.pdf,.srt,.vtt";

export type MeetingFormValue = {
  title: string;
  date: string;
  time: string;
  notes: string;
  language: string;
  studies: { id: string; slug: string; title: string; owner: string | null; members: { id: string; name: string; role: string }[] }[];
  participants: string[];
  decks: { deck_id: string; version_id: string | null }[];
};

export function formDefaults(): MeetingFormValue {
  const { date } = taipeiParts(new Date());
  return { title: "", date, time: "14:00", notes: "", language: "zh-TW", studies: [], participants: [], decks: [] };
}

/** Form value of an existing meeting (edit sheet). */
export function formFrom(d: MeetingDetail): MeetingFormValue {
  const { date, time } = taipeiParts(d.meeting.held_at);
  return {
    title: d.meeting.title, date, time, notes: d.meeting.notes, language: d.meeting.language,
    studies: d.studies.map(s => ({ id: s.id, slug: s.slug, title: s.title, owner: s.owner?.name ?? null, members: s.members.map(m => ({ id: m.id, name: m.name, role: m.role })) })),
    participants: d.participants.map(p => p.id),
    decks: d.decks.map(x => ({ deck_id: x.deck_id, version_id: x.version_id })),
  };
}
