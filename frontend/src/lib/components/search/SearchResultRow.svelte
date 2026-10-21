<script lang="ts">
  import { Sparkles } from "@lucide/svelte";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { typeMeta } from "#lib/search/meta.ts";
  import type { SearchHit } from "#lib/search/types.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Highlighted from "./Highlighted.svelte";

  let { hit }: { hit: SearchHit } = $props();
  const meta = $derived(typeMeta(hit.type));
  const m = $derived(hit.meta as Record<string, string | number | boolean | null | undefined>);

  /** Short type-specific facts shown after the study name. */
  const facts = $derived.by(() => {
    const out: string[] = [];
    if (hit.type === "paper") {
      if (m.year) out.push(String(m.year));
      if (m.venue) out.push(String(m.venue));
    } else if (hit.type === "task") {
      const st = m.status === "done" ? "search.status.done" : m.status === "dropped" ? "search.status.dropped" : "search.status.open";
      out.push(t(st));
      if (m.due_on) out.push(t("search.due", { date: formatDate(`${m.due_on}T12:00:00+08:00`) }));
    } else if (hit.type === "milestone") {
      if (m.due_on) out.push(t("search.due", { date: formatDate(`${m.due_on}T12:00:00+08:00`) }));
    } else if (hit.type === "note" && m.event_date) {
      out.push(formatDate(`${m.event_date}T12:00:00+08:00`));
    } else if (hit.type === "meeting") {
      out.push(formatDate(hit.at));
    } else {
      out.push(formatDate(hit.at));
    }
    return out;
  });
  const semanticOnly = $derived(hit.matched.length === 1 && hit.matched[0] === "semantic");
</script>

<a
  href={hit.url}
  class="group flex min-h-[64px] items-start gap-3 rounded-2xl px-3 py-3 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:px-4"
>
  <span class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2 [&>svg]:size-[17px]"><meta.icon /></span>
  <span class="min-w-0 flex-1">
    <span class="flex min-w-0 items-start gap-2">
      <Highlighted text={hit.title} ranges={hit.title_highlights} class="min-w-0 flex-1 text-[14.5px] leading-snug font-medium break-words text-ink" />
      {#if semanticOnly}<span class="shrink-0"><Pill tone="lilac" size="sm"><Sparkles class="size-3" />{t("search.matchedSemantic")}</Pill></span>{/if}
    </span>
    {#if hit.snippet}
      <Highlighted text={hit.snippet} ranges={hit.highlights} class="mt-1 line-clamp-2 text-[13px] leading-relaxed break-words text-ink-2" />
    {/if}
    <span class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
      {#if hit.study && hit.type !== "study"}<span class="max-w-full truncate font-medium text-ink-2">{hit.study.title}</span><span aria-hidden="true">·</span>{/if}
      {#each facts as f, i (i)}<span>{f}</span><span aria-hidden="true" class="last:hidden">·</span>{/each}
      {#if hit.author}<span>{hit.author.name}</span>{/if}
    </span>
  </span>
</a>
