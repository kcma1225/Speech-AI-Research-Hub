<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { notesList } from "#lib/notes/list.svelte.ts";
  import NoteList from "#lib/components/notes/NoteList.svelte";
  import NewNoteSheet from "#lib/components/notes/NewNoteSheet.svelte";
  import { session } from "#lib/stores/session.svelte.ts";

  /**
   * Mail-style notes: list pane on the left stays mounted while `/notes/[id]` swaps the right pane.
   * Phones get two levels: `/notes` = list only, `/notes/[id]` = note only.
   */
  let { children } = $props();
  let newOpen = $state(false);
  const activeId = $derived(page.params.id ?? null);

  // ?tags=<id,…> (⌘K tag links) preselects the filter; ?new=1 (dashboard button) opens the create sheet.
  // Both are consumed and stripped so later navigation inside the notes area does not re-apply them.
  $effect(() => {
    const tags = page.url.searchParams.get("tags");
    const wantsNew = page.url.searchParams.get("new") === "1";
    untrack(() => {
      if (tags !== null) {
        notesList.tags = tags.split(",").filter(Boolean);
        void notesList.reload();
      } else if (!notesList.loaded && !notesList.loading) void notesList.reload();
      if (tags === null && !wantsNew) return;
      if (wantsNew && session.canEdit) newOpen = true;
      const url = new URL(page.url.href);
      url.searchParams.delete("tags");
      url.searchParams.delete("new");
      void goto(url, { state: page.state, shallow: true, replace: true });
    });
  });
</script>

<div class="lg:grid lg:h-[calc(100dvh-136px)] lg:min-h-[560px] lg:grid-cols-[minmax(300px,348px)_minmax(0,1fr)] lg:gap-5">
  <aside class="{activeId ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col lg:overflow-hidden lg:rounded-[var(--radius-card)] lg:border lg:border-line/70 lg:bg-surface lg:shadow-card">
    <NoteList {activeId} onNew={() => (newOpen = true)} />
  </aside>
  <div class="{activeId ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-col">
    {@render children()}
  </div>
</div>

<NewNoteSheet bind:open={newOpen} />
