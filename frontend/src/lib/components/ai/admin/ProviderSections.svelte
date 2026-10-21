<script lang="ts" module>
  import type { Health } from "#lib/ai/routing.ts";
  export type ProviderSection<T> = { id: string; name: string; kind: string | null; vendor: string; health: Health; items: T[] };
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { ChevronRight } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { dot } from "#lib/ai/routing.ts";
  import StateDot from "../StateDot.svelte";
  import ProviderIcon from "../ProviderIcon.svelte";

  /**
   * Models grouped under collapsible provider-account headers. Collapsed by default except `focusId`
   * (the account of the selected model) or a lone account; while `query` is set every matching section opens.
   * The open set is remembered per `storageKey` for the browser session. Arrow keys / Home / End move between
   * headers and the `[data-acc-nav]` elements inside the items.
   */
  let {
    sections,
    storageKey,
    focusId = null,
    query = "",
    layout = "list",
    item,
    allOpen = $bindable(false),
  }: {
    sections: ProviderSection<T>[];
    storageKey: string;
    focusId?: string | null;
    query?: string;
    layout?: "list" | "grid";
    item: Snippet<[T]>;
    allOpen?: boolean;
  } = $props();

  const KEY = $derived(`hub.providerSections:${storageKey}`);
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const uid = $props.id();

  function load(): Set<string> | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  }
  function save(s: Set<string>) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...s]));
    } catch {
      /* storage unavailable: state lives for this view only */
    }
  }

  let expanded = $state(new Set<string>());
  let ready = false;
  $effect(() => {
    if (ready || !sections.length) return;
    ready = true;
    const s = load() ?? new Set<string>();
    if (focusId) s.add(focusId);
    if (sections.length === 1) s.add(sections[0]!.id);
    expanded = s;
  });

  // While searching, every section with a match opens; headers can still be closed until the query changes.
  const searching = $derived(query.trim() !== "");
  let searchClosed = $state(new Set<string>());
  $effect(() => {
    void query;
    searchClosed = new Set();
  });

  const isOpen = (id: string) => (searching ? !searchClosed.has(id) : expanded.has(id));
  $effect(() => {
    allOpen = sections.length > 0 && sections.every(s => isOpen(s.id));
  });

  function toggle(id: string) {
    if (searching) {
      const n = new Set(searchClosed);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      searchClosed = n;
      return;
    }
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    expanded = n;
    save(n);
  }
  export function setAll(open: boolean) {
    if (searching) {
      searchClosed = open ? new Set() : new Set(sections.map(s => s.id));
      return;
    }
    const n = open ? new Set([...expanded, ...sections.map(s => s.id)]) : new Set<string>();
    expanded = n;
    save(n);
  }

  let root = $state<HTMLElement | null>(null);
  function onKey(e: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !root) return;
    const nav = [...root.querySelectorAll<HTMLElement>("[data-acc-nav]")];
    const i = nav.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? nav.length - 1 : Math.min(nav.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    nav[next]?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={root} class="flex flex-col gap-1" onkeydown={onKey}>
  {#each sections as s (s.id)}
    {@const open = isOpen(s.id)}
    <section class="rounded-2xl {open ? 'bg-surface-2/60' : ''} transition-colors">
      <h3>
        <button
          type="button"
          data-acc-nav
          id="{uid}-h-{s.id}"
          aria-expanded={open}
          aria-controls="{uid}-p-{s.id}"
          class="flex min-h-12 w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
          onclick={() => toggle(s.id)}
        >
          <ChevronRight class="size-4 shrink-0 text-ink-3 transition-transform duration-200 {open ? 'rotate-90' : ''}" aria-hidden="true" />
          <ProviderIcon kind={s.kind} label={s.vendor} size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13.5px] font-semibold text-ink">{s.name}</span>
            {#if s.vendor && s.vendor !== s.name}<span class="block truncate text-[11.5px] text-ink-3">{s.vendor}</span>{/if}
          </span>
          <StateDot state={dot(s.health)} />
          <span class="sr-only">{t(`aiAdmin.health.${s.health}`)}</span>
          <span class="grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums {searching ? 'bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]' : 'bg-surface-3 text-ink-2'}" aria-label={t("aiAdmin.picker.modelCount", { n: s.items.length })}>{s.items.length}</span>
        </button>
      </h3>
      {#if open}
        <div id="{uid}-p-{s.id}" role="region" aria-labelledby="{uid}-h-{s.id}" transition:slide={{ duration: reduce ? 0 : 180 }}>
          <ul class="px-1.5 pt-0.5 pb-2 {layout === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-2.5 gap-y-1.5' : 'flex flex-col gap-1'}">
            {#each s.items as it, i (i)}{@render item(it)}{/each}
          </ul>
        </div>
      {/if}
    </section>
  {/each}
</div>
