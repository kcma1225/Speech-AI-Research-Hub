<script lang="ts">
  import { ArrowRight, ArrowUpRight, AudioLines, FileText, MessageSquareQuote, MessageSquareReply, Mic, Plus, Presentation, Upload } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import type { Dashboard } from "#lib/types.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { toneFor, type Tone } from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";

  let data = $state<Dashboard | null>(null);
  let error = $state<string | null>(null);
  const s = $derived(data?.stats);
  $effect(() => {
    api.get<Dashboard>("/dashboard").then(d => (data = d), e => (error = e.message));
  });

  const hour = Number(new Intl.DateTimeFormat("en", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Taipei" }).format(new Date()));
  const greeting: MessageKey = hour < 11 ? "dash.greeting.morning" : hour < 18 ? "dash.greeting.afternoon" : "dash.greeting.evening";

  const kindMeta: Record<Dashboard["activity"][number]["kind"], { icon: typeof Presentation; tone: Tone }> = {
    slide_version: { icon: Presentation, tone: "peach" },
    note: { icon: FileText, tone: "sky" },
    recording: { icon: AudioLines, tone: "mint" },
    review: { icon: MessageSquareQuote, tone: "lilac" },
    reply: { icon: MessageSquareReply, tone: "butter" },
  };
</script>

<div class="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
  <div>
    <h1 class="font-display text-[34px] leading-[1.05] sm:text-[46px]">{t(greeting, { name: session.user!.name })}</h1>
    <p class="mt-2 text-[14px] text-ink-3">{t("dash.subtitle")}</p>
  </div>
  {#if session.canEdit}
    <div class="flex gap-2">
      <Button variant="secondary" href="/notes?new=1"><Plus />{t("action.newNote")}</Button>
      <Button variant="primary" href="/slides?upload=1"><Upload />{t("action.upload")}</Button>
    </div>
  {/if}
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else}
  <div class="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-3">
    <!-- Hero: latest deck -->
    <section class="relative overflow-hidden rounded-[28px] hero-gradient p-5 text-hero-ink sm:p-7 xl:col-span-2">
      {#if !data}
        <Skeleton class="h-[260px] bg-white/40 dark:bg-white/5" />
      {:else if !data.latestSlide}
        <div class="flex min-h-[240px] flex-col justify-between gap-6">
          <span class="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/55 px-3 py-1 text-xs font-medium backdrop-blur dark:bg-black/25"><Presentation class="size-3.5" />{t("dash.latest")}</span>
          <div>
            <h2 class="font-display text-[34px] leading-tight sm:text-[42px]">{t("dash.noSlides")}</h2>
            <p class="mt-2 max-w-md text-sm opacity-75">{t("dash.noSlidesHint")}</p>
          </div>
          {#if session.canEdit}<Button variant="primary" href="/slides?upload=1" class="w-fit"><Upload />{t("action.upload")}</Button>{/if}
        </div>
      {:else}
        {@const deck = data.latestSlide}
        <div class="grid items-center gap-6 md:grid-cols-[1fr_minmax(0,46%)]">
          <div class="flex min-w-0 flex-col gap-5">
            <span class="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/55 px-3 py-1 text-xs font-medium backdrop-blur dark:bg-black/25"><Presentation class="size-3.5" />{t("dash.latest")}</span>
            <div>
              <h2 class="font-display text-[32px] leading-[1.08] text-balance sm:text-[42px]">{deck.title}</h2>
              <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] opacity-80">
                {#if deck.authorName}<span class="inline-flex items-center gap-2"><Avatar name={deck.authorName} size={22} class="ring-white/60" />{deck.authorName}</span><span aria-hidden="true">·</span>{/if}
                <span>{t("dash.version", { n: deck.version })}</span><span aria-hidden="true">·</span>
                <span>{formatDate(deck.publishedAt)}</span>
              </div>
            </div>
            {#if deck.tags.length}
              <div class="flex flex-wrap gap-1.5">
                {#each deck.tags as tag (tag.id)}<span class="rounded-full bg-white/55 px-2.5 py-0.5 text-xs font-medium dark:bg-black/25">{tag.name}</span>{/each}
              </div>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="primary" href="/slides/{deck.id}">{t("action.open")}<ArrowRight /></Button>
              {#if deck.reviewCount}
                <a href="/slides/{deck.id}#reviews" class="inline-flex h-10 items-center gap-2 rounded-full bg-white/55 px-4 text-sm font-medium backdrop-blur hover:bg-white/75 dark:bg-black/25 dark:hover:bg-black/35">
                  <MessageSquareQuote class="size-4" />{t("dash.reviews", { n: deck.reviewCount })}
                </a>
              {/if}
            </div>
          </div>
          <a href="/slides/{deck.id}" class="group block" aria-label={deck.title}>
            <div class="aspect-[16/10] overflow-hidden rounded-[18px] bg-white/70 shadow-[0_24px_48px_-20px_rgb(80_30_10/0.45)] ring-1 ring-black/5 transition-transform duration-300 group-hover:-translate-y-1 dark:bg-black/30 dark:ring-white/10">
              {#if deck.thumbnailUrl}
                <img src={deck.thumbnailUrl} alt="" class="size-full object-cover" loading="lazy" />
              {:else}
                <div class="grid size-full place-items-center"><Presentation class="size-10 opacity-40" /></div>
              {/if}
            </div>
          </a>
        </div>
      {/if}
    </section>

    <!-- Stats -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4">
      {#snippet stat(label: string, value: number | undefined, icon: typeof Presentation, tone: Tone, foot: string | null, href: string)}
        {@const Icon = icon}
        <a href={href} class="group flex flex-col justify-between gap-4 rounded-[22px] border border-line/70 bg-surface p-4 shadow-card transition-colors hover:border-line-2 sm:p-5">
          <div class="flex items-center justify-between">
            <span class="grid size-9 place-items-center rounded-xl" style="background:var(--pill-{tone});color:var(--pill-{tone}-ink)"><Icon class="size-[18px]" /></span>
            <ArrowUpRight class="size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div>
            {#if value === undefined}<Skeleton class="h-9 w-14" />{:else}<p class="text-[32px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{value}</p>{/if}
            <p class="mt-1.5 text-[13px] text-ink-2">{label}</p>
            {#if foot}<p class="mt-0.5 text-[12px] text-ink-3">{foot}</p>{/if}
          </div>
        </a>
      {/snippet}
      {@render stat(t("dash.stat.slides"), s?.slides, Presentation, "peach", s ? t("dash.stat.thisWeek", { n: s.slidesThisWeek }) : null, "/slides")}
      {@render stat(t("dash.stat.notes"), s?.notes, FileText, "sky", s ? t("dash.stat.thisWeek", { n: s.notesThisWeek }) : null, "/notes")}
      {@render stat(t("dash.stat.recordings"), s?.recordings, Mic, "mint", null, "/recordings")}
      {@render stat(t("dash.stat.pending"), s?.pendingReviews, MessageSquareQuote, "lilac", s && !s.pendingReviews ? t("dash.stat.allClear") : null, "#pending")}
    </div>

    <!-- Activity -->
    <Card class="xl:col-span-2" padded={false}>
      <div class="px-5 pt-5 sm:px-6 sm:pt-6"><CardHeader title={t("dash.activity")} /></div>
      {#if !data}
        <div class="flex flex-col gap-2 px-5 pb-5 sm:px-6">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-11" />{/each}</div>
      {:else if !data.activity.length}
        <EmptyState title={t("dash.activity.empty")} class="pb-10" />
      {:else}
        <table class="hidden w-full text-left text-[13.5px] md:table">
          <thead>
            <tr class="border-y border-line bg-surface-2/60 text-[12px] text-ink-3">
              <th class="py-2.5 pl-6 font-medium">{t("dash.activity.col.item")}</th>
              <th class="py-2.5 font-medium">{t("dash.activity.col.type")}</th>
              <th class="py-2.5 font-medium">{t("dash.activity.col.who")}</th>
              <th class="py-2.5 pr-6 text-right font-medium">{t("dash.activity.col.when")}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.activity as a (a.kind + a.id)}
              {@const meta = kindMeta[a.kind]}
              <tr class="group border-b border-line last:border-0 hover:bg-surface-2/60">
                <td class="max-w-0 py-3 pl-6">
                  <a href={a.url} class="flex items-center gap-3">
                    <span class="grid size-8 shrink-0 place-items-center rounded-lg" style="background:var(--pill-{meta.tone});color:var(--pill-{meta.tone}-ink)"><meta.icon class="size-4" /></span>
                    <span class="truncate font-medium text-ink group-hover:underline">{a.title}</span>
                  </a>
                </td>
                <td class="w-28 py-3"><Pill tone={meta.tone} size="sm" dot>{t(`dash.kind.${a.kind}`)}</Pill></td>
                <td class="w-44 py-3">
                  {#if a.actor}<span class="flex items-center gap-2 text-ink-2"><Avatar name={a.actor.name} size={24} class="ring-0" /><span class="truncate">{a.actor.name}</span></span>{:else}<span class="text-ink-3">—</span>{/if}
                </td>
                <td class="w-32 py-3 pr-6 text-right whitespace-nowrap text-ink-3">{relativeTime(a.at)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <ul class="flex flex-col px-3 pb-3 md:hidden">
          {#each data.activity as a (a.kind + a.id)}
            {@const meta = kindMeta[a.kind]}
            <li>
              <a href={a.url} class="flex items-center gap-3 rounded-2xl px-2 py-2.5 active:bg-surface-2">
                <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="background:var(--pill-{meta.tone});color:var(--pill-{meta.tone}-ink)"><meta.icon class="size-4" /></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium">{a.title}</span>
                  <span class="block truncate text-[12px] text-ink-3">{t(`dash.kind.${a.kind}`)}{#if a.actor} · {a.actor.name}{/if}</span>
                </span>
                <span class="shrink-0 text-[12px] text-ink-3">{relativeTime(a.at)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- Pending reviews -->
    <Card class="scroll-mt-24">
      <div id="pending"></div>
      <CardHeader title={t("dash.pending")} />
      {#if !data}
        <div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-20" />{/each}</div>
      {:else if !data.pendingReviews.length}
        <EmptyState title={t("dash.pending.empty")}>{#snippet icon()}<MessageSquareQuote />{/snippet}</EmptyState>
      {:else}
        <ul class="flex flex-col gap-2.5">
          {#each data.pendingReviews as r (r.reviewId)}
            <li>
              <a href="/slides/{r.slideId}#review-{r.reviewId}" class="block rounded-2xl border border-line p-3.5 transition-colors hover:border-line-2 hover:bg-surface-2/60">
                <p class="line-clamp-2 text-[13.5px] leading-relaxed text-ink">“{r.excerpt}”</p>
                <div class="mt-2.5 flex items-center gap-2 text-[12px] text-ink-3">
                  {#if r.authorName}<Avatar name={r.authorName} size={20} class="ring-0" /><span class="shrink-0 whitespace-nowrap text-ink-2">{r.authorName}</span><span aria-hidden="true">·</span>{/if}
                  <span class="min-w-0 truncate">{t("dash.pending.on", { title: r.slideTitle })}</span>
                  <span class="ml-auto shrink-0">{relativeTime(r.createdAt)}</span>
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- Recent notes -->
    <section class="xl:col-span-3">
      <div class="mb-3 flex items-center justify-between px-1">
        <h2 class="text-[15px] font-semibold">{t("dash.recentNotes")}</h2>
        <a href="/notes" class="inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">{t("action.viewAll")}<ArrowRight class="size-3.5" /></a>
      </div>
      {#if !data}
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{#each [0, 1, 2] as i (i)}<Skeleton class="h-36 rounded-[22px]" />{/each}</div>
      {:else if !data.recentNotes.length}
        <Card><EmptyState title={t("dash.recentNotes.empty")}>{#snippet icon()}<FileText />{/snippet}</EmptyState></Card>
      {:else}
        <div class="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {#each data.recentNotes as note (note.id)}
            <a href="/notes/{note.id}" class="group flex flex-col rounded-[22px] border border-line/70 bg-surface p-5 shadow-card transition-colors hover:border-line-2">
              <div class="flex items-start justify-between gap-3">
                <h3 class="line-clamp-2 text-[15px] font-semibold text-ink group-hover:underline">{note.title}</h3>
                {#if note.hasAudio}<span class="grid size-7 shrink-0 place-items-center rounded-lg" style="background:var(--pill-mint);color:var(--pill-mint-ink)" title={t("dash.hasAudio")}><AudioLines class="size-3.5" /></span>{/if}
              </div>
              <p class="mt-2 line-clamp-2 flex-1 text-[13px] leading-relaxed text-ink-3">{note.excerpt}</p>
              <div class="mt-4 flex items-center gap-2">
                <div class="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
                  {#each note.tags.slice(0, 2) as tag (tag.id)}<Pill tone={toneFor(tag.name)} size="sm">{tag.name}</Pill>{/each}
                </div>
                <span class="shrink-0 text-[12px] text-ink-3">{relativeTime(note.updatedAt)}</span>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/if}
