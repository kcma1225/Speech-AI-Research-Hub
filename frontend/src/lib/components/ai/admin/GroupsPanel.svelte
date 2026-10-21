<script lang="ts">
  import { Boxes, Pencil, Plus, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, ROLE_KEYS, toErrorBody, type AiErrorBody, type Group } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import GroupEditor from "./GroupEditor.svelte";
  import GroupStack from "./diagram/GroupStack.svelte";

  /** 群組: named strategies over models and child groups. A role binds to one model or one group. */
  let { editId = $bindable(null) }: { editId?: string | null } = $props();
  let editing = $state<Group | null | undefined>(undefined);
  // Opened from the overview diagram ("edit this group").
  $effect(() => {
    if (!editId || !adminStore.groups) return;
    const g = adminStore.groups.find(x => x.id === editId);
    if (g) editing = g;
    editId = null;
  });
  let target = $state<Group | null>(null);
  let confirmOpen = $state(false);
  let deleteError = $state<AiErrorBody | null>(null);
  let top = $state<HTMLElement | null>(null);

  async function remove() {
    const g = target;
    if (!g) return;
    deleteError = null;
    try {
      await aiApi.del(`/admin/ai/groups/${g.id}`);
      toasts.show(t("aiAdmin.groups.deleted", { name: g.name }), "success");
      await adminStore.reloadRouting();
    } catch (e) {
      deleteError = toErrorBody(e);
      throw e;
    }
  }
  function close() {
    editing = undefined;
    top?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const capTone = { chat: "sky", embedding: "lilac", asr: "peach" } as const;
</script>

<div bind:this={top} class="scroll-mt-24"></div>
{#if editing !== undefined}
  <GroupEditor group={editing} onClose={close} />
{:else}
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-[62ch] text-[13.5px] text-ink-3">{t("aiAdmin.groups.intro")}</p>
      <Button variant="primary" class="ml-auto" onclick={() => (editing = null)}><Plus />{t("aiAdmin.groups.add")}</Button>
    </div>
    {#if !adminStore.groups}
      <div class="grid gap-3 md:grid-cols-2">{#each [0, 1] as i (i)}<Skeleton class="h-44" />{/each}</div>
    {:else if !adminStore.groups.length}
      <Card>
        <EmptyState title={t("aiAdmin.groups.empty")} hint={t("aiAdmin.groups.emptyHint")}>
          {#snippet icon()}<Boxes />{/snippet}
          {#snippet action()}<Button variant="primary" onclick={() => (editing = null)}><Plus />{t("aiAdmin.groups.add")}</Button>{/snippet}
        </EmptyState>
      </Card>
    {:else}
      <ul class="grid gap-3 md:grid-cols-2">
        {#each adminStore.groups as g (g.id)}
          <li class="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line/70 bg-surface p-4 shadow-card">
            <div class="mb-2 flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[15px] font-semibold">{g.name}</p>
                {#if g.description}<p class="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{g.description}</p>{/if}
              </div>
              <Pill tone={capTone[g.capability]} size="sm">{t(`aiAdmin.cap.${g.capability}` as MessageKey)}</Pill>
            </div>
            <GroupStack group={g} />
            <div class="mt-3 flex flex-wrap gap-1.5 text-[12px] text-ink-3">
              {#if g.bound_roles.length}
                {#each g.bound_roles as role (role)}<Pill tone="mint" size="sm" dot>{t(ROLE_KEYS[role].label)}</Pill>{/each}
              {:else if !g.used_by.length}<span>{t("aiAdmin.groups.notBound")}</span>{/if}
              {#if g.used_by.length}<span>{t("aiAdmin.groups.childOf", { names: g.used_by.map(u => u.name).join("、") })}</span>{/if}
            </div>
            <div class="mt-auto flex gap-2 pt-3">
              <Button size="sm" variant="secondary" onclick={() => (editing = g)}><Pencil />{t("aiAdmin.providers.edit")}</Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("aiAdmin.groups.deleteTitle", { name: g.name })}
                onclick={() => {
                  target = g;
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
  title={t("aiAdmin.groups.deleteTitle", { name: target?.name ?? "" })}
  description={deleteError ? `${deleteError.error} ${deleteError.hint ?? ""}` : t("aiAdmin.groups.deleteHint")}
  confirmLabel={t("aiAdmin.providers.delete")}
  onConfirm={remove}
/>
