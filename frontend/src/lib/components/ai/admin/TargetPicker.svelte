<script lang="ts">
  import { AudioLines, Boxes, Check, ChevronsDownUp, ChevronsUpDown, Search } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { Capability, GroupStrategy, ModelProfile, TargetInput } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { L } from "#lib/ai/form.ts";
  import { audioModelsFor, dot, modelHealth, modelsFor, providerHealth } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import StateDot from "../StateDot.svelte";
  import Highlight from "./Highlight.svelte";
  import ProfileBadges from "./ProfileBadges.svelte";
  import ProviderSections, { type ProviderSection } from "./ProviderSections.svelte";

  /**
   * 「綁定到…」 picker: groups and models (grouped by account, with profile badges) of one capability.
   * `exclude` hides groups that would create a cycle; `current` marks the selected target.
   */
  let {
    open = $bindable(false),
    capability,
    title,
    description,
    groups: allowGroups = true,
    models: allowModels = true,
    exclude = new Set<string>(),
    current = null,
    onPick,
  }: {
    open?: boolean;
    capability: Capability | null;
    title: string;
    description?: string;
    groups?: boolean;
    models?: boolean;
    exclude?: Set<string>;
    current?: string | null;
    onPick: (target: TargetInput, label: string) => void;
  } = $props();

  let query = $state("");
  let showHidden = $state(false);
  $effect(() => {
    if (open) query = "";
  });

  const q = $derived(query.trim().toLowerCase());
  const groups = $derived(allowGroups && capability ? (adminStore.groups ?? []).filter(g => g.capability === capability && !exclude.has(g.id) && (!q || g.name.toLowerCase().includes(q))) : []);
  const models = $derived(
    capability && allowModels ? modelsFor(adminStore.models, capability, showHidden).filter(m => !q || `${m.model_id} ${m.fields.display_name ?? ""} ${m.provider_name ?? ""}`.toLowerCase().includes(q)) : [],
  );
  // Speech roles: multimodal chat models with audio input are offered in their own section (see ai/asr/adapters/llm.ts).
  const audioModels = $derived(
    capability === "asr" && allowModels
      ? audioModelsFor(adminStore.models, showHidden).filter(m => !q || `${m.model_id} ${m.fields.display_name ?? ""} ${m.provider_name ?? ""}`.toLowerCase().includes(q))
      : [],
  );
  const byProvider = $derived.by(() => {
    const out: ProviderSection<ModelProfile>[] = [];
    for (const m of models) {
      let g = out.find(x => x.id === m.provider_id);
      if (!g) {
        const p = adminStore.provider(m.provider_id);
        const vendor = (p?.label ? L(p.label) : "") || (m.provider_kind ? L(adminStore.entry(m.provider_family ?? "llm", m.provider_kind)?.label) : "");
        out.push((g = { id: m.provider_id, name: m.provider_name ?? "?", kind: m.provider_kind, vendor, health: p ? providerHealth(p) : "unknown", items: [] }));
      }
      g.items.push(m);
    }
    const inUse = (g: ProviderSection<ModelProfile>) => Number(g.items.some(m => m.used_by.length > 0));
    out.sort((a, b) => inUse(b) - inUse(a) || a.name.localeCompare(b.name));
    for (const g of out) g.items.sort((a, b) => Number(b.used_by.length > 0) - Number(a.used_by.length > 0) || a.model_id.localeCompare(b.model_id));
    return out;
  });
  const currentProvider = $derived(current?.startsWith("model:") ? (adminStore.model(current.slice(6))?.provider_id ?? null) : null);
  let sections = $state<{ setAll: (open: boolean) => void } | null>(null);
  let allOpen = $state(false);
  const strategyKey = (s: GroupStrategy) => `aiAdmin.strategy.${s}` as MessageKey;
  function pick(target: TargetInput, label: string) {
    onPick(target, label);
    open = false;
  }
</script>

