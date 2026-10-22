<script lang="ts">
  import { tick } from "svelte";
  import { DropdownMenu } from "bits-ui";
  import { Brain, ChevronLeft, ChevronRight, Copy, Ellipsis, Info, ListChecks, Pencil, RotateCcw, Sparkles } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { hasMessage, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import AgentMarkdown from "./AgentMarkdown.svelte";
  import AskCard from "./AskCard.svelte";
  import MessageAttachments from "./attach/MessageAttachments.svelte";
  import { answerLabel } from "#lib/agent/ask.ts";
  import type { Answer, AskArgs, Message } from "#lib/agent/types.ts";

  /**
   * One transcript message. Assistant text is Markdown (remote images off); reasoning is collapsible.
   * User messages: 編輯 (inline; resubmits from here), 複製, ‹ 1/2 › between versions — on hover/focus on desktop, via
   * ⋯ or a long press on phones. Answers to a question card render as a compact summary with 「修改答案」.
   */
  let { message, streaming = false, canRemember = false, conversationId = null, onContinue, ask = null, busy = false, onEdit, onEditAnswers, onRegenerate, onSwitch }: {
    message: Pick<Message, "role" | "text" | "reasoning" | "status" | "memories" | "kind" | "page_context"> & { id?: string; answers?: Message["answers"]; versions?: string[] | null; attachments?: Message["attachments"] };
    streaming?: boolean;
    canRemember?: boolean;
    conversationId?: string | null;
    onContinue?: () => void;
    /** The questions an answer message answers. */
    ask?: AskArgs | null;
    /** A reply is being generated (editing waits). */
    busy?: boolean;
    onEdit?: (text: string) => Promise<boolean>;
    onEditAnswers?: (answers: Answer[]) => Promise<boolean>;
    /** Latest assistant reply only. */
    onRegenerate?: () => void;
    onSwitch?: (messageId: string) => void;
  } = $props();
  let showReasoning = $state(false);
  let showMemories = $state(false);
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let menuOpen = $state(false);
  let editor = $state<HTMLTextAreaElement | null>(null);

  const versionIndex = $derived(message.versions && message.id ? message.versions.indexOf(message.id) : -1);
  async function startEdit() {
    draft = message.text;
    editing = true;
    await tick();
    editor?.focus();
    editor?.setSelectionRange(draft.length, draft.length);
  }
  async function saveEdit() {
    const value = draft.trim();
    if (!value || !onEdit || saving) return;
    if (value === message.text.trim()) {
      editing = false;
      return;
    }
    saving = true;
    try {
      if (await onEdit(value)) editing = false;
    } finally {
      saving = false;
    }
  }
  function editKeys(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      editing = false;
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void saveEdit();
    }
  }
  // Long press on a phone opens the ⋯ menu.
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  function pressStart(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    pressTimer = setTimeout(() => {
      menuOpen = true;
      navigator.vibrate?.(10);
    }, 500);
  }
  function pressEnd() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }

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

