<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { DropdownMenu } from "bits-ui";
  import { goto } from "$app/navigation";
  import { Crown, Ellipsis, LogOut, UserMinus, UserPlus } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { DirectoryUser, StudyMember } from "#lib/studies/types.ts";
  import { memberRoleTone } from "#lib/studies/ui.ts";
  import type { StudyTabProps } from "./registry.ts";

  let { detail, reload }: StudyTabProps = $props();
  const canManage = $derived(detail.permissions.manage);
  const base = $derived(`/studies/${detail.study.id}/members`);
  const me = $derived(session.user?.id);

  async function run(work: () => Promise<unknown>, success: string) {
    try {
      await work();
      toasts.show(success, "success");
      await reload();
      return true;
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return false;
    }
  }

  // ───── Add ─────
  let addOpen = $state(false);
  let directory = $state<DirectoryUser[]>([]);
  let pick = $state("");
  let role = $state<"member" | "advisor">("member");
  let adding = $state(false);
  $effect(() => {
    if (!addOpen) return;
    pick = "";
    role = "member";
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (directory = r.users), () => {});
  });
  const candidates = $derived(directory.filter(u => !detail.members.some(m => m.id === u.id)));
  const picked = $derived(candidates.find(u => u.id === pick));
  $effect(() => {
    if (picked && picked.role !== "professor" && role === "advisor") role = "member";
  });
  async function add() {
    if (!picked) return;
    adding = true;
    const ok = await run(() => api.post(base, { userId: picked.id, role }), t("members.added", { name: picked.name }));
    adding = false;
    if (ok) addOpen = false;
  }

  // ───── Row actions ─────
  const roleLabel = (role: StudyMember["role"]) => t(`studies.role.${role}` as MessageKey);
  const changeRole = (member: StudyMember, next: "member" | "advisor") =>
    run(() => api.patch(`${base}/${member.id}`, { role: next }), t("members.roleChanged", { name: member.name, role: roleLabel(next) }));

  let confirm = $state<{ kind: "remove" | "leave" | "transfer"; member: StudyMember } | null>(null);
  let confirmOpen = $state(false);
  function ask(kind: "remove" | "leave" | "transfer", member: StudyMember) {
    confirm = { kind, member };
    confirmOpen = true;
  }
  async function confirmAction() {
    if (!confirm) return;
    const { kind, member } = confirm;
    if (kind === "transfer") {
      await api.post(`/studies/${detail.study.id}/transfer`, { userId: member.id });
      toasts.show(t("members.transferred", { name: member.name }), "success");
      await reload();
    } else {
      await api.del(`${base}/${member.id}`);
      toasts.show(kind === "leave" ? t("members.left") : t("members.removed", { name: member.name }), "success");
      if (kind === "leave") await goto(`/studies/${detail.study.slug}`, { replace: true });
      await reload();
    }
  }
  const confirmTitle = $derived(
    !confirm ? "" : confirm.kind === "transfer" ? t("members.transferConfirm", { name: confirm.member.name }) : confirm.kind === "leave" ? t("members.leaveConfirm", { title: detail.study.title }) : t("members.removeConfirm", { name: confirm.member.name }),
  );
  const confirmDesc = $derived(
    !confirm ? "" : confirm.kind === "transfer" ? t("members.transferDesc", { name: confirm.member.name }) : confirm.kind === "leave" ? t("members.leaveDesc") : t("members.removeDesc"),
  );
  const hasActions = (m: StudyMember) => m.role !== "owner" && (canManage || m.id === me);
</script>

