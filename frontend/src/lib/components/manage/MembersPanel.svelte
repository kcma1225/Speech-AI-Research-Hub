<script lang="ts">
  import { ShieldCheck, UserRoundCheck, UserRoundX, Users } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import RoleMenu from "./RoleMenu.svelte";
  import { roleLabel, roleTone, tc, type AdminUser, type GrantableRole } from "./manage.ts";

  let users = $state<AdminUser[] | null>(null);
  let error = $state<string | null>(null);
  let busyId = $state<string | null>(null);
  $effect(() => {
    api.get<{ users: AdminUser[] }>("/users").then(r => (users = r.users), e => (error = e.message));
  });
  const disabledCount = $derived(users?.filter(u => u.disabled).length ?? 0);

  function replace(user: AdminUser) {
    users = (users ?? []).map(u => (u.id === user.id ? user : u));
  }

  async function changeRole(user: AdminUser, role: GrantableRole) {
    if (busyId) return;
    busyId = user.id;
    try {
      const result = await api.patch<{ user: AdminUser }>(`/users/${user.id}`, { role });
      replace(result.user);
      toasts.show(t("manage.members.roleChanged", { name: user.name, role: t(roleLabel(role)) }), "success");
    } catch (err) {
      toasts.show((err as Error).message, "error");
    } finally {
      busyId = null;
    }
  }

  let target = $state<AdminUser | null>(null);
  let confirmOpen = $state(false);
  function askToggle(user: AdminUser) {
    target = user;
    confirmOpen = true;
  }
  async function toggle() {
    const user = target;
    if (!user) return;
    try {
      const result = await api.patch<{ user: AdminUser }>(`/users/${user.id}`, { disabled: !user.disabled });
      replace(result.user);
      toasts.show(t(result.user.disabled ? "manage.members.disabledToast" : "manage.members.enabledToast", { name: user.name }), "success");
    } catch (err) {
      toasts.show((err as Error).message, "error");
    }
  }

  const isFixed = (user: AdminUser) => user.role === "owner" || user.id === session.user?.id;
</script>

{#snippet who(user: AdminUser, compact = false)}
  <div class="flex min-w-0 items-center gap-3">
    <Avatar name={user.name} size={36} class="ring-0 {user.disabled ? 'opacity-50 grayscale' : ''}" />
    <div class="min-w-0">
      <p class="flex items-center gap-1.5 truncate font-medium {user.disabled ? 'text-ink-3' : 'text-ink'}">
        <span class="truncate">{user.name}</span>
        {#if user.id === session.user?.id}<span class="rounded-full bg-surface-3 px-1.5 text-[11px] font-medium text-ink-3">{t("manage.members.you")}</span>{/if}
      </p>
      <p class="truncate text-[12px] text-ink-3">
        {#if compact}{t("manage.members.col.lastLogin")} · {@render lastLogin(user)}{:else}{t("manage.members.joined", { date: formatDate(user.created_at) })}{/if}
      </p>
    </div>
  </div>
{/snippet}

{#snippet role(user: AdminUser)}
  {#if isFixed(user)}
    <span class="inline-flex items-center gap-1.5" title={t("manage.members.protected")}>
      <Pill tone={roleTone[user.role]}>{t(roleLabel(user.role))}</Pill>
      <ShieldCheck class="size-3.5 text-ink-3" aria-label={t("manage.members.protected")} />
    </span>
  {:else}
    <RoleMenu
      role={user.role}
      label={t("manage.members.changeRole", { name: user.name })}
      busy={busyId === user.id}
      onChange={r => changeRole(user, r)}
    />
  {/if}
{/snippet}

{#snippet status(user: AdminUser)}
  <Pill tone={user.disabled ? "stone" : "mint"} dot>{t(user.disabled ? "manage.members.disabled" : "manage.members.active")}</Pill>
{/snippet}

{#snippet lastLogin(user: AdminUser)}
  {#if user.last_login_at}
    <span title={formatDate(user.last_login_at, { dateStyle: "medium", timeStyle: "short" })}>{relativeTime(user.last_login_at)}</span>
  {:else}
    <span class="text-ink-3">{t("manage.members.never")}</span>
  {/if}
{/snippet}

{#snippet action(user: AdminUser)}
  {#if !isFixed(user)}
    {#if user.disabled}
      <Button size="sm" variant="secondary" onclick={() => askToggle(user)}><UserRoundCheck />{t("manage.members.enable")}</Button>
    {:else}
      <Button size="sm" variant="ghost" class="hover:!text-danger" onclick={() => askToggle(user)}><UserRoundX />{t("manage.members.disable")}</Button>
    {/if}
  {/if}
{/snippet}

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !users}
  <Card padded={false}><div class="flex flex-col gap-2 p-5">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-14" />{/each}</div></Card>
{:else if !users.length}
  <Card><EmptyState title={t("manage.members.empty")}>{#snippet icon()}<Users />{/snippet}</EmptyState></Card>
{:else}
  <p class="mb-3 text-[13px] text-ink-3">
    {tc("manage.members.count", users.length)}{#if disabledCount} · {t("manage.members.disabledCount", { n: disabledCount })}{/if}
  </p>
  <Card padded={false} class="overflow-hidden">
    <table class="hidden w-full text-left text-[13.5px] md:table">
      <thead>
        <tr class="border-b border-line bg-surface-2/60 text-[12px] text-ink-3">
          <th class="w-[34%] py-2.5 pl-6 font-medium">{t("manage.members.col.member")}</th>
          <th class="w-[18%] py-2.5 font-medium">{t("manage.members.col.role")}</th>
          <th class="w-[16%] py-2.5 font-medium">{t("manage.members.col.lastLogin")}</th>
          <th class="py-2.5 font-medium">{t("manage.members.col.status")}</th>
          <th class="py-2.5 pr-6 text-right font-medium"><span class="sr-only">{t("manage.members.col.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.id)}
          <tr class="border-b border-line last:border-0 hover:bg-surface-2/60 {user.role === 'owner' ? 'bg-surface-2/40' : ''}">
            <td class="max-w-0 py-3 pl-6">{@render who(user)}</td>
            <td class="py-3">{@render role(user)}</td>
            <td class="py-3 whitespace-nowrap text-ink-2">{@render lastLogin(user)}</td>
            <td class="py-3">{@render status(user)}</td>
            <td class="py-3 pr-6 text-right">{@render action(user)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <ul class="divide-y divide-line md:hidden">
      {#each users as user (user.id)}
        <li class="flex flex-col gap-3 p-4 {user.role === 'owner' ? 'bg-surface-2/40' : ''}">
          <div class="flex items-start justify-between gap-3">
            {@render who(user, true)}
            {@render status(user)}
          </div>
          <div class="flex min-h-8 items-center justify-between gap-2 pl-12">
            {@render role(user)}
            {@render action(user)}
          </div>
        </li>
      {/each}
    </ul>
  </Card>
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={t(target?.disabled ? "manage.members.enableTitle" : "manage.members.disableTitle", { name: target?.name ?? "" })}
  description={t(target?.disabled ? "manage.members.enableDesc" : "manage.members.disableDesc")}
  confirmLabel={t(target?.disabled ? "manage.members.enable" : "manage.members.disable")}
  danger={!target?.disabled}
  onConfirm={toggle}
/>
