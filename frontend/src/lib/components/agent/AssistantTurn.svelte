<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import AskCard from "./AskCard.svelte";
  import MessageItem from "./MessageItem.svelte";
  import PlanChecklist from "./PlanChecklist.svelte";
  import ResultChips from "./ResultChips.svelte";
  import ThinkingLine from "./ThinkingLine.svelte";
  import ToolTimeline from "./ToolTimeline.svelte";
  import TurnActivity from "./TurnActivity.svelte";
  import WorkflowCard from "#lib/components/workflows/WorkflowCard.svelte";
  import WorkflowBatchCard from "#lib/components/workflows/WorkflowBatchCard.svelte";
  import GoalCard from "#lib/components/workflows/GoalCard.svelte";
  import { askArgs } from "#lib/agent/ask.ts";
  import { hasActivity, workflowIdOf, type AssistantTurn } from "#lib/agent/transcript.ts";
  import type { Streaming } from "#lib/agent/chat.svelte.ts";
  import type { Answer, Message, Run, ToolCall } from "#lib/agent/types.ts";

  /**
   * One assistant turn of the compact transcript: the live plan (one checklist), one 「處理過程」 row, the answer, result
   * chips, and only the cards that need the user (workflow cards, consent cards, question cards, notices).
   */
  let { turn, compact = false, streaming = null, run = null, sinceFallback, canRemember = false, conversationId = null, busy = false, deferredAsks = false, focusKey = null, onDecide, onAnswer, onContinue, onRegenerate }: {
    turn: AssistantTurn;
    compact?: boolean;
    streaming?: Streaming | null;
    run?: Run | null;
    sinceFallback: number;
    canRemember?: boolean;
    conversationId?: string | null;
    busy?: boolean;
    /** A later user message exists: open question cards collapse to 「繼續回答」. */
    deferredAsks?: boolean;
    /** Deep-linked card (`toolcall:<id>`, lib/agent/focus.ts): a deferred question card opens in full. */
    focusKey?: string | null;
    onDecide: (call: ToolCall, decision: "approve" | "approve_conversation" | "deny", opts?: { reason?: string; editedArgs?: Record<string, unknown> }) => Promise<void>;
    onAnswer: (call: ToolCall, answers: Answer[]) => Promise<void>;
    onContinue?: () => void;
    /** Set on the latest reply only. */
    onRegenerate?: () => void;
  } = $props();

  const stream = $derived(turn.live && streaming && (!run || streaming.runId === run.id) ? streaming : null);
  // Streamed text is the answer unless the step is also preparing tool calls (then it is a preamble → status row).
  const answerStream = $derived(stream?.text && !stream.inputs.length ? stream.text : "");
  const showRow = $derived(turn.live || hasActivity(turn));
  const finalView = $derived(turn.final ? ({ ...turn.final, reasoning: "" } as Message) : null);
</script>

{#if turn.plan}
  <div class="ml-11"><PlanChecklist plan={turn.plan} live={turn.live} /></div>
{/if}

{#if showRow}
  {#if turn.live && !turn.calls.length && !turn.steps.length && !stream?.inputs.length && !answerStream && !turn.plan}
    <div class="ml-11"><ThinkingLine since={stream?.startedAt ?? sinceFallback} /></div>
  {:else}
    <TurnActivity {turn} streaming={stream} {run} {onDecide} />
  {/if}
{/if}

{#if answerStream}
  <MessageItem message={{ role: "assistant", text: answerStream, reasoning: "", status: "complete", memories: [], kind: null, page_context: null }} streaming />
{/if}

{#if finalView}
  <div data-msg-id={finalView.id} class="scroll-mt-4">
    <MessageItem message={finalView} {canRemember} {conversationId} {onContinue} {busy} {onRegenerate} />
  </div>
{/if}

{#if turn.results.length}<ResultChips calls={turn.results} />{/if}

{#each turn.workflows as c (c.id)}
  {@const id = workflowIdOf(c)}
  {#if id?.startsWith("goal:")}<div class={compact ? "" : "sm:ml-11"}>{#key id}<GoalCard id={id.slice(5)} {compact} />{/key}</div>
  {:else if id?.startsWith("batch:")}<div class={compact ? "" : "sm:ml-11"}>{#key id}<WorkflowBatchCard batchId={id.slice(6)} {compact} {focusKey} />{/key}</div>
  {:else if id}<div class={compact ? "" : "sm:ml-11"}>{#key id}<WorkflowCard {id} {compact} collapsible />{/key}</div>{/if}
{/each}

{#if turn.pending.length}
  <ToolTimeline calls={turn.pending} {compact} {onDecide} />
{/if}

{#each turn.asks as c (c.id)}
  <div class={compact ? "" : "sm:ml-11"} data-focus-key="toolcall:{c.id}">
    <AskCard args={askArgs(c)!} deferred={deferredAsks && focusKey !== `toolcall:${c.id}`} disabled={busy} onSubmit={(a) => onAnswer(c, a)} />
  </div>
{/each}

{#each turn.notices as n (n.id)}
  {#if n.items?.length}
    <!-- A partial run's summary lines up with the workflow card it belongs to. -->
    <div class={compact ? "" : "sm:ml-11"}><MessageItem message={n} {onContinue} /></div>
  {:else}
    <MessageItem message={n} {onContinue} />
  {/if}
{/each}

{#if turn.live && turn.pending.length}
  <p class="sr-only" aria-live="polite">{t("agent.activity.waitingYou")}</p>
{/if}
