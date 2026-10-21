/** Registers the meetings module's ai-worker jobs (imported once from src/ai-worker/handlers.ts). */
import { registerAiJob } from "../../ai-worker/registry.js";
import { ANALYZE_JOB, TRANSCRIBE_JOB, type AnalyzePayload, type TranscribePayload } from "../../lib/meetings/media.js";
import { runAnalyze } from "./analyze.js";
import { runTranscribe } from "./transcribe.js";

registerAiJob<TranscribePayload>(TRANSCRIBE_JOB, { roles: ["asr"], concurrency: 1, timeoutMs: 3 * 60 * 60_000, run: ctx => runTranscribe(ctx) });
registerAiJob<AnalyzePayload>(ANALYZE_JOB, { roles: ["analysis"], concurrency: 2, timeoutMs: 30 * 60_000, run: ctx => runAnalyze(ctx) });
