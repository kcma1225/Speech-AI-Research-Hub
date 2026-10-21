<script lang="ts">
  /** `compact`: only the logo mark stays visible (the collapsed sidebar rail); the name fades out. */
  let { class: cls = "", size = "md", compact = false }: { class?: string; size?: "md" | "lg"; compact?: boolean } = $props();
</script>

<a href="/" class="group inline-flex items-center gap-2.5 {cls}" aria-label="Speech-AI Hub">
  <span class="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-[10px] hero-gradient ring-1 ring-black/5 dark:ring-white/10" aria-hidden="true">
    <svg viewBox="0 0 24 24" class="size-4.5 text-hero-ink" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  </span>
  <span
    class="font-display leading-none whitespace-nowrap text-ink transition-[opacity,translate] duration-200 ease-out {size === 'lg' ? 'text-[30px]' : 'text-[23px]'} {compact
      ? '-translate-x-1 opacity-0'
      : ''}"
    aria-hidden={compact ? "true" : undefined}>Speech-AI <em class="italic">Hub</em></span
  >
</a>
