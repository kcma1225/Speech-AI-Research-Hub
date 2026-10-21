<script lang="ts">
  import { Boxes, Check, Search } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { Capability, GroupStrategy, ModelProfile, TargetInput } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { dot, modelHealth, modelsFor, providerTone } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import StateDot from "../StateDot.svelte";
  import ProfileBadges from "./ProfileBadges.svelte";

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
  const byProvider = $derived.by(() => {
    const out: Array<{ id: string; name: string; items: ModelProfile[] }> = [];
    for (const m of models) {
      let g = out.find(x => x.id === m.provider_id);
      if (!g) out.push((g = { id: m.provider_id, name: m.provider_name ?? "?", items: [] }));
      g.items.push(m);
    }
    for (const g of out) g.items.sort((a, b) => Number(b.used_by.length > 0) - Number(a.used_by.length > 0) || a.model_id.localeCompare(b.model_id));
    return out;
  });
  const strategyKey = (s: GroupStrategy) => `aiAdmin.strategy.${s}` as MessageKey;
  function pick(target: TargetInput, label: string) {
    onPick(target, label);
    open = false;
  }
</script>

<Sheet bind:open {title} {description} side="right">
  <div class="sticky top-0 z-10 -mx-1 flex flex-col gap-2 bg-surface px-1 pt-1 pb-3">
    <label class="flex h-11 items-center gap-2 rounded-xl border border-line-2 bg-surface px-3 focus-within:border-ink">
      <Search class="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <input bind:value={query} class="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3" placeholder={t("aiAdmin.picker.search")} aria-label={t("aiAdmin.picker.search")} />
    </label>
    <div class="flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
      <span>{t("aiAdmin.picker.count", { n: models.length + groups.length })}</span>
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
                <span class="block truncate text-[14px] font-medium">{g.name}</span>
                <span class="block text-[12px] text-ink-3">{t(strategyKey(g.strategy))} · {t("aiAdmin.groups.memberCount", { n: g.members.length })}</span>
              </span>
              {#if current === `group:${g.id}`}<Check class="size-4 shrink-0" />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#each byProvider as pg (pg.id)}
      <h3 class="mt-1 mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-ink-2">
        <span class="size-2.5 rounded-sm" style="background: var(--pill-{providerTone(pg.id)}-ink)"></span>{pg.name}
      </h3>
      <ul class="mb-4 flex flex-col gap-1">
        {#each pg.items as m (m.id)}
          <li>
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-surface-2 {current === `model:${m.id}` ? 'border-ink' : 'border-line'} {m.enabled ? '' : 'opacity-60'}"
              onclick={() => pick({ model_id: m.id }, m.model_id)}
            >
              <StateDot state={dot(modelHealth(m, adminStore.providers, adminStore.bindings))} />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]">{m.model_id}</span>
                <ProfileBadges model={m} class="mt-1" />
              </span>
              {#if current === `model:${m.id}`}<Check class="size-4 shrink-0" />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      {#if !groups.length}<p class="py-8 text-center text-[13px] text-ink-3">{t("aiAdmin.picker.empty")}</p>{/if}
    {/each}
  {/if}
</Sheet>
