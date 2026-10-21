<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { BookMarked, FileText, Globe, Plus, Search, Upload, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { authorsShort, venueLine } from "#lib/library/format.ts";
  import type { ReadingStatus, StudyPaper } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { StudyTabProps } from "#lib/components/study/tabs/registry.ts";
  import AddPaperSheet from "./AddPaperSheet.svelte";
  import ExportMenu from "./ExportMenu.svelte";
  import ImportWizard from "./ImportWizard.svelte";
  import OnlineSearchSheet from "./OnlineSearchSheet.svelte";
  import PaperSheet from "./PaperSheet.svelte";
  import StatusPill from "./StatusPill.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";

  /** Study tab 文獻: the study's reading list (status, tags, notes), import / search / add, export for LaTeX. */
  let { detail }: StudyTabProps = $props();
  const canEdit = $derived(detail.permissions.edit);
  const studyId = $derived(detail.study.id);
  const studyCtx = $derived({ id: detail.study.id, slug: detail.study.slug, title: detail.study.title, canEdit });

  type ListResponse = { papers: StudyPaper[]; tags: { tag: string; count: number }[]; counts: { unread: number; reading: number; read: number; total: number } };
  let data = $state<ListResponse | null>(null);
  let error = $state<string | null>(null);
  let status = $state<ReadingStatus | "all">("all");
  let tag = $state("");
  let q = $state("");

  let seq = 0;
  async function load() {
    const id = ++seq;
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (tag) p.set("tag", tag);
    if (q.trim()) p.set("q", q.trim());
    try {
      const r = await api.get<ListResponse>(`/studies/${studyId}/papers${p.size ? `?${p}` : ""}`);
      if (id !== seq) return;
      data = r;
      error = null;
    } catch (e) {
      if (id === seq) error = (e as Error).message;
    }
  }
  $effect(() => {
    void studyId;
    const key = `${status}|${tag}|${q.trim()}`;
    const timer = setTimeout(() => void load(), key && untrack(() => data) ? 200 : 0);
    return () => clearTimeout(timer);
  });

  // Paper sheet, deep-linked with &paper=<id>.
  // Row 從研究移除 (study editors; DELETE /studies/:id/papers/:paperId): trash on hover / focus, always on touch.
  let removing = $state<StudyPaper | null>(null);
  let removeOpen = $state(false);
  async function removeFromStudy() {
    const target = removing;
    if (!target) return;
    await api.del(`/studies/${studyId}/papers/${target.paper.id}`);
    if (data) data = { ...data, papers: data.papers.filter(x => x.paper.id !== target.paper.id) };
    void load();
    toasts.show(t("library.removed"), "success");
  }

  let sheetOpen = $state(false);
  let current = $state<string | null>(page.url.searchParams.get("paper"));
  $effect(() => {
    if (current && untrack(() => !sheetOpen)) sheetOpen = true;
  });
  $effect(() => {
    const url = new URL(page.url.href);
    const want = sheetOpen && current ? current : null;
    if ((url.searchParams.get("paper") ?? null) === want) return;
    if (want) url.searchParams.set("paper", want);
    else url.searchParams.delete("paper");
    untrack(() => void goto(url, { shallow: true, replace: true }));
  });
  function openPaper(id: string) {
    current = id;
    sheetOpen = true;
  }

  async function setStatus(sp: StudyPaper, s: ReadingStatus) {
    const before = sp.reading_status;
    sp.reading_status = s;
    try {
      await api.patch(`/studies/${studyId}/papers/${sp.paper.id}`, { reading_status: s });
      void load();
    } catch (e) {
      sp.reading_status = before;
      toasts.show((e as Error).message, "error");
    }
  }

  let addOpen = $state(false);
  let importOpen = $state(false);
  let searchOpen = $state(false);

  const statusOptions = $derived([
    { value: "all" as const, label: `${t("library.status.all")}${data ? ` ${data.counts.total}` : ""}` },
    { value: "unread" as const, label: `${t("library.status.unread")}${data ? ` ${data.counts.unread}` : ""}` },
    { value: "reading" as const, label: `${t("library.status.reading")}${data ? ` ${data.counts.reading}` : ""}` },
    { value: "read" as const, label: `${t("library.status.read")}${data ? ` ${data.counts.read}` : ""}` },
  ]);
  const tagOptions = $derived([{ value: "", label: t("library.tab.allTags") }, ...(data?.tags ?? []).map(x => ({ value: x.tag, label: x.tag, hint: String(x.count) }))]);
  const filtering = $derived(status !== "all" || Boolean(tag) || Boolean(q.trim()));
</script>

<div class="mb-4 flex flex-col gap-2.5 sm:mb-5">
  <div class="flex flex-wrap items-center gap-2">
    {#if canEdit}
      <Button variant="primary" onclick={() => (addOpen = true)}><Plus />{t("library.add")}</Button>
      <Button onclick={() => (importOpen = true)}><Upload />{t("library.import.button")}</Button>
      <Button onclick={() => (searchOpen = true)}><Globe />{t("library.onlineSearch")}</Button>
    {/if}
    <span class="ml-auto"><ExportMenu studyRef={detail.study.id} disabled={!data?.counts.total} /></span>
  </div>
  <div class="flex flex-col gap-2 lg:flex-row lg:items-center">
    <label class="relative min-w-0 flex-1 lg:max-w-sm">
      <span class="sr-only">{t("library.tab.search")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
      <input
        bind:value={q}
        type="search"
        placeholder={t("library.tab.search")}
        class="h-11 w-full rounded-full border border-line-2 bg-surface pr-10 pl-10 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:h-10 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {#if q}<button type="button" class="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("library.filter.clear")} onclick={() => (q = "")}><X class="size-4" /></button>{/if}
    </label>
    <div class="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
      <Segmented bind:value={status} label={t("library.status")} options={statusOptions} />
    </div>
    {#if data?.tags.length}<Select bind:value={tag} label={t("library.tags")} options={tagOptions} class="w-full min-w-0 sm:w-48" />{/if}
  </div>
</div>

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !data}
  <Card><div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-16" />{/each}</div></Card>
{:else if !data.papers.length}
  <Card>
    <EmptyState title={filtering ? t("library.emptyFiltered") : t("library.tab.empty")} hint={filtering ? undefined : t("library.tab.emptyHint")} class="py-12">
      {#snippet icon()}<BookMarked />{/snippet}
      {#snippet action()}
        {#if filtering}
          <Button variant="secondary" onclick={() => ((status = "all"), (tag = ""), (q = ""))}>{t("library.filter.clear")}</Button>
        {:else if canEdit}
          <div class="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onclick={() => (importOpen = true)}><Upload />{t("library.import.button")}</Button>
            <Button onclick={() => (searchOpen = true)}><Globe />{t("library.onlineSearch")}</Button>
          </div>
        {/if}
      {/snippet}
    </EmptyState>
  </Card>
{:else}
  <Card padded={false} class="overflow-hidden">
    <!-- Desktop table -->
    <table class="hidden w-full table-fixed text-left md:table">
      <thead class="border-b border-line text-[12px] font-medium text-ink-3">
        <tr>
          <th class="w-[112px] py-3 pl-5 font-medium">{t("library.col.status")}</th>
          <th class="py-3 pr-3 font-medium">{t("library.col.title")}</th>
          <th class="hidden w-[150px] py-3 pr-3 font-medium lg:table-cell">{t("library.col.venue")}</th>
          <th class="hidden w-[170px] py-3 pr-5 font-medium xl:table-cell">{t("library.col.key")}</th>
          {#if canEdit}<th class="w-14 py-3 pr-3"><span class="sr-only">{t("crud.more")}</span></th>{/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        {#each data.papers as sp (sp.paper.id)}
          <tr class="group cursor-pointer transition-colors hover:bg-surface-2/70" onclick={() => openPaper(sp.paper.id)}>
            <td class="py-2.5 pl-4 align-top" onclick={e => e.stopPropagation()}>
              {#if canEdit}<StatusPill status={sp.reading_status} onChange={s => setStatus(sp, s)} label="{t('library.status')}: {sp.paper.title}" />{:else}<span class="inline-flex h-10 items-center pl-1.5"><StatusPill status={sp.reading_status} /></span>{/if}
            </td>
            <td class="min-w-0 py-3 pr-3 align-top">
              <button type="button" class="block w-full text-left outline-none focus-visible:underline" onclick={e => (e.stopPropagation(), openPaper(sp.paper.id))}>
                <span class="block text-[14px] leading-snug font-medium break-words text-ink">{sp.paper.title}</span>
                <span class="mt-0.5 block truncate text-[12.5px] text-ink-3">{authorsShort(sp.paper.authors)}<span class="lg:hidden">{venueLine(sp.paper) ? ` · ${venueLine(sp.paper)}` : ""}</span></span>
              </button>
              {#if sp.tags.length || sp.paper.has_pdf || sp.notes_md.trim()}
                <span class="mt-1.5 flex flex-wrap items-center gap-1">
                  {#if sp.paper.has_pdf}<Pill tone="rose" size="sm">PDF</Pill>{/if}
                  {#if sp.notes_md.trim()}<span class="inline-flex h-5 items-center gap-1 text-[11px] text-ink-3"><FileText class="size-3" />{t("library.notes")}</span>{/if}
                  {#each sp.tags as tg (tg)}<Pill tone={toneFor(tg.toLowerCase())} size="sm">{tg}</Pill>{/each}
                </span>
              {/if}
            </td>
            <td class="hidden py-3 pr-3 align-top text-[12.5px] text-ink-2 lg:table-cell"><span class="line-clamp-2">{sp.paper.venue ?? sp.paper.container_title ?? "—"}</span><span class="text-ink-3 tabular-nums">{sp.paper.year ?? ""}</span></td>
            <td class="hidden py-3 pr-5 align-top xl:table-cell"><code class="block truncate font-mono text-[12px] text-ink-2">{sp.cite_key}</code></td>
            {#if canEdit}<td class="py-1.5 pr-3 align-top" onclick={e => e.stopPropagation()}><DeleteButton reveal label={t("crud.paper.removeFromStudy")} onclick={() => ((removing = sp), (removeOpen = true))} /></td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
    <!-- Phone cards -->
    <ul class="flex flex-col divide-y divide-line md:hidden">
      {#each data.papers as sp (sp.paper.id)}
        <li class="flex gap-2 px-3 py-3">
          <div class="min-w-0 flex-1">
            <button type="button" class="block w-full text-left" onclick={() => openPaper(sp.paper.id)}>
              <span class="block text-[14.5px] leading-snug font-medium break-words text-ink">{sp.paper.title}</span>
              <span class="mt-0.5 block text-[12.5px] break-words text-ink-3">{authorsShort(sp.paper.authors, 2)}{venueLine(sp.paper) ? ` · ${venueLine(sp.paper)}` : ""}</span>
            </button>
            <span class="mt-1.5 flex flex-wrap items-center gap-1">
              {#if canEdit}<StatusPill status={sp.reading_status} onChange={s => setStatus(sp, s)} label="{t('library.status')}: {sp.paper.title}" />{:else}<StatusPill status={sp.reading_status} />{/if}
              {#if sp.paper.has_pdf}<Pill tone="rose" size="sm">PDF</Pill>{/if}
              {#each sp.tags.slice(0, 3) as tg (tg)}<Pill tone={toneFor(tg.toLowerCase())} size="sm">{tg}</Pill>{/each}
            </span>
          </div>
          {#if canEdit}<DeleteButton label={t("crud.paper.removeFromStudy")} onclick={() => ((removing = sp), (removeOpen = true))} />{/if}
        </li>
      {/each}
    </ul>
  </Card>
  <p class="mt-3 text-[12.5px] text-ink-3">{t("library.tab.subtitle", { n: data.counts.total, read: data.counts.read, reading: data.counts.reading })}</p>
{/if}

<PaperSheet bind:open={sheetOpen} paperId={current} study={studyCtx} onChanged={load} tagSuggestions={(data?.tags ?? []).map(x => x.tag)} />
{#if canEdit}
  <AddPaperSheet bind:open={addOpen} study={detail.study} onAdded={id => (void load(), openPaper(id))} />
  <ImportWizard bind:open={importOpen} study={detail.study} onImported={load} />
  <OnlineSearchSheet bind:open={searchOpen} study={detail.study} onAdded={load} />
{/if}

<ConfirmDialog bind:open={removeOpen} title={t("library.removeConfirm", { title: removing?.paper.title ?? "" })} description={t("library.removeHint")} confirmLabel={t("library.removeFromStudy")} onConfirm={removeFromStudy} />
