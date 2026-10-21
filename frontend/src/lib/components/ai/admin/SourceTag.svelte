<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { FieldSource } from "#lib/ai/admin.ts";

  /** Where a profile value came from: the provider's model list, the built-in catalog or a manual override. */
  let { source, class: cls = "" }: { source: FieldSource | undefined; class?: string } = $props();
  const key = $derived(source === "manual" ? "aiAdmin.src.manual" : source === "provider_api" ? "aiAdmin.src.api" : "aiAdmin.src.catalog");
  const hint = $derived(source === "manual" ? "aiAdmin.src.manual.hint" : source === "provider_api" ? "aiAdmin.src.api.hint" : "aiAdmin.src.catalog.hint");
</script>

{#if source}
  <span
    class="inline-flex h-[18px] shrink-0 items-center rounded-md px-1.5 text-[10.5px] font-semibold {source === 'manual'
      ? 'bg-ink text-primary-ink'
      : source === 'provider_api'
        ? 'bg-[var(--pill-mint)] text-[var(--pill-mint-ink)]'
        : 'bg-surface-3 text-ink-3'} {cls}"
    title={t(hint)}>{t(key)}</span
  >
{/if}
