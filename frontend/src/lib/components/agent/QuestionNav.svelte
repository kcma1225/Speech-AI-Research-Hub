<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ArrowDownToLine, ChevronDown, ChevronUp, ListOrdered } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { menuContent } from "#lib/components/ui/menu.ts";

  /**
   * Question navigator: jumps between the user's questions of a long conversation.
   * - `rail`: slim column at the right of the transcript (labels when `wide`, tick marks with a hover label otherwise).
   * - `sheet`: floating button that opens a bottom sheet (phones / narrow tablets).
   * - `compact`: a small bar with 上一題 / 下一題 and a dropdown list (the global Ask-AI panel).
   */
  let { questions, current, variant, wide = false, onJump, onLatest }: {
    questions: { id: string; text: string }[];
    /** Index of the question the reader is at (-1 = before the first). */
    current: number;
    variant: "rail" | "sheet" | "compact";
    wide?: boolean;
    onJump: (index: number) => void;
    onLatest: () => void;
  } = $props();
  let sheetOpen = $state(false);

  const firstLine = (s: string) => {
    const line = s.trim().split("\n").find((l) => l.trim()) ?? "";
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  };
  const tooltip = (s: string) => (s.length > 280 ? `${s.slice(0, 280)}…` : s);
  const canPrev = $derived(current > 0);
  const canNext = $derived(current < questions.length - 1);
  const btn = "grid size-10 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-35";
  const keys = $derived(t("agent.qnav.keys"));
</script>

