<script lang="ts">
  import type { Component } from "svelte";
  import { viewer } from "#lib/agent/viewer.ts";
  import { assistantPanel } from "#lib/agent/panel.svelte.ts";

  /**
   * A link from the viewer to the document's own page. Closing the viewer first releases its live connection to the
   * document before the page's editor opens one; the Ask-AI panel closes so the page is visible.
   */
  let { href, label, icon: Icon }: { href: string; label: string; icon?: Component } = $props();
</script>

<a
  {href}
  class="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-line-2"
  onclick={(e) => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      viewer.closeViewer();
      assistantPanel.open = false;
    }
  }}
>
  {#if Icon}<Icon class="size-3.5 text-ink-3" />{/if}{label}
</a>
