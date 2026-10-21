<script lang="ts" generics="T extends string">
  import { Select } from "bits-ui";
  import { markFormDirty } from "./close-guard.svelte.ts";
  import { Check, ChevronDown, ChevronUp } from "@lucide/svelte";

  let { value = $bindable(), options, label, onValueChange, class: cls = "" }: {
    value: T;
    options: { value: T; label: string; hint?: string }[];
    label: string;
    onValueChange?: (v: T) => void;
    class?: string;
  } = $props();
  const markDirty = markFormDirty();
  const selected = $derived(options.find(o => o.value === value));
</script>

<Select.Root type="single" bind:value={value as string} onValueChange={v => (markDirty(), onValueChange?.(v as T))} items={options}>
  <Select.Trigger
    aria-label={label}
    class="inline-flex h-10 min-w-40 cursor-pointer items-center justify-between gap-3 rounded-xl border border-line-2 bg-surface px-3.5 text-sm text-ink transition-colors hover:border-ink-3 data-[state=open]:border-ink {cls}"
  >
    <span class="truncate">{selected?.label ?? ""}</span>
    <ChevronDown class="size-4 text-ink-3" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      sideOffset={6}
      class="z-50 flex max-h-[min(18rem,var(--bits-select-content-available-height))] min-w-[var(--bits-select-anchor-width)] flex-col overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]"
    >
      <!-- Shown only while there is more to scroll, so a list opened at the selected item hints at what's above. -->
      <Select.ScrollUpButton class="flex h-6 shrink-0 items-center justify-center text-ink-3"><ChevronUp class="size-4" /></Select.ScrollUpButton>
      <Select.Viewport class="min-h-0">
        {#each options as option (option.value)}
          <Select.Item
            value={option.value}
            label={option.label}
            class="flex h-9 cursor-pointer items-center justify-between gap-6 rounded-xl px-2.5 text-sm text-ink outline-none data-highlighted:bg-surface-2"
          >
            {#snippet children({ selected })}
              <span>{option.label}{#if option.hint}<span class="ml-2 text-ink-3">{option.hint}</span>{/if}</span>
              {#if selected}<Check class="size-4" />{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
      <Select.ScrollDownButton class="flex h-6 shrink-0 items-center justify-center text-ink-3"><ChevronDown class="size-4" /></Select.ScrollDownButton>
    </Select.Content>
  </Select.Portal>
</Select.Root>