<Sheet bind:open {title} {description} side="right" guard={false}>
  <div class="sticky top-0 z-10 -mx-1 flex flex-col gap-2 bg-surface px-1 pt-1 pb-3">
    <label class="flex h-11 items-center gap-2 rounded-xl border border-line-2 bg-surface px-3 focus-within:border-ink">
      <Search class="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <input bind:value={query} class="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3" placeholder={t("aiAdmin.picker.search")} aria-label={t("aiAdmin.picker.search")} />
    </label>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
      <span class="mr-auto">{t("aiAdmin.picker.count", { n: models.length + groups.length + audioModels.length })}</span>
      {#if byProvider.length > 1}
        <button type="button" class="-mx-1 inline-flex h-8 items-center gap-1 rounded-full px-2 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink" onclick={() => sections?.setAll(!allOpen)}>
          {#if allOpen}<ChevronsDownUp class="size-3.5" aria-hidden="true" />{t("aiAdmin.picker.collapseAll")}{:else}<ChevronsUpDown class="size-3.5" aria-hidden="true" />{t("aiAdmin.picker.expandAll")}{/if}
        </button>
      {/if}
      <span class="inline-flex items-center gap-2">{t("aiAdmin.picker.showHidden")}<Switch bind:checked={showHidden} label={t("aiAdmin.picker.showHidden")} /></span>
    </div>
  </div>

  {#if !capability}
    <p class="py-8 text-center text-[13px] text-ink-3">{t("aiAdmin.picker.mixed")}</p>
  {:else}
    {#if groups.length}
      <h3 class="mt-1 mb-1.5 text-[12.5px] font-semibold text-ink-2">{t("aiAdmin.picker.groups")}</h3>
      <ul class="mb-4 flex flex-col gap-1">
        {#each groups as g (g.id)}
          <li>
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-surface-2 {current === `group:${g.id}` ? 'border-ink' : 'border-line'}"
              onclick={() => pick({ group_id: g.id }, g.name)}
            >
              <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2"><Boxes class="size-4" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[14px] font-medium"><Highlight text={g.name} {query} /></span>
                <span class="block text-[12px] text-ink-3">{t(strategyKey(g.strategy))} · {t("aiAdmin.groups.memberCount", { n: g.members.length })}</span>
              </span>
              {#if current === `group:${g.id}`}<Check class="size-4 shrink-0" />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if capability === "asr"}
      <p class="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-3">{t("aiAdmin.asr.pickerHint")}</p>
    {/if}
    {#if byProvider.length}
      {#if groups.length || audioModels.length}<h3 class="mt-1 mb-1.5 text-[12.5px] font-semibold text-ink-2">{capability === "asr" ? t("aiAdmin.asr.dedicated") : t("aiAdmin.picker.models")}</h3>{/if}
      <ProviderSections bind:this={sections} bind:allOpen sections={byProvider} storageKey="picker:{capability}:{title}" focusId={currentProvider} {query}>
        {#snippet item(m: ModelProfile)}
          <li>
            <button
              type="button"
              data-acc-nav
              class="flex min-h-12 w-full items-center gap-3 rounded-xl border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 {current === `model:${m.id}` ? 'border-ink' : 'border-line'} {m.enabled ? '' : 'opacity-60'}"
              onclick={() => pick({ model_id: m.id }, m.model_id)}
            >
              <StateDot state={dot(modelHealth(m, adminStore.providers, adminStore.bindings))} />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]"><Highlight text={m.model_id} {query} /></span>
                <ProfileBadges model={m} class="mt-1" />
              </span>
              {#if current === `model:${m.id}`}<Check class="size-4 shrink-0" />{/if}
            </button>
          </li>
        {/snippet}
      </ProviderSections>
    {/if}
    {#if audioModels.length}
      <h3 class="mt-4 mb-1 text-[12.5px] font-semibold text-ink-2">{t("aiAdmin.asr.multimodal")}</h3>
      <p class="mb-2 text-[12px] text-ink-3">{t("aiAdmin.asr.multimodalHint")}</p>
      <ul class="flex flex-col gap-1">
        {#each audioModels as m (m.id)}
          <li>
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 rounded-xl border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 {current === `model:${m.id}` ? 'border-ink' : 'border-line'} {m.enabled ? '' : 'opacity-60'}"
              onclick={() => pick({ model_id: m.id }, m.model_id)}
            >
              <StateDot state={dot(modelHealth(m, adminStore.providers, adminStore.bindings))} />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]"><Highlight text={m.model_id} {query} /></span>
                <span class="mt-1 flex flex-wrap items-center gap-1">
                  <span class="inline-flex h-[18px] items-center gap-1 rounded-md bg-[var(--pill-sky)] px-1.5 text-[10.5px] font-semibold text-[var(--pill-sky-ink)]"><AudioLines class="size-3" aria-hidden="true" />{t("aiAdmin.asr.badge")}</span>
                  <span class="truncate text-[11.5px] text-ink-3">{m.provider_name}</span>
                </span>
              </span>
              {#if current === `model:${m.id}`}<Check class="size-4 shrink-0" />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if !byProvider.length && !groups.length && !audioModels.length}
      <p class="py-8 text-center text-[13px] text-ink-3">{t("aiAdmin.picker.empty")}</p>
    {/if}
  {/if}
</Sheet>
