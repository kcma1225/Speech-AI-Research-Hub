<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowUp, Brain, NotebookPen, Rocket, Square, Workflow, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";

  /**
   * Message composer: Enter sends (not while composing with an IME), Shift+Enter is a new line, Esc stops a running
   * reply. Shows the page-context chip and the autopilot / memory toggles; autopilot draws an accent band on top.
   */
  let {
    busy = false,
    disabled = false,
    placeholder,
    autopilot = null,
    memory = null,
    acting = false,
    contextLabel = null,
    contextTitle = "",
    onSend,
    onStop,
    onAutopilot,
    onMemory,
    onClearContext,
    onMakeNote,
    makeNoteDisabled = false,
    onAgent,
    agentCompact = false,
    attach,
    tray,
    onAt,
    onFiles,
    value = $bindable(""),
    ref = $bindable(null),
  }: {
    busy?: boolean;
    disabled?: boolean;
    placeholder?: string;
    /** null = no toggle (interview mode). */
    autopilot?: boolean | null;
    memory?: { on: boolean; available: boolean } | null;
    /** An auto-approved write is running (the band animates). */
    acting?: boolean;
    contextLabel?: string | null;
    contextTitle?: string;
    onSend: (text: string) => void | Promise<void>;
    onStop: () => void;
    onAutopilot?: (v: boolean) => void;
    onMemory?: (v: boolean) => void;
    onClearContext?: () => void;
    /** 「整理成筆記」 quick action (chat mode). */
    onMakeNote?: () => void;
    makeNoteDisabled?: boolean;
    /** 「交給 Agent」: hands the typed text to a workflow (also `/agent <text>` in onSend's caller). */
    onAgent?: (text: string) => void;
    /** Icon-only button (narrow panels). */
    agentCompact?: boolean;
    /** Attachments: toolbar button, chips above the input, and typing @ (at a word start) to open the picker. */
    attach?: Snippet;
    tray?: Snippet;
    onAt?: () => void;
    /** Pasted clipboard images / files dropped on the composer (uploaded as attachments). */
    onFiles?: (files: File[]) => void;
    value?: string;
    ref?: HTMLTextAreaElement | null;
  } = $props();

  function resize() {
    if (!ref) return;
    ref.style.height = "auto";
    ref.style.height = `${Math.min(ref.scrollHeight, 220)}px`;
  }
  $effect(() => {
    void value;
    resize();
  });

  function submit() {
    const text = value.trim();
    if (!text || disabled || busy) return;
    void onSend(text);
  }
  function oninput(e: Event) {
    const ev = e as InputEvent;
    if (!onAt || ev.inputType !== "insertText" || ev.data !== "@" || !ref) return;
    const at = ref.selectionStart ?? value.length;
    const before = value.slice(0, at - 1);
    if (before && !/\s$/.test(before)) return;
    value = before + value.slice(at);
    onAt();
  }
  /** Clipboard images (screenshots, copied pictures). Text that comes along (e.g. alt text from a web page) still pastes. */
  function onpaste(e: ClipboardEvent) {
    if (!onFiles || disabled) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
    onFiles(files);
  }

  // Drag files onto the composer: a dashed overlay while over it. Counted so child enter/leave pairs don't flicker.
  let dragDepth = $state(0);
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  function ondragenter(e: DragEvent) {
    if (!onFiles || disabled || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
  }
  function ondragover(e: DragEvent) {
    if (!onFiles || disabled || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
  function ondragleave(e: DragEvent) {
    if (dragDepth) dragDepth--;
  }
  function ondrop(e: DragEvent) {
    if (!onFiles || disabled || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  }
</script>

<div
  class="composer relative rounded-[24px] border border-line-2 bg-surface shadow-card"
  data-autopilot={autopilot || undefined}
  data-acting={acting || undefined}
  role="group"
  aria-label={t("agent.composer")}
  {ondragenter}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  {#if dragDepth > 0}
    <div class="drop pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[24px] border-2 border-dashed border-ink/40 bg-surface/90 text-center" aria-hidden="true">
      <div>
        <p class="text-[14px] font-medium text-ink">{t("attach.dropHere")}</p>
        <p class="mt-0.5 text-[12px] text-ink-3">{t("attach.dropHint")}</p>
      </div>
    </div>
  {/if}
  {#if autopilot}<span class="band" aria-hidden="true"></span>{/if}
  {#if contextLabel}
    <div class="flex px-3 pt-2.5">
      <span class="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-surface-2 pr-1 pl-2.5 text-[12px] text-ink-2">
        <span class="truncate">{contextTitle ? t("agent.contextChipNamed", { label: t(`agent.context.${contextLabel}` as MessageKey), title: contextTitle }) : t("agent.contextChip", { label: t(`agent.context.${contextLabel}` as MessageKey) })}</span>
        {#if onClearContext}<button type="button" class="grid size-6 place-items-center rounded-full hover:bg-surface-3" aria-label={t("agent.contextRemove")} onclick={onClearContext}><X class="size-3" /></button>{/if}
      </span>
    </div>
  {/if}
  {#if tray}{@render tray()}{/if}
  <label class="sr-only" for="agent-composer">{t("agent.composer")}</label>
  <textarea
    id="agent-composer"
    bind:this={ref}
    bind:value
    rows="1"
    {onkeydown}
    {oninput}
    {onpaste}
    placeholder={placeholder ?? (busy ? t("agent.placeholderBusy") : t("agent.placeholder"))}
    disabled={disabled}
    aria-keyshortcuts="Enter Shift+Enter Escape"
    class="block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 sm:text-[14.5px]"
  ></textarea>
  <div class="flex items-center gap-1 px-2 pb-2 sm:gap-1.5">
    {#if attach}{@render attach()}{/if}
    {#if autopilot !== null && onAutopilot}
      <button
        type="button"
        role="switch"
        aria-checked={autopilot}
        aria-label={t("agent.autopilot")}
        title={t("agent.autopilotHint")}
        onclick={() => onAutopilot(!autopilot)}
        class="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium transition-colors {autopilot ? 'bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}"
      >
        <Rocket class="size-4" /><span class="hidden sm:inline">{t("agent.autopilot")}</span>
        <span class="thumb {autopilot ? 'on' : ''}" aria-hidden="true"></span>
      </button>
    {/if}
    {#if memory && onMemory}
      <button
        type="button"
        role="switch"
        aria-checked={memory.on}
        aria-label={t("agent.memory")}
        disabled={!memory.available}
        title={memory.available ? (memory.on ? t("agent.memoryOn") : t("agent.memoryOff")) : t("agent.memoryDisabledHint")}
        onclick={() => onMemory(!memory.on)}
        class="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50 {memory.on ? 'bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}"
      >
        <Brain class="size-4" /><span class="hidden sm:inline">{t("agent.memory")}</span>
      </button>
    {/if}
    {#if onAgent}
      <button
        type="button"
        disabled={disabled || busy}
        title={value.trim() ? t("wf.handOffHint") : t("wf.handOffEmpty")}
        aria-label={t("wf.handOff")}
        onclick={() => (value.trim() ? onAgent(value.trim()) : ref?.focus())}
        class="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Workflow class="size-4" /><span class={agentCompact ? "sr-only" : "hidden sm:inline"}>{t("wf.handOff")}</span>
      </button>
    {/if}
    {#if onMakeNote}
      <button
        type="button"
        disabled={makeNoteDisabled || busy}
        title={t("agent.makeNote.hint")}
        aria-label={t("agent.makeNote.label")}
        onclick={onMakeNote}
        class="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <NotebookPen class="size-4" /><span class={agentCompact ? "sr-only" : "hidden sm:inline"}>{t("agent.makeNote.label")}</span>
      </button>
    {/if}
    <span class="hidden flex-1 truncate text-right text-[11.5px] text-ink-3 lg:block" aria-hidden="true">{t("agent.keys")}</span>
    <span class="flex-1 lg:hidden"></span>
    {#if busy}
      <button type="button" class="grid size-10 place-items-center rounded-full bg-ink text-primary-ink" aria-label={t("agent.stop")} title={`${t("agent.stop")} (Esc)`} onclick={onStop}><Square class="size-3.5 fill-current" /></button>
    {:else}
      <button type="button" class="grid size-10 place-items-center rounded-full bg-ink text-primary-ink transition-opacity disabled:opacity-30" aria-label={t("agent.send")} disabled={disabled || !value.trim()} onclick={submit}><ArrowUp class="size-4.5" /></button>
    {/if}
  </div>
</div>

<style>
  .drop {
    animation: drop-in 120ms ease-out;
  }
  @keyframes drop-in {
    from {
      opacity: 0;
    }
  }
  .band {
    position: absolute;
    left: 18px;
    right: 18px;
    top: -1px;
    height: 2px;
    border-radius: 2px;
    background: var(--pill-butter-ink);
    transform-origin: center;
    animation: grow 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  [data-acting] .band {
    background: linear-gradient(90deg, var(--pill-butter-ink), var(--hero-b), var(--pill-butter-ink));
    background-size: 200% 100%;
    animation: flow 2.4s linear infinite;
  }
  @keyframes grow {
    from {
      transform: scaleX(0);
    }
  }
  @keyframes flow {
    to {
      background-position: -200% 0;
    }
  }
  .thumb {
    position: relative;
    width: 22px;
    height: 12px;
    border-radius: 999px;
    background: var(--line-2);
    transition: background-color 150ms;
  }
  .thumb::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--surface);
    transition: transform 150ms cubic-bezier(0.2, 0, 0, 1);
  }
  .thumb.on {
    background: var(--pill-butter-ink);
  }
  .thumb.on::after {
    transform: translateX(10px);
  }
  @media (prefers-reduced-motion: reduce) {
    .drop,
    .band,
    [data-acting] .band {
      animation: none;
      background: var(--pill-butter-ink);
    }
    .thumb,
    .thumb::after {
      transition: none;
    }
  }
</style>
