<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import AttachmentChip from "./AttachmentChip.svelte";
  import type { Attachment } from "./types.ts";

  /** Attachments of a sent user message (above the bubble, right-aligned). */
  let { items, onOpen }: { items: Attachment[]; onOpen?: () => void } = $props();
</script>

<div class="flex flex-wrap justify-end gap-1.5" role="list" aria-label={t("attach.messageLabel", { n: items.length })}>
  {#each items as item (`${item.kind}:${item.id}:${item.version ?? ""}`)}
    <span role="listitem" class="min-w-0"><AttachmentChip {item} {onOpen} /></span>
  {/each}
</div>
