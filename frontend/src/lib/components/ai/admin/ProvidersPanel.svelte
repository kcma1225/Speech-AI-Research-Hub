<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Cpu, Ellipsis, KeyRound, LogIn, LogOut, Pencil, Plug, Plus, Power, RefreshCw, Server, Trash2 } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type Category, type Family, type Provider, type TestResult } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { L } from "#lib/ai/form.ts";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import ProviderIcon from "../ProviderIcon.svelte";
  import StateDot from "../StateDot.svelte";
  import OAuthSheet from "./OAuthSheet.svelte";
  import ProviderSheet from "./ProviderSheet.svelte";
  import TestResultView from "./TestResultView.svelte";

  let { family, title, onShowModels }: { family: Family; title?: string; onShowModels?: (providerId: string) => void } = $props();

  const list = $derived(adminStore.providers?.filter(p => p.family === family) ?? null);
  const groups = $derived(
    (["external", "local", "subscription"] as Category[])
      .map(c => ({ category: c, items: (list ?? []).filter(p => p.category === c) }))
      .filter(g => g.items.length),
  );

  let sheetOpen = $state(false);
  let editing = $state<Provider | null>(null);
  let oauthOpen = $state(false);
  let oauthTarget = $state<Provider | null>(null);
  let confirmOpen = $state(false);
  let target = $state<Provider | null>(null);
  let testing = $state<string | null>(null);
  let results = $state<Record<string, { result?: TestResult; error?: AiErrorBody }>>({});
  let addButton = $state<HTMLElement | null>(null);

  function add() {
    editing = null;
    sheetOpen = true;
  }
  function edit(p: Provider) {
    editing = p;
    sheetOpen = true;
  }

  async function saved(p: Provider, opts: { login: boolean }) {
    toasts.show(t(editing ? "aiAdmin.providers.saved" : "aiAdmin.providers.created", { name: p.name }), "success");
    await adminStore.reloadProviders();
    if (opts.login) {
      oauthTarget = adminStore.providers?.find(x => x.id === p.id) ?? p;
      oauthOpen = true;
    }
  }

  async function runTest(p: Provider) {
    testing = p.id;
    try {
      const result = await aiApi.post<TestResult>(`/admin/ai/providers/${p.id}/test`);
      results = { ...results, [p.id]: { result } };
      if (result.probe.ok) toasts.show(result.models_synced != null ? t("aiAdmin.providers.testOkSynced", { name: p.name, n: result.models_synced }) : t("aiAdmin.providers.testOk", { name: p.name }), "success");
      await Promise.all([adminStore.reloadProviders(), adminStore.reloadModels()]);
    } catch (e) {
      results = { ...results, [p.id]: { error: toErrorBody(e) } };
    } finally {
      testing = null;
    }
  }

  async function toggle(p: Provider) {
    try {
      await aiApi.patch(`/admin/ai/providers/${p.id}`, { enabled: !p.enabled });
      await adminStore.reloadProviders();
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    }
  }

  async function logout(p: Provider) {
    try {
      await aiApi.post(`/admin/ai/providers/${p.id}/oauth/logout`);
      toasts.show(t("aiAdmin.providers.loggedOut", { name: p.name }), "success");
      await adminStore.reloadProviders();
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    }
  }

  let deleteError = $state<AiErrorBody | null>(null);
  async function remove() {
    const p = target;
    if (!p) return;
    deleteError = null;
    try {
      await aiApi.del(`/admin/ai/providers/${p.id}`);
      toasts.show(t("aiAdmin.providers.deleted", { name: p.name }), "success");
      await adminStore.reloadProviders();
    } catch (e) {
      deleteError = toErrorBody(e);
      throw e;
    }
  }

  const probeState = (p: Provider) => (!p.enabled ? "unconfigured" : !p.last_probe ? "unknown" : p.last_probe.ok ? "up" : "down");
  const groupLabel = (c: Category) => t(`aiAdmin.providers.group.${c}`);
  const oauthLabel = (p: Provider) => t(`aiAdmin.providers.oauth.${p.oauth_meta?.status ?? "none"}`);
  const isLogin = (p: Provider) => p.kind === "chatgpt" || p.kind === "claude-oauth";
</script>