{#snippet controls(vertical: boolean)}
  <div class="flex {vertical ? 'flex-col' : ''} items-center gap-0.5">
    <button type="button" class={btn} disabled={!canPrev} aria-label={t("agent.qnav.prev")} title="{t('agent.qnav.prev')} (Alt+↑)" onclick={() => onJump(Math.max(0, current - 1))}><ChevronUp class="size-4" /></button>
    <button type="button" class={btn} disabled={!canNext} aria-label={t("agent.qnav.next")} title="{t('agent.qnav.next')} (Alt+↓)" onclick={() => onJump(Math.min(questions.length - 1, current + 1))}><ChevronDown class="size-4" /></button>
    <button type="button" class={btn} aria-label={t("agent.qnav.latest")} title="{t('agent.qnav.latest')} (Alt+End)" onclick={onLatest}><ArrowDownToLine class="size-4" /></button>
  </div>
{/snippet}

{#if variant === "rail"}
  <nav class="rail flex h-full min-h-0 flex-col border-l border-line {wide ? 'w-[212px]' : 'w-[52px]'}" aria-label={t("agent.qnav.title")}>
    {#if wide}<p class="px-3.5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{t("agent.qnav.title")} · {questions.length}</p>{/if}
    <ol class="min-h-0 flex-1 overflow-y-auto overscroll-contain {wide ? 'px-2 py-1' : 'flex flex-col items-center gap-0.5 py-3'}">
      {#each questions as q, i (q.id)}
        <li class="relative {wide ? '' : 'w-full'}">
          <button
            type="button"
            class="item group/q {wide ? 'flex min-h-10 w-full items-start gap-2 rounded-xl px-2 py-2 text-left' : 'grid h-7 w-full place-items-center'}"
            aria-current={i === current ? "true" : undefined}
            aria-label={wide ? undefined : t("agent.qnav.jump", { n: i + 1, text: firstLine(q.text) })}
            title={wide ? tooltip(q.text) : undefined}
            onclick={() => onJump(i)}
          >
            {#if wide}
              <span class="num mt-px w-5 shrink-0 text-right text-[11.5px] text-ink-3 tabular-nums">{i + 1}</span>
              <span class="label line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">{firstLine(q.text)}</span>
            {:else}
              <span class="tick block h-[3px] w-4 rounded-full bg-line-2"></span>
              <span class="tip pointer-events-none absolute top-1/2 right-[calc(100%+6px)] z-20 w-max max-w-[260px] -translate-y-1/2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-[12.5px] leading-snug text-ink shadow-pop" aria-hidden="true">
                <span class="text-ink-3 tabular-nums">{i + 1}.</span> {firstLine(q.text)}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ol>
    <div class="flex shrink-0 justify-center border-t border-line py-1.5" title={keys}>{@render controls(!wide)}</div>
  </nav>
{:else if variant === "sheet"}
  <button type="button" class="fab inline-flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-medium text-ink-2 shadow-pop" aria-label={t("agent.qnav.open")} onclick={() => (sheetOpen = true)}>
    <ListOrdered class="size-4" />{current >= 0 ? `${current + 1} / ${questions.length}` : questions.length}
  </button>
  <Sheet bind:open={sheetOpen} title={t("agent.qnav.title")}>
    <ol class="flex flex-col gap-1">
      {#each questions as q, i (q.id)}
        <li>
          <button type="button" class="item flex min-h-11 w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left" aria-current={i === current ? "true" : undefined} onclick={() => ((sheetOpen = false), onJump(i))}>
            <span class="num w-5 shrink-0 text-right text-[12px] text-ink-3 tabular-nums">{i + 1}</span>
            <span class="label line-clamp-3 min-w-0 flex-1 text-[13.5px] leading-snug text-ink-2">{q.text}</span>
          </button>
        </li>
      {/each}
    </ol>
    {#snippet footer()}
      <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-ink-2 hover:bg-surface-3" onclick={() => ((sheetOpen = false), onLatest())}><ArrowDownToLine class="size-4" />{t("agent.qnav.latest")}</button>
    {/snippet}
  </Sheet>
{:else}
  <div class="flex items-center gap-0.5 rounded-full border border-line bg-surface/95 p-0.5 shadow-card backdrop-blur" role="group" aria-label={t("agent.qnav.title")}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="inline-flex h-10 max-w-[180px] items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3" aria-label={t("agent.qnav.open")}>
        <ListOrdered class="size-4 shrink-0" /><span class="tabular-nums">{current >= 0 ? `${current + 1} / ${questions.length}` : questions.length}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} max-h-[min(60dvh,420px)] w-[min(320px,calc(100vw-32px))] overflow-y-auto">
          {#each questions as q, i (q.id)}
            <DropdownMenu.Item class="item flex min-h-10 cursor-pointer items-start gap-2 rounded-xl px-2.5 py-2 text-left outline-none select-none data-highlighted:bg-surface-2" aria-current={i === current ? "true" : undefined} onSelect={() => onJump(i)}>
              <span class="num w-5 shrink-0 text-right text-[12px] text-ink-3 tabular-nums">{i + 1}</span>
              <span class="label line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug text-ink-2">{firstLine(q.text)}</span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {@render controls(false)}
  </div>
{/if}

<style>
  .item[aria-current="true"] .label,
  :global(.item[aria-current="true"]) .label {
    color: var(--ink);
    font-weight: 600;
  }
  .item[aria-current="true"] .num {
    color: var(--ink);
  }
  .item:hover .label {
    color: var(--ink);
  }
  button.item:not(.grid):hover,
  .item[aria-current="true"]:not(.grid) {
    background: var(--surface-2);
  }
  .tick {
    transition:
      width 140ms ease,
      background-color 140ms ease;
  }
  .item:hover .tick,
  .item:focus-visible .tick {
    width: 22px;
    background: var(--ink-3);
  }
  .item[aria-current="true"] .tick {
    width: 24px;
    background: var(--ink);
  }
  .tip {
    opacity: 0;
    transform: translate(4px, -50%);
    transition:
      opacity 120ms ease,
      transform 120ms ease;
  }
  .item:hover .tip,
  .item:focus-visible .tip {
    opacity: 1;
    transform: translate(0, -50%);
  }
  .rail {
    transition: width 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .tick,
    .tip,
    .rail {
      transition: none;
    }
  }
</style>
