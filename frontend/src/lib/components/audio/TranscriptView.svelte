<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronDown, ChevronUp, Copy, CopyCheck, LocateFixed, Search, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { cueIndexAt, formatClock, type Cue } from "#lib/recordings/types.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /**
   * Transcript synced to playback: highlights and follows the current cue, click to seek, search with highlighted matches.
   * Following pauses when the user scrolls the list; a pill brings it back.
   */
  let {
    cues,
    currentTime,
    playing = false,
    onSeek,
    actions,
    class: cls = "",
    listClass = "max-h-[560px]",
    scroll = "self",
    insetTop = 0,
    insetBottom = 0,
  }: {
    cues: Cue[];
    currentTime: number;
    playing?: boolean;
    onSeek: (time: number) => void;
    /** Extra header buttons (e.g. replace/remove transcript). */
    actions?: Snippet;
    class?: string;
    /** Height of the scrolling cue list (`scroll="self"`). */
    listClass?: string;
    /** `self`: the list scrolls in its own box; `page`: the list is in the page flow and the window scrolls (phones). */
    scroll?: "self" | "page";
    /** Page mode: px hidden behind fixed bars at the top/bottom of the viewport. */
    insetTop?: number;
    insetBottom?: number;
  } = $props();

  let list = $state<HTMLOListElement | null>(null);
  let query = $state("");
  let matchCursor = $state(0);
  let follow = $state(true);
  let copied = $state(false);
  let programmaticUntil = 0;

  const active = $derived(cueIndexAt(cues, currentTime));
  /** Highlight only while inside the cue; between cues keep following the last started one. */
  const inside = $derived(active >= 0 && currentTime < cues[active]!.end + 0.25);
  const needle = $derived(query.trim().toLowerCase());
  const matches = $derived(needle ? cues.flatMap((c, i) => (c.text.toLowerCase().includes(needle) ? [i] : [])) : []);
  const focusedMatch = $derived(matches.length ? matches[Math.min(matchCursor, matches.length - 1)]! : -1);
  const showReturn = $derived(!follow && active >= 0 && playing);

  function parts(text: string): { text: string; hit: boolean }[] {
    if (!needle) return [{ text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    const lower = text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
      if (i > at) out.push({ text: text.slice(at, i), hit: false });
      out.push({ text: text.slice(i, i + needle.length), hit: true });
      at = i + needle.length;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  }

  function scrollToCue(index: number, smooth = true) {
    const row = list?.querySelector<HTMLElement>(`[data-cue="${index}"]`);
    if (!list || !row) return;
    const behavior = smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto";
    programmaticUntil = performance.now() + 800;
    if (scroll === "page") {
      const rect = row.getBoundingClientRect();
      const center = (insetTop + innerHeight - insetBottom) / 2;
      window.scrollTo({ top: Math.max(0, scrollY + rect.top + rect.height / 2 - center), behavior });
    } else {
      const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
      list.scrollTo({ top: Math.max(0, top), behavior });
    }
  }

  // Follow the current cue.
  $effect(() => {
    if (follow && active >= 0 && !needle) scrollToCue(active);
  });
  // Jump to the focused search match.
  $effect(() => {
    if (focusedMatch >= 0) {
      follow = false;
      scrollToCue(focusedMatch);
    }
  });

  function userScrolled() {
    if (performance.now() > programmaticUntil) follow = false;
  }
  function resume() {
    follow = true;
    if (active >= 0) scrollToCue(active);
  }
  function seekTo(index: number) {
    follow = true;
    onSeek(cues[index]!.start);
  }
  function step(delta: number) {
    if (!matches.length) return;
    matchCursor = (Math.min(matchCursor, matches.length - 1) + delta + matches.length) % matches.length;
  }

  async function copyAll() {
    const text = cues.map(c => `[${formatClock(c.start)}] ${c.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      toasts.show(t("recordings.transcript.copied"), "success");
      setTimeout(() => (copied = false), 1600);
    } catch {
      toasts.show(t("recordings.transcript.copyFailed"), "error");
    }
  }
</script>

<svelte:window
  onwheel={() => scroll === "page" && (follow = false)}
  ontouchmove={() => scroll === "page" && (follow = false)}
  onscroll={() => scroll === "page" && userScrolled()}
/>

<div class="flex min-h-0 flex-col {cls}">
  <div class="flex flex-wrap items-center gap-2 pb-3">
    <div class="relative min-w-0 flex-1 basis-56">
      <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        bind:value={query}
        oninput={() => (matchCursor = 0)}
        onkeydown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape" && query) {
            e.preventDefault();
            query = "";
          }
        }}
        placeholder={t("recordings.transcript.search")}
        aria-label={t("recordings.transcript.search")}
        class="h-9 w-full rounded-full border border-line-2 bg-surface pr-24 pl-9 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] [&::-webkit-search-cancel-button]:hidden"
      />
      {#if needle}
        <div class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
          <span class="px-1 text-[11.5px] text-ink-3 tabular-nums" aria-live="polite">
            {matches.length ? t("recordings.transcript.matchOf", { i: Math.min(matchCursor, matches.length - 1) + 1, n: matches.length }) : t("recordings.transcript.noMatch")}
          </span>
          <button type="button" class="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40" aria-label={t("recordings.transcript.prevMatch")} disabled={!matches.length} onclick={() => step(-1)}><ChevronUp class="size-4" /></button>
          <button type="button" class="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40" aria-label={t("recordings.transcript.nextMatch")} disabled={!matches.length} onclick={() => step(1)}><ChevronDown class="size-4" /></button>
          <button type="button" class="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("recordings.transcript.clear")} onclick={() => (query = "")}><X class="size-4" /></button>
        </div>
      {/if}
    </div>
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        onclick={copyAll}
      >
        {#if copied}<CopyCheck class="size-4" />{:else}<Copy class="size-4" />{/if}{t("recordings.transcript.copy")}
      </button>
      {@render actions?.()}
    </div>
  </div>

  <div class="relative min-h-0 flex-1">
    <ol
      bind:this={list}
      class="relative -mx-2 px-2 {scroll === 'self' ? `overflow-y-auto overscroll-contain py-2 [mask-image:linear-gradient(to_bottom,transparent,black_14px,black_calc(100%-14px),transparent)] ${listClass}` : ''}"
      aria-label={t("recordings.transcript.title")}
      onwheel={() => scroll === "self" && (follow = false)}
      ontouchmove={() => scroll === "self" && (follow = false)}
      onscroll={() => scroll === "self" && userScrolled()}
    >
      {#each cues as cue, i (i)}
        {@const current = i === active && inside}
        {@const hit = needle && matches.includes(i)}
        <li data-cue={i}>
          <button
            type="button"
            class="group grid w-full grid-cols-[3.25rem_1fr] items-baseline gap-3 rounded-xl px-2.5 py-2 text-left transition-colors
              {current ? 'bg-surface-3' : 'hover:bg-surface-2'}
              {i === focusedMatch ? 'ring-1 ring-ink-3' : ''}"
            aria-current={current ? "true" : undefined}
            aria-label={t("recordings.transcript.seekTo", { time: formatClock(cue.start) })}
            onclick={() => seekTo(i)}
          >
            <span class="text-[12px] font-medium tabular-nums {current ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}">{formatClock(cue.start)}</span>
            <span class="text-[14.5px] leading-relaxed {current ? 'text-ink' : 'text-ink-2'} {hit || !needle ? '' : 'opacity-55'}">
              {#each parts(cue.text) as part, k (k)}{#if part.hit}<mark class="rounded-[4px] px-0.5" style="background:var(--pill-butter);color:var(--pill-butter-ink)">{part.text}</mark>{:else}{part.text}{/if}{/each}
            </span>
          </button>
        </li>
      {/each}
    </ol>

    {#if showReturn}
      <button
        type="button"
        class="{scroll === 'page' ? 'fixed z-30' : 'absolute bottom-3'} left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-ink shadow-pop animate-[pop-in_140ms_ease-out] hover:bg-primary-hover"
        style={scroll === "page" ? `bottom:${insetBottom + 12}px` : undefined}
        onclick={resume}
      >
        <LocateFixed class="size-4" />{t("recordings.transcript.resume")}
      </button>
    {/if}
  </div>
</div>
