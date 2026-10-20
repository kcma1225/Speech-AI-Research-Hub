<script lang="ts">
  import type { Snippet } from "svelte";
  let { class: cls = "", children, padded = true }: { class?: string; children: Snippet; padded?: boolean } = $props();
</script>

<section class="rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card {padded ? 'p-5 sm:p-6' : ''} {cls}">
  {@render children()}
</section>
