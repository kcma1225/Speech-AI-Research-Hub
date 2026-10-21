<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { ExternalLink } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t, relativeTime } from "#lib/i18n.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import type { NoteDetail } from "#lib/components/notes/types.ts";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import LiveText from "./LiveText.svelte";
  import ViewerLink from "./ViewerLink.svelte";

  /** A note: live collaborative view (read-only here) with pending suggestions; 「在筆記中審核」 opens the editor. */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  let detail = $state<NoteDetail | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      detail = await api.get<NoteDetail>(`/notes/${id}`);
      viewer.setTitle(entry.ref, detail.note.title || t("viewer.untitled"));
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void viewer.revisionOf(entry.ref);
    untrack(() => void load());
  });
  // The note's own page already holds this document's live connection: show the stored text instead.
  const onPage = $derived(page.url.pathname.includes(`/notes/${id}`));
  const editorUrl = $derived(detail ? `/studies/${encodeURIComponent(detail.study.slug)}/notes/${id}${entry.focus.suggestionId ? `?suggestion=${entry.focus.suggestionId}` : ""}` : null);
</script>

{#if error && !detail}
  <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
{:else if !detail}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2 text-[12px] text-ink-3">
      <span class="min-w-0 truncate">{detail.study.title}</span>
      <span>·</span>
      <span>{t("viewer.updatedAgo", { when: relativeTime(detail.note.updated_at) })}</span>
      <span class="min-w-0 flex-1"></span>
      {#if editorUrl}<ViewerLink href={editorUrl} icon={ExternalLink} label={detail.permissions.edit ? t("viewer.note.review") : t("viewer.note.open")} />{/if}
    </div>
    <div class="min-h-0 flex-1 border-t border-line">
      {#if onPage}
        <div class="h-full overflow-y-auto px-5 py-4">
          <p class="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("viewer.onPage")}</p>
          <MarkdownView source={detail.note.content_md} fontSize={14.5} />
        </div>
      {:else}
        <LiveText docName={detail.doc_name} targetType="note" targetId={id} {entry} artifact={entry.ref} rendered label={detail.note.title} onMessage={(m) => m.type === "meta" && void load()} />
      {/if}
    </div>
  </div>
{/if}
