<script lang="ts" module>
  import type { ReadingStatus } from "#lib/library/types.ts";
  import type { Tone } from "#lib/components/ui/Pill.svelte";
  export const STATUS_TONE: Record<ReadingStatus, Tone> = { unread: "stone", reading: "butter", read: "mint" };
  export const STATUSES: ReadingStatus[] = ["unread", "reading", "read"];
</script>

<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Check, ChevronDown } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";

  /** Reading status pill; with `onChange` it opens a menu to change it. */
  let { status, onChange, label }: { status: ReadingStatus; onChange?: (s: ReadingStatus) => void; label?: string } = $props();
  const text = (s: ReadingStatus) => t(`library.status.${s}` as MessageKey);
</script>

{#if onChange}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="inline-flex h-10 min-w-[84px] shrink-0 cursor-pointer items-center justify-between gap-1 rounded-full px-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      aria-label={label ?? t("library.status")}
    >
      <span class="inline-flex h-7 items-center gap-1.5 rounded-full pr-2 pl-2.5" style="background: var(--pill-{STATUS_TONE[status]}); color: var(--pill-{STATUS_TONE[status]}-ink)">
        <span class="size-1.5 rounded-full bg-current"></span>{text(status)}<ChevronDown class="size-3 opacity-70" />
      </span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" sideOffset={4} class="{menuContent} min-w-40">
        {#each STATUSES as s (s)}
          <DropdownMenu.Item class={menuItem} onSelect={() => s !== status && onChange(s)}>
            <span class="size-2 rounded-full" style="background: var(--pill-{STATUS_TONE[s]}-ink)"></span>
            <span class="flex-1">{text(s)}</span>
            {#if s === status}<Check />{/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else}
  <span class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium" style="background: var(--pill-{STATUS_TONE[status]}); color: var(--pill-{STATUS_TONE[status]}-ink)">
    <span class="size-1.5 rounded-full bg-current"></span>{text(status)}
  </span>
{/if}
