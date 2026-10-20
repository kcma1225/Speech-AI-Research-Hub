<script lang="ts">
  let { class: cls = "", size = "md" }: { class?: string; size?: "md" | "lg" } = $props();
</script>

<a href="/" class="group inline-flex items-center gap-2.5 {cls}" aria-label="Speech-AI Hub">
  <span class="relative grid size-8 place-items-center overflow-hidden rounded-[10px] hero-gradient ring-1 ring-black/5 dark:ring-white/10" aria-hidden="true">
    <svg viewBox="0 0 24 24" class="size-4.5 text-hero-ink" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  </span>
  <span class="font-display leading-none text-ink {size === 'lg' ? 'text-[30px]' : 'text-[23px]'}">Speech-AI <em class="italic">Hub</em></span>
</a>
