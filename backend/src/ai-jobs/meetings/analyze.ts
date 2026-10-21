/**
 * `ai_meeting_analyze` (ai-worker, role `analysis`): splits a meeting into per-study drafts (summary, professor feedback,
 * proposed tasks with assignees from THAT study's members, evidence timestamps) plus a 「其他」 section and speaker guesses.
 * Structured output (json_schema → json_object → plain, degrading on `bad_request`), zod validation and one repair retry.
 * Long transcripts are map-reduced (windows checkpointed, so a retry skips finished windows).
 * Stages: context → mapping → analyzing → saving → done (`waiting_llm` while `analysis` is unavailable).
 */
import { transaction } from "../../db.js";
import { AiJobInputError, type AiJobContext } from "../../ai-worker/registry.js";
import { isAiError } from "../../ai/errors.js";
import type { ChatMessage, JsonSchema, ReasoningOptions, ResponseFormat } from "../../ai/types.js";
import {
  buildRefs, FINAL_SCHEMA, finalMessages, MAP_SCHEMA, MAP_THRESHOLD_CHARS, MAP_WINDOW_CHARS, mapMessages, mapNotesToLines,
  parseFinal, parseMap, REPAIR_PROMPT, toResult, transcriptLines, windows,
} from "../../lib/meetings/analysis.js";
import { loadAnalysisInput, saveAnalysis } from "../../lib/meetings/context.js";
import type { AnalyzePayload } from "../../lib/meetings/media.js";
import { findMeeting, meetingUrl, refreshStatus } from "../../lib/meetings/store.js";
import { notifyFromJob } from "./notify.js";

export type AnalyzeResult = { drafts: number; tasks: number; chunks: number; model: string | null; repaired: boolean; warnings: number };
type Checkpoint = { map?: Record<string, string[]>; format?: number };

const FORMATS = (name: string, schema: JsonSchema): (ResponseFormat | undefined)[] => [
  { type: "json_schema", name, schema, strict: false },
  { type: "json_object" },
  undefined,
];

/** One structured call: degrades the response format on `bad_request`, repairs invalid JSON once. */
async function callJson<T>(
  ctx: AiJobContext<AnalyzePayload>,
  state: { format: number; model: string | null; repaired: boolean },
  messages: ChatMessage[],
  name: string,
  schema: JsonSchema,
  parser: (text: string) => T,
  maxTokens: number,
): Promise<T> {
  const formats = FORMATS(name, schema);
  const call = async (msgs: ChatMessage[]) => {
    // Extraction needs little thinking: ask for low effort. Reasoning models may still think for thousands of tokens
    // (counted in max_tokens) and return no text: retry once with thinking off and twice the budget.
    let reasoning: ReasoningOptions = { effort: "low" };
    let budget = maxTokens;
    for (;;) {
      try {
        const r = await ctx.ai.chat("analysis", { messages: msgs, maxTokens: budget, temperature: 0.2, reasoning, responseFormat: formats[state.format] }, { jobId: ctx.job.id, userId: ctx.job.payload.userId ?? undefined, signal: ctx.signal });
        if (r.route) state.model = `${r.route.providerKind}/${r.route.model}`;
        if (!r.text.trim() && r.stopReason === "max_tokens" && reasoning.enabled !== false) {
          ctx.log.warn({ jobId: ctx.job.id, usage: r.usage }, "analysis reply empty (reasoning used the budget); retrying without thinking");
          reasoning = { enabled: false, effort: "none" };
          budget = Math.min(32_000, maxTokens * 2);
          continue;
        }
        return r.text;
      } catch (e) {
        if (isAiError(e) && e.code === "bad_request" && state.format < formats.length - 1) {
          state.format++;
          continue;
        }
        throw e;
      }
    }
  };
  const text = await call(messages);
  try {
    return parser(text);
  } catch (error) {
    state.repaired = true;
    const fixed = await call([...messages, { role: "assistant", content: text.slice(0, 8000) || "（空白）" }, { role: "user", content: REPAIR_PROMPT(String((error as Error).message ?? error)) }]);
    try {
      return parser(fixed);
    } catch {
      // Retryable by the runner; on the last attempt fail with a message the user can act on.
      if (ctx.job.attempts >= ctx.job.maxAttempts) throw new AiJobInputError("AI 回覆的格式不正確，請按「重新分析」再試一次。");
      throw new Error("AI 回覆的格式不正確，稍後會重試。");
    }
  }
}

