/**
 * Object keys of the meetings module (docs/architecture.md "Object keys"). Media sources and transcoded audio reuse the
 * worker's `media_transcode` layout (`media/uploads/<mediaId>/…`, `media/items/<meetingId>/<mediaId>.m4a`); everything
 * else lives under `meetings/<meetingId>/`.
 */
export const meetingKeys = {
  /** Uploaded file, or part 0 of a browser recording (concatenated chunks). Kept as the playback video when allowed. */
  mediaSource: (mediaId: string) => `media/uploads/${mediaId}/source`,
  /** Further recorder sessions of one browser recording (after a reload), concatenated by the worker. */
  mediaPart: (mediaId: string, part: number) => `media/uploads/${mediaId}/part-${part}`,
  mediaUploadPrefix: (mediaId: string) => `media/uploads/${mediaId}/`,
  /** Transcoded audio (24 kHz mono AAC). */
  mediaAudio: (meetingId: string, mediaId: string) => `media/items/${meetingId}/${mediaId}.m4a`,
  mediaAudioPrefix: (meetingId: string) => `media/items/${meetingId}/`,
  /** One MediaRecorder chunk (≈10 s of WebM/Opus); `seq` is zero-padded so keys sort in order. */
  recordingChunk: (meetingId: string, mediaId: string, part: number, seq: number) =>
    `meetings/${meetingId}/rec/${mediaId}/${part}/${String(seq).padStart(6, "0")}.webm`,
  recordingPartPrefix: (meetingId: string, mediaId: string, part: number) => `meetings/${meetingId}/rec/${mediaId}/${part}/`,
  recordingPrefix: (meetingId: string, mediaId: string) => `meetings/${meetingId}/rec/${mediaId}/`,
  transcriptWords: (meetingId: string, transcriptId: string) => `meetings/${meetingId}/transcripts/${transcriptId}/words.json`,
  feedbackFile: (meetingId: string, feedbackId: string) => `meetings/${meetingId}/feedback/${feedbackId}/file`,
  meetingPrefix: (meetingId: string) => `meetings/${meetingId}/`,
};
