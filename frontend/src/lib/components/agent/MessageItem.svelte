<script lang="ts">
  import { Brain, ChevronRight, Copy, Info, Sparkles } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import AgentMarkdown from "./AgentMarkdown.svelte";
  import type { Message } from "#lib/agent/types.ts";

  /** One transcript message. Assistant text is Markdown (remote images off); reasoning is collapsible. */
  let { message, streaming = false, canRemember = false, conversationId = null, onContinue }: {
    message: Pick<Message, "role" | "text" | "reasoning" | "status" | "memories" | "kind" | "page_context"> & { id?: string };
    streaming?: boolean;
    canRemember?: boolean;
    conversationId?: string | null;
    onContinue?: () => void;
  } = $props();
  let showReasoning = $state(false);
  let showMemories = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.text);
      toasts.show(t("agent.copied"), "success");
    } catch {
      // clipboard unavailable
    }
  }
  async function rememberThis() {
    try {
      await api.post("/memories", { content: message.text.trim().slice(0, 300), ...(conversationId ? { conversation_id: conversationId } : {}) });
      toasts.show(t("agent.remembered"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  const noticeKey = $derived(message.kind ? (`agent.notice.${message.kind}` as MessageKey) : null);
</script>

{#if message.role === "user"}
  <div class="group flex justify-end">
    <div class="flex max-w-[min(85%,640px)] flex-col items-end gap-1">
      <div class="rounded-[20px] rounded-br-md bg-ink px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words text-primary-ink">{message.text}</div>
      {#if canRemember && message.text.length <= 300}
        <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[12px] text-ink-3 opacity-100 hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" onclick={rememberThis}>
          <Brain class="size-3.5" />{t("agent.rememberThis")}
        </button>
      {/if}
    </div>
  </div>
{:else if message.role === "assistant"}
  {#if !message.text && message.reasoning && !streaming}
    <!-- A tool step without text: only the reasoning toggle, aligned with the timeline. -->
    <div class="ml-11 -mb-2">
      <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full text-[12.5px] text-ink-3 hover:text-ink" aria-expanded={showReasoning} onclick={() => (showReasoning = !showReasoning)}>
        <ChevronRight class="size-3.5 transition-transform duration-150 {showReasoning ? 'rotate-90' : ''}" />{t("agent.reasoning")}
      </button>
      {#if showReasoning}<p class="mb-2 border-l-2 border-line-2 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{message.reasoning}</p>{/if}
    </div>
  {:else if message.text || message.reasoning || streaming}
    <div class="group flex gap-3">
      <span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full hero-gradient text-hero-ink" aria-hidden="true"><Sparkles class="size-4" /></span>
      <div class="min-w-0 flex-1">
        {#if message.reasoning}
          <button type="button" class="mb-1 inline-flex min-h-8 items-center gap-1 rounded-full text-[12.5px] text-ink-3 hover:text-ink" aria-expanded={showReasoning} onclick={() => (showReasoning = !showReasoning)}>
            <ChevronRight class="size-3.5 transition-transform duration-150 {showReasoning ? 'rotate-90' : ''}" />{t("agent.reasoning")}
          </button>
          {#if showReasoning}<p class="mb-2 border-l-2 border-line-2 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{message.reasoning}</p>{/if}
        {/if}
        {#if message.text}
          <AgentMarkdown source={message.text} {streaming} />
        {/if}
        <div class="mt-1 flex flex-wrap items-center gap-1.5">
          {#if message.status === "cancelled"}<span class="rounded-full bg-surface-3 px-2 py-0.5 text-[11.5px] text-ink-3">{t("agent.stopped")}</span>{/if}
          {#if message.memories.length}
            <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full bg-[var(--pill-lilac)] px-2.5 text-[12px] font-medium text-[var(--pill-lilac-ink)]" aria-expanded={showMemories} onclick={() => (showMemories = !showMemories)}>
              <Brain class="size-3.5" />{t("agent.memoryUsed", { n: message.memories.length })}
            </button>
          {/if}
          {#if !streaming && message.text}
            <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 opacity-100 hover:bg-surface-3 hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" aria-label={t("agent.copy")} onclick={copy}><Copy class="size-3.5" /></button>
          {/if}
        </div>
        {#if showMemories}
          <ul class="mt-1.5 flex flex-col gap-1 rounded-2xl border border-line bg-surface-2 p-3 text-[12.5px] text-ink-2" aria-label={t("agent.memoryUsedTitle")}>
            {#each message.memories as m (m.id)}<li>· {m.content}</li>{/each}
            <li class="mt-1"><a class="underline decoration-line-2 underline-offset-2 hover:text-ink" href="/settings?tab=assistant">{t("agent.memoryManage")}</a></li>
          </ul>
        {/if}
      </div>
    </div>
  {/if}
{:else if message.role === "notice"}
  <div class="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-dashed border-line-2 px-4 py-3 text-center text-[13px] text-ink-2" role="note">
    <Info class="size-4 text-ink-3" /><span>{noticeKey ? t(noticeKey) : message.text}</span>
    {#if onContinue && message.kind?.startsWith("limit_")}<button type="button" class="inline-flex min-h-8 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-primary-ink" onclick={onContinue}>{t("agent.continue")}</button>{/if}
  </div>
{:else if message.role === "compaction"}
  <p class="flex items-center justify-center gap-2 text-center text-[12px] text-ink-3"><span class="h-px w-8 bg-line-2"></span>{t("agent.compacted")}<span class="h-px w-8 bg-line-2"></span></p>
{/if}
