/** Registers the slides module's ai-worker jobs (imported once from src/ai-worker/handlers.ts). */
import { isAiError } from "../../ai/errors.js";
import { isLlmUnavailable, isPlatformError } from "../../ai/platform/errors.js";
import { AiJobInputError, registerAiJob } from "../../ai-worker/registry.js";
import { notifyDraft, runSlidesGenerate, SLIDES_GENERATE_JOB, type SlidesGeneratePayload } from "./generate.js";

registerAiJob<SlidesGeneratePayload>(SLIDES_GENERATE_JOB, {
  roles: ["slides"],
  concurrency: 2,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    try {
      return await runSlidesGenerate(ctx, { storage: ctx.storage });
    } catch (e) {
      // Tell the user when this is the final failure (not a pause for the model, a cancel, or a pending retry).
      const final = !ctx.signal.aborted && !isLlmUnavailable(e) && (e instanceof AiJobInputError || (isAiError(e) && !e.retryable) || isPlatformError(e) || ctx.job.attempts >= ctx.job.maxAttempts);
      if (final) {
        const error = e instanceof AiJobInputError ? e.message : isAiError(e) ? e.message_zh : isPlatformError(e) ? e.message_zh : "處理時發生錯誤。";
        await notifyDraft(ctx.db, ctx.job.payload, { ok: false, error }).catch(() => undefined);
      }
      throw e;
    }
  },
});
