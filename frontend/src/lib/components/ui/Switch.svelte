<script lang="ts">
  import { Switch } from "bits-ui";
  import { markFormDirty } from "./close-guard.svelte.ts";
  let { checked = $bindable(false), disabled = false, label, onCheckedChange }: { checked?: boolean; disabled?: boolean; label: string; onCheckedChange?: (v: boolean) => void } = $props();
  const markDirty = markFormDirty();
</script>

<Switch.Root
  bind:checked
  {disabled}
  onCheckedChange={v => (markDirty(), onCheckedChange?.(v))}
  aria-label={label}
  class="peer relative inline-flex h-6 w-10 shrink-0 cursor-pointer after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] items-center rounded-full px-0.5 transition-colors data-[state=checked]:bg-ink data-[state=unchecked]:bg-line-2 disabled:cursor-not-allowed disabled:opacity-50"
>
  <Switch.Thumb class="pointer-events-none block size-5 rounded-full bg-popover shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 data-[state=checked]:translate-x-4 dark:data-[state=checked]:bg-canvas" />
</Switch.Root>
