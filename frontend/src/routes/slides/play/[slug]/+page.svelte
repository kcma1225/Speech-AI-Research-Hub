<script lang="ts">
  import { deckUrl } from "#lib/slides/util.ts";
  import { Popover } from "bits-ui";
  import { ArrowLeft, BookOpen, Download, Expand, FileText, Link2, LogIn, Presentation, Star } from "@lucide/svelte";
  import { page } from "$app/state";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { menuContent } from "#lib/components/ui/menu.ts";
  import SlidePlayer from "#lib/components/slides/SlidePlayer.svelte";
  import type { SlideDetail } from "#lib/slides/types.ts";

  // Standalone full-screen player (outside the app shell): signed-in users, public decks, and
  // share-link visitors (`?key=` or the `slide_share_<slug>` cookie set by /api/slides/share/…).
  const slug = $derived(page.params.slug!);
  let detail = $state<SlideDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let player = $state<ReturnType<typeof SlidePlayer> | null>(null);
  const shareKey = $derived(page.url.searchParams.get("key"));
  // `?p=3` opens a given page (otherwise the last viewed one).
  const startPage = $derived(Number(page.url.searchParams.get("p")) || null);

  $effect(() => {
    const key = page.url.searchParams.get("key");
    detail = null;
    error = null;
    api.get<SlideDetail>(`/slides/by-slug/${encodeURIComponent(slug)}${key ? `?key=${encodeURIComponent(key)}` : ""}`).then(
      d => (detail = d),
      e => (error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }),
    );
  });
  const signedIn = $derived(Boolean(session.user));
  // `?key=` visitors may not hold the share cookie yet: PDF and reference routes need the key too.
  const withKey = (href: string) => {
    const key = page.url.searchParams.get("key");
    return key && href.startsWith("/api/") ? `${href}${href.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : href;
  };
  const loginHref = $derived(`/login?next=${encodeURIComponent(page.url.pathname)}`);
</script>

<svelte:head><title>{detail ? `${detail.project.title} · ` : ""}{t("brand.name")}</title></svelte:head>

<div class="flex h-dvh flex-col bg-canvas">
  <header class="flex h-[calc(56px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4">
    {#if signedIn}
      <Button variant="ghost" size="sm" href={detail?.study ? deckUrl(detail.study.slug, detail.project.id) : detail ? `/slides/${detail.project.id}` : "/slides"} class="px-2.5 sm:px-3" aria-label={t("slides.play.back")}>
        <ArrowLeft /><span class="hidden sm:inline">{t("slides.play.back")}</span>
      </Button>
    {:else}
      <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Presentation class="size-4" /></span>
    {/if}
    <h1 class="min-w-0 flex-1 truncate text-[14px] font-semibold sm:text-[15px]">{detail?.project.title ?? ""}</h1>
    {#if detail}
      {#if detail.references.length}
        <Popover.Root>
          <Popover.Trigger class="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink sm:px-3" aria-label={t("slides.play.references")}>
            <BookOpen class="size-4" /><span class="hidden sm:inline">{t("slides.play.references")}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={6} class="{menuContent} w-72">
              {#each detail.references as ref (ref.id)}
                <a href={withKey(ref.href)} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-surface-2">
                  {#if ref.kind === "file"}<FileText class="size-4 shrink-0 text-ink-3" />{:else}<Link2 class="size-4 shrink-0 text-ink-3" />{/if}
                  <span class="min-w-0 flex-1 truncate text-sm">{ref.title}</span>
                  {#if ref.is_default}<Star class="size-3.5 shrink-0 text-ink-3" />{/if}
                </a>
              {/each}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      {/if}
      {#if detail.pdfUrl}
        <Button variant="ghost" size="sm" href={withKey(detail.pdfUrl)} class="px-2.5 sm:px-3" aria-label={t("slides.pdf")}><Download /><span class="hidden sm:inline">PDF</span></Button>
      {/if}
      <Button variant="secondary" size="sm" disabled={!detail.activeVersion} onclick={() => player?.fullscreen()} class="px-2.5 sm:px-3" aria-label={t("slides.fullscreen")}>
        <Expand /><span class="hidden sm:inline">{t("slides.fullscreen")}</span>
      </Button>
    {/if}
    {#if !signedIn}
      <Button variant="ghost" size="sm" href={loginHref} class="px-2.5 sm:px-3" aria-label={t("slides.play.login")}><LogIn /><span class="hidden sm:inline">{t("slides.play.login")}</span></Button>
    {/if}
  </header>

  <main class="relative min-h-0 flex-1">
    {#if error}
      <div class="grid h-full place-items-center">
        <EmptyState title={error.status === 404 ? t("slides.notFound") : t("slides.loadError")} hint={error.status === 404 ? undefined : error.message}>
          {#snippet icon()}<Presentation />{/snippet}
          {#snippet action()}
            {#if signedIn}<Button variant="secondary" href="/studies">{t("slides.backToStudies")}</Button>{:else}<Button variant="primary" href={loginHref}>{t("slides.play.login")}</Button>{/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else if !detail}
      <div class="grid h-full place-items-center text-ink-3"><Spinner class="size-5" /></div>
    {:else}
      <SlidePlayer
        bind:this={player}
        version={detail.activeVersion}
        deck={detail.project.slug}
        title={detail.project.title}
        {startPage}
        {shareKey}
        variant="stage"
        globalKeys
        class="absolute inset-0"
      >
        {#snippet empty()}
          <EmptyState title={t("slides.noDeck")} hint={t("slides.noDeck.rendering")}>{#snippet icon()}<Presentation />{/snippet}</EmptyState>
        {/snippet}
      </SlidePlayer>
    {/if}
  </main>
</div>
