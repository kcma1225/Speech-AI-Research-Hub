<script lang="ts">
  import { Paperclip } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { PageContext } from "#lib/agent/types.ts";
  import AttachPicker from "./AttachPicker.svelte";
  import type { AttachDraft } from "./state.svelte.ts";

  /** 「附加」 button of the composer toolbar; opens the picker (also opened by typing @ via `open`). */
  let { draft, context = null, conversationId = null, disabled = false, compact = false, open = $bindable(false) }: {
    draft: AttachDraft;
    context?: PageContext | null;
    conversationId?: string | null;
    disabled?: boolean;
    /** Narrow composer (side panel): icon only. */
    compact?: boolean;
    open?: boolean;
  } = $props();
</script>

<button
  type="button"
  {disabled}
  title={t("attach.buttonHint")}
  aria-label={draft.count ? `${t("attach.button")}（${draft.count}）` : t("attach.button")}
  aria-haspopup="dialog"
  onclick={() => (open = true)}
  class="relative inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent motion-reduce:transition-none {compact ? '' : 'sm:px-3'}"
>
  <Paperclip class="size-4" />{#if !compact}<span class="hidden sm:inline" aria-hidden="true">{t("attach.button")}</span>{/if}
  {#if draft.count}<span class="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-[10px] leading-none text-primary-ink {compact ? '' : 'sm:static sm:h-5 sm:min-w-5 sm:text-[11px]'}" aria-hidden="true">{draft.count}</span>{/if}
</button>

<AttachPicker bind:open {draft} {context} {conversationId} />
