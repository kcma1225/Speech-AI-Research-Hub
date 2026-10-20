<script lang="ts">
  let { class: cls = "" }: { class?: string } = $props();
</script>

<div class="animate-pulse rounded-xl bg-surface-3 {cls}"></div>
