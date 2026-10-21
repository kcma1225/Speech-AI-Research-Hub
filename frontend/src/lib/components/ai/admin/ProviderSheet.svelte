<script lang="ts">
  import { ArrowLeft, Check, ExternalLink, Search, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type Category, type Family, type Provider, type RegistryEntry, type TestResult } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { L, rawFromConfig, toPayload, visible, type RawValues } from "#lib/ai/form.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import ProviderIcon from "../ProviderIcon.svelte";
  import DynamicField from "./DynamicField.svelte";
  import TestResultView from "./TestResultView.svelte";

  /** Add flow (searchable vendor picker → form from the registry) or edit an existing account. */
  let { open = $bindable(false), family, provider = null, onSaved }: { open?: boolean; family: Family; provider?: Provider | null; onSaved: (p: Provider, opts: { login: boolean }) => void } = $props();

  let entry = $state<RegistryEntry | null>(null);
  let query = $state("");
  let cat = $state<"all" | Category>("all");
  let name = $state("");
  let enabled = $state(true);
  let raw = $state<RawValues>({});
  let cleared = $state(new Set<string>());
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);
  let testing = $state(false);
  let saveError = $state<AiErrorBody | null>(null);
  let test = $state<TestResult | null>(null);
  let testError = $state<AiErrorBody | null>(null);
  let checkModel = $state("");

  const entries = $derived((family === "llm" ? adminStore.registry?.llm : adminStore.registry?.asr) ?? []);
  const filtered = $derived(
    entries.filter(e => (cat === "all" || e.category === cat) && (!query.trim() || `${e.label.zh} ${e.label.en} ${e.id}`.toLowerCase().includes(query.trim().toLowerCase()))),
  );
  const cats = $derived<Array<{ value: "all" | Category; label: string }>>([
    { value: "all", label: t("aiAdmin.sheet.all") },
    { value: "external", label: t("aiAdmin.providers.group.external") },
    { value: "local", label: t("aiAdmin.providers.group.local") },
    ...(family === "llm" ? [{ value: "subscription" as const, label: t("aiAdmin.providers.group.subscription") }] : []),
  ]);
  const warnings = $derived(entry?.quirks?.warnings_zh ?? []);
  const embedOnly = $derived(Boolean(entry?.capabilities && !entry.capabilities.chat && entry.capabilities.embeddings));

  // Reset whenever the sheet opens.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      query = "";
      cat = "all";
      test = testError = saveError = null;
      errors = {};
      cleared = new Set();
      checkModel = "";
      if (provider) {
        const e = adminStore.entry(provider.family, provider.kind) ?? null;
        entry = e;
        name = provider.name;
        enabled = provider.enabled;
        raw = e ? rawFromConfig(e.fields, provider.config) : {};
      } else {
        entry = null;
        name = "";
        enabled = true;
      }
    }
    wasOpen = open;
  });

  function pick(e: RegistryEntry) {
    entry = e;
    raw = rawFromConfig(e.fields, {});
    name = L(e.label).replace(/（.*?）|\(.*?\)/g, "").trim();
    test = testError = saveError = null;
  }

  function payload() {
    const p = toPayload(entry!.fields, raw, cleared);
    errors = p.errors;
    return Object.keys(p.errors).length ? null : p;
  }

  async function runTest() {
    if (!entry) return;
    const p = payload();
    if (!p) return;
    testing = true;
    test = testError = null;
    try {
      test = await aiApi.post<TestResult>("/admin/ai/providers/test", {
        family,
        kind: entry.id,
        name: name || "draft",
        config: p.config,
        secrets: Object.fromEntries(Object.entries(p.secrets).filter(([, v]) => v !== null)),
        ...(provider ? { base_id: provider.id } : {}),
        ...(checkModel.trim() ? { model: checkModel.trim(), capability: embedOnly ? "embedding" : "chat" } : {}),
      });
    } catch (e) {
      testError = toErrorBody(e);
    } finally {
      testing = false;
    }
  }

  async function save() {
    if (!entry) return;
    const p = payload();
    if (!p) return;
    saving = true;
    saveError = null;
    try {
      let saved: Provider;
      if (provider) {
        saved = (await aiApi.patch<{ provider: Provider }>(`/admin/ai/providers/${provider.id}`, { name, config: p.config, secrets: p.secrets, enabled })).provider;
      } else {
        const secrets = Object.fromEntries(Object.entries(p.secrets).filter(([, v]) => v !== null));
        saved = (await aiApi.post<{ provider: Provider }>("/admin/ai/providers", { family, kind: entry.id, name, config: p.config, secrets, enabled })).provider;
      }
      // Fill the model profiles right away (limits and capabilities come from the listing + catalog).
      void aiApi.post(`/admin/ai/providers/${saved.id}/sync`).then(
        () => adminStore.reloadModels(),
        () => undefined,
      );
      open = false;
      onSaved(saved, { login: !provider && entry.subscription && entry.id !== "claude-cli" });
    } catch (e) {
      saveError = toErrorBody(e);
      const issues = (saveError.detail?.issues ?? []) as Array<{ key: string; message_zh: string }>;
      errors = Object.fromEntries(issues.map(i => [i.key, i.message_zh]));
    } finally {
      saving = false;
    }
  }

  const capChips = (e: RegistryEntry) => {
    const c = e.capabilities;
    if (!c) return [e.live ? t("aiAdmin.cap.live") : null].filter(Boolean) as string[];
    return [c.chat && t("aiAdmin.cap.chat"), c.tools && t("aiAdmin.cap.tools"), c.embeddings && t("aiAdmin.cap.embedding"), c.vision && t("aiAdmin.cap.vision"), c.reasoning && t("aiAdmin.cap.reasoning")].filter(Boolean) as string[];
  };
