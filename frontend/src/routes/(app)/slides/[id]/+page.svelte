<script lang="ts">
  import { tick } from "svelte";
  import { Tabs } from "bits-ui";
  import { ArrowLeft, CircleAlert, Download, Expand, Globe, History, Info, LoaderCircle, MessageSquareQuote, Play, Presentation } from "@lucide/svelte";
  import { page } from "$app/state";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import DeckFrame from "#lib/components/slides/DeckFrame.svelte";
  import InfoPanel from "#lib/components/slides/InfoPanel.svelte";
  import ReviewsPanel from "#lib/components/slides/ReviewsPanel.svelte";
  import UploadSheet from "#lib/components/slides/UploadSheet.svelte";
  import VersionsPanel from "#lib/components/slides/VersionsPanel.svelte";
  import type { SlideDetail } from "#lib/slides/types.ts";
  import { isBusy, watchStatus } from "#lib/slides/util.ts";

  type Tab = "reviews" | "versions" | "info";
  const id = $derived(page.params.id!);
  let detail = $state<SlideDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let tab = $state<Tab>("reviews");
  let previewId = $state<string | null>(null);
  let uploadOpen = $state(false);
  let highlight = $state<string | null>(null);
  let frame = $state<ReturnType<typeof DeckFrame> | null>(null);
  let panel = $state<HTMLElement | null>(null);

  async function load() {
    try {
      detail = await api.get<SlideDetail>(`/slides/${id}`);
      error = null;
    } catch (e) {
      error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message };
    }
  }
  $effect(() => {
    void id;
    detail = null;
    previewId = null;
    void load().then(applyHash);
  });

  // The view URL carries a fresh token on every load; keep the iframe on the same URL while the
  // version is unchanged so reloading the detail (after a review, a save…) doesn't restart the deck.
  const shownVersion = $derived(detail ? (detail.versions.find(v => v.id === previewId && v.viewUrl) ?? detail.activeVersion) : null);
  let frameSrc = $state<string | null>(null);
  let frameVersion: string | null = null;
  $effect(() => {
    const v = shownVersion;
    if ((v?.id ?? null) !== frameVersion || !v) {
      frameVersion = v?.id ?? null;
      frameSrc = v?.viewUrl ?? null;
    }
  });

  // Follow the latest version while it renders, then reload once it settles.
  const latest = $derived(detail?.versions[0]);
  const busyId = $derived(latest && isBusy(latest.status) ? latest.id : null);
  $effect(() => {
    const versionId = busyId;
    if (!versionId) return;
    return watchStatus(id, s => {
      const v = detail?.versions.find(x => x.id === s.id);
      if (!v || s.id !== versionId) return void load();
      v.status = s.status;
      v.stage = s.stage;
      v.progress = s.progress;
      if (!isBusy(s.status)) void load();
    });
  });

  /** `#reviews` opens the reviews tab; `#review-<id>` also scrolls to and highlights that review. */
  async function applyHash() {
    const hash = location.hash.slice(1);
    if (!hash || !detail) return;
    if (hash === "reviews" || hash.startsWith("review-")) {
      tab = "reviews";
      await tick();
      const target = hash.startsWith("review-") ? document.getElementById(hash) : null;
      (target ?? panel)?.scrollIntoView({ behavior: "smooth", block: target ? "center" : "start" });
      if (target) {
        highlight = hash.slice("review-".length);
        setTimeout(() => (highlight = null), 2400);
      }
    } else if (hash === "versions" || hash === "info") tab = hash;
  }
  $effect(() => {
    const onHash = () => void applyHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  const tabs = $derived([
    { value: "reviews" as const, label: t("slides.tab.reviews"), icon: MessageSquareQuote, count: detail?.reviews.length ?? 0 },
    { value: "versions" as const, label: t("slides.tab.versions"), icon: History, count: detail?.versions.length ?? 0 },
    { value: "info" as const, label: t("slides.tab.info"), icon: Info, count: 0 },
  ]);
  const author = $derived(detail ? (detail.activeVersion?.uploader_name ?? detail.project.creator_name ?? null) : null);
  const preview = $derived(previewId && shownVersion?.id === previewId ? shownVersion : null);
</script>

<svelte:head><title>{detail ? `${detail.project.title} · ` : ""}{t("brand.name")}</title></svelte:head>

<a href="/slides" class="mb-4 inline-flex h-8 items-center gap-1.5 rounded-full pr-3 text-[13px] font-medium text-ink-2 hover:text-ink lg:mb-5">
  <ArrowLeft class="size-4" />{t("slides.back")}
</a>

{#if error}
  <Card>
    <EmptyState title={error.status === 404 ? t("slides.notFound") : t("slides.loadError")} hint={error.status === 404 ? undefined : error.message} class="py-14">
      {#snippet icon()}<Presentation />{/snippet}
      {#snippet action()}<Button variant="secondary" href="/slides">{t("slides.back")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !detail}
  <Skeleton class="mb-3 h-11 w-2/3" />
  <Skeleton class="mb-6 h-5 w-1/3" />
  <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
    <Skeleton class="aspect-[16/10] rounded-[22px]" />
    <Skeleton class="h-[420px] rounded-[22px]" />
  </div>
{:else}
  {@const d = detail}
  <header class="mb-5 flex flex-col gap-4 lg:mb-6 lg:flex-row lg:items-end lg:justify-between">
    <div class="min-w-0">
      <h1 class="font-display text-[30px] leading-[1.08] text-balance text-ink sm:text-[40px]">{d.project.title}</h1>
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-3">
        {#if author}<span class="inline-flex items-center gap-2 text-ink-2"><Avatar name={author} size={22} class="ring-0" />{author}</span><span aria-hidden="true">·</span>{/if}
        {#if d.activeVersion}
          <span>{t("slides.version", { n: d.activeVersion.version })}</span><span aria-hidden="true">·</span>
          <span>{formatDate(d.activeVersion.published_at ?? d.activeVersion.created_at)}</span>
        {:else}
          <span>{t("slides.noVersion")}</span>
        {/if}
        {#if d.project.public_view}<Pill size="sm"><Globe class="size-3" />{t("slides.public")}</Pill>{/if}
        {#each d.tags as tag (tag.id)}<Pill tone={toneFor(tag.name)} size="sm">{tag.name}</Pill>{/each}
      </div>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={!frameSrc} onclick={() => frame?.fullscreen()}><Expand />{t("slides.fullscreen")}</Button>
      <Button variant="secondary" href={d.project.playerUrl}><Play />{t("slides.player")}</Button>
      {#if d.pdfUrl}<Button variant="primary" href={d.pdfUrl}><Download />PDF</Button>{/if}
    </div>
  </header>

  <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_400px]">
    <div class="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6">
      <DeckFrame bind:this={frame} src={frameSrc} title={d.project.title} class="aspect-[16/10] rounded-[22px] border border-line/70 shadow-card">
        {#snippet empty()}
          <div class="flex max-w-sm flex-col items-center gap-3">
            {#if latest && isBusy(latest.status)}
              <span class="grid size-11 place-items-center rounded-2xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><LoaderCircle class="size-5 animate-spin" /></span>
              <p class="text-sm font-medium">{t("slides.noDeck")}</p>
              <p class="text-[13px] text-ink-3">{t("slides.noDeck.rendering")}</p>
              <div class="mt-1 w-56">
                <div class="mb-1.5 flex justify-between text-[12px] text-ink-3"><span>{latest.stage ?? t("slides.status.queued")}</span><span class="tabular-nums">{latest.progress}%</span></div>
                <Progress value={latest.progress || null} />
              </div>
            {:else}
              <span class="grid size-11 place-items-center rounded-2xl" style="background:var(--pill-rose);color:var(--pill-rose-ink)"><CircleAlert class="size-5" /></span>
              <p class="text-sm font-medium">{t("slides.noDeck")}</p>
              {#if latest?.status === "failed"}
                <p class="text-[13px] text-ink-3">{t("slides.noDeck.failed")}</p>
                <Button size="sm" variant="secondary" onclick={() => (tab = "versions")}>{t("slides.tab.versions")}</Button>
              {/if}
            {/if}
          </div>
        {/snippet}
      </DeckFrame>
      {#if preview}
        <div class="flex items-center justify-between gap-3 rounded-2xl border border-ink/80 bg-surface px-4 py-2.5 text-[13px]">
          <span class="font-medium">{t("slides.previewing", { n: preview.version })}</span>
          <Button size="sm" variant="ghost" class="-mr-2" onclick={() => (previewId = null)}>{t("slides.backToActive")}</Button>
        </div>
      {/if}
    </div>

    <section bind:this={panel} id="reviews" class="min-w-0 scroll-mt-20 rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card">
      <Tabs.Root bind:value={tab}>
        <Tabs.List class="flex gap-1 border-b border-line p-2">
          {#each tabs as item (item.value)}
            <Tabs.Trigger
              value={item.value}
              class="inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full px-3 text-[13.5px] font-medium whitespace-nowrap text-ink-3 transition-colors hover:text-ink data-[state=active]:bg-surface-3 data-[state=active]:text-ink"
            >
              <item.icon class="size-4" />{item.label}
              {#if item.count}<span class="text-[12px] tabular-nums opacity-70">{item.count}</span>{/if}
            </Tabs.Trigger>
          {/each}
        </Tabs.List>
        <div class="p-4 sm:p-5">
          <Tabs.Content value="reviews" class="outline-none">
            <ReviewsPanel projectId={d.project.id} bind:reviews={detail.reviews} canReview={d.permissions.review} canReply={d.permissions.reply} {highlight} />
          </Tabs.Content>
          <Tabs.Content value="versions" class="outline-none">
            <VersionsPanel projectId={d.project.id} versions={d.versions} canManage={d.permissions.manage} bind:previewId onUpload={() => (uploadOpen = true)} onChanged={load} />
          </Tabs.Content>
          <Tabs.Content value="info" class="outline-none">
            <InfoPanel detail={d} onChanged={load} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </section>
  </div>

  {#if d.permissions.manage}
    <UploadSheet bind:open={uploadOpen} projectId={d.project.id} limits={d.limits} onUploaded={() => ((tab = "versions"), void load())} onRendered={() => void load()} />
  {/if}
{/if}
