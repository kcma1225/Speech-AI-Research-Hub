<script lang="ts">
  import { Ban, Link2, Plus } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import InviteSheet from "./InviteSheet.svelte";
  import { roleLabel, roleTone, stateTone, tc, type Invitation } from "./manage.ts";

  let invitations = $state<Invitation[] | null>(null);
  let error = $state<string | null>(null);
  let sheetOpen = $state(false);
  let filter = $state<"active" | "all">("all");
  $effect(() => {
    api.get<{ invitations: Invitation[] }>("/invitations").then(r => (invitations = r.invitations), e => (error = e.message));
  });
  const activeCount = $derived(invitations?.filter(i => i.state === "active").length ?? 0);
  // Usable links first; the API already orders each group newest first.
  const shown = $derived(
    filter === "active" ? (invitations ?? []).filter(i => i.state === "active") : [...(invitations ?? [])].sort((a, b) => Number(b.state === "active") - Number(a.state === "active")),
  );

  let target = $state<Invitation | null>(null);
  let confirmOpen = $state(false);
  async function revoke() {
    const invite = target;
    if (!invite) return;
    try {
      await api.del(`/invitations/${invite.id}`);
      invitations = (invitations ?? []).map(i => (i.id === invite.id ? { ...i, state: "revoked", revoked_at: new Date().toISOString() } : i));
      toasts.show(t("manage.invites.revoked"), "success");
    } catch (err) {
      toasts.show((err as Error).message, "error");
    }
  }

  function expiry(invite: Invitation) {
    // A revoked or used-up link never becomes usable again, so its expiry date is noise.
    if (invite.state === "revoked" && invite.revoked_at) return t("manage.invites.revokedAt", { time: relativeTime(invite.revoked_at) });
    if (invite.state === "revoked" || invite.state === "exhausted") return "—";
    if (!invite.expires_at) return t("manage.invites.never");
    const past = new Date(invite.expires_at).getTime() <= Date.now();
    return t(past ? "manage.invites.expiredAt" : "manage.invites.expiresIn", { time: relativeTime(invite.expires_at) });
  }
  const fullDate = (iso: string) => formatDate(iso, { dateStyle: "medium", timeStyle: "short" });
</script>

