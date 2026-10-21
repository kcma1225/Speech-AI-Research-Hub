<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ArrowLeft, Sigma } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import LatexEditor from "#lib/components/latex/LatexEditor.svelte";
  import type { ProjectDetail } from "#lib/latex/types.ts";

  const slug = $derived(page.params.slug ?? "");
  const id = $derived(page.params.id ?? "");
  let detail = $state<ProjectDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);

  async function load() {
    try {
      const next = await api.get<ProjectDetail>(`/latex/${encodeURIComponent(id)}`);
      detail = next;
      error = null;
      if (next.study.slug !== slug) void goto(`/studies/${next.study.slug}/latex/${next.project.id}${page.url.search}`, { replace: true });
    } catch (e) {
      error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message };
    }
  }
  $effect(() => {
    void id;
    detail = null;
    void load();
  });
</script>

<svelte:head><title>{detail?.project.title ?? t("latex.title")} · Speech-AI Hub</title></svelte:head>

{#if error}
  <a href="/studies/{slug}?tab=latex" class="-ml-2 mb-2 inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink"><ArrowLeft class="size-4" />{t("latex.back")}</a>
  <Card>
    <EmptyState title={error.status === 404 || error.status === 400 ? t("latex.notFound") : t("common.error")} hint={error.status === 404 || error.status === 400 ? t("latex.notFoundHint") : error.message} class="py-14">
      {#snippet icon()}<Sigma />{/snippet}
      {#snippet action()}<Button variant="secondary" href="/studies/{slug}?tab=latex">{t("latex.back")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !detail}
  <Skeleton class="mb-3 h-6 w-40" />
  <Skeleton class="mb-4 h-11 w-2/3" />
  <Skeleton class="h-[65dvh] rounded-[22px]" />
{:else}
  {#key detail.project.id}
    <LatexEditor initial={detail} />
  {/key}
{/if}