</script>

<Sheet bind:open side="right" title={provider ? t("aiAdmin.sheet.editTitle", { name: provider.name }) : t("aiAdmin.sheet.addTitle")} description={entry ? L(entry.label) : t("aiAdmin.sheet.pickVendor")}>
  {#snippet icon()}{#if entry}<ProviderIcon kind={entry.id} label={L(entry.label)} size="md" />{/if}{/snippet}
  {#snippet children()}
    {#if !entry}
      <div class="flex flex-col gap-3 pt-1">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            bind:value={query}
            placeholder={t("aiAdmin.sheet.search")}
            aria-label={t("aiAdmin.sheet.search")}
            class="h-11 w-full rounded-xl border border-line-2 bg-surface pr-3 pl-10 text-[15px] outline-none placeholder:text-ink-3 focus:border-ink sm:text-sm"
          />
        </div>
        <div class="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"><Segmented bind:value={cat} guardIgnore options={cats} label={t("aiAdmin.sheet.pickVendor")} class="min-w-max" /></div>
        <ul class="flex flex-col gap-1.5" aria-label={t("aiAdmin.sheet.pickVendor")}>
          {#each filtered as e (e.id)}
            <li>
              <button
                type="button"
                onclick={() => pick(e)}
                class="flex w-full items-start gap-3 rounded-2xl border border-line px-3.5 py-3 text-left transition-colors hover:border-line-2 hover:bg-surface-2 focus-visible:border-ink"
              >
                <ProviderIcon kind={e.id} label={L(e.label)} size="md" />
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <span class="text-[14px] font-medium text-ink">{L(e.label)}</span>
                    {#if e.subscription}<Pill tone="butter" size="sm">{t("aiAdmin.providers.group.subscription")}</Pill>{/if}
                  </span>
                  {#if e.help_zh}<span class="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-ink-3">{e.help_zh}</span>{/if}
                  <span class="mt-1.5 flex flex-wrap gap-1">
                    {#each capChips(e) as c (c)}<span class="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">{c}</span>{/each}
                  </span>
                </span>
              </button>
            </li>
          {:else}
            <li class="py-8 text-center text-[13px] text-ink-3">{t("aiAdmin.sheet.noMatch")}</li>
          {/each}
        </ul>
      </div>
    {:else}
      <form class="flex flex-col gap-4 pt-1" onsubmit={e => (e.preventDefault(), void save())}>
        <div class="flex flex-wrap items-center gap-2">
          {#if !provider}
            <Button size="sm" variant="ghost" class="-ml-2" onclick={() => (entry = null)}><ArrowLeft />{t("aiAdmin.sheet.back")}</Button>
          {/if}
          {#if entry.docsUrl}
            <Button size="sm" variant="ghost" href={entry.docsUrl} target="_blank" class="ml-auto">{t("aiAdmin.sheet.docs")}<ExternalLink /></Button>
          {/if}
        </div>
        {#if !adminStore.registry?.secrets_key_configured}
          <AiErrorPanel compact error={{ error: t("aiAdmin.keyMissing"), code: "secrets_key_missing" }} />
        {/if}
        {#if warnings.length}
          <div class="rounded-2xl border border-[var(--pill-butter-ink)]/25 bg-[var(--pill-butter)] p-3.5 text-[13px] text-[var(--pill-butter-ink)]">
            <p class="mb-1.5 flex items-center gap-1.5 font-semibold"><TriangleAlert class="size-4" />{t("aiAdmin.sheet.warnings")}</p>
            <ul class="list-disc space-y-1 pl-5 leading-snug">
              {#each warnings as w (w)}<li>{w}</li>{/each}
            </ul>
          </div>
        {:else if entry.help_zh}
          <p class="text-[13px] leading-relaxed text-ink-3">{entry.help_zh}</p>
        {/if}
        <TextField label="{t('aiAdmin.sheet.name')} *" bind:value={name} hint={t("aiAdmin.sheet.nameHint")} error={errors.name ?? null} maxlength={80} required />
        {#each entry.fields as f (f.key)}
          {#if visible(f, raw)}
            <DynamicField
              field={f}
              bind:value={raw[f.key]!}
              secretSet={Boolean(provider?.secrets_set[f.key])}
              cleared={cleared.has(f.key)}
              onClear={() => {
                const next = new Set(cleared);
                if (next.has(f.key)) next.delete(f.key);
                else next.add(f.key);
                cleared = next;
              }}
              error={errors[f.key] ?? null}
            />
          {/if}
        {/each}
        {#if provider}
          <div class="flex items-center justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
            <span class="text-[13.5px] font-medium">{t("aiAdmin.sheet.enabled")}</span>
            <Switch bind:checked={enabled} label={t("aiAdmin.sheet.enabled")} />
          </div>
        {/if}
        {#if entry.subscription && entry.id !== "claude-cli"}
          <p class="text-[12.5px] text-ink-3">{t("aiAdmin.sheet.subscriptionNote")}</p>
        {:else}
          <section class="rounded-2xl bg-surface-2 p-3.5">
            {#if family === "llm"}
              <TextField label={t("aiAdmin.sheet.checkModelLabel")} bind:value={checkModel} placeholder={entry?.quirks?.staticModels?.[0] ?? entry?.defaultModel ?? (embedOnly ? "text-embedding-3-small" : "")} hint={embedOnly ? t("aiAdmin.sheet.checkEmbed") : t("aiAdmin.sheet.checkModel")} />
            {/if}
            <Button class="mt-3" variant="outline" loading={testing} onclick={runTest}>{#if test?.probe.ok && !testing}<Check />{/if}{t("aiAdmin.sheet.testDraft")}</Button>
            {#if testError}<AiErrorPanel class="mt-3" compact error={testError} />{/if}
            {#if test}<TestResultView class="mt-3" result={test} />{/if}
          </section>
        {/if}
        {#if saveError}<AiErrorPanel compact error={saveError} />{/if}
        <button type="submit" class="hidden" aria-hidden="true" tabindex="-1"></button>
      </form>
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if entry}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      <Button variant="primary" loading={saving} disabled={!name.trim()} onclick={save}>
        {!provider && entry.subscription && entry.id !== "claude-cli" ? t("aiAdmin.sheet.saveAndLogin") : t("aiAdmin.sheet.save")}
      </Button>
    {/if}
  {/snippet}
</Sheet>
