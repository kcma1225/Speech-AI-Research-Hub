import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JobInputError, tail, throwIfAborted } from "../errors.js";
import { ProgressParser, hasVideoStream, parseDuration, progressPercent, streamTypesArgs, transcodeArgs } from "../ffmpeg.js";
import { PeakAccumulator, peakArgs } from "../peaks.js";
import { run } from "../process.js";
import { STAGES, type MediaTranscodeResult } from "../types.js";
import type { Handler, HandlerContext } from "./context.js";

const payloadSchema = z.object({
  itemId: z.uuid(),
  sourceKey: z.string().regex(/^media\/uploads\/[0-9a-f-]{36}\/source$/),
  outputKey: z.string().regex(/^media\/items\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.m4a$/),
  fileName: z.string().max(500),
  /** Further recorder parts (`media/uploads/<id>/part-<n>`), concatenated after `sourceKey`. */
  extraSourceKeys: z.array(z.string().regex(/^media\/uploads\/[0-9a-f-]{36}\/part-\d{1,3}$/)).max(50).optional(),
  /** Keep `sourceKey` when it contains video (playback copy). */
  keepSource: z.boolean().optional(),
});

const TRANSCODE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PEAKS_TIMEOUT_MS = 10 * 60 * 1000;

export const mediaTranscode: Handler = async (raw, context) => {
  const { storage, signal, workDir, progress, log } = context;
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) throw new JobInputError("工作內容不正確。");
  const { sourceKey, outputKey, extraSourceKeys = [], keepSource = false } = payload.data;
  const sources = [sourceKey, ...extraSourceKeys];
  const inputs = sources.map((_, i) => path.join(workDir, i === 0 ? "source" : `part-${i}`));
  const output = path.join(workDir, "output.m4a");

  progress(STAGES.analyze, 0);
  for (const [i, key] of sources.entries()) {
    await storage.download(key, inputs[i]!, signal);
    throwIfAborted(signal);
  }

  let durationSeconds: number | null = 0;
  for (const input of inputs) {
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], {
      timeoutMs: 30_000,
      signal,
      keepLog: 2000,
    });
    const d = probe.code === 0 ? parseDuration(probe.log) : null;
    durationSeconds = d === null || durationSeconds === null ? null : durationSeconds + d;
  }
  if (durationSeconds === 0) durationSeconds = null;
  const streams = await run("ffprobe", streamTypesArgs(inputs[0]!), { timeoutMs: 30_000, signal, keepLog: 4000 });
  const hasVideo = streams.code === 0 && hasVideoStream(streams.log);
  if (streams.code === 0 && !/^audio\b/m.test(streams.log)) throw new JobInputError(hasVideo ? "影片中沒有音軌。" : "媒體檔沒有可用的音訊。");

  progress(STAGES.transcode, 0);
  const parser = new ProgressParser();
  let last = -1;
  const result = await run("ffmpeg", transcodeArgs(inputs.length > 1 ? inputs : inputs[0]!, output), {
    timeoutMs: TRANSCODE_TIMEOUT_MS,
    signal,
    onStdout: chunk => {
      const seconds = parser.push(chunk);
      const percent = seconds === null ? null : progressPercent(seconds, durationSeconds);
      if (percent !== null && percent > last) {
        last = percent;
        progress(STAGES.transcode, percent);
      }
    },
  });
  if (result.timedOut) throw new JobInputError("轉碼逾時。");
  if (result.code !== 0) {
    log.info({ log: tail(result.log, 1000) }, "ffmpeg failed");
    throw new JobInputError("無法解析媒體檔。");
  }
  const { size } = await stat(output);
  // Browser recordings (streamed WebM) carry no duration: measure the transcoded file instead.
  if (durationSeconds === null) {
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", output], { timeoutMs: 30_000, signal, keepLog: 2000 });
    durationSeconds = probe.code === 0 ? parseDuration(probe.log) : null;
  }
  if (size === 0) throw new JobInputError("媒體檔沒有可用的音訊。");
  const peaks = await computePeaks(output, context);

  progress(STAGES.upload, 96);
  await storage.uploadFile(outputKey, output, "audio/mp4", signal);
  throwIfAborted(signal);
  // The uploads are no longer needed (except a video kept for playback); a failed delete must not fail the job.
  const keptSource = keepSource && hasVideo;
  for (const key of keptSource ? extraSourceKeys : sources) {
    await storage.delete(key).catch(error => log.warn({ err: error, key }, "could not delete media upload"));
  }
  progress(STAGES.done, 100);
  return { outputKey, bytes: size, durationSeconds, ...(peaks ? { peaks } : {}), hasVideo, keptSource } satisfies MediaTranscodeResult;
};

/**
 * Waveform peaks of the transcoded audio, decoded through a pipe and bucketed while streaming
 * (recordings can be hours long). Best effort: any failure other than an abort is logged and yields
 * undefined, so the job still succeeds without peaks.
 */
async function computePeaks(file: string, { signal, log }: HandlerContext): Promise<number[] | undefined> {
  const peaks = new PeakAccumulator();
  try {
    const result = await run("ffmpeg", peakArgs(file), {
      timeoutMs: PEAKS_TIMEOUT_MS,
      signal,
      keepLog: 2000,
      onStdoutData: chunk => peaks.push(chunk),
    });
    if (result.timedOut || result.code !== 0) {
      log.warn({ code: result.code, timedOut: result.timedOut, log: tail(result.log, 1000) }, "waveform peaks failed; continuing without them");
      return undefined;
    }
    const values = peaks.finish();
    return values.length ? values : undefined;
  } catch (error) {
    throwIfAborted(signal);
    log.warn({ err: error }, "waveform peaks failed; continuing without them");
    return undefined;
  }
}

/** Removes partial output after cancel/failure; the finalizer deletes the upload itself. */
export async function cleanupMedia(raw: unknown, remove: (key: string) => Promise<void>) {
  const payload = payloadSchema.safeParse(raw);
  if (payload.success) await remove(payload.data.outputKey);
}
