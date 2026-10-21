<script lang="ts">
  import { untrack } from "svelte";
  import { Check, ChevronDown, CheckCheck, ExternalLink, FileCode2, Sparkles, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import PreviewPane from "#lib/components/slides/editor/PreviewPane.svelte";
  import SlidePlayer from "#lib/components/slides/SlidePlayer.svelte";
  import WordDiff from "#lib/components/suggest/WordDiff.svelte";
  import type { Suggestion } from "#lib/components/suggest/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { draftStageLabel } from "#lib/slides/draft.ts";
  import type { AiDraftJob, PreviewInfo, SlideDetail, SourceResponse } from "#lib/slides/types.ts";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import ViewerLink from "./ViewerLink.svelte";
  import { poll } from "./util.ts";

  /**
   * A deck: 「草稿預覽」 = the newest ready quick render (`slide_preview`) of the in-app Quarto source, re-rendered when the
   * source changes (accepted AI suggestions, the AI draft job, other editors) — or 「已發布版本」 = the player of the active
   * published version. Both run in the same sandboxed iframe / page images as the deck pages (opaque origin,
   * capability URLs from the API), so nothing new is exposed. Pending AI suggestions of the source files are listed with
   * 接受／拒絕 for study editors.
   */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  let detail = $state<SlideDetail | null>(null);
  let preview = $state<PreviewInfo | null>(null);
  let job = $state<AiDraftJob | null>(null);
  let files = $state<SourceResponse["files"]>([]);
  let suggestions = $state<Suggestion[]>([]);
  let canReview = $state(false);
  let error = $state<string | null>(null);
  let mode = $state<"draft" | "published" | null>(null);
  let showSuggestions = $state(true);
  let page = $state(1);
  let busyHunk = $state<string | null>(null);

  const source = $derived(detail?.project.source ?? null);
  const canEdit = $derived(!!detail?.permissions.manage);
  const version = $derived.by(() => {
    if (!detail) return null;
    const want = entry.ref.version;
    const pick = want !== undefined ? detail.versions.find((v) => v.id === want || v.version === Number(want)) : null;
    return pick && pick.status === "published" ? pick : detail.activeVersion;
  });
  const running = (j: AiDraftJob | null) => j?.status === "queued" || j?.status === "running";
  const previewBusy = $derived(preview?.latest?.status === "queued" || preview?.latest?.status === "rendering");
  const stale = $derived(!!source && !!preview?.ready && preview.ready.revision < source.revision);

  /** `full`: also the source files and their suggestions (first load, refresh requests, a new revision). */
  let loadedRev = -1;
  async function load(full = false) {
    try {
      const d = await api.get<SlideDetail>(`/slides/${id}`);
      detail = d;
      viewer.setTitle(entry.ref, d.project.title);
      mode ??= d.project.source && (!d.activeVersion || d.project.source.revision > (d.project.source.published_revision ?? 0)) ? "draft" : d.activeVersion ? "published" : "draft";
      if (d.project.source) {
        const withFiles = full || d.project.source.revision !== loadedRev;
        const [p, j, s] = await Promise.all([
          api.get<{ preview: PreviewInfo }>(`/slides/${id}/source/preview`),
          api.get<{ job: AiDraftJob | null }>(`/slides/${id}/ai/generate`).catch(() => ({ job: null })),
          withFiles ? api.get<SourceResponse>(`/slides/${id}/source`) : null,
        ]);
        const before = preview?.ready?.id;
        preview = p.preview;
        job = j.job;
        if (before && p.preview.ready && p.preview.ready.id !== before) viewer.markUpdated(entry.ref);
        if (s) {
          files = s.files;
          loadedRev = d.project.source.revision;
          await loadSuggestions();
        }
        await ensurePreview();
      }
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function loadSuggestions() {
    const text = files.filter((f) => f.kind === "text");
    const lists = await Promise.all(
      text.map((f) =>
        api.get<{ suggestions: Suggestion[]; permissions: { review: boolean } }>(`/suggestions?target_type=deck_source&target_id=${f.id}&status=pending`).catch(() => ({ suggestions: [], permissions: { review: false } })),
      ),
    );
    const before = new Set(suggestions.map((s) => s.id));
    suggestions = lists.flatMap((l) => l.suggestions).filter((s) => s.pending > 0 || s.stale > 0);
    canReview = lists.some((l) => l.permissions.review);
    if (suggestions.some((s) => !before.has(s.id)) && before.size) viewer.markUpdated(entry.ref);
  }

  // The source moved past the newest preview: editors queue a render (the editor page does the same after saving).
  let requested = 0;
  async function ensurePreview(force = false) {
    if (!canEdit || !source) return;
    const latest = preview?.latest?.revision ?? 0;
    if (!force && (latest >= source.revision || previewBusy || running(job) || requested >= source.revision)) return;
    requested = source.revision;
    try {
      preview = (await api.post<{ preview: PreviewInfo }>(`/slides/${id}/source/preview`)).preview;
    } catch (e) {
      if (force) toasts.show((e as Error).message, "error");
    }
  }

  $effect(() => {
    void viewer.revisionOf(entry.ref);
    untrack(() => void load(true));
  });
  $effect(() => poll(async () => {
    await load();
    return previewBusy || running(job) ? 2500 : 15_000;
  }, 3000));

  // Focus: a page → that slide; a suggestion / file → the draft with its suggestions.
  let lastNonce = -1;
  $effect(() => {
    const e = entry;
    untrack(() => {
      if (e.nonce === lastNonce) return;
      lastNonce = e.nonce;
      if (e.focus.page) page = e.focus.page;
      if (e.focus.suggestionId || e.focus.fileId) {
        mode = "draft";
        showSuggestions = true;
      }
    });
  });

  const pathOf = (s: Suggestion) => files.find((f) => f.id === s.target_id)?.path ?? "";
  async function decide(s: Suggestion, hunkId: string | "all", accept: boolean) {
    busyHunk = `${s.id}:${hunkId}`;
    try {
      const path = hunkId === "all" ? `/suggestions/${s.id}/${accept ? "accept-all" : "reject-all"}` : `/suggestions/${s.id}/hunks/${hunkId}/${accept ? "accept" : "reject"}`;
      await api.post(path);
      if (accept) toasts.show(t("viewer.deck.accepted"), "success");
      await load(true);
      if (accept) await ensurePreview();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busyHunk = null;
    }
  }
  const pendingCount = $derived(suggestions.reduce((n, s) => n + s.hunks.filter((h) => h.state === "pending").length, 0));
  const deckUrl = $derived(detail?.study ? `/studies/${encodeURIComponent(detail.study.slug)}/decks/${id}` : `/slides/${id}`);
  const editUrl = $derived(detail?.study && source ? `/studies/${encodeURIComponent(detail.study.slug)}/decks/${id}/edit${entry.focus.fileId ? `?file=${entry.focus.fileId}` : ""}` : null);
</script>

{#if error && !detail}
  <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
{:else if !detail}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 pb-2">
      {#if source && detail.activeVersion}
        <Segmented guardIgnore value={mode ?? "draft"} onValueChange={(v) => (mode = v)} label={t("viewer.deck.view")} options={[{ value: "draft", label: t("viewer.deck.draft") }, { value: "published", label: t("viewer.deck.published") }]} />
      {/if}
      <span class="min-w-0 flex-1"></span>
      <ViewerLink href={deckUrl} icon={ExternalLink} label={t("viewer.deck.open")} />
      {#if editUrl && canEdit}<ViewerLink href={editUrl} icon={FileCode2} label={t("viewer.deck.edit")} />{/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-3">
      {#if running(job)}
        <div class="mb-3 flex items-center gap-3 rounded-2xl border border-line bg-surface-2 p-3" role="status">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]"><Sparkles class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-ink">{t("viewer.deck.generating")}</p>
            <p class="truncate text-[12px] text-ink-3">{draftStageLabel(job?.stage)}</p>
            <Progress value={job?.progress || null} class="mt-1.5 h-1" />
          </div>
        </div>
      {/if}

      {#if (mode ?? "draft") === "draft" && source}
        <PreviewPane {preview} slide={Math.max(0, page - 1)} {stale} canRefresh={canEdit} onRefresh={() => void ensurePreview(true)} />
      {:else if version}
        <SlidePlayer {version} deck={detail.project.slug} title={detail.project.title} bind:page startPage={entry.focus.page ?? null} speaker={false} />
      {:else}
        <p class="rounded-2xl bg-surface-2 px-4 py-8 text-center text-[13px] text-ink-3">{t("viewer.deck.none")}</p>
      {/if}

      {#if suggestions.length}
        <section class="mt-4 rounded-2xl border border-line bg-surface">
          <button type="button" class="flex min-h-12 w-full items-center gap-2 px-4 text-left" aria-expanded={showSuggestions} onclick={() => (showSuggestions = !showSuggestions)}>
            <span class="size-2 shrink-0 rounded-full bg-[var(--pill-butter-ink)]"></span>
            <span class="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">{t("viewer.pending", { n: pendingCount })}</span>
            <ChevronDown class="size-4 text-ink-3 transition-transform duration-150 motion-reduce:transition-none {showSuggestions ? 'rotate-180' : ''}" />
          </button>
          {#if showSuggestions}
            <div class="flex flex-col gap-3 border-t border-line p-3">
              {#if !canReview}<p class="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("suggest.readOnly")}</p>{/if}
              {#each suggestions as s (s.id)}
                <article class="rounded-xl border border-line p-3 {entry.focus.suggestionId === s.id ? 'ring-2 ring-[var(--pill-butter-ink)]/40' : ''}">
                  <header class="mb-2 flex flex-wrap items-center gap-2">
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13px] font-medium text-ink">{s.title || t("suggest.untitled")}</span>
                      <span class="block truncate font-mono text-[11.5px] text-ink-3">{pathOf(s)}</span>
                    </span>
                    {#if canReview && s.pending > 1}
                      <Button size="sm" variant="ghost" disabled={!!busyHunk} onclick={() => decide(s, "all", false)}><X />{t("viewer.rejectAll")}</Button>
                      <Button size="sm" variant="secondary" disabled={!!busyHunk} onclick={() => decide(s, "all", true)}><CheckCheck />{t("viewer.acceptAll")}</Button>
                    {/if}
                  </header>
                  {#each s.hunks.filter((h) => h.state === "pending" || h.state === "stale") as h (h.id)}
                    <div class="mt-2 rounded-lg bg-surface-2 p-2.5">
                      <WordDiff before={h.before} after={h.after} class="font-mono !text-[12px]" />
                      {#if h.state === "stale"}<p class="mt-1 text-[12px] text-ink-3">{t("suggest.stale")}</p>{/if}
                      {#if canReview}
                        <div class="mt-2 flex justify-end gap-1.5">
                          <Button size="sm" variant="ghost" disabled={!!busyHunk} onclick={() => decide(s, h.id, false)}><X />{t("suggest.reject")}</Button>
                          {#if h.state === "pending"}<Button size="sm" variant="primary" loading={busyHunk === `${s.id}:${h.id}`} disabled={!!busyHunk} onclick={() => decide(s, h.id, true)}><Check />{t("suggest.accept")}</Button>{/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </div>
  </div>
{/if}
