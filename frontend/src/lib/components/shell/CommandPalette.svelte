<script lang="ts">
  import { Command, Dialog } from "bits-ui";
  import { goto } from "$app/navigation";
  import { CornerDownLeft, Info, PanelLeftClose, PanelLeftOpen, Search, SearchCheck } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { canSee, manageNav, workspaceNav } from "#lib/nav.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { sidebar } from "#lib/stores/sidebar.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { focusSnippet, SEARCH_TYPES, typeMeta } from "#lib/search/meta.ts";
  import type { SearchResponse } from "#lib/search/types.ts";
  import Highlighted from "#lib/components/search/Highlighted.svelte";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { searchPalette } from "./search.svelte";

  /** Types shown in ⌘K (milestones and decks only on the /search page). */
  const PALETTE_TYPES = ["study", "note", "paper", "meeting", "task"];

  let query = $state("");
  let results = $state<SearchResponse | null>(null);
  let loading = $state(false);
  let seq = 0;

  const pages = $derived(
    [...workspaceNav, ...manageNav].filter(
      item => !item.external && canSee(item, session.user) && t(item.label).toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  // Shell actions (desktop only: phones and tablets have no sidebar to collapse).
  const sidebarLabel = $derived(sidebar.collapsed ? t("nav.expand") : t("nav.collapse"));
  const showSidebarAction = $derived(viewport.desktop && sidebarLabel.toLowerCase().includes(query.trim().toLowerCase()));

  $effect(() => {
    const q = query.trim();
    const id = ++seq;
    if (!q) {
      results = null;
      loading = false;
      return;
    }
    loading = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api.get<SearchResponse>(`/search?${new URLSearchParams({ q, types: PALETTE_TYPES.join(","), limit: "4" })}`);
        if (id === seq) results = r;
      } catch {
        if (id === seq) results = { q, search_mode: "keyword_only", notice_zh: null, groups: [], total: 0 };
      } finally {
        if (id === seq) loading = false;
      }
    }, 180);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!searchPalette.open) query = "";
  });

  // ⌘K has no trigger element, so remember what had focus and give it back on close.
  let returnFocus: HTMLElement | null = null;
  let navigating = false;
  $effect.pre(() => {
    if (searchPalette.open) returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  });

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchPalette.open = !searchPalette.open;
    }
  }
  function go(href: string) {
    navigating = true;
    searchPalette.open = false;
    void goto(href).finally(() => (navigating = false));
  }
  const groups = $derived(
    results ? [...results.groups].sort((a, b) => SEARCH_TYPES.findIndex(x => x.type === a.type) - SEARCH_TYPES.findIndex(x => x.type === b.type)) : [],
  );
  const empty = $derived(!!results && !loading && !pages.length && !groups.length && !showSidebarAction);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const item = "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink outline-none data-selected:bg-surface-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-3";
  const heading = "px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase";
</script>

<svelte:window onkeydown={onKeydown} />

<Dialog.Root bind:open={searchPalette.open}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_140ms_ease-out]" />
    <Dialog.Content
      onCloseAutoFocus={e => {
        // After navigating, SvelteKit manages focus; otherwise return it to where the user was.
        if (navigating || returnFocus?.isConnected) e.preventDefault();
        if (!navigating && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }}
      class="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-50 mx-auto max-w-[620px] overflow-hidden rounded-[24px] border border-line bg-popover shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out] sm:top-[12vh]"
    >
      <Dialog.Title class="sr-only">{t("search.short")}</Dialog.Title>
      <Command.Root shouldFilter={false} loop>
        <div class="flex items-center gap-3 border-b border-line px-4">
          {#if loading}<Spinner class="size-[18px] text-ink-3" />{:else}<Search class="size-[18px] text-ink-3" />{/if}
          <Command.Input bind:value={query} placeholder={t("search.placeholderAll")} class="h-14 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3" />
          <span class="hidden sm:contents"><Kbd>Esc</Kbd></span>
          <button type="button" class="-mr-1 h-9 rounded-full px-2.5 text-[14px] font-medium text-ink-2 sm:hidden" onclick={() => (searchPalette.open = false)}>{t("action.cancel")}</button>
        </div>
        <Command.List class="max-h-[min(440px,62dvh)] overflow-y-auto p-2">
          <Command.Viewport>
            {#if empty}
              <Command.Empty class="px-3 py-10 text-center text-sm text-ink-3">{t("search.empty", { q: query.trim() })}</Command.Empty>
            {/if}
            {#each groups as g (g.type)}
              {@const m = typeMeta(g.type)}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t(m.label)}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each g.results as hit (hit.id)}
                    <Command.Item value="{g.type}-{hit.id}" onSelect={() => go(hit.url)} class={item}>
                      <m.icon />
                      <span class="flex min-w-0 flex-1 flex-col">
                        <Highlighted text={hit.title} ranges={hit.title_highlights} class="truncate" />
                        {#if hit.snippet || hit.study}
                          {@const snip = focusSnippet(hit.snippet, hit.highlights)}
                          <span class="truncate text-[12px] text-ink-3">{#if hit.study && g.type !== "study"}<span class="text-ink-2">{hit.study.title}</span>{#if hit.snippet}{" · "}{/if}{/if}<Highlighted text={snip.text} ranges={snip.ranges} /></span>
                        {/if}
                      </span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
            {#if pages.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t("search.pages")}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each pages as p (p.key)}
                    <Command.Item value="page-{p.key}" onSelect={() => go(p.href)} class={item}><p.icon /><span class="flex-1">{t(p.label)}</span></Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if showSidebarAction}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t("search.actions")}</Command.GroupHeading>
                <Command.GroupItems>
                  <Command.Item
                    value="action-sidebar"
                    onSelect={() => {
                      searchPalette.open = false;
                      sidebar.toggle();
                    }}
                    class={item}
                  >
                    {#if sidebar.collapsed}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
                    <span class="flex-1">{sidebarLabel}</span>
                    <span class="flex gap-1"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>B</Kbd></span>
                  </Command.Item>
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if query.trim()}
              <Command.Group>
                <Command.GroupItems>
                  <Command.Item value="search-all" onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}`)} class={item}>
                    <SearchCheck /><span class="min-w-0 flex-1 truncate">{t("search.seeAll", { q: query.trim() })}</span>
                  </Command.Item>
                </Command.GroupItems>
              </Command.Group>
            {/if}
          </Command.Viewport>
        </Command.List>
        {#if results && query.trim() && results.search_mode === "keyword_only"}
          <div class="flex items-center gap-1.5 border-t border-line px-4 py-2 text-[12px] text-ink-3" role="status"><Info class="size-3.5 shrink-0" />{t("search.keywordOnly")}</div>
        {/if}
        <div class="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-3 sm:flex">
          <span class="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("search.navigate")}</span>
          <span class="flex items-center gap-1.5"><Kbd><CornerDownLeft class="size-3" /></Kbd>{t("search.open")}</span>
          <span class="flex items-center gap-1.5"><Kbd>Esc</Kbd>{t("search.close")}</span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
