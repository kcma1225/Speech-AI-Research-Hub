<script lang="ts">
  import { Tabs, DropdownMenu } from "bits-ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Activity, ArrowDownToLine, ArrowUpFromLine, Boxes, Cpu, Fingerprint, Link2, Network, RefreshCw, Server } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { toErrorBody } from "#lib/ai/admin.ts";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import AiErrorPanel from "#lib/components/ai/AiErrorPanel.svelte";
  import ProvidersPanel from "#lib/components/ai/admin/ProvidersPanel.svelte";
  import GroupsPanel from "#lib/components/ai/admin/GroupsPanel.svelte";
  import ModelsPanel from "#lib/components/ai/admin/ModelsPanel.svelte";
  import RoutingDiagram from "#lib/components/ai/admin/RoutingDiagram.svelte";
  import BindingsPanel from "#lib/components/ai/admin/BindingsPanel.svelte";
  import TrafficPanel from "#lib/components/ai/admin/TrafficPanel.svelte";
  import EmbeddingPanel from "#lib/components/ai/admin/EmbeddingPanel.svelte";
  import TransferSheet from "#lib/components/ai/admin/TransferSheet.svelte";

  const isAdmin = $derived(session.user?.role === "admin");
  $effect(() => {
    if (session.user && !isAdmin) void goto("/", { replace: true });
  });
  $effect(() => {
    if (isAdmin) void adminStore.load();
  });

  const tabs = [
    { value: "overview", label: "aiAdmin.tab.overview", icon: Network },
    { value: "providers", label: "aiAdmin.tab.providers", icon: Server },
    { value: "models", label: "aiAdmin.tab.models", icon: Cpu },
    { value: "groups", label: "aiAdmin.tab.groups", icon: Boxes },
    { value: "bindings", label: "aiAdmin.tab.bindings", icon: Link2 },
    { value: "traffic", label: "aiAdmin.tab.traffic", icon: Activity },
    { value: "embedding", label: "aiAdmin.tab.embedding", icon: Fingerprint },
  ] as const;
  type Tab = (typeof tabs)[number]["value"];
  const fromUrl = (): Tab => (tabs.find(x => x.value === page.url.searchParams.get("tab"))?.value ?? "overview");
  let tab = $state<Tab>(fromUrl());
  $effect(() => {
    if ((page.url.searchParams.get("tab") ?? "overview") !== tab) void goto(tab === "overview" ? page.url.pathname : `?tab=${tab}`, { shallow: true, replace: true });
  });
  let editGroupId = $state<string | null>(null);
  let modelsProvider = $state<string | null>(null);

  let transferOpen = $state(false);
  let transferMode = $state<"export" | "import">("export");
  const openTransfer = (m: "export" | "import") => {
    transferMode = m;
    transferOpen = true;
  };
</script>

<svelte:head><title>{t("aiAdmin.title")} · Speech-AI Hub</title></svelte:head>

{#if isAdmin}
  <PageHeader title={t("aiAdmin.title")} subtitle={t("aiAdmin.subtitle")}>
    {#snippet actions()}
      <Button variant="ghost" size="icon" aria-label={t("aiAdmin.refresh")} title={t("aiAdmin.refresh")} onclick={() => adminStore.load()}><RefreshCw /></Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium hover:bg-surface-2">
          <ArrowDownToLine class="size-4" />{t("aiAdmin.transfer.export")} / {t("aiAdmin.transfer.import")}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} class={menuContent}>
            <DropdownMenu.Item class={menuItem} onSelect={() => openTransfer("export")}><ArrowDownToLine />{t("aiAdmin.transfer.export")}</DropdownMenu.Item>
            <DropdownMenu.Item class={menuItem} onSelect={() => openTransfer("import")}><ArrowUpFromLine />{t("aiAdmin.transfer.import")}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/snippet}
  </PageHeader>

  {#if adminStore.error}
    <AiErrorPanel class="mb-5" error={toErrorBody(adminStore.error)} />
  {/if}

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
    <Tabs.Content value="overview" class="outline-none"><RoutingDiagram active={tab === "overview"} onEditGroup={id => ((editGroupId = id), (tab = "groups"))} /></Tabs.Content>
    <Tabs.Content value="providers" class="flex flex-col gap-10 outline-none">
      <ProvidersPanel family="llm" title={t("aiAdmin.providers.llmTitle")} onShowModels={id => ((modelsProvider = id), (tab = "models"))} />
      <div class="flex flex-col gap-3">
        <p class="text-[13.5px] text-ink-3">{t("aiAdmin.speech.intro")} {t("aiAdmin.speech.taiwanese")}</p>
        <ProvidersPanel family="asr" title={t("aiAdmin.speech.providers")} onShowModels={id => ((modelsProvider = id), (tab = "models"))} />
      </div>
    </Tabs.Content>
    <Tabs.Content value="models" class="outline-none">
      {#key modelsProvider}<ModelsPanel initialProvider={modelsProvider ?? ""} />{/key}
    </Tabs.Content>
    <Tabs.Content value="groups" class="outline-none"><GroupsPanel bind:editId={editGroupId} /></Tabs.Content>
    <Tabs.Content value="bindings" class="outline-none"><BindingsPanel onSwitchWizard={() => (tab = "embedding")} /></Tabs.Content>
    <Tabs.Content value="traffic" class="outline-none"><TrafficPanel /></Tabs.Content>
    <Tabs.Content value="embedding" class="outline-none"><EmbeddingPanel /></Tabs.Content>
  </Tabs.Root>

  <TransferSheet bind:open={transferOpen} mode={transferMode} />
{/if}