<Card>
  <CardHeader title={t("members.title")} subtitle={t("members.subtitle")}>
    {#snippet actions()}{#if canManage}<Button size="sm" variant="primary" onclick={() => (addOpen = true)}><UserPlus />{t("members.add")}</Button>{/if}{/snippet}
  </CardHeader>
  <ul class="-mx-2 flex flex-col divide-y divide-line">
    {#each detail.members as member (member.id)}
      <li class="flex items-center gap-3 px-2 py-3">
        <Avatar name={member.name} id={member.id} size={38} class="ring-0 {member.disabled ? 'opacity-50 grayscale' : ''}" />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-1.5 text-[14.5px] font-medium text-ink">
            <span class="truncate">{displayName(member, "formal")}</span>
            {#if member.id === me}<span class="rounded-full bg-surface-3 px-1.5 text-[11px] font-medium text-ink-3">{t("members.you")}</span>{/if}
            {#if member.disabled}<span class="text-[12px] text-ink-3">· {t("members.disabled")}</span>{/if}
          </p>
          <p class="truncate text-[12.5px] text-ink-3">{t(`role.${member.account_role}` as MessageKey)} · {formatDate(member.added_at)}</p>
        </div>
        <Pill tone={memberRoleTone[member.role]} class="shrink-0">{roleLabel(member.role)}</Pill>
        {#if hasActions(member)}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger class="-mr-1 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("members.changeRole", { name: member.name })}>
              <Ellipsis class="size-4" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-56">
                {#if canManage && member.role === "member" && member.account_role === "professor"}
                  <DropdownMenu.Item class={menuItem} onSelect={() => changeRole(member, "advisor")}>{t("studies.role.advisor")}</DropdownMenu.Item>
                {/if}
                {#if canManage && member.role === "advisor"}
                  <DropdownMenu.Item class={menuItem} onSelect={() => changeRole(member, "member")}>{t("studies.role.member")}</DropdownMenu.Item>
                {/if}
                {#if canManage && member.role === "member"}
                  <DropdownMenu.Item class={menuItem} onSelect={() => ask("transfer", member)}><Crown />{t("members.transfer")}</DropdownMenu.Item>
                {/if}
                {#if member.id === me}
                  <DropdownMenu.Item class={menuItem} onSelect={() => ask("leave", member)}><LogOut />{t("members.leave")}</DropdownMenu.Item>
                {:else if canManage}
                  <DropdownMenu.Item class="{menuItem} text-danger" onSelect={() => ask("remove", member)}><UserMinus />{t("members.remove")}</DropdownMenu.Item>
                {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {:else}
          <span class="size-10 shrink-0" aria-hidden="true"></span>
        {/if}
      </li>
    {/each}
  </ul>
  {#if !canManage}<p class="mt-3 text-[12.5px] text-ink-3">{t("studies.manageOnly")}</p>{/if}
</Card>

<Sheet bind:open={addOpen} title={t("members.add")} side="right">
  {#snippet children()}
    <div class="flex flex-col gap-5 pt-1">
      {#if !candidates.length}
        <p class="text-[13px] text-ink-3">{t("members.noCandidates")}</p>
      {:else}
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("members.pick")}</span>
          <Select
            bind:value={pick}
            label={t("members.pick")}
            class="w-full"
            options={[{ value: "", label: "—" }, ...candidates.map(u => ({ value: u.id, label: displayName(u), hint: `@${u.username} · ${t(`role.${u.role}` as MessageKey)}` }))]}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("members.role")}</span>
          <Segmented
            bind:value={role}
            label={t("members.role")}
            class="w-full"
            options={picked?.role === "professor"
              ? [{ value: "member", label: t("studies.role.member") }, { value: "advisor", label: t("studies.role.advisor") }]
              : [{ value: "member", label: t("studies.role.member") }]}
          />
          <p class="text-[12.5px] text-ink-3">{role === "advisor" ? t("members.roleHint.advisor") : t("members.roleHint.member")}{#if picked && picked.role !== "professor"} · {t("members.professorOnly")}{/if}</p>
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (addOpen = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" loading={adding} disabled={!picked} onclick={add}><UserPlus />{t("members.add")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={confirmOpen} title={confirmTitle} description={confirmDesc} confirmLabel={confirm?.kind === "transfer" ? t("members.transfer") : confirm?.kind === "leave" ? t("members.leave") : t("members.remove")} danger={confirm?.kind !== "transfer"} onConfirm={confirmAction} />
