<script lang="ts">
  import { Check, PenLine, X } from "@lucide/svelte";
  import { tick } from "svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /**
   * The study page title. Editors get a pencil button that turns it into an inline field
   * (Enter or blur saves, Esc cancels; trimmed, 1–200 chars). `onRename` does the optimistic update.
   */
  let { title, canEdit, onRename }: { title: string; canEdit: boolean; onRename: (title: string) => Promise<void> } = $props();

  let editing = $state(false);
  let draft = $state("");
  let input = $state<HTMLInputElement | null>(null);

  async function start() {
    draft = title;
    editing = true;
    await tick();
    input?.focus();
    input?.select();
  }
  function cancel() {
    editing = false;
  }
  async function save() {
    if (!editing) return;
    const next = draft.trim();
    if (!next) {
      toasts.show(t("studies.rename.empty"), "error");
      input?.focus();
      return;
    }
    editing = false;
    if (next !== title) await onRename(next);
  }
  function keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  const iconButton = "grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink [&_svg]:size-[18px]";
</script>

{#if editing}
  <div class="flex items-center gap-1.5">
    <input
      bind:this={input}
      bind:value={draft}
      maxlength={200}
      aria-label={t("studies.field.title")}
      class="h-14 min-w-0 flex-1 rounded-xl border border-line-2 bg-surface px-3 font-display text-[26px] leading-none text-ink outline-none focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:h-16 sm:text-[36px]"
      onkeydown={keydown}
      onblur={() => void save()}
    />
    <button type="button" class={iconButton} aria-label={t("action.save")} onmousedown={e => e.preventDefault()} onclick={() => void save()}><Check /></button>
    <button type="button" class={iconButton} aria-label={t("action.cancel")} onmousedown={e => e.preventDefault()} onclick={cancel}><X /></button>
  </div>
{:else}
  <div class="group flex items-start gap-1.5">
    <h1 class="min-w-0 font-display text-[32px] leading-[1.06] text-balance break-words text-ink sm:text-[44px]">{title}</h1>
    {#if canEdit}
      <button type="button" class="{iconButton} mt-0.5 sm:mt-1.5 sm:opacity-60 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" aria-label={t("studies.rename")} title={t("studies.rename")} onclick={start}><PenLine /></button>
    {/if}
  </div>
{/if}
