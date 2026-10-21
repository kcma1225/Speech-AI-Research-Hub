/**
 * `ai_workflow` (ai-worker): advances one workflow run (src/workflows/engine.ts) until it waits for the user or ends.
 * Tools of the assistant are registered here too (the engine's researchers use the same read tools), with an app shim:
 * db / storage / log / notifier / config, no collab server (live documents are read from their stored state).
 */
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config.js";
import { Notifier } from "../../lib/notify.js";
import { registerAiJob } from "../../ai-worker/registry.js";
import { runWorkflow } from "../../workflows/engine.js";
import { platformPort } from "../../workflows/llm.js";
import { WORKFLOW_JOB, type WorkflowJobPayload } from "../../workflows/jobs.js";
import "../../agent/tools/index.js";
import "../../lib/slides/agent-tools.js";
import "../../lib/meetings/agent-tools.js";
import "../../lib/latex-projects/agent-tools.js";
import "../../lib/search/agent.js";
import "../../workflows/playbooks/index.js";

let shim: FastifyInstance | null = null;

registerAiJob<WorkflowJobPayload>(WORKFLOW_JOB, {
  roles: ["assistant"],
  concurrency: 2,
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    if (!ctx.job.payload?.workflowId) return { status: "missing" };
    if (!shim) {
      const config = loadConfig();
      shim = { db: ctx.db, storage: ctx.storage, log: ctx.log, config, notifier: new Notifier(ctx.db, ctx.log as never, config) } as unknown as FastifyInstance;
    }
    return runWorkflow(
      { db: ctx.db, storage: ctx.storage, app: shim, model: platformPort(ctx.ai), platform: ctx.ai, log: ctx.log, signal: ctx.signal, jobId: ctx.job.id, progress: ctx.progress },
      ctx.job.payload.workflowId,
      { lastAttempt: ctx.job.attempts >= ctx.job.maxAttempts },
    );
  },
});
