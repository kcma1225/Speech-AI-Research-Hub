<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import AttachmentChip from "./AttachmentChip.svelte";
  import type { AttachDraft } from "./state.svelte.ts";
  import { MAX_ATTACHMENTS } from "./types.ts";

  /** Chips of the message being written (above the composer input). */
  let { draft }: { draft: AttachDraft } = $props();
</script>

{#if draft.items.length}
  <div class="px-3 pt-2.5" role="group" aria-label={t("attach.trayLabel", { n: draft.items.length, max: MAX_ATTACHMENTS })}>
    <div class="flex max-h-[96px] flex-wrap gap-1.5 overflow-y-auto">
      {#each draft.items as item (item.key)}
        <AttachmentChip {item} pending={item.pending} error={item.error ?? null} onRemove={() => draft.remove(item.key)} />
      {/each}
    </div>
  </div>
{/if}