{#snippet versionSwitch()}
  {#if message.versions && versionIndex >= 0 && onSwitch}
    <div class="inline-flex items-center text-[12px] text-ink-3 tabular-nums" role="group" aria-label={t("agent.versions")}>
      <button type="button" class="grid size-8 place-items-center rounded-full hover:bg-surface-3 hover:text-ink disabled:opacity-40" disabled={versionIndex === 0 || busy} aria-label={t("agent.versionPrev")} onclick={() => onSwitch?.(message.versions![versionIndex - 1]!)}><ChevronLeft class="size-3.5" /></button>
      <span aria-live="polite">{versionIndex + 1} / {message.versions.length}</span>
      <button type="button" class="grid size-8 place-items-center rounded-full hover:bg-surface-3 hover:text-ink disabled:opacity-40" disabled={versionIndex === message.versions.length - 1 || busy} aria-label={t("agent.versionNext")} onclick={() => onSwitch?.(message.versions![versionIndex + 1]!)}><ChevronRight class="size-3.5" /></button>
    </div>
  {/if}
{/snippet}

{#if message.role === "user" && message.answers && ask}
  {@const answers = message.answers.answers}
  <div class="group flex justify-end">
    <div class="flex w-full max-w-[min(92%,560px)] flex-col items-end gap-1">
      {#if editing}
        <div class="w-full"><AskCard args={ask} initial={answers} editing disabled={busy} onCancel={() => (editing = false)} onSubmit={async (a) => { if (onEditAnswers && (await onEditAnswers(a))) editing = false; }} /></div>
      {:else}
        <div class="w-full rounded-[20px] rounded-br-md border border-line bg-surface-2 px-4 py-3">
          <p class="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-3"><ListChecks class="size-3.5" />{t("agent.ask.yourAnswers")}</p>
          <dl class="flex flex-col gap-1.5 text-[13.5px]">
            {#each ask.questions as q (q.id)}
              {@const a = answers.find((x) => x.id === q.id)}
              <div class="flex flex-col"><dt class="text-[12px] text-ink-3">{q.prompt}</dt><dd class="break-words {a?.skipped || !a ? 'text-ink-3 italic' : 'text-ink'}">{answerLabel(q, a)}</dd></div>
            {/each}
          </dl>
        </div>
        <div class="flex items-center gap-0.5">
          {@render versionSwitch()}
          {#if onEditAnswers}<button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40" disabled={busy} onclick={() => (editing = true)}><Pencil class="size-3.5" />{t("agent.ask.changeAnswers")}</button>{/if}
        </div>
      {/if}
    </div>
  </div>
{:else if message.role === "user"}
  <div class="group flex justify-end">
    <div class="flex max-w-[min(85%,640px)] flex-col items-end gap-1 {editing ? 'w-full' : ''}">
      {#if editing}
        <div class="w-full rounded-[20px] border border-line-2 bg-popover p-2.5 shadow-pop">
          <Textarea bind:value={draft} bind:ref={editor} rows={3} maxlength={20000} aria-label={t("agent.editMessage")} onkeydown={editKeys} class="[&_textarea]:border-0 [&_textarea]:bg-transparent" />
          <p class="px-1 pt-1 text-[11.5px] text-ink-3">{t("agent.editHint")}</p>
          <div class="flex justify-end gap-2 pt-1.5">
            <Button size="sm" variant="ghost" onclick={() => (editing = false)}>{t("action.cancel")}</Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!draft.trim() || busy} onclick={() => void saveEdit()}>{t("agent.resend")}</Button>
          </div>
        </div>
      {:else}
        {#if message.attachments?.length}<MessageAttachments items={message.attachments} />{/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="rounded-[20px] rounded-br-md bg-surface-3 px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text [-webkit-touch-callout:none]" onpointerdown={pressStart} onpointerup={pressEnd} onpointercancel={pressEnd} onpointerleave={pressEnd}>{message.text}</div>
        <div class="flex items-center gap-0.5">
          {@render versionSwitch()}
          <!-- Desktop: hover / focus actions. -->
          <div class="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(pointer:fine)]:flex">
            {#if onEdit}<button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40" disabled={busy} aria-label={t("agent.edit")} title={t("agent.edit")} onclick={startEdit}><Pencil class="size-3.5" /></button>{/if}
            <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("agent.copy")} title={t("agent.copy")} onclick={copy}><Copy class="size-3.5" /></button>
            {#if canRemember && message.text.length <= 300}
              <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[12px] text-ink-3 hover:text-ink" onclick={rememberThis}><Brain class="size-3.5" />{t("agent.rememberThis")}</button>
            {/if}
          </div>
          <!-- Touch: ⋯ menu (also opened by a long press on the bubble). -->
          <DropdownMenu.Root bind:open={menuOpen}>
            <DropdownMenu.Trigger class="grid size-10 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink [@media(pointer:fine)]:hidden" aria-label={t("agent.messageActions")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-48">
                {#if onEdit}<DropdownMenu.Item class={menuItem} disabled={busy} onSelect={startEdit}><Pencil />{t("agent.edit")}</DropdownMenu.Item>{/if}
                <DropdownMenu.Item class={menuItem} onSelect={copy}><Copy />{t("agent.copy")}</DropdownMenu.Item>
                {#if canRemember && message.text.length <= 300}<DropdownMenu.Item class={menuItem} onSelect={rememberThis}><Brain />{t("agent.rememberThis")}</DropdownMenu.Item>{/if}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
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
            <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-focus-within:opacity-100 [@media(pointer:fine)]:group-hover:opacity-100" aria-label={t("agent.copy")} title={t("agent.copy")} onclick={copy}><Copy class="size-3.5" /></button>
          {/if}
          {#if !streaming && onRegenerate}
            <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[12px] text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40" disabled={busy} onclick={onRegenerate}><RotateCcw class="size-3.5" />{t("agent.regenerate")}</button>
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
  {#if message.kind?.startsWith("workflow_") || message.kind?.startsWith("goal_")}
    <!-- Workflow status: the card above carries the details; one quiet line. -->
    <p class="flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-3" role="note"><Info class="size-3.5" />{message.text}</p>
  {:else}
  <div class="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-dashed border-line-2 px-4 py-3 text-center text-[13px] text-ink-2" role="note">
    <Info class="size-4 text-ink-3" /><span>{noticeKey && hasMessage(noticeKey) ? t(noticeKey) : message.text}</span>
    {#if onContinue && message.kind?.startsWith("limit_")}<button type="button" class="inline-flex min-h-8 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-primary-ink" onclick={onContinue}>{t("agent.continue")}</button>{/if}
  </div>
  {/if}
{:else if message.role === "compaction"}
  <p class="flex items-center justify-center gap-2 text-center text-[12px] text-ink-3"><span class="h-px w-8 bg-line-2"></span>{t("agent.compacted")}<span class="h-px w-8 bg-line-2"></span></p>
{/if}
