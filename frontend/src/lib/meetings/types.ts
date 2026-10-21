/** Meetings API types (backend routes/meetings*.ts, docs/architecture.md "Meetings"). */
import type { Role } from "#lib/types.ts";

export type MeetingStatus = "draft" | "recorded" | "processing" | "transcribed" | "analyzing" | "review" | "done";
export type DraftStatus = "pending" | "confirmed" | "dismissed";

export type MeetingCard = {
  id: string;
  title: string;
  held_at: string;
  status: MeetingStatus;
  created_by: string | null;
  creator_name: string | null;
  has_transcript: boolean;
  duration_sec: number | null;
  media_count: number;
  studies: { id: string; slug: string; title: string; owner: { id: string; name: string } | null; draft_status: DraftStatus | null }[];
  participants: { id: string; name: string; role: Role }[];
  drafts: { pending: number; confirmed: number; dismissed: number };
  /** List rows: the caller may delete it (creator, or owner/member of a linked study). */
  can_delete?: boolean;
};

export type Segment = { id: number; start: number; end: number; text: string; speaker?: string | null };

export type Media = {
  id: string;
  kind: "recording" | "upload";
  status: "recording" | "processing" | "ready" | "failed";
  file_name: string;
  mime: string;
  bytes: number;
  has_video: boolean;
  has_audio: boolean;
  duration_sec: number | null;
  peaks: number[] | null;
  error: string | null;
  parts: number;
  created_by: string | null;
  created_at: string;
  audio_url: string | null;
  video_url: string | null;
};

export type Transcript = {
  id: string;
  source: "asr" | "upload" | "live";
  language: string | null;
  segments: Segment[];
  speakers: { id: string; label: string | null }[];
  warnings: string[];
  model: string | null;
  file_name: string | null;
  duration_sec: number | null;
  media_id: string | null;
  created_at: string;
  has_words: boolean;
};

export type TranscriptMeta = { id: string; source: Transcript["source"]; language: string | null; model: string | null; file_name: string | null; duration_sec: number | null; created_at: string; segment_count: number };
export type SpeakerMapEntry = { speaker_label: string; user_id: string | null; name: string | null; user_name: string | null };
export type ProposedTask = { id: string; title: string; detail: string; assignee_id: string | null; due: string | null };
export type Evidence = { start: number; end: number; quote: string };

export type Draft = {
  id: string;
  study_id: string;
  study_slug: string;
  study_title: string;
  summary_md: string;
  feedback_md: string;
  proposed_tasks: ProposedTask[];
  evidence: Evidence[];
  status: DraftStatus;
  origin: "ai" | "edited";
  edited_by_name: string | null;
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  note_id: string | null;
  task_ids: string[];
  updated_at: string;
  can_edit: boolean;
};

export type Feedback = {
  id: string;
  author_id: string | null;
  author_name: string | null;
  author_role: Role | null;
  body_md: string;
  file_name: string | null;
  has_file: boolean;
  has_text: boolean;
  file_url: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
};

export type JobInfo = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; stage: string; progress: number; error: string | null; run_after: string; attempts: number } | null;

export type MeetingStudy = {
  id: string;
  slug: string;
  title: string;
  status: string;
  current_stage: string | null;
  owner: { id: string; name: string } | null;
  members: { id: string; name: string; role: "owner" | "member" | "advisor"; account_role: Role }[];
  can_edit: boolean;
};

export type MeetingDetail = {
  meeting: { id: string; title: string; held_at: string; status: MeetingStatus; notes: string; language: string; created_by: string | null; creator_name: string | null; created_at: string; updated_at: string; transcript_id: string | null };
  studies: MeetingStudy[];
  participants: { id: string; name: string; role: Role }[];
  decks: { deck_id: string; title: string; slug: string; kind: string; study_id: string; version_id: string | null; version: number | null }[];
  media: Media[];
  transcript: Transcript | null;
  transcripts: TranscriptMeta[];
  speaker_map: SpeakerMapEntry[];
  feedback: Feedback[];
  drafts: Draft[];
  analysis: { other_md?: string; speaker_guesses?: { label: string; user_id: string | null; name: string | null; reason: string }[]; model?: string | null; analyzed_at?: string; error?: string | null } | null;
  jobs: { transcribe: JobInfo; analyze: JobInfo };
  permissions: { edit: boolean; delete: boolean; feedback: boolean; studies: string[] };
};

export type DeckOption = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  study_id: string;
  study_title: string;
  active_version_id: string | null;
  versions: { id: string; version: number; status: string; published_at: string | null }[];
};
