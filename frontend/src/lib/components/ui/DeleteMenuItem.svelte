<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Trash2 } from "@lucide/svelte";
  import { menuSeparator } from "./menu.ts";

  /**
   * The labelled 「刪除」 entry at the bottom of a ⋯ menu (danger style, after a separator). Without permission it
   * stays visible but disabled, with the reason under the label and as its tooltip (`reason`), so delete is never
   * mistaken for a missing feature.
   */
  let { label, reason = null, separator = true, onSelect }: {
    label: string;
    /** Why the user may not delete (e.g. 「只有這個研究的成員可以刪除」); null = allowed. */
    reason?: string | null;
    separator?: boolean;
    onSelect: () => void;
  } = $props();
</script>

{#if separator}<DropdownMenu.Separator class={menuSeparator} />{/if}
<DropdownMenu.Item
  class="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm text-danger outline-none select-none data-highlighted:bg-danger-soft data-disabled:cursor-not-allowed data-disabled:text-ink-3 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-danger data-disabled:[&_svg]:text-ink-3"
  disabled={!!reason}
  title={reason ?? undefined}
  data-delete-action={reason ? "disabled" : "enabled"}
  {onSelect}
>
  <Trash2 />
  <span class="flex min-w-0 flex-col">
    <span>{label}</span>
    {#if reason}<span class="max-w-60 text-[11.5px] leading-snug whitespace-normal text-ink-3">{reason}</span>{/if}
  </span>
</DropdownMenu.Item>