export async function runAnalyze(ctx: AiJobContext<AnalyzePayload>, opts: { mapThreshold?: number; windowChars?: number } = {}): Promise<AnalyzeResult> {
  const { meetingId } = ctx.job.payload;
  const meeting = await findMeeting(ctx.db, meetingId);
  if (!meeting) throw new AiJobInputError("會議已被刪除。");
  await ctx.progress("context", 3);
  const input = await loadAnalysisInput(ctx.db, meeting);
  if (!input.studies.length) throw new AiJobInputError("會議沒有選擇研究，無法拆分草稿。");
  if (!input.segments.length && !input.feedback.length) throw new AiJobInputError("還沒有逐字稿或回饋可以分析。");
  const refs = buildRefs(input);
  const lines = transcriptLines(input, refs);
  const checkpoint: Checkpoint = (ctx.checkpoint as Checkpoint | null) ?? {};
  const state = { format: checkpoint.format ?? 0, model: null as string | null, repaired: false };

  let messages: ChatMessage[];
  let chunks = 1;
  if (lines.join("\n").length > (opts.mapThreshold ?? MAP_THRESHOLD_CHARS)) {
    const parts = windows(lines, opts.windowChars ?? MAP_WINDOW_CHARS);
    chunks = parts.length;
    const notes: Record<string, string[]> = { ...(checkpoint.map ?? {}) };
    for (const [i, part] of parts.entries()) {
      if (notes[String(i)]) continue;
      await ctx.progress("mapping", Math.round(5 + (i / parts.length) * 60));
      const out = await callJson(ctx, state, mapMessages(input, refs, part, i, parts.length), "meeting_notes", MAP_SCHEMA, parseMap, 6000);
      notes[String(i)] = mapNotesToLines(out);
      await ctx.saveCheckpoint({ map: notes, format: state.format } satisfies Checkpoint);
    }
    messages = finalMessages(input, refs, { notes: parts.flatMap((_, i) => notes[String(i)] ?? []) });
  } else {
    messages = finalMessages(input, refs, { transcript: lines });
  }

  await ctx.progress("analyzing", chunks > 1 ? 70 : 20);
  const final = await callJson(ctx, state, messages, "meeting_drafts", FINAL_SCHEMA, parseFinal, 12_000);
  const result = toResult(final, input, refs);

  await ctx.progress("saving", 95);
  const recipients = await transaction(ctx.db, async client => {
    const locked = await client.query("SELECT 1 FROM meetings WHERE id=$1 FOR UPDATE", [meetingId]);
    if (!locked.rowCount) throw new AiJobInputError("會議已被刪除。");
    await saveAnalysis(client, meetingId, result, { model: state.model, chunks });
    // This job's row is still `running`: do not count it as an active analysis.
    await refreshStatus(client, meetingId, { finishingJobId: ctx.job.id });
    const withContent = result.drafts.filter(d => d.summary_md || d.feedback_md || d.tasks.length).map(d => d.studyId);
    if (!withContent.length) return [];
    return (await client.query<{ user_id: string }>(
      `SELECT DISTINCT sm.user_id FROM study_members sm JOIN meeting_study_drafts d ON d.study_id=sm.study_id AND d.meeting_id=$1
        WHERE sm.study_id = ANY($2) AND sm.role IN ('owner','member') AND d.status='pending'`,
      [meetingId, withContent],
    )).rows.map(r => r.user_id);
  });
  await notifyFromJob(ctx.db, recipients, { kind: "meeting", title: "會議草稿待確認", body: `${meeting.title}：AI 已整理各研究的摘要與待辦`, url: meetingUrl(meetingId) }, "tasks");
  await ctx.progress("done", 100);
  return {
    drafts: result.drafts.length,
    tasks: result.drafts.reduce((n, d) => n + d.tasks.length, 0),
    chunks,
    model: state.model,
    repaired: state.repaired,
    warnings: result.warnings.length,
  };
}
