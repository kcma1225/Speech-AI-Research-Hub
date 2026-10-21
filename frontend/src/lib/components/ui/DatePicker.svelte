<script lang="ts">
  import { Calendar, Popover } from "bits-ui";
  import { parseDate, type DateValue } from "@internationalized/date";
  import { CalendarDays, ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { formatDate, i18n, t } from "#lib/i18n.svelte.ts";
  import { todayTaipei } from "#lib/dates.ts";
  import { markFormDirty } from "./close-guard.svelte.ts";

  /** Custom date picker; `value` is `YYYY-MM-DD`. With `clearable`, `""` means no date (shown as `placeholder`). */
  let { value = $bindable(), label, onValueChange, clearable = false, placeholder, class: cls = "" }: {
    value: string;
    label: string;
    onValueChange?: (v: string) => void;
    clearable?: boolean;
    placeholder?: string;
    class?: string;
  } = $props();
  let open = $state(false);
  const markDirty = markFormDirty();

  const parsed = $derived.by(() => {
    try {
      return parseDate(value);
    } catch {
      return parseDate(todayTaipei());
    }
  });

  function pick(next: DateValue | undefined) {
    if (!next) return;
    value = next.toString();
    markDirty();
    onValueChange?.(value);
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    aria-label={label}
    class="inline-flex h-10 items-center gap-2 rounded-xl border border-line-2 bg-surface px-3.5 text-sm text-ink transition-colors hover:border-ink-3 data-[state=open]:border-ink {cls}"
  >
    <CalendarDays class="size-4 text-ink-3" />
    {#if value}
      <span class="tabular-nums">{formatDate(`${value}T12:00:00+08:00`, { year: "numeric", month: "short", day: "numeric", weekday: "short" })}</span>
    {:else}
      <span class="text-ink-3">{placeholder ?? t("date.none")}</span>
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content align="start" sideOffset={6} class="z-50 rounded-2xl border border-line bg-surface p-3 shadow-pop outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]">
      <Calendar.Root type="single" value={parsed} onValueChange={pick} locale={i18n.locale} weekdayFormat="short" fixedWeeks>
        {#snippet children({ months, weekdays })}
          <Calendar.Header class="mb-2 flex items-center justify-between gap-2">
            <Calendar.PrevButton class="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink" aria-label={t("date.prev")}><ChevronLeft class="size-4" /></Calendar.PrevButton>
            <Calendar.Heading class="text-sm font-semibold" />
            <Calendar.NextButton class="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink" aria-label={t("date.next")}><ChevronRight class="size-4" /></Calendar.NextButton>
          </Calendar.Header>
          {#each months as month (month.value.toString())}
            <Calendar.Grid class="border-collapse">
              <Calendar.GridHead>
                <Calendar.GridRow class="flex">
                  {#each weekdays as day (day)}
                    <Calendar.HeadCell class="w-9 pb-1 text-center text-[11px] font-medium text-ink-3">{day}</Calendar.HeadCell>
                  {/each}
                </Calendar.GridRow>
              </Calendar.GridHead>
              <Calendar.GridBody>
                {#each month.weeks as weekDates, w (w)}
                  <Calendar.GridRow class="flex">
                    {#each weekDates as date (date.toString())}
                      <Calendar.Cell {date} month={month.value} class="p-0">
                        <Calendar.Day
                          class="grid size-9 cursor-pointer place-items-center rounded-full text-[13px] text-ink tabular-nums transition-colors hover:bg-surface-3 data-[outside-month]:text-ink-3/50 data-[today]:font-semibold data-[today]:underline data-[today]:underline-offset-4 data-[selected]:bg-primary data-[selected]:text-primary-ink data-[selected]:no-underline"
                        />
                      </Calendar.Cell>
                    {/each}
                  </Calendar.GridRow>
                {/each}
              </Calendar.GridBody>
            </Calendar.Grid>
          {/each}
          <div class="mt-2 flex justify-end gap-1 border-t border-line pt-2">
            {#if clearable && value}
              <button type="button" class="h-8 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={() => ((value = ""), markDirty(), onValueChange?.(""), (open = false))}>{t("date.clear")}</button>
            {/if}
            <button type="button" class="h-8 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={() => pick(parseDate(todayTaipei()))}>{t("date.today")}</button>
          </div>
        {/snippet}
      </Calendar.Root>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
