<script lang="ts">
  import { Cpu, Pencil, Plus, RefreshCw, Search } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type ModelCapability, type ModelProfile, type ProfileField } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { dot, modelHealth, providerTone, statFor, tokens, pct } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import StateDot from "../StateDot.svelte";
  import ModelSheet from "./ModelSheet.svelte";
  import SourceTag from "./SourceTag.svelte";

  /** 模型: every model profile (per account) with limits, capabilities and where each value came from. */
  let { initialProvider = "" }: { initialProvider?: string } = $props();
  let query = $state("");
  // svelte-ignore state_referenced_locally
  let provider = $state(initialProvider);
  let cap = $state<"all" | ModelCapability>("all");
  let showHidden = $state(false);
  let syncing = $state<string | null>(null);
  let editing = $state<ModelProfile | null>(null);
  let sheetOpen = $state(false);
  let addOpen = $state(false);
  let addProvider = $state("");
  let addId = $state("");
  let addBusy = $state(false);
  let addError = $state<ReturnType<typeof toErrorBody> | null>(null);
  let limit = $state(80);

  const list = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return (adminStore.models ?? [])
      .filter(m => (!provider || m.provider_id === provider) && (cap === "all" || m.fields.capability === cap) && (showHidden || m.enabled) && (!q || `${m.model_id} ${m.fields.display_name ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => b.used_by.length - a.used_by.length || (a.provider_name ?? "").localeCompare(b.provider_name ?? "") || a.model_id.localeCompare(b.model_id));
  });
  $effect(() => {
    void query;
    void provider;
    void cap;
    void showHidden;
    limit = 80;
  });
  const hiddenCount = $derived((adminStore.models ?? []).filter(m => !m.enabled).length);
  const providers = $derived(adminStore.providers ?? []);

  async function sync(id: string) {
    syncing = id;
    try {
      const r = await aiApi.post<{ count: number }>(`/admin/ai/providers/${id}/sync`);
      toasts.show(t("aiAdmin.models.synced", { n: r.count, name: adminStore.provider(id)?.name ?? "" }), "success");
      await Promise.all([adminStore.reloadModels(), adminStore.reloadProviders()]);
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    } finally {
      syncing = null;
    }
  }

  async function toggle(m: ModelProfile, enabled: boolean) {
    try {
      const r = await aiApi.patch<{ model: ModelProfile }>(`/admin/ai/models/${m.id}`, { enabled });
      adminStore.putModel(r.model);
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    }
  }

  async function add() {
    addBusy = true;
    addError = null;
    try {
      const r = await aiApi.post<{ model: ModelProfile }>("/admin/ai/models", { provider_id: addProvider, model_id: addId.trim() });
      await adminStore.reloadModels();
      addOpen = false;
      toasts.show(t("aiAdmin.models.added", { name: r.model.model_id }), "success");
      editing = adminStore.model(r.model.id) ?? r.model;
      sheetOpen = true;
    } catch (e) {
      addError = toErrorBody(e);
    } finally {
      addBusy = false;
    }
  }

  const capKey = (c: string) => `aiAdmin.cap.${c}` as MessageKey;
  const srcOf = (m: ModelProfile, k: ProfileField) => m.sources[k];
</script>

<section class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center gap-2">
    <label class="flex h-10 min-w-0 flex-1 basis-56 items-center gap-2 rounded-xl border border-line-2 bg-surface px-3 focus-within:border-ink">
      <Search class="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <input bind:value={query} class="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3" placeholder={t("aiAdmin.models.search")} aria-label={t("aiAdmin.models.search")} />
    </label>
    <Select bind:value={provider} label={t("aiAdmin.models.provider")} class="min-w-44" options={[{ value: "", label: t("aiAdmin.models.allProviders") }, ...providers.map(p => ({ value: p.id, label: p.name }))]} />
    <Button variant="primary" onclick={() => ((addOpen = true), (addProvider = provider || providers[0]?.id || ""), (addId = ""), (addError = null))} disabled={!providers.length}><Plus />{t("aiAdmin.models.add")}</Button>
  </div>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
      <Segmented
        bind:value={cap}
        label={t("aiAdmin.models.capability")}
        class="min-w-max"
        options={[
          { value: "all", label: t("aiAdmin.sheet.all") },
          { value: "chat", label: t("aiAdmin.cap.chat") },
          { value: "embedding", label: t("aiAdmin.cap.embedding") },
          { value: "asr", label: t("aiAdmin.cap.asr") },
        ]}
      />
    </div>
    <span class="inline-flex items-center gap-2 text-[13px] text-ink-2">{t("aiAdmin.models.showHidden", { n: hiddenCount })}<Switch bind:checked={showHidden} label={t("aiAdmin.models.showHidden", { n: hiddenCount })} /></span>
  </div>

  {#if provider}
    {@const p = adminStore.provider(provider)}
    {#if p}
      <div class="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 px-4 py-2.5 text-[13px]">
        <span class="size-2.5 rounded-sm" style="background: var(--pill-{providerTone(p.id)}-ink)"></span>
        <span class="font-medium">{p.name}</span>
        <span class="text-ink-3">{t("aiAdmin.models.syncedAt", { time: p.models_synced_at ? relativeTime(p.models_synced_at) : "—" })}</span>
        <Button size="sm" variant="secondary" class="ml-auto" loading={syncing === p.id} onclick={() => sync(p.id)}><RefreshCw />{t("aiAdmin.models.sync")}</Button>
      </div>
    {/if}
  {/if}

  {#if !adminStore.models}
    <div class="flex flex-col gap-2">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-16" />{/each}</div>
  {:else if !list.length}
    <Card>
      <EmptyState title={t("aiAdmin.models.empty")} hint={t("aiAdmin.models.emptyHint")}>
        {#snippet icon()}<Cpu />{/snippet}
      </EmptyState>
    </Card>
  {:else}
    <div class="overflow-hidden rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card">
      <div class="hidden grid-cols-[minmax(0,2.2fr)_repeat(4,minmax(0,1fr))_auto] gap-3 border-b border-line px-4 py-2 text-[12px] font-medium text-ink-3 lg:grid">
        <span>{t("aiAdmin.models.col.model")}</span>
        <span>{t("aiAdmin.field.context_window")}</span>
        <span>{t("aiAdmin.field.max_output_tokens")}</span>
        <span>{t("aiAdmin.models.col.caps")}</span>
        <span>{t("aiAdmin.models.col.live")}</span>
        <span class="sr-only">{t("aiAdmin.models.col.actions")}</span>
      </div>
      <ul class="divide-y divide-line">
        {#each list.slice(0, limit) as m (m.id)}
          {@const s = statFor(adminStore.stats?.models, m)}
          {@const h = modelHealth(m, adminStore.providers, adminStore.bindings)}
          <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(0,2.2fr)_repeat(4,minmax(0,1fr))_auto] {m.enabled ? '' : 'opacity-60'}">
            <div class="flex min-w-0 items-start gap-2.5">
              <span class="mt-1.5 size-2.5 shrink-0 rounded-sm" style="background: var(--pill-{providerTone(m.provider_id)}-ink)" title={m.provider_name ?? ""}></span>
              <div class="min-w-0">
                <p class="flex min-w-0 items-center gap-2">
                  <span class="truncate font-mono text-[13px] font-medium">{m.model_id}</span>
                  <StateDot state={dot(h)} />
                </p>
                <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                  <span>{m.provider_name}</span>
                  <span class="rounded-md bg-surface-3 px-1.5 text-[11px] text-ink-2">{t(capKey(m.fields.capability))}</span>
                  {#if m.fields.display_name && m.fields.display_name !== m.model_id}<span class="truncate">{m.fields.display_name}</span>{/if}
                  {#if m.used_by.length}<span class="text-ink-2">{t("aiAdmin.models.inUse", { n: m.used_by.length })}</span>{/if}
                </p>
              </div>
            </div>
            <div class="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] lg:contents">
              <span class="inline-flex items-center gap-1.5 tabular-nums"><span class="text-ink-3 lg:hidden">{t("aiAdmin.badge.ctx")}</span>{tokens(m.fields.context_window)}<SourceTag source={srcOf(m, "context_window")} /></span>
              <span class="inline-flex items-center gap-1.5 tabular-nums">
                {#if m.fields.capability === "embedding"}<span class="text-ink-3 lg:hidden">dims</span>{m.fields.embedding_dims ?? "—"}<SourceTag source={srcOf(m, "embedding_dims")} />
                {:else}<span class="text-ink-3 lg:hidden">{t("aiAdmin.badge.out")}</span>{tokens(m.fields.max_output_tokens)}<SourceTag source={srcOf(m, "max_output_tokens")} />{/if}
              </span>
              <span class="inline-flex flex-wrap items-center gap-1">
                {#each [["vision", "aiAdmin.field.vision"], ["tools", "aiAdmin.field.tools"], ["reasoning", "aiAdmin.field.reasoning"]] as [k, key] (k)}
                  {#if m.fields.capability === "chat" && (m.fields as Record<string, unknown>)[k] !== undefined}
                    <span
                      class="inline-flex h-[20px] items-center gap-1 rounded-md px-1.5 text-[11px] font-medium {(m.fields as Record<string, unknown>)[k] ? 'bg-[var(--pill-sky)] text-[var(--pill-sky-ink)]' : 'bg-surface-3 text-ink-3 line-through'}"
                      title="{t(key as MessageKey)} · {t(`aiAdmin.src.${srcOf(m, k as ProfileField) === 'provider_api' ? 'api' : (srcOf(m, k as ProfileField) ?? 'catalog')}` as MessageKey)}">{t(key as MessageKey)}</span
                    >
                  {/if}
                {/each}
              </span>
              <span class="text-ink-3 tabular-nums">{#if s}{t("aiAdmin.models.liveChip", { calls: s.calls, rate: pct(s.success_rate) })}{:else}—{/if}</span>
            </div>
            <div class="col-start-2 row-start-1 flex items-center gap-1 lg:col-start-auto lg:row-start-auto">
              <Switch checked={m.enabled} label={t("aiAdmin.models.showInPickersFor", { name: m.model_id })} onCheckedChange={v => toggle(m, v)} />
              <Button size="icon" variant="ghost" aria-label={t("aiAdmin.models.edit", { name: m.model_id })} onclick={() => ((editing = m), (sheetOpen = true))}><Pencil /></Button>
            </div>
          </li>
        {/each}
      </ul>
      {#if list.length > limit}
        <div class="border-t border-line p-3 text-center"><Button size="sm" variant="ghost" onclick={() => (limit += 120)}>{t("aiAdmin.models.more", { n: list.length - limit })}</Button></div>
      {/if}
    </div>
  {/if}
</section>

<ModelSheet bind:open={sheetOpen} model={editing ? (adminStore.model(editing.id) ?? editing) : null} />

<Sheet bind:open={addOpen} title={t("aiAdmin.models.addTitle")} description={t("aiAdmin.models.addHint")} side="center">
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.models.provider")}</span>
      <Select bind:value={addProvider} label={t("aiAdmin.models.provider")} class="w-full" options={providers.map(p => ({ value: p.id, label: p.name }))} />
    </div>
    <TextField label={t("aiAdmin.models.modelId")} bind:value={addId} placeholder="vendor/model-name" spellcheck="false" autocomplete="off" />
    {#if addError}<AiErrorPanel compact error={addError} />{/if}
    <div class="flex justify-end gap-2 pt-1">
      <Button variant="ghost" onclick={() => (addOpen = false)}>{t("action.cancel")}</Button>
      <Button variant="primary" loading={addBusy} disabled={!addProvider || !addId.trim()} onclick={add}>{t("aiAdmin.models.addRun")}</Button>
    </div>
  </div>
</Sheet>
