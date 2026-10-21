<script lang="ts">
  import { Check, ChevronDown, Plus, Search } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { requestRaw } from "#lib/library/api.ts";
  import { authorsShort, doiUrl, recordVenue, arxivUrl } from "#lib/library/format.ts";
  import type { DuplicateResponse, PaperDetail, SearchHit, SearchResponse, SearchSource } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import WideSheet from "./WideSheet.svelte";

  /** Online search (OpenAlex, S2, arXiv, Crossref…) with 「已在文獻庫」 badges; adds to the study (or the lab library). */
  let { open = $bindable(false), study = null, onAdded }: { open?: boolean; study?: { id: string; title: string } | null; onAdded?: () => void } = $props();

  const SOURCES: { value: SearchSource; label: string }[] = [
    { value: "openalex", label: "OpenAlex" },
    { value: "s2", label: "Semantic Scholar" },
    { value: "arxiv", label: "arXiv" },
    { value: "crossref", label: "Crossref" },
    { value: "isca", label: "ISCA" },
  ];
  const sourceName = (id: string) => SOURCES.find(x => x.value === id)?.label ?? id;
  let q = $state("");
  let sources = $state<SearchSource[]>(["openalex", "s2", "arxiv", "crossref"]);
  let yearFrom = $state("");
  let yearTo = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let res = $state<SearchResponse | null>(null);
  let expanded = $state<Record<number, boolean>>({});
  let adding = $state<Record<number, boolean>>({});
  let added = $state<Record<number, boolean>>({});
  let input = $state<HTMLInputElement | null>(null);

  async function search() {
    if (!q.trim() || !sources.length) return;
    busy = true;
    error = null;
    expanded = {};
    added = {};
    const p = new URLSearchParams({ q: q.trim(), sources: sources.join(","), limit: "25" });
    if (/^\d{4}$/.test(yearFrom)) p.set("yearFrom", yearFrom);
    if (/^\d{4}$/.test(yearTo)) p.set("yearTo", yearTo);
    if (study) p.set("study", study.id);
    const r = await requestRaw<SearchResponse>("GET", `/library/search?${p}`);
    busy = false;
    if (r.ok) res = r.data;
    else error = r.data.error ?? t("common.error");
  }

  async function add(i: number, hit: SearchHit) {
    adding[i] = true;
    const body = hit.existing
      ? { paperId: hit.existing.paperId }
      : { record: hit.record, onDuplicate: "add" as const, ...(study ? { study: study.id } : {}) };
    const r = hit.existing && study
      ? await requestRaw("POST", `/studies/${study.id}/papers`, body)
      : await requestRaw<{ paper: PaperDetail } | DuplicateResponse>("POST", "/library/papers", body);
    adding[i] = false;
    if (r.ok) {
      added[i] = true;
      toasts.show(t("library.search.added"), "success");
      onAdded?.();
    } else toasts.show(r.data.error ?? t("common.error"), "error");
  }

  const toggle = (s: SearchSource) => (sources = sources.includes(s) ? sources.filter(x => x !== s) : [...sources, s]);
</script>

<WideSheet
  bind:open
  title={t("library.search.title")}
  description={study?.title}
  onOpenAutoFocus={e => {
    e.preventDefault();
    input?.focus();
  }}
