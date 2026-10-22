<script lang="ts">
  import { Library, UserRound } from "@lucide/svelte";
  import { RadioGroup } from "bits-ui";
  import { t } from "#lib/i18n.svelte.ts";
  import type { LibraryScope, LibraryScopeCounts } from "#lib/library/scope.ts";

  /** The /library 「我的研究 / 全部文獻」 switch (same look as the /studies scope switch), with counts per scope. */
  let { value = $bindable(), counts, onValueChange }: { value: LibraryScope; counts: LibraryScopeCounts | null; onValueChange?: (v: LibraryScope) => void } = $props();
  const options = $derived([
    { value: "mine" as const, label: t("library.scope.mine"), icon: UserRound, n: counts?.mine },
    { value: "all" as const, label: t("library.scope.all"), icon: Library, n: counts?.all },
  ]);
</script>

<RadioGroup.Root
  bind:value={value as string}
  onValueChange={v => onValueChange?.(v as LibraryScope)}
  orientation="horizontal"
  aria-label={t("library.scope.label")}
  class="grid w-full grid-cols-2 rounded-full border border-line bg-surface-2 p-1 sm:inline-grid sm:w-auto"
>
  {#each options as option (option.value)}
    <RadioGroup.Item
      value={option.value}
      class="inline-flex h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-[14px] font-medium whitespace-nowrap text-ink-3 transition-[background-color,color,box-shadow] hover:text-ink motion-reduce:transition-none data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-card sm:px-5 dark:data-[state=checked]:bg-surface-3"
    >
      <option.icon class="size-4 shrink-0" />
      <span class="truncate">{option.label}</span>
      <span
        class="inline-grid h-5 min-w-5 place-items-center rounded-full bg-surface-3 px-1.5 text-[12px] font-semibold tabular-nums text-ink-2"
        aria-label={option.n === undefined ? undefined : t("library.count", { n: option.n })}>{option.n ?? "–"}</span
      >
    </RadioGroup.Item>
  {/each}
</RadioGroup.Root>
