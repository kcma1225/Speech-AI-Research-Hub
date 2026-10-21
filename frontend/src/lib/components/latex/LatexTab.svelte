<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { Plus, Sigma } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import type { StudyTabProps } from "#lib/components/study/tabs/registry.ts";
  import { isRunning, type LatexTemplate, type ProjectCard as Card_ } from "#lib/latex/types.ts";
  import CreateProjectSheet from "./CreateProjectSheet.svelte";
  import ProjectCard from "./ProjectCard.svelte";

  /** Study tab 論文: the study's LaTeX projects (one per article/thesis) and 「新增論文」. */
  let { detail }: StudyTabProps = $props();
  const canEdit = $derived(detail.permissions.edit);
  const slug = $derived(detail.study.slug);

  let projects = $state<Card_[] | null>(null);
  let templates = $state<LatexTemplate[]>([]);
  let error = $state<string | null>(null);
  let createOpen = $state(false);

  async function load() {
    try {
      const r = await api.get<{ projects: Card_[]; templates: LatexTemplate[] }>(`/studies/${encodeURIComponent(slug)}/latex`);
      projects = r.projects;
      templates = r.templates;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void slug;
    untrack(() => void load());
  });
  $effect(() => {
    if (!projects?.some(p => isRunning(p.last_compile_status))) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (page.url.searchParams.get("new") === "1" && untrack(() => canEdit)) untrack(() => (createOpen = true));
  });
</script>

<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
  <p class="max-w-2xl text-[13px] leading-relaxed text-ink-3">{t("latex.tabHint")}</p>
  {#if canEdit}
    <Button variant="primary" onclick={() => (createOpen = true)}><Plus />{t("latex.new")}</Button>
  {/if}
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !projects}
  <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
    {#each [0, 1, 2] as i (i)}
      <div class="overflow-hidden rounded-[22px] border border-line/70 bg-surface">
        <Skeleton class="aspect-[16/10] rounded-none" />
        <div class="flex flex-col gap-2.5 p-4"><Skeleton class="h-5 w-3/4" /><Skeleton class="h-4 w-1/2" /></div>
      </div>
    {/each}
  </div>
{:else if !projects.length}
  <Card>
    <EmptyState title={t("latex.empty")} hint={canEdit ? t("latex.emptyHint") : t("latex.emptyHintViewer")} class="py-14">
      {#snippet icon()}<Sigma />{/snippet}
      {#snippet action()}
        {#if canEdit}<Button variant="primary" onclick={() => (createOpen = true)}><Plus />{t("latex.new")}</Button>{/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <div class="grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
    {#each projects as project (project.id)}
      <ProjectCard {project} href="/studies/{encodeURIComponent(slug)}/latex/{project.id}" />
    {/each}
  </div>
{/if}

{#if canEdit}
  <CreateProjectSheet bind:open={createOpen} study={detail.study} {templates} />
{/if}
