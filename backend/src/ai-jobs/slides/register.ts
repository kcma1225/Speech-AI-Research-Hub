/** Registers the slides module's ai-worker jobs (imported once from src/ai-worker/handlers.ts). */
import { registerAiJob } from "../../ai-worker/registry.js";
import { runSlidesGenerate, SLIDES_GENERATE_JOB, type SlidesGeneratePayload } from "./generate.js";

registerAiJob<SlidesGeneratePayload>(SLIDES_GENERATE_JOB, {
  roles: ["slides"],
  concurrency: 2,
  timeoutMs: 20 * 60_000,
  run: ctx => runSlidesGenerate(ctx, { storage: ctx.storage }),
});
