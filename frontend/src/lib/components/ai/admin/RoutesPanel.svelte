<script lang="ts">
  import { ArrowRight, GitBranch, Pencil, Plus, Route as RouteIcon, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, ROLE_KEYS, toErrorBody, type AiErrorBody, type Capability, type Route } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import RouteEditor from "./RouteEditor.svelte";

  let { capabilities, title }: { capabilities: Capability[]; title?: string } = $props();
  const list = $derived(adminStore.routes?.filter(r => capabilities.includes(r.capability)) ?? null);

  let editing = $state<Route | null | undefined>(undefined);
  let target = $state<Route | null>(null);
  let confirmOpen = $state(false);
  let deleteError = $state<AiErrorBody | null>(null);
  let top = $state<HTMLElement | null>(null);

  async function remove() {
    const r = target;
    if (!r) return;
    deleteError = null;
    try {
      await aiApi.del(`/admin/ai/routes/${r.id}`);
      toasts.show(t("aiAdmin.routes.deleted", { name: r.name }), "success");
      await Promise.all([adminStore.reloadRoutes(), adminStore.reloadProviders()]);
    } catch (e) {
      deleteError = toErrorBody(e);
      throw e;
    }
  }

  function close() {
    editing = undefined;
    top?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const capKey = (c: Capability) => `aiAdmin.cap.${c}` as MessageKey;
  const strategyKey = (r: Route) => `aiAdmin.routes.strategy.${r.strategy}` as MessageKey;
  const capTone = { chat: "sky", embedding: "lilac", asr: "peach" } as const;
</script>

<div bind:this={top} class="scroll-mt-24"></div>
{#if editing !== undefined}
  <RouteEditor route={editing} {capabilities} onClose={close} />
{:else}
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      {#if title}<h2 class="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>{/if}
      <Button variant="primary" class="ml-auto" onclick={() => (editing = null)}><Plus />{t("aiAdmin.routes.add")}</Button>
    </div>
    {#if !list}
      <div class="grid gap-3 md:grid-cols-2">{#each [0, 1] as i (i)}<Skeleton class="h-36" />{/each}</div>
    {:else if !list.length}
      <Card>
        <EmptyState title={t("aiAdmin.routes.empty")} hint={t("aiAdmin.routes.emptyHint")}>
          {#snippet icon()}<RouteIcon />{/snippet}
          {#snippet action()}<Button variant="primary" onclick={() => (editing = null)}><Plus />{t("aiAdmin.routes.add")}</Button>{/snippet}
        </EmptyState>
      </Card>
    {:else}
      <ul class="grid gap-3 md:grid-cols-2">
        {#each list as r (r.id)}
          <li class="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line/70 bg-surface p-4 shadow-card">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[15px] font-semibold">{r.name}</p>
                {#if r.description}<p class="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{r.description}</p>{/if}
              </div>
              <div class="flex shrink-0 gap-1.5">
                <Pill tone={capTone[r.capability]} size="sm">{t(capKey(r.capability))}</Pill>
                <Pill tone="stone" size="sm">{t(strategyKey(r))}</Pill>
              </div>
            </div>
            <ol class="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              {#each r.members as m, i (m.id ?? i)}
                {#if i > 0}<li aria-hidden="true" class="text-ink-3"><ArrowRight class="size-3.5" /></li>{/if}
                <li class="inline-flex max-w-full items-center gap-1 truncate rounded-lg border border-line px-2 py-1 {m.enabled ? '' : 'line-through opacity-60'}">
                  {#if m.child_route_id}<GitBranch class="size-3.5 shrink-0 text-ink-3" /><span class="truncate">{m.child_route_name}</span>
                  {:else}<span class="truncate text-ink-3">{m.provider_name}</span><span class="text-ink-3">/</span><span class="truncate font-mono text-[11.5px]">{m.model}</span>{/if}
                  {#if r.strategy === "load_balance"}<span class="text-ink-3">×{m.weight}</span>{/if}
                </li>
              {:else}
                <li class="text-ink-3">{t("aiAdmin.routes.noMembers")}</li>
              {/each}
            </ol>
            <div class="mt-3 flex flex-wrap gap-1.5 text-[12px] text-ink-3">
              {#if r.bound_roles.length}
                {#each r.bound_roles as role (role)}<Pill tone="mint" size="sm" dot>{t(ROLE_KEYS[role].label)}</Pill>{/each}
              {:else}<span>{t("aiAdmin.routes.notBound")}</span>{/if}
              {#if r.used_by.length}<span>· {t("aiAdmin.routes.childOf", { names: r.used_by.map(u => u.route_name).join("、") })}</span>{/if}
            </div>
            <div class="mt-auto flex gap-2 pt-3">
              <Button size="sm" variant="secondary" onclick={() => (editing = r)}><Pencil />{t("aiAdmin.providers.edit")}</Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("aiAdmin.routes.deleteTitle", { name: r.name })}
                onclick={() => {
                  target = r;
                  deleteError = null;
                  confirmOpen = true;
                }}><Trash2 />{t("aiAdmin.providers.delete")}</Button
              >
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={t("aiAdmin.routes.deleteTitle", { name: target?.name ?? "" })}
  description={deleteError ? `${deleteError.error} ${deleteError.hint ?? ""}` : t("aiAdmin.routes.deleteHint")}
  confirmLabel={t("aiAdmin.providers.delete")}
  onConfirm={remove}
/>
