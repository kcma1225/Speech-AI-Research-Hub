<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { goto } from "$app/navigation";
  import { Ellipsis, FileCode2, FilePen, Globe, MessageSquareQuote, Presentation, Trash2 } from "@lucide/svelte";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import type { SlideSummary } from "#lib/slides/types.ts";
  import { deckUrl } from "#lib/slides/util.ts";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import StatusPill from "./StatusPill.svelte";

  /**
   * `showStudy`: the study pill (off inside the study's own 簡報 tab). `onDelete` (study editors) adds a ⋯ menu
   * with 編輯原始檔 / 刪除簡報 next to the card's link.
   */
  let { deck, showStudy = true, onDelete }: { deck: SlideSummary; showStudy?: boolean; onDelete?: () => void } = $props();
  const status = $derived(deck.latest_status && deck.latest_status !== "published" ? deck.latest_status : null);
  const draft = $derived(!deck.active_version && !deck.latest_status && deck.has_source);
  const date = $derived(deck.published_at ?? deck.updated_at);
</script>

<div class="relative flex flex-col">
<a href={deckUrl(deck.study.slug, deck.id)} class="group flex flex-1 flex-col overflow-hidden rounded-[22px] border border-line/70 bg-surface shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2">
  <div class="relative aspect-[16/10] overflow-hidden border-b border-line/70 bg-surface-2">
    {#if deck.thumbnailUrl}
      <img src={deck.thumbnailUrl} alt="" loading="lazy" class="size-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]" />
    {:else}
      <div class="grid size-full place-items-center hero-gradient opacity-70"><Presentation class="size-9 text-hero-ink opacity-45" /></div>
    {/if}
    <div class="absolute top-2.5 left-2.5 {onDelete ? 'right-14' : 'right-2.5'} flex items-start justify-between gap-2">
      {#if status}<StatusPill {status} class="shadow-card" />{:else if draft}<span class="inline-flex h-6 items-center gap-1 rounded-full bg-surface/90 px-2 text-[11px] font-medium text-ink-2 shadow-card backdrop-blur"><FilePen class="size-3" />{t("slides.deck.draft")}</span>{:else}<span></span>{/if}
      {#if deck.public_view}
        <span class="inline-flex h-6 items-center gap-1 rounded-full bg-surface/90 px-2 text-[11px] font-medium text-ink-2 shadow-card backdrop-blur" title={t("slides.public")}>
          <Globe class="size-3" />{t("slides.public")}
        </span>
      {/if}
    </div>
  </div>
  <div class="flex flex-1 flex-col gap-3 p-4 sm:p-[18px]">
    <h3 class="line-clamp-2 text-[15px] leading-snug font-semibold text-ink group-hover:underline">{deck.title}</h3>
    <div class="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
      {#if deck.author_name}
        <Avatar name={deck.author_name} size={20} class="ring-0" />
        <span class="min-w-0 truncate text-ink-2">{deck.author_name}</span>
        <span aria-hidden="true">·</span>
      {/if}
      <span class="shrink-0">{deck.active_version ? t("slides.version", { n: deck.active_version }) : t("slides.noVersion")}</span>
      <span aria-hidden="true">·</span>
      <span class="shrink-0">{formatDate(date)}</span>
    </div>
    <div class="mt-auto flex items-center gap-2">
      <div class="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
        {#if showStudy}<Pill tone={toneFor(deck.study.id)} size="sm" class="shrink">{deck.study.title}</Pill>{/if}
        {#if deck.kind === "paper_report"}<Pill size="sm" class="shrink-0">{t("slides.kind.paper_report")}</Pill>{/if}
      </div>
      {#if deck.review_count}
        <span class="inline-flex shrink-0 items-center gap-1 text-[12px] text-ink-3" title={t("slides.reviews", { n: deck.review_count })}>
          <MessageSquareQuote class="size-3.5" />{deck.review_count}
        </span>
      {/if}
    </div>
  </div>
</a>
{#if onDelete}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="absolute top-1.5 right-1.5 grid size-10 cursor-pointer place-items-center rounded-full bg-surface/90 text-ink-2 shadow-card backdrop-blur hover:bg-surface hover:text-ink" aria-label={t("crud.more")} title={t("crud.more")}>
      <Ellipsis class="size-4" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={4} class={menuContent}>
        {#if deck.has_source}
          <DropdownMenu.Item class={menuItem} onSelect={() => void goto(deckUrl(deck.study.slug, deck.id, "edit"))}><FileCode2 />{t("slides.edit.open")}</DropdownMenu.Item>
          <DropdownMenu.Separator class={menuSeparator} />
        {/if}
        <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={onDelete}><Trash2 />{t("crud.deck.delete")}</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
</div>