<section class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    {#if title}<h2 class="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>{/if}
    <Button bind:ref={addButton} variant="primary" class="ml-auto" onclick={add}><Plus />{t("aiAdmin.providers.add")}</Button>
  </div>

  {#if adminStore.registry && !adminStore.registry.secrets_key_configured}
    <AiErrorPanel compact error={{ error: t("aiAdmin.keyMissing"), code: "secrets_key_missing" }} />
  {/if}

  {#if !list}
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{#each [0, 1, 2] as i (i)}<Skeleton class="h-40" />{/each}</div>
  {:else if !list.length}
    <Card>
      <EmptyState title={t("aiAdmin.providers.empty")} hint={t("aiAdmin.providers.emptyHint")}>
        {#snippet icon()}<Server />{/snippet}
        {#snippet action()}<Button variant="primary" onclick={add}><Plus />{t("aiAdmin.providers.add")}</Button>{/snippet}
      </EmptyState>
    </Card>
  {:else}
    {#each groups as g (g.category)}
      <div class="flex flex-col gap-2.5">
        <h3 class="px-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{groupLabel(g.category)}</h3>
        <ul class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {#each g.items as p (p.id)}
            {@const r = results[p.id]}
            <li class="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line/70 bg-surface p-4 shadow-card {p.enabled ? '' : 'opacity-70'}">
              <div class="flex items-start gap-3">
                <ProviderIcon kind={p.kind} label={L(p.label)} size="lg" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[15px] font-semibold text-ink">{p.name}</p>
                  <p class="truncate text-[12.5px] text-ink-3">{L(p.label) || p.kind}</p>
                </div>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger aria-label={t("aiAdmin.more")} class="-mr-1 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink data-[state=open]:bg-surface-3">
                    <Ellipsis class="size-4.5" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={6} class={menuContent}>
                      <DropdownMenu.Item class={menuItem} onSelect={() => edit(p)}><Pencil />{t("aiAdmin.providers.edit")}</DropdownMenu.Item>
                      <DropdownMenu.Item class={menuItem} onSelect={() => toggle(p)}><Power />{p.enabled ? t("aiAdmin.providers.disable") : t("aiAdmin.providers.enable")}</DropdownMenu.Item>
                      {#if isLogin(p) && p.oauth_meta?.status !== "none"}
                        <DropdownMenu.Item class={menuItem} onSelect={() => logout(p)}><LogOut />{t("aiAdmin.providers.logout")}</DropdownMenu.Item>
                      {/if}
                      <DropdownMenu.Separator class={menuSeparator} />
                      <DropdownMenu.Item
                        class="{menuItem} text-danger [&_svg]:!text-danger"
                        onSelect={() => {
                          target = p;
                          deleteError = null;
                          confirmOpen = true;
                        }}><Trash2 />{t("aiAdmin.providers.delete")}</DropdownMenu.Item
                      >
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-1.5">
                {#if !p.enabled}<Pill tone="stone" size="sm">{t("aiAdmin.providers.disabled")}</Pill>{/if}
                {#if isLogin(p)}
                  <Pill tone={p.oauth_meta?.status === "connected" ? "mint" : p.oauth_meta?.status === "needs_reauth" ? "rose" : "stone"} size="sm" dot>{oauthLabel(p)}</Pill>
                {/if}
                {#each Object.entries(p.secrets_set) as [k, set] (k)}
                  {#if set}<span class="inline-flex h-5 items-center gap-1 rounded-full bg-surface-3 px-2 text-[11px] text-ink-2"><KeyRound class="size-3" />••••</span>{/if}
                {/each}
                <span class="text-[12px] text-ink-3">{p.used_by.length ? t("aiAdmin.providers.usedBy", { n: p.used_by.length }) : t("aiAdmin.providers.unused")}</span>
                {#if onShowModels}
                  <button type="button" class="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink" onclick={() => onShowModels(p.id)}><Cpu class="size-3.5" />{t("aiAdmin.providers.models", { n: p.model_count })}</button>
                {/if}
              </div>
              {#if p.base_url}<p class="mt-2 truncate font-mono text-[11.5px] text-ink-3" title={p.base_url}>{p.base_url}</p>{/if}

              <div class="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px]">
                <StateDot state={probeState(p)} class="mt-1" />
                <p class="min-w-0 flex-1 leading-snug text-ink-2">
                  {#if !p.last_probe}{t("aiAdmin.providers.probe.never")}
                  {:else}
                    <span class="font-medium">{p.last_probe.ok ? t("aiAdmin.providers.probe.ok") : t("aiAdmin.providers.probe.failed")}</span>
                    <span class="text-ink-3"> · {p.last_probe.detail_zh.replace(/[。.]\s*$/, "")}{#if p.last_probe_at}{" · "}{t("aiAdmin.providers.probedAt", { time: relativeTime(p.last_probe_at) })}{/if}</span>
                  {/if}
                </p>
              </div>
              {#if r?.error}<AiErrorPanel class="mt-3" compact error={r.error} />{/if}
              {#if r?.result && !r.result.probe.ok}<TestResultView class="mt-3" result={r.result} />{/if}

              <div class="mt-auto flex flex-wrap gap-2 pt-3">
                {#if isLogin(p)}
                  <Button
                    size="sm"
                    variant={p.oauth_meta?.status === "connected" ? "secondary" : "primary"}
                    onclick={() => {
                      oauthTarget = p;
                      oauthOpen = true;
                    }}><LogIn />{p.oauth_meta?.status === "connected" ? t("aiAdmin.providers.relogin") : t("aiAdmin.providers.login")}</Button
                  >
                {/if}
                <Button size="sm" variant="secondary" loading={testing === p.id} onclick={() => runTest(p)}>{#if p.family === "llm"}<RefreshCw />{t("aiAdmin.providers.testSync")}{:else}<Plug />{t("aiAdmin.providers.test")}{/if}</Button>
                <Button size="sm" variant="ghost" onclick={() => edit(p)}><Pencil />{t("aiAdmin.providers.edit")}</Button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</section>

<ProviderSheet bind:open={sheetOpen} {family} provider={editing} onSaved={saved} />
<OAuthSheet bind:open={oauthOpen} provider={oauthTarget} onDone={() => adminStore.reloadProviders()} />
<ConfirmDialog
  bind:open={confirmOpen}
  title={t("aiAdmin.providers.deleteTitle", { name: target?.name ?? "" })}
  description={deleteError ? `${deleteError.error} ${deleteError.hint ?? ""}` : t("aiAdmin.providers.deleteHint")}
  confirmLabel={t("aiAdmin.providers.delete")}
  onConfirm={remove}
  returnFocus={addButton}
/>
