<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Tabs } from "bits-ui";
  import { ArrowLeft, CircleAlert, Download, Expand, FileSearch, Globe, History, Info, LoaderCircle, MessageSquareQuote, Play, Presentation, Send, Trash2 } from "@lucide/svelte";
  import { page } from "$app/state";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import SlidePlayer from "#lib/components/slides/SlidePlayer.svelte";
  import InfoPanel from "#lib/components/slides/InfoPanel.svelte";
  import ReviewsPanel from "#lib/components/slides/ReviewsPanel.svelte";
  import UploadSheet from "#lib/components/slides/UploadSheet.svelte";
  import VersionsPanel from "#lib/components/slides/VersionsPanel.svelte";
  import type { PageManifest, SlideDetail, SlideReview } from "#lib/slides/types.ts";
  import { isBusy, watchStatus } from "#lib/slides/util.ts";

  type Tab = "reviews" | "versions" | "info";
  const id = $derived(page.params.id!);
  let detail = $state<SlideDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let tab = $state<Tab>("reviews");
  let previewId = $state<string | null>(null);
  let uploadOpen = $state(false);
  let highlight = $state<string | null>(null);
  let player = $state<ReturnType<typeof SlidePlayer> | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let currentPage = $state(1);
  let manifest = $state<PageManifest | null>(null);
  let startPage = $state<number | null>(null);
  /** versionId → jobId of re-index jobs started from this page. */
  let reindexing = $state<Record<string, string>>({});

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
    untrack(() => {
      detail = null;
      previewId = null;
      reindexing = {};
      void load().then(() => {
        // A converted PPTX waits for its uploader: open it for checking right away.
        const latest = detail?.versions[0];
        if (latest?.status === "review" && latest.pagesUrl && detail?.permissions.manage && !location.hash) previewId = latest.id;
        void applyHash();
      });
    });
  });

  // The player shows a previewed version (published or awaiting review) or else the active one.
  const shownVersion = $derived(detail ? (detail.versions.find(v => v.id === previewId && (v.viewUrl || v.pagesUrl)) ?? detail.activeVersion) : null);
  const reviewCounts = $derived.by(() => {
    const counts: Record<number, number> = {};
    for (const r of detail?.reviews ?? []) if (r.page !== null && r.versionId === shownVersion?.id) counts[r.page] = (counts[r.page] ?? 0) + 1;
    return counts;
  });

  /** A version that just finished converting into `review` opens in the player for its uploader to check. */
  function showReview(versionId: string) {
    const v = detail?.versions.find(x => x.id === versionId);
    if (v?.status === "review" && v.pagesUrl && detail?.permissions.manage) previewId = v.id;
  }

  /** Moves the player to a review's page (switching to its version when that one is not shown). */
  function jumpTo(review: SlideReview) {
    if (review.page === null || !detail) return;
    if (review.versionId && review.versionId !== shownVersion?.id) {
      const v = detail.versions.find(x => x.id === review.versionId && (x.viewUrl || x.pagesUrl));
      if (!v) return;
      startPage = review.page;
      previewId = v.is_active ? null : v.id;
      return;
    }
    player?.goto(review.page);
  }

  // Re-index jobs: reload once the job settles (the jobs widget polls /jobs/active while it runs).
  $effect(() => {
    const pending = Object.entries(reindexing);
    if (!pending.length) return;
    const jobs = jobsStore.jobs;
    untrack(() => {
      for (const [versionId, jobId] of pending) {
        const job = jobs.find(j => j.id === jobId);
        if (!job || job.status === "queued" || job.status === "running") continue;
        const { [versionId]: _, ...rest } = reindexing;
        reindexing = rest;
        if (job.status === "succeeded") toasts.show(t("slides.versions.reindexDone"), "success");
        else toasts.show(t("slides.versions.reindexFailed"), "error");
        void load();
      }
    });
  });

  // Review version shown in the player: publish or discard it from here too.
  let publishing = $state(false);
  let discardOpen = $state(false);
  async function publishShown() {
    const v = shownVersion;
    if (!v || v.status !== "review") return;
    publishing = true;
    try {
      const result = await api.post<{ active: boolean }>(`/slides/${id}/versions/${v.id}/publish`);
      toasts.show(result.active ? t("slides.versions.publishedActive", { n: v.version }) : t("slides.versions.publishedOnly", { n: v.version }), "success");
      if (result.active) previewId = null;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      publishing = false;
    }
  }
  async function discardShown() {
    const v = shownVersion;
    if (!v) return;
    try {
      await api.del(`/slides/${id}/versions/${v.id}`);
      toasts.show(t("slides.versions.discarded", { n: v.version }), "success");
      previewId = null;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    }
  }

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
      if (!isBusy(s.status)) void load().then(() => showReview(s.id));
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
        const review = detail.reviews.find(r => r.id === highlight);
        if (review) jumpTo(review);
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
  const canPlay = $derived(Boolean(shownVersion && (shownVersion.viewUrl || shownVersion.pagesUrl)));
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
      <Button variant="secondary" disabled={!canPlay} onclick={() => player?.fullscreen()}><Expand />{t("slides.fullscreen")}</Button>
      <Button variant="secondary" href={d.project.playerUrl}><Play />{t("slides.player")}</Button>
      {#if d.pdfUrl}<Button variant="primary" href={d.pdfUrl}><Download />PDF</Button>{/if}
    </div>
  </header>

  <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_400px]">
    <div class="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6">
      <SlidePlayer
        bind:this={player}
        bind:page={currentPage}
        bind:manifest
        version={shownVersion}
        deck={d.project.slug}
        title={d.project.title}
        {startPage}
        counts={reviewCounts}
      >
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
      </SlidePlayer>
      {#if preview?.status === "review"}
        <div class="flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center" style="border-color:var(--pill-lilac-ink);background:var(--pill-lilac)">
          <span class="hidden size-10 shrink-0 place-items-center rounded-xl bg-surface/70 sm:grid" style="color:var(--pill-lilac-ink)"><FileSearch class="size-5" /></span>
          <div class="min-w-0 flex-1" style="color:var(--pill-lilac-ink)">
            <p class="text-sm font-semibold">{t("slides.review.checkTitle", { n: preview.version })}</p>
            <p class="mt-0.5 text-[12.5px] leading-relaxed opacity-90">{d.permissions.manage ? t("slides.review.checkHint", { n: preview.pageCount ?? 0 }) : t("slides.versions.reviewHintViewer")}</p>
          </div>
          {#if d.permissions.manage}
            <div class="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" variant="ghost" class="text-danger hover:text-danger" onclick={() => (discardOpen = true)}><Trash2 />{t("slides.versions.discard")}</Button>
              <Button size="sm" variant="primary" loading={publishing} onclick={publishShown}><Send />{t("slides.versions.publish")}</Button>
            </div>
          {/if}
        </div>
      {:else if preview}
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
            <ReviewsPanel
              projectId={d.project.id}
              bind:reviews={detail.reviews}
              canReview={d.permissions.review}
              canReply={d.permissions.reply}
              {highlight}
              version={shownVersion}
              versions={d.versions}
              page={currentPage}
              onJump={jumpTo}
            />
          </Tabs.Content>
          <Tabs.Content value="versions" class="outline-none">
            <VersionsPanel
              projectId={d.project.id}
              versions={d.versions}
              canManage={d.permissions.manage}
              bind:previewId
              reindexing={Object.keys(reindexing)}
              onUpload={() => (uploadOpen = true)}
              onChanged={load}
              onReindex={(versionId, jobId) => (reindexing = { ...reindexing, [versionId]: jobId })}
            />
          </Tabs.Content>
          <Tabs.Content value="info" class="outline-none">
            <InfoPanel detail={d} onChanged={load} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </section>
  </div>

  {#if d.permissions.manage}
    <UploadSheet
      bind:open={uploadOpen}
      projectId={d.project.id}
      limits={d.limits}
      onUploaded={() => ((tab = "versions"), void load())}
      onRendered={s => void load().then(() => showReview(s.id))}
    />
    <ConfirmDialog
      bind:open={discardOpen}
      title={t("slides.versions.discardTitle", { n: shownVersion?.version ?? "" })}
      description={t("slides.versions.discardDescription")}
      confirmLabel={t("slides.versions.discard")}
      onConfirm={discardShown}
    />
  {/if}
{/if}
