-- UI support for the SvelteKit app: per-user locale and preferences, slide thumbnails, audio waveform peaks.
ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'zh-TW' CHECK (locale IN ('zh-TW','en'));
-- Validated by backend/src/lib/preferences.ts; missing keys mean the default.
ALTER TABLE users ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';
-- Full S3 key `<output_prefix>thumbnail.png` (960x540 PNG of the first slide); NULL when the render produced none.
ALTER TABLE slide_versions ADD COLUMN thumbnail_key text;
-- Waveform peaks of the current audio: JSON array of numbers in [0,1]; NULL when unknown or no audio.
ALTER TABLE items ADD COLUMN audio_peaks jsonb CHECK (audio_peaks IS NULL OR jsonb_typeof(audio_peaks) = 'array');
