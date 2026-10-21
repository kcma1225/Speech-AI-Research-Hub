import { t } from "#lib/i18n.svelte.ts";
import type { MessageKey } from "#lib/messages.ts";
import type { AiDraftJob } from "#lib/slides/types.ts";

const STAGES = ["context", "generating", "continuing", "writing", "validating", "fixing", "visual_check", "publishing", "waiting_llm", "queued", "starting", "done"];

/** 繁中/English label of an `ai_slides_generate` stage (unknown stages are shown as they are). */
export const draftStageLabel = (stage: string | null | undefined) =>
  stage && STAGES.includes(stage) ? t(`slides.editor.ai.stage.${stage}` as MessageKey) : (stage ?? "");

export const draftRunning = (job: AiDraftJob | null | undefined) => job?.status === "queued" || job?.status === "running";
