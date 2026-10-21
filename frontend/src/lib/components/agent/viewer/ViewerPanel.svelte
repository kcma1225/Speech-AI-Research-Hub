<script lang="ts">
  import type { Component } from "svelte";
  import { ArrowLeft, LocateFixed, LocateOff, RefreshCw, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import KindIcon from "../attach/KindIcon.svelte";
  import { viewer, refreshArtifact } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import DocsMenu from "./DocsMenu.svelte";
  import type { ChatSession } from "#lib/agent/chat.svelte.ts";

  /**
   * 「文件檢視器」 chrome: kind + title, 「已更新」 flash, 跟隨 AI, reload, the conversation's documents, close.
   * The body lazy-loads the viewer of the kind (each one only calls the routes the pages use, so it shows only what
   * the user may read).
   */
  let { session, onBack }: { session: ChatSession; /** Phones / drawer: back to the chat. */ onBack?: () => void } = $props();

  type ViewerProps = { entry: ViewerEntry };
  const loaders: Record<string, () => Promise<{ default: Component<ViewerProps> }>> = {
    deck: () => import("./DeckViewer.svelte"),
    note: () => import("./NoteViewer.svelte"),
    latex_project: () => import("./LatexViewer.svelte"),
    paper: () => import("./PaperViewer.svelte"),
    meeting: () => import("./MeetingViewer.svelte"),
    upload: () => import("./UploadViewer.svelte"),
  };

  const entry = $derived(viewer.current);
  const title = $derived(entry ? viewer.titleOf(entry.ref) || t(`attach.kind.${entry.ref.kind}` as MessageKey) : "");

  // 「已更新」: a short pill after the viewer reports a change of the shown document.
  let flash = $state(false);
  $effect(() => {
    const u = viewer.updated;
    if (!u || !entry || u.key !== entry.key) return;
    flash = true;
    const timer = setTimeout(() => (flash = false), 2400);
    return () => clearTimeout(timer);
  });
</script>

<section class="flex h-full min-h-0 flex-col bg-canvas" aria-label={t("viewer.title")}>
  <header class="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
    {#if onBack}
      <button type="button" class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("viewer.backToChat")} title={t("viewer.backToChat")} onclick={onBack}><ArrowLeft class="size-4.5" /></button>
    {/if}
    {#if entry}
      <span class="ml-1 grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2"><KindIcon kind={entry.ref.kind} class="size-4" /></span>
      <div class="ml-1.5 min-w-0 flex-1">
        <p class="truncate text-[14px] leading-tight font-semibold text-ink" title={title}>{title}</p>
        <p class="flex items-center gap-1.5 truncate text-[11.5px] leading-tight text-ink-3">
          {t(`attach.kind.${entry.ref.kind}` as MessageKey)}
          {#if flash}<span class="flash rounded-full bg-[var(--pill-mint)] px-1.5 text-[11px] font-medium text-[var(--pill-mint-ink)]" role="status">{t("viewer.updated")}</span>{/if}
        </p>
      </div>
    {:else}
      <p class="ml-2 min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{t("viewer.title")}</p>
    {/if}
    {#if entry}
      <button
        type="button"
        class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-surface-3 {viewer.follow ? 'text-ink' : 'text-ink-3'}"
        aria-pressed={viewer.follow}
        aria-label={t("viewer.follow")}
        title={viewer.follow ? t("viewer.followOn") : t("viewer.followOff")}
        onclick={() => (viewer.follow = !viewer.follow)}
      >
        {#if viewer.follow}<LocateFixed class="size-4" />{:else}<LocateOff class="size-4" />{/if}
      </button>
      <button type="button" class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("viewer.reload")} title={t("viewer.reload")} onclick={() => entry && refreshArtifact(entry.ref)}><RefreshCw class="size-4" /></button>
    {/if}
    <DocsMenu {session} compact />
    <button type="button" class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("viewer.close")} title={t("viewer.close")} onclick={() => viewer.closeViewer()}><X class="size-4.5" /></button>
  </header>

  <div class="relative min-h-0 flex-1 overflow-hidden">
    {#if entry && loaders[entry.ref.kind]}
      {#key entry.key}
        {#await loaders[entry.ref.kind]!()}
          <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
        {:then mod}
          <mod.default {entry} />
        {:catch e}
          <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{t("viewer.loadFailed")}：{(e as Error).message}</p>
        {/await}
      {/key}
    {:else}
      <div class="grid h-full place-items-center p-6 text-center">
        <div class="max-w-xs">
          <p class="text-[14px] font-medium text-ink">{t("viewer.emptyTitle")}</p>
          <p class="mt-1 text-[13px] leading-relaxed text-ink-3">{t("viewer.emptyHint")}</p>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .flash {
    animation: flash-in 220ms ease-out;
  }
  @keyframes flash-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flash {
      animation: none;
    }
  }
</style>
