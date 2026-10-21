<script lang="ts">
  import { CalendarClock } from "@lucide/svelte";
  import { daysUntil } from "#lib/dates.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";

  /** Due date with a relative hint; red when overdue, amber when within 3 days. `done` mutes it. */
  let { date, done = false, compact = false }: { date: string; done?: boolean; compact?: boolean } = $props();
  const days = $derived(daysUntil(date));
  const relative = $derived(
    done ? null : days < 0 ? t("studies.due.overdue", { n: -days }) : days === 0 ? t("studies.due.today") : days === 1 ? t("studies.due.tomorrow") : days <= 14 ? t("studies.due.inDays", { n: days }) : null,
  );
  const tone = $derived(done ? "text-ink-3" : days < 0 ? "text-danger" : days <= 3 ? "text-[var(--pill-butter-ink)]" : "text-ink-3");
  const absolute = $derived(formatDate(`${date}T12:00:00+08:00`, { month: "short", day: "numeric" }));
</script>

<span class="inline-flex shrink-0 items-center gap-1 text-[12.5px] tabular-nums {tone}" title={formatDate(`${date}T12:00:00+08:00`, { dateStyle: "full" })}>
  <CalendarClock class="size-3.5" />
  {#if compact}{relative ?? absolute}{:else}{absolute}{#if relative}<span aria-hidden="true">·</span>{relative}{/if}{/if}
</span>
