<script lang="ts">
  import { Popover } from "bits-ui";
  import { ChevronDown, RefreshCw } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type Provider, type TestResult } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";

  /** Free-text model id with suggestions from the account's model list (fetched on demand) or the registry. */
  let { value = $bindable(""), provider, label, error = null }: { value: string; provider: Provider | null; label: string; error?: string | null } = $props();
  let open = $state(false);
  let filter = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  const uid = $props.id();

  const suggestions = $derived.by(() => {
    if (!provider) return [];
    const fetched = adminStore.models[provider.id];
    if (fetched?.length) return fetched;
    const e = adminStore.entry(provider.family, provider.kind);
    return e?.models ?? e?.quirks?.staticModels ?? [];
  });
  const shown = $derived(suggestions.filter(m => !filter.trim() || m.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 200));

  async function load() {
    if (!provider) return;
    loading = true;
    loadError = null;
    try {
      const r = await aiApi.post<TestResult>(`/admin/ai/providers/${provider.id}/test`);
      if (r.models.length) adminStore.setModels(provider.id, r.models.map(m => m.id));
      else if (!r.probe.ok) loadError = r.probe.detail_zh;
    } catch (e) {
      loadError = toErrorBody(e).error;
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <label for="mp-{uid}" class="text-[13px] font-medium text-ink-2">{label}</label>
  <div class="flex items-stretch gap-1.5">
    <input
      id="mp-{uid}"
      bind:value
      placeholder={t("aiAdmin.routes.member.modelPlaceholder")}
      spellcheck="false"
      autocomplete="off"
      aria-invalid={error ? true : undefined}
      class="h-11 min-w-0 flex-1 rounded-xl border bg-surface px-3.5 font-mono text-[14px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3 focus:border-ink sm:h-10 sm:text-[13px] {error ? 'border-danger' : 'border-line-2'}"
    />
    <Popover.Root bind:open onOpenChange={o => o && !suggestions.length && !loading && load()}>
      <Popover.Trigger
        disabled={!provider}
        aria-label={t("aiAdmin.routes.member.models")}
        class="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line-2 bg-surface text-ink-2 hover:border-ink-3 disabled:opacity-50 sm:h-10 sm:w-10 data-[state=open]:border-ink"
      >
        <ChevronDown class="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} class="z-50 flex max-h-[min(22rem,70dvh)] w-[min(22rem,calc(100vw-32px))] flex-col rounded-2xl border border-line bg-surface p-2 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]">
          <div class="flex items-center gap-1.5 p-1">
            <input
              bind:value={filter}
              placeholder={t("aiAdmin.routes.member.searchModels")}
              aria-label={t("aiAdmin.routes.member.searchModels")}
              class="h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-surface px-3 text-[13px] outline-none focus:border-ink"
            />
            <button type="button" onclick={load} disabled={loading} aria-label={t("aiAdmin.routes.member.loadModels")} title={t("aiAdmin.routes.member.loadModels")} class="grid size-9 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink">
              {#if loading}<Spinner class="size-4" />{:else}<RefreshCw class="size-4" />{/if}
            </button>
          </div>
          {#if loadError}<p class="px-2 py-1 text-[12px] text-danger">{loadError}</p>{/if}
          <ul class="min-h-0 overflow-y-auto" role="listbox" aria-label={t("aiAdmin.routes.member.models")}>
            {#each shown as m (m)}
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={m === value}
                  onclick={() => {
                    value = m;
                    open = false;
                  }}
                  class="flex min-h-9 w-full items-center rounded-lg px-2.5 text-left font-mono text-[12.5px] break-all text-ink hover:bg-surface-2 {m === value ? 'bg-surface-2 font-semibold' : ''}">{m}</button
                >
              </li>
            {:else}
              <li class="px-2.5 py-3 text-[12.5px] text-ink-3">{loading ? t("common.loading") : t("aiAdmin.routes.member.noModels")}</li>
            {/each}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
  {#if error}<p class="text-[12.5px] text-danger" role="alert">{error}</p>{/if}
</div>