{#snippet statePill(invite: Invitation)}
  <Pill tone={stateTone[invite.state]} dot>{t(`manage.invites.state.${invite.state}`)}</Pill>
{/snippet}

{#snippet uses(invite: Invitation)}
  <span class="tabular-nums">
    {#if invite.max_uses === null}
      {invite.use_count} <span class="text-ink-3">/ ∞</span>
    {:else}
      {t("manage.invites.usesOf", { used: invite.use_count, max: invite.max_uses })}
    {/if}
  </span>
{/snippet}

{#snippet joined(invite: Invitation)}
  {#if invite.uses?.length}
    <span class="flex items-center gap-2">
      <span class="flex -space-x-1.5">
        {#each invite.uses.slice(0, 4) as u (u.id)}<span title={u.name}><Avatar name={u.name} size={24} /></span>{/each}
      </span>
      {#if invite.uses.length === 1}<span class="truncate text-ink-2">{invite.uses[0]!.name}</span>{:else if invite.uses.length > 4}<span class="text-ink-3">+{invite.uses.length - 4}</span>{/if}
    </span>
  {:else}
    <span class="text-ink-3">{t("manage.invites.nobody")}</span>
  {/if}
{/snippet}

{#snippet revokeButton(invite: Invitation)}
  {#if invite.state === "active"}
    <Button
      size="sm"
      variant="ghost"
      class="hover:!text-danger"
      onclick={() => {
        target = invite;
        confirmOpen = true;
      }}><Ban />{t("manage.invites.revoke")}</Button
    >
  {/if}
{/snippet}

<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
  <div class="flex flex-wrap items-center gap-3">
    <Segmented
      bind:value={filter}
      label={t("manage.invites.filter")}
      options={[
        { value: "all", label: t("manage.invites.filter.all") },
        { value: "active", label: t("manage.invites.filter.active") },
      ]}
    />
    {#if invitations}<p class="hidden text-[13px] text-ink-3 sm:block">{tc("manage.invites.activeCount", activeCount)}</p>{/if}
  </div>
  <Button variant="primary" onclick={() => (sheetOpen = true)}><Plus />{t("manage.invites.create")}</Button>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !invitations}
  <Card padded={false}><div class="flex flex-col gap-2 p-5">{#each [0, 1, 2] as i (i)}<Skeleton class="h-12" />{/each}</div></Card>
{:else if !shown.length}
  <Card>
    <EmptyState title={t("manage.invites.empty")} hint={t("manage.invites.emptyHint")}>
      {#snippet icon()}<Link2 />{/snippet}
      {#snippet action()}<Button variant="secondary" onclick={() => (sheetOpen = true)}><Plus />{t("manage.invites.create")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else}
  <Card padded={false} class="overflow-hidden">
    <table class="hidden w-full text-left text-[13.5px] lg:table">
      <thead>
        <tr class="border-b border-line bg-surface-2/60 text-[12px] text-ink-3">
          <th class="py-2.5 pl-6 font-medium">{t("manage.invites.col.state")}</th>
          <th class="py-2.5 font-medium">{t("manage.invites.col.role")}</th>
          <th class="py-2.5 font-medium">{t("manage.invites.col.uses")}</th>
          <th class="py-2.5 font-medium">{t("manage.invites.col.expires")}</th>
          <th class="py-2.5 font-medium">{t("manage.invites.col.joined")}</th>
          <th class="py-2.5 font-medium">{t("manage.invites.col.created")}</th>
          <th class="py-2.5 pr-6"><span class="sr-only">{t("manage.members.col.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each shown as invite (invite.id)}
          <tr class="border-b border-line last:border-0 hover:bg-surface-2/60 {invite.state === 'active' ? '' : 'text-ink-3'}">
            <td class="py-3 pl-6">{@render statePill(invite)}</td>
            <td class="py-3"><Pill tone={roleTone[invite.role]}>{t(roleLabel(invite.role))}</Pill></td>
            <td class="py-3">{@render uses(invite)}</td>
            <td class="py-3 whitespace-nowrap" title={invite.state === "revoked" && invite.revoked_at ? fullDate(invite.revoked_at) : invite.expires_at ? fullDate(invite.expires_at) : undefined}>{expiry(invite)}</td>
            <td class="max-w-48 py-3">{@render joined(invite)}</td>
            <td class="py-3 whitespace-nowrap" title={fullDate(invite.created_at)}>{relativeTime(invite.created_at)}</td>
            <td class="py-3 pr-6 text-right">{@render revokeButton(invite)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <ul class="divide-y divide-line lg:hidden">
      {#each shown as invite (invite.id)}
        <li class="flex flex-col gap-2.5 p-4 text-[13px]">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              {@render statePill(invite)}
              <Pill tone={roleTone[invite.role]}>{t(roleLabel(invite.role))}</Pill>
            </div>
            {@render revokeButton(invite)}
          </div>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-ink-2">
            <div><dt class="text-[11.5px] text-ink-3">{t("manage.invites.col.uses")}</dt><dd>{@render uses(invite)}</dd></div>
            <div><dt class="text-[11.5px] text-ink-3">{t("manage.invites.col.expires")}</dt><dd>{expiry(invite)}</dd></div>
            <div><dt class="text-[11.5px] text-ink-3">{t("manage.invites.col.created")}</dt><dd>{relativeTime(invite.created_at)}</dd></div>
            <div class="min-w-0"><dt class="text-[11.5px] text-ink-3">{t("manage.invites.col.joined")}</dt><dd class="min-w-0">{@render joined(invite)}</dd></div>
          </dl>
        </li>
      {/each}
    </ul>
  </Card>
{/if}

<InviteSheet bind:open={sheetOpen} onCreated={invite => (invitations = [invite, ...(invitations ?? [])])} />

<ConfirmDialog bind:open={confirmOpen} title={t("manage.invites.revokeTitle")} description={t("manage.invites.revokeDesc")} confirmLabel={t("manage.invites.revoke")} onConfirm={revoke} />
