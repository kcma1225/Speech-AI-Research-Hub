<script lang="ts">
  import { Command, Dialog } from "bits-ui";
  import { goto } from "$app/navigation";
  import { AudioLines, CornerDownLeft, FileText, Hash, Presentation, Search } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { manageNav, workspaceNav } from "#lib/nav.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { SearchResult } from "#lib/types.ts";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { searchPalette } from "./search.svelte";

  let query = $state("");
  let results = $state<SearchResult | null>(null);
  let loading = $state(false);
  let seq = 0;

  const pages = $derived(
    [...workspaceNav, ...manageNav].filter(
      item => !item.external && (!item.roles || (session.user && item.roles.includes(session.user.role))) && t(item.label).toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

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
        const r = await api.get<SearchResult>(`/search?q=${encodeURIComponent(q)}`);
        if (id === seq) results = r;
      } catch {
        if (id === seq) results = { slides: [], notes: [], tags: [] };
      } finally {
        if (id === seq) loading = false;
      }
    }, 160);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!searchPalette.open) query = "";
  });

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchPalette.open = !searchPalette.open;
    }
  }
  function go(href: string) {
    searchPalette.open = false;
    void goto(href);
  }
  const empty = $derived(!!results && !loading && !pages.length && !results.slides.length && !results.notes.length && !results.tags.length);
  const item = "flex h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm text-ink outline-none data-selected:bg-surface-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-3";
  const heading = "px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase";
</script>

<svelte:window onkeydown={onKeydown} />

<Dialog.Root bind:open={searchPalette.open}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_140ms_ease-out]" />
    <Dialog.Content
      class="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-50 mx-auto max-w-[620px] overflow-hidden rounded-[24px] border border-line bg-surface shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out] sm:top-[12vh]"
    >
      <Dialog.Title class="sr-only">{t("search.short")}</Dialog.Title>
      <Command.Root shouldFilter={false} loop>
        <div class="flex items-center gap-3 border-b border-line px-4">
          {#if loading}<Spinner class="size-[18px] text-ink-3" />{:else}<Search class="size-[18px] text-ink-3" />{/if}
          <Command.Input bind:value={query} placeholder={t("search.placeholder")} class="h-14 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3" />
          <Kbd class="hidden sm:inline-flex">Esc</Kbd>
        </div>
        <Command.List class="max-h-[min(440px,62dvh)] overflow-y-auto p-2">
          <Command.Viewport>
            {#if empty}
              <Command.Empty class="px-3 py-10 text-center text-sm text-ink-3">{t("search.empty", { q: query.trim() })}</Command.Empty>
            {/if}
            {#if results?.slides.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t("search.slides")}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each results.slides as s (s.id)}
                    <Command.Item value="slide-{s.id}" onSelect={() => go(`/slides/${s.id}`)} class={item}><Presentation /><span class="flex-1 truncate">{s.title}</span><span class="text-xs text-ink-3">/{s.slug}</span></Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if results?.notes.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t("search.notes")}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each results.notes as n (n.id)}
                    <Command.Item value="note-{n.id}" onSelect={() => go(`/notes/${n.id}`)} class={item}>
                      {#if n.hasAudio}<AudioLines />{:else}<FileText />{/if}
                      <span class="min-w-0 flex-1 truncate">{n.title}<span class="ml-2 text-ink-3">{n.excerpt}</span></span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if results?.tags.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>{t("search.tags")}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each results.tags as tag (tag.id)}
                    <Command.Item value="tag-{tag.id}" onSelect={() => go(`/${tag.kind === "slide" ? "slides" : "notes"}?tags=${tag.id}`)} class={item}>
                      <Hash /><span class="flex-1 truncate">{tag.name}</span><span class="text-xs text-ink-3">{t(tag.kind === "slide" ? "search.slides" : "search.notes")}</span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
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
          </Command.Viewport>
        </Command.List>
        <div class="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-3 sm:flex">
          <span class="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("search.navigate")}</span>
          <span class="flex items-center gap-1.5"><Kbd><CornerDownLeft class="size-3" /></Kbd>{t("search.open")}</span>
          <span class="flex items-center gap-1.5"><Kbd>Esc</Kbd>{t("search.close")}</span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
