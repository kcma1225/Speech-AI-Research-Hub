-- Meetings (M6): cross-study lab meetings with recordings, transcripts, feedback and per-study AI drafts.
-- docs/architecture.md "Meetings".

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  held_at timestamptz NOT NULL,
  -- draft: created, nothing recorded · recorded: media uploaded / converting · processing: transcribing
  -- transcribed: transcript ready · analyzing: AI analysis running or waiting · review: drafts waiting for members
  -- done: every study draft confirmed or dismissed
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','recorded','processing','transcribed','analyzing','review','done')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 20000),
  language text NOT NULL DEFAULT 'zh-TW' CHECK (language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$|^auto$'),
  -- Transcript shown and analysed (the newest asr/upload transcript, else a live one).
  transcript_id uuid,
  -- Last analysis: {other_md, other_evidence[], speaker_guesses[], model, analyzed_at, chunks}
  analysis jsonb,
  analysis_error text,
  transcribe_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  analyze_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_held ON meetings (held_at DESC);

CREATE TABLE meeting_participants (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_participants_user ON meeting_participants (user_id);

CREATE TABLE meeting_studies (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (meeting_id, study_id)
);
CREATE INDEX meeting_studies_study ON meeting_studies (study_id);

CREATE TABLE meeting_decks (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  -- NULL = the deck's active version at the time of the meeting is unknown / any.
  version_id uuid REFERENCES slide_versions(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (meeting_id, deck_id)
);

CREATE TABLE meeting_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- recording: browser MediaRecorder (chunked upload) · upload: an audio/video file
  kind text NOT NULL CHECK (kind IN ('recording','upload')),
  -- recording: chunks arriving · processing: worker extracting/transcoding · ready · failed
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('recording','processing','ready','failed')),
  file_name text NOT NULL DEFAULT '' CHECK (length(file_name) <= 300),
  mime text NOT NULL DEFAULT '',
  bytes bigint NOT NULL DEFAULT 0,
  -- Browser recordings: number of recorder sessions (a reload starts a new part) and the last chunk seq per part.
  parts jsonb NOT NULL DEFAULT '{}',
  has_video boolean NOT NULL DEFAULT false,
  -- Original video kept for playback (media/uploads/<id>/source) when small enough; NULL otherwise.
  video_key text,
  audio_key text,             -- media/items/<meetingId>/<mediaId>.m4a
  duration_sec double precision,
  peaks jsonb,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_media_meeting ON meeting_media (meeting_id, created_at);

CREATE TABLE transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  media_id uuid REFERENCES meeting_media(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('asr','upload','live')),
  language text,
  -- [{id, start, end, text, speaker?}] seconds
  segments jsonb NOT NULL DEFAULT '[]',
  -- [{id:"S1", label}]
  speakers jsonb NOT NULL DEFAULT '[]',
  words_key text,             -- meetings/<meetingId>/transcripts/<id>/words.json
  warnings jsonb NOT NULL DEFAULT '[]',
  model text,
  file_name text,
  duration_sec double precision,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_meeting ON transcripts (meeting_id, created_at DESC);
ALTER TABLE meetings ADD CONSTRAINT meetings_transcript_fk FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE SET NULL;

CREATE TABLE speaker_map (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_label text NOT NULL CHECK (length(speaker_label) BETWEEN 1 AND 40),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, speaker_label)
);

CREATE TABLE meeting_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body_md text NOT NULL DEFAULT '' CHECK (length(body_md) <= 50000),
  file_name text,
  file_key text,              -- meetings/<meetingId>/feedback/<id>/file
  file_text text CHECK (file_text IS NULL OR length(file_text) <= 200000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_feedback_meeting ON meeting_feedback (meeting_id, created_at);

CREATE TABLE meeting_study_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  summary_md text NOT NULL DEFAULT '',
  feedback_md text NOT NULL DEFAULT '',
  -- [{id, title, detail, assignee_id?, due?}]
  proposed_tasks jsonb NOT NULL DEFAULT '[]',
  -- [{start, end, quote}]
  evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  -- ai: written by the analysis · edited: changed by a member since
  origin text NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','edited')),
  edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  task_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, study_id)
);
CREATE INDEX meeting_drafts_study ON meeting_study_drafts (study_id, status);
