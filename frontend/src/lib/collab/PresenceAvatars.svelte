<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { CollabPeer } from "./session.svelte.ts";

  /** Who else is in the document (colours match their remote cursors). */
  let { peers, max = 4 }: { peers: CollabPeer[]; max?: number } = $props();
  const shown = $derived(peers.slice(0, max));
  const initials = (name: string) => (/[㐀-鿿]/.test(name) ? name.replace(/\s/g, "").slice(-2) : name.trim().slice(0, 2).toUpperCase());
</script>

{#if peers.length}
  <div class="flex items-center" role="group" aria-label={t("collab.peers", { n: peers.length })}>
    {#each shown as p (p.clientId)}
      <span
        class="-ml-1.5 grid size-8 place-items-center rounded-full text-[11px] font-semibold ring-2 ring-surface first:ml-0"
        style="background:{p.colorLight};color:{p.color};box-shadow:inset 0 0 0 1.5px {p.color}"
        title={p.name}
        aria-label={p.name}>{initials(p.name)}</span
      >
    {/each}
    {#if peers.length > max}<span class="-ml-1.5 grid size-8 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-2 ring-2 ring-surface">+{peers.length - max}</span>{/if}
  </div>
{/if}