>
  {#snippet header()}
    <form
      class="flex flex-col gap-2.5"
      onsubmit={e => {
        e.preventDefault();
        void search();
      }}
    >
      <div class="flex gap-2">
        <label class="relative min-w-0 flex-1">
          <span class="sr-only">{t("library.search.placeholder")}</span>
          <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
          <input
            bind:this={input}
            bind:value={q}
            type="search"
            placeholder={t("library.search.placeholder")}
            class="h-11 w-full rounded-full border border-line-2 bg-surface pr-4 pl-10 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <Button type="submit" variant="primary" class="h-11" loading={busy} disabled={!q.trim() || !sources.length}>{t("library.search.go")}</Button>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="mr-1 text-[12.5px] text-ink-3">{t("library.search.sources")}</span>
        {#each SOURCES as s (s.value)}
          <button
            type="button"
            aria-pressed={sources.includes(s.value)}
            class="inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors sm:h-8 {sources.includes(s.value) ? 'border-ink bg-ink text-canvas' : 'border-line-2 text-ink-2 hover:border-ink-3'}"
            onclick={() => toggle(s.value)}
          >
            {#if sources.includes(s.value)}<Check class="size-3.5" />{/if}{s.label}
          </button>
        {/each}
        <span class="ml-auto flex items-center gap-1.5">
          <TextField bind:value={yearFrom} placeholder={t("library.search.yearFrom")} aria-label={t("library.search.yearFrom")} inputmode="numeric" maxlength={4} class="w-24" />
          <span class="text-ink-3">–</span>
          <TextField bind:value={yearTo} placeholder={t("library.search.yearTo")} aria-label={t("library.search.yearTo")} inputmode="numeric" maxlength={4} class="w-24" />
        </span>
      </div>
    </form>
  {/snippet}
  {#snippet children()}
    {#if error}
      <p class="py-6 text-center text-[13px] text-danger" role="alert">{error}</p>
    {:else if busy && !res}
      <div class="flex flex-col gap-2">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-20" />{/each}</div>
    {:else if !res}
      <EmptyState title={t("library.search.title")} hint={t("library.search.hint")}>{#snippet icon()}<Search />{/snippet}</EmptyState>
    {:else}
      {#if res.skipped.length || res.errors.length}
        <div class="mb-3 flex flex-col gap-1 rounded-2xl bg-surface-2/70 px-3.5 py-2.5 text-[12px] text-ink-3">
          {#if res.skipped.length}<p>{t("library.search.skipped", { list: res.skipped.map(s => `${sourceName(s.source)}（${s.reason}）`).join("、") })}</p>{/if}
          {#if res.errors.length}<p>{t("library.search.failed", { list: res.errors.map(s => `${sourceName(s.source)}：${s.message}`).join("、") })}</p>{/if}
        </div>
      {/if}
      {#if !res.hits.length}
        <EmptyState title={t("library.search.empty")} />
      {:else}
        <ul class="flex flex-col divide-y divide-line">
          {#each res.hits as hit, i (i)}
            {@const r = hit.record}
            {@const done = added[i] || (study ? hit.existing?.inStudy : Boolean(hit.existing))}
            <li class="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:gap-4">
              <div class="min-w-0 flex-1">
                <p class="text-[14.5px] leading-snug font-medium break-words text-ink">{r.title}</p>
                <p class="mt-0.5 text-[12.5px] break-words text-ink-3">{authorsShort(r.authors, 4)}{recordVenue(r) ? ` · ${recordVenue(r)}` : ""}</p>
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {#if hit.existing?.inStudy}<Pill tone="mint" size="sm">{t("library.search.inStudy")}</Pill>{:else if hit.existing}<Pill tone="sky" size="sm">{t("library.search.inLibrary")}</Pill>{/if}
                  {#each hit.sources as s (s)}<Pill tone="stone" size="sm">{s}</Pill>{/each}
                  {#if r.doi}<a class="text-[12px] text-ink-3 underline-offset-2 hover:underline" href={doiUrl(r.doi)} target="_blank" rel="noopener noreferrer">DOI</a>{/if}
                  {#if r.arxivId}<a class="text-[12px] text-ink-3 underline-offset-2 hover:underline" href={arxivUrl(r.arxivId)} target="_blank" rel="noopener noreferrer">arXiv</a>{/if}
                  {#if r.abstract}
                    <button type="button" class="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[12px] text-ink-3 hover:bg-surface-2 hover:text-ink" aria-expanded={Boolean(expanded[i])} onclick={() => (expanded[i] = !expanded[i])}>
                      {t("library.search.abstract")}<ChevronDown class="size-3.5 transition-transform {expanded[i] ? 'rotate-180' : ''}" />
                    </button>
                  {/if}
                </div>
                {#if expanded[i] && r.abstract}<p class="mt-2 text-[13px] leading-relaxed text-ink-2">{r.abstract}</p>{/if}
              </div>
              <Button size="sm" variant={done ? "ghost" : "secondary"} disabled={done} loading={adding[i]} onclick={() => add(i, hit)} class="self-start">
                {#if done}<Check />{t("library.search.added")}{:else}<Plus />{study ? t("library.search.addToStudy") : t("library.search.addToLab")}{/if}
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/snippet}
</WideSheet>
