<script lang="ts">
  import { untrack, type Component } from "svelte";
  import { BookOpenText, Brain, ChevronRight, FilePen, FilePlus, FileText, Pencil, ScanEye, Search, Trash2, Workflow } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import AgentMarkdown from "./AgentMarkdown.svelte";
  import ToolTimeline from "./ToolTimeline.svelte";
  import { argsSummary, toolTitle } from "#lib/agent/tools.ts";
  import { CATEGORY_ORDER, currentCall, setTurnOpen, turnOpen, turnSeconds, type ActivityCategory, type AssistantTurn } from "#lib/agent/transcript.ts";
  import type { Streaming } from "#lib/agent/chat.svelte.ts";
  import type { Run, ToolCall } from "#lib/agent/types.ts";

  /**
   * The 「處理過程」 row of one assistant turn: collapsed it is one line (「讀了 7 個章節、看了 3 頁 · 32 秒」, or a live
   * status while the turn works); expanded it is the detailed timeline — reasoning, preambles and tool rows per step.
   * The expand state is remembered per turn for this browser session.
   */
  let { turn, streaming = null, run = null, onDecide }: {
    turn: AssistantTurn;
    streaming?: Streaming | null;
    run?: Run | null;
    onDecide: (call: ToolCall, decision: "approve" | "approve_conversation" | "deny", opts?: { reason?: string; editedArgs?: Record<string, unknown> }) => Promise<void>;
  } = $props();

  // The turn key never changes for a mounted row (it is the each-block key).
  let open = $state(untrack(() => turnOpen(turn.key)));
  function toggle() {
    open = !open;
    setTurnOpen(turn.key, open);
  }
  const uid = $props.id();

  const ICON: Record<ActivityCategory, Component> = { section: BookOpenText, page: ScanEye, search: Search, read: FileText, create: FilePlus, suggest: FilePen, edit: Pencil, delete: Trash2, memory: Brain };
  const cats = $derived(CATEGORY_ORDER.filter((c) => (turn.counts[c] ?? 0) > 0));
  const parts = $derived(cats.map((c) => t(`agent.activity.${c}`, { n: turn.counts[c]! })));

  // Live elapsed time (ticks once a second only while the turn works).
  let now = $state(Date.now());
  $effect(() => {
    if (!turn.live) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const seconds = $derived(turn.live ? (turn.startedAt ? Math.max(0, Math.round((now - new Date(turn.startedAt).getTime()) / 1000)) : null) : turnSeconds(turn));
  const duration = $derived(seconds === null ? "" : seconds >= 60 ? t("agent.activity.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 }) : t("agent.activity.seconds", { s: seconds }));

  // One live line: what the turn is doing right now.
  const status = $derived.by(() => {
    if (!turn.live) return "";
    const input = streaming?.inputs.at(-1);
    if (input) return t("agent.preparing", { tool: input.title });
    const c = currentCall(turn);
    if (c) {
      const detail = argsSummary(c);
      const what = c.summary || toolTitle(c);
      return t("agent.activity.now", { what: detail && !what.includes(detail) ? `${what}〈${detail}〉` : what });
    }
    if (streaming?.text) return t("agent.activity.writing");
    if (turn.plan?.current) return t("agent.activity.now", { what: turn.plan.current });
    return t("agent.thinking");
  });

  // Expanded view: per assistant message, its reasoning, its text (unless it is the shown answer) and its tool rows.
  const shown = $derived(new Set(turn.activity.map((c) => c.id)));
  const planIds = $derived(new Set(turn.calls.filter((c) => c.tool === "update_plan").map((c) => c.id)));
  const stepsView = $derived(
    turn.messages
      .filter((m) => m.role === "assistant")
      .map((m) => ({
        m,
        text: m === turn.final ? "" : m.text.trim(),
        calls: turn.calls.filter((c) => c.message_id === m.id && (shown.has(c.id) || planIds.has(c.id))),
      }))
      .filter((s) => s.text || s.m.reasoning.trim() || s.calls.length),
  );
  let reasoningOpen = $state<Record<string, boolean>>({});
</script>

<div class="activity ml-11" data-turn-activity data-live={turn.live ? "" : undefined}>
  <button
    type="button"
    class="flex min-h-10 w-full items-center gap-2 rounded-xl px-1 text-left text-[13px] text-ink-2 hover:bg-surface-2 focus-visible:bg-surface-2"
    aria-expanded={open}
    aria-controls="turn-{uid}"
    aria-label={`${open ? t("agent.activity.hide") : t("agent.activity.show")}：${turn.live ? status : parts.join("、")}`}
    onclick={toggle}
  >
    <span class="icons flex shrink-0 items-center" aria-hidden="true">
      {#if turn.live}
        <span class="grid size-7 place-items-center rounded-full bg-surface-3"><span class="spin"></span></span>
      {:else if cats.length}
        {#each cats.slice(0, 3) as c (c)}
          {@const Icon = ICON[c]}
          <span class="grid size-7 place-items-center rounded-full border-2 border-canvas bg-surface-3 text-ink-2 [&:not(:first-child)]:-ml-2"><Icon class="size-3.5" /></span>
        {/each}
      {:else}
        <span class="grid size-7 place-items-center rounded-full bg-surface-3 text-ink-2"><Workflow class="size-3.5" /></span>
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      {#if turn.live}
        <span class="live block truncate font-medium" aria-live="polite">{status}</span>
      {:else}
        <span class="line-clamp-2 break-words sm:line-clamp-1">
          <span class="font-medium text-ink">{t("agent.activity.title")}</span>{#if parts.length}<span> · {parts.join("、")}</span>{/if}{#if turn.failed}<span class="text-danger"> · {t("agent.activity.failed", { n: turn.failed })}</span>{/if}{#if turn.denied}<span class="text-ink-3"> · {t("agent.activity.denied", { n: turn.denied })}</span>{/if}
        </span>
      {/if}
    </span>
    {#if turn.live && run && run.step >= 3}<span class="hidden shrink-0 text-[12px] text-ink-3 tabular-nums sm:inline">{t("agent.step", { step: run.step + 1, max: run.max_steps })}</span>{/if}
    {#if duration}<span class="shrink-0 text-[12px] text-ink-3 tabular-nums">{duration}</span>{/if}
    <ChevronRight class="size-3.5 shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none {open ? 'rotate-90' : ''}" />
  </button>

  {#if open}
    <div id="turn-{uid}" class="detail mt-1 mb-1 ml-3.5 flex flex-col gap-1.5 border-l border-line pl-3">
      {#each stepsView as s (s.m.id)}
        {#if s.m.reasoning.trim()}
          <div>
            <button type="button" class="inline-flex min-h-9 items-center gap-1 rounded-full text-[12.5px] text-ink-3 hover:text-ink" aria-expanded={!!reasoningOpen[s.m.id]} onclick={() => (reasoningOpen[s.m.id] = !reasoningOpen[s.m.id])}>
              <ChevronRight class="size-3.5 transition-transform duration-150 motion-reduce:transition-none {reasoningOpen[s.m.id] ? 'rotate-90' : ''}" />{t("agent.activity.thought")}
            </button>
            {#if reasoningOpen[s.m.id]}<p class="mb-1 border-l-2 border-line-2 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{s.m.reasoning}</p>{/if}
          </div>
        {/if}
        {#if s.text}
          <div class="step-text text-[13px] text-ink-2"><AgentMarkdown source={s.text} /></div>
        {/if}
        {#if s.calls.length}<ToolTimeline calls={s.calls} bare indent={false} {onDecide} />{/if}
      {/each}
      {#if turn.live && streaming?.reasoning && !streaming.text}
        <p class="border-l-2 border-line-2 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{streaming.reasoning.slice(-600)}</p>
      {/if}
      {#if turn.live && streaming?.text && streaming.inputs.length}
        <div class="step-text text-[13px] text-ink-2"><AgentMarkdown source={streaming.text} streaming /></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .activity {
    animation: row-in 150ms ease-out;
  }
  @keyframes row-in {
    from {
      opacity: 0;
    }
  }
  .detail {
    animation: open-in 160ms ease-out;
  }
  @keyframes open-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  .step-text :global(p) {
    margin: 0.15em 0;
  }
  .spin {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1.5px solid var(--line-2);
    border-top-color: var(--ink);
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .live {
    background: linear-gradient(90deg, var(--ink-2) 0%, var(--ink-2) 35%, var(--ink) 50%, var(--ink-2) 65%, var(--ink-2) 100%);
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: sweep 1.6s linear infinite;
  }
  @keyframes sweep {
    from {
      background-position: 120% 0;
    }
    to {
      background-position: -100% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .activity,
    .detail {
      animation: none;
    }
    .spin {
      animation: none;
      border-color: var(--ink-3);
      width: 8px;
      height: 8px;
      background: var(--ink-3);
    }
    .live {
      animation: none;
      background: none;
      color: var(--ink-2);
    }
  }
</style>
