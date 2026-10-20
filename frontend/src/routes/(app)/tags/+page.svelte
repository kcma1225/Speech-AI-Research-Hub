<script lang="ts">
  import { Tabs } from "bits-ui";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { FileText, Lock, Presentation } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import TagBoard from "#lib/components/manage/TagBoard.svelte";
  import { tagNamespaces, type ManagedTag, type TagKind } from "#lib/components/manage/manage.ts";

  const tabs = [
    { value: "note", icon: FileText },
    { value: "slide", icon: Presentation },
  ] as const satisfies readonly { value: TagKind; icon: unknown }[];
  let tab = $state<TagKind>(page.url.searchParams.get("tab") === "slide" ? "slide" : "note");
  $effect(() => {
    if ((page.url.searchParams.get("tab") ?? "note") !== tab) void goto(tab === "note" ? page.url.pathname : `?tab=${tab}`, { shallow: true, replace: true });
  });

  let lists = $state<Record<TagKind, ManagedTag[] | null>>({ note: null, slide: null });
  let error = $state<string | null>(null);
  $effect(() => {
    for (const kind of ["note", "slide"] as const)
      api.get<{ tags: ManagedTag[] }>(tagNamespaces[kind].api).then(
        r => {
          lists[kind] = r.tags;
        },
        e => (error = e.message),
      );
  });
</script>

<svelte:head><title>{t("nav.tags")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("nav.tags")} subtitle={t("manage.tags.subtitle")} />

{#if !session.canEdit}
  <p class="-mt-2 mb-5 inline-flex items-center gap-2 rounded-full bg-surface-2 px-3.5 py-1.5 text-[13px] text-ink-2"><Lock class="size-3.5" />{t("manage.tags.readOnly")}</p>
{/if}

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else}
  <Tabs.Root bind:value={tab} class="flex flex-col gap-5">
    <Tabs.List class="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
      {#each tabs as item (item.value)}
        <Tabs.Trigger
          value={item.value}
          class="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-full px-4 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card"
        >
          <item.icon class="size-4" />{t(tagNamespaces[item.value].label)}
          {#if lists[item.value]}
            <span class="rounded-full bg-surface-3 px-1.5 py-px text-[11.5px] text-ink-3 tabular-nums">{lists[item.value]!.length}</span>
          {/if}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#each tabs as item (item.value)}
      <Tabs.Content value={item.value} class="outline-none">
        <TagBoard kind={item.value} bind:tags={lists[item.value]} canEdit={session.canEdit} />
      </Tabs.Content>
    {/each}
  </Tabs.Root>
{/if}
