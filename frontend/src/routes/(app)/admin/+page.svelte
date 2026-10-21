<script lang="ts">
  import { Tabs } from "bits-ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Link2, Users } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import InvitesPanel from "#lib/components/manage/InvitesPanel.svelte";
  import MembersPanel from "#lib/components/manage/MembersPanel.svelte";
  import AdminSetupCard from "#lib/components/manage/AdminSetupCard.svelte";

  const isAdmin = $derived(session.user?.role === "admin");
  $effect(() => {
    if (session.user && !isAdmin) void goto("/", { replace: true });
  });

  const tabs = [
    { value: "members", label: "manage.admin.tab.members", icon: Users },
    { value: "invites", label: "manage.admin.tab.invites", icon: Link2 },
  ] as const;
  type Tab = (typeof tabs)[number]["value"];
  let tab = $state<Tab>(page.url.searchParams.get("tab") === "invites" ? "invites" : "members");
  $effect(() => {
    if ((page.url.searchParams.get("tab") ?? "members") !== tab) void goto(tab === "members" ? page.url.pathname : `?tab=${tab}`, { shallow: true, replace: true });
  });
</script>

<svelte:head><title>{t("nav.admin")} · Speech-AI Hub</title></svelte:head>

{#if isAdmin}
  <PageHeader title={t("nav.admin")} subtitle={t("manage.admin.subtitle")} />
  <AdminSetupCard />
  <Tabs.Root bind:value={tab} class="flex flex-col gap-5">
    <Tabs.List class="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
      {#each tabs as item (item.value)}
        <Tabs.Trigger
          value={item.value}
          class="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-full px-4 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card"
        >
          <item.icon class="size-4" />{t(item.label)}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
    <Tabs.Content value="members" class="outline-none"><MembersPanel /></Tabs.Content>
    <Tabs.Content value="invites" class="outline-none"><InvitesPanel /></Tabs.Content>
  </Tabs.Root>
{/if}
