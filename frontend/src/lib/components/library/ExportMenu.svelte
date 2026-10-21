<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Download } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";

  let { studyRef, disabled = false }: { studyRef: string; disabled?: boolean } = $props();
  const href = (format: string) => `/api/studies/${encodeURIComponent(studyRef)}/papers/export?format=${format}`;
  const items = [
    { format: "bibtex", label: "library.export.bibtex" },
    { format: "ris", label: "library.export.ris" },
    { format: "csl-json", label: "library.export.csl" },
  ] as const;
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    {disabled}
    class="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:border-line-2 hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
  >
    <Download class="size-4" />{t("library.export")}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-64">
      {#each items as item (item.format)}
        <DropdownMenu.Item class={menuItem} onSelect={() => window.location.assign(href(item.format))}>{t(item.label)}</DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
