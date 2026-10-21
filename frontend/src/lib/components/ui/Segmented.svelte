<script lang="ts" generics="T extends string">
  import type { Component } from "svelte";
  import { RadioGroup } from "bits-ui";
  import { markFormDirty } from "./close-guard.svelte.ts";

  let { value = $bindable(), options, label, onValueChange, guardIgnore = false, class: cls = "" }: {
    value: T;
    options: { value: T; label: string; icon?: Component }[];
    label: string;
    onValueChange?: (v: T) => void;
    /** A view/tab switch, not a form value: doesn't mark an enclosing sheet as having unsaved changes. */
    guardIgnore?: boolean;
    class?: string;
  } = $props();
  const markDirty = markFormDirty();
</script>

<RadioGroup.Root
  bind:value={value as string}
  onValueChange={v => (guardIgnore || markDirty(), onValueChange?.(v as T))}
  orientation="horizontal"
  aria-label={label}
  class="inline-flex rounded-full border border-line bg-surface-2 p-1 {cls}"
>
  {#each options as option (option.value)}
    <RadioGroup.Item
      value={option.value}
      class="inline-flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-[background-color,color,box-shadow] hover:text-ink data-[state=checked]:bg-popover data-[state=checked]:text-ink data-[state=checked]:shadow-card dark:data-[state=checked]:bg-surface-3 [&_svg]:size-3.5"
    >
      {#if option.icon}<option.icon />{/if}
      {option.label}
    </RadioGroup.Item>
  {/each}
</RadioGroup.Root>
