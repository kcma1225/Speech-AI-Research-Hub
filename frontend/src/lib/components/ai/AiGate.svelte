<script lang="ts">
  import type { Snippet } from "svelte";
  import { Wrench } from "@lucide/svelte";
  import { aiStatus, type AiRole } from "#lib/ai/status.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";

  /**
   * Wraps every AI entry point. Renders `children` while `role` is ok/degraded; otherwise `fallback`
   * (when given) or a 「維護中」 badge with the platform's hint. Status comes from GET /api/ai/status
   * (shared store, polled every 30 s). `inline` renders the badge compactly next to other controls.
   */
  let { role, children, fallback, inline = false }: { role: AiRole; children: Snippet; fallback?: Snippet; inline?: boolean } = $props();

  $effect(() => aiStatus.watch());
  const available = $derived(aiStatus.available(role));
  const status = $derived(aiStatus.of(role));
</script>

{#if available}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{:else}
  <span
    class="inline-flex max-w-full items-center gap-2 rounded-full border border-dashed border-line-2 bg-surface-2 text-ink-3 {inline ? 'h-8 px-3 text-[12.5px]' : 'h-10 px-4 text-[13px]'}"
    title={status.hint ?? t("ai.maintenanceHint")}
    aria-disabled="true"
  >
    <Wrench class="size-3.5 shrink-0" />
    <span class="truncate font-medium">{aiStatus.loaded ? t("ai.maintenance") : t("ai.checking")}</span>
  </span>
{/if}
