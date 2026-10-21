<script lang="ts">
  import { CircleCheck, CircleX } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { TestResult } from "#lib/ai/admin.ts";
  import AiErrorPanel from "../AiErrorPanel.svelte";

  let { result, class: cls = "" }: { result: TestResult; class?: string } = $props();
  let showAll = $state(false);
  const LIMIT = 24;
  const shown = $derived(showAll ? result.models : result.models.slice(0, LIMIT));
</script>

<div class="flex flex-col gap-3 {cls}" aria-live="polite">
  <p class="flex items-start gap-2 text-[13.5px] {result.probe.ok ? 'text-success' : 'text-danger'}">
    {#if result.probe.ok}<CircleCheck class="mt-0.5 size-4 shrink-0" />{:else}<CircleX class="mt-0.5 size-4 shrink-0" />{/if}
    <span><span class="font-medium">{result.probe.ok ? t("aiAdmin.providers.probe.ok") : t("aiAdmin.providers.probe.failed")}</span>
      <span class="text-ink-3"> · {result.probe.detail_zh} · {result.probe.latencyMs} ms</span></span>
  </p>
  {#if result.check}
    {#if result.check.ok}
      <p class="flex items-start gap-2 text-[13.5px] text-success"><CircleCheck class="mt-0.5 size-4 shrink-0" /><span>{result.check.detail_zh} <span class="text-ink-3">· {result.check.latencyMs} ms</span></span></p>
    {:else if result.check.error}
      <AiErrorPanel compact error={result.check.error} />
    {/if}
  {/if}
  {#if result.models_error}<AiErrorPanel compact error={result.models_error} />{/if}
  {#if result.probe.ok}
    {#if result.models.length}
      <div>
        <p class="mb-1.5 text-[12.5px] font-medium text-ink-2">{t("aiAdmin.sheet.models", { n: result.models.length })}</p>
        <ul class="flex flex-wrap gap-1.5">
          {#each shown as m (m.id)}<li class="max-w-full truncate rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2">{m.id}</li>{/each}
          {#if !showAll && result.models.length > LIMIT}
            <li><button type="button" class="h-7 rounded-lg px-2 text-[12px] text-ink-3 hover:bg-surface-3 hover:text-ink" onclick={() => (showAll = true)}>{t("aiAdmin.sheet.moreModels", { n: result.models.length - LIMIT })}</button></li>
          {/if}
        </ul>
      </div>
    {:else if !result.models_error}
      <p class="text-[12.5px] text-ink-3">{t("aiAdmin.sheet.noModels")}</p>
    {/if}
  {:else}
    {#if result.probe.hint_zh}<p class="text-[12.5px] leading-relaxed text-ink-2">{result.probe.hint_zh}</p>{/if}
    {#if result.probe.code}<p class="text-[12px] text-ink-3">{t("aiAdmin.err.code")}: <code>{result.probe.code}</code></p>{/if}
  {/if}
</div>
