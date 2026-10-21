<script lang="ts">
  import type { Component, Snippet } from "svelte";

  /** Square icon button for editor toolbars (≥ 40 px touch target on phones, 32 px on desktop). */
  let { icon: Icon, label, shortcut, active = false, disabled = false, onclick, children }: {
    icon?: Component;
    label: string;
    shortcut?: string;
    active?: boolean;
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="grid h-10 min-w-10 shrink-0 place-items-center rounded-lg px-1 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40 lg:h-8 lg:min-w-8 [&_svg]:size-4 {active ? 'bg-surface-3 text-ink' : ''}"
  aria-label={label}
  aria-pressed={active || undefined}
  title={shortcut ? `${label} (${shortcut})` : label}
  {disabled}
  onmousedown={e => e.preventDefault()}
  {onclick}
>
  {#if Icon}<Icon />{/if}
  {@render children?.()}
</button>
