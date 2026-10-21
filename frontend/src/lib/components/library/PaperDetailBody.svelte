<script lang="ts">
  import { untrack } from "svelte";
  import { BookOpen, Download, ExternalLink, FileSearch, FileUp, Link2, Pencil, Plus, Sparkles, Trash2, Waypoints, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { requestRaw } from "#lib/library/api.ts";
  import { arxivUrl, authorsFull, doiUrl, pdfUrl } from "#lib/library/format.ts";
  import type { PaperDetail, ReadingStatus, StudyPaper } from "#lib/library/types.ts";
  import type { StudyCard } from "#lib/studies/types.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import MarkdownEditor from "#lib/components/markdown/MarkdownEditor.svelte";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import AiDraftDialog from "./AiDraftDialog.svelte";
  import CitationBox from "./CitationBox.svelte";
  import PaperEditSheet from "./PaperEditSheet.svelte";
  import TagInput from "./TagInput.svelte";
  import { STATUSES } from "./StatusPill.svelte";

  /**
   * Everything about one paper: metadata, PDF, citation, studies, and — inside a study — reading status, cite key,
   * tags and notes with AI helpers. Used by PaperSheet (side panel) and the /library/[id] reader page.
   */
  let { paperId, study = null, layout = "sheet", onChanged, onGone, tagSuggestions = [] }: {
    paperId: string;
    study?: { id: string; slug: string; title: string; canEdit: boolean } | null;
    layout?: "sheet" | "page";
    onChanged?: () => void;
    /** The paper was deleted or removed from the study. */
    onGone?: () => void;
    tagSuggestions?: string[];
  } = $props();

  let paper = $state<PaperDetail | null>(null);
  let sp = $state<StudyPaper | null>(null);
  let error = $state<string | null>(null);
  let notes = $state("");
  let savedNotes = $state("");
  let citeKey = $state("");
  let notesLayout = $state<"split" | "edit" | "preview">(session.user?.preferences.editor.layout ?? "split");
  const canEditStudy = $derived(Boolean(study?.canEdit && sp));

  async function load() {
    try {
      if (study) {
        const r = await requestRaw<{ studyPaper: StudyPaper; paper: PaperDetail }>("GET", `/studies/${study.id}/papers/${paperId}`);
        if (r.ok) {
          paper = r.data.paper;
          adopt(r.data.studyPaper);
        } else if (r.status === 404) {
          paper = (await api.get<{ paper: PaperDetail }>(`/library/papers/${paperId}`)).paper;
          sp = null;
        } else throw new Error(r.data.error);
      } else {
        paper = (await api.get<{ paper: PaperDetail }>(`/library/papers/${paperId}`)).paper;
      }
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function adopt(next: StudyPaper) {
    sp = next;
    citeKey = next.cite_key;
    if (notes === savedNotes) notes = next.notes_md;
    savedNotes = next.notes_md;
  }
  $effect(() => {
    void paperId;
    void study?.id;
    untrack(() => {
      paper = null;
      sp = null;
      notes = savedNotes = "";
      void load();
    });
  });

  async function patchStudyPaper(body: Record<string, unknown>, okMessage?: string) {
    if (!study || !sp) return false;
    try {
      const r = await api.patch<{ studyPaper: StudyPaper }>(`/studies/${study.id}/papers/${paperId}`, body);
      adopt(r.studyPaper);
      if (okMessage) toasts.show(okMessage, "success");
      onChanged?.();
      return true;
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return false;
    }
  }

  let savingNotes = $state(false);
  async function saveNotes() {
    savingNotes = true;
    const value = notes;
    if (await patchStudyPaper({ notes_md: value }, t("library.notes.saved"))) notes = value;
    savingNotes = false;
  }
  const dirty = $derived(Boolean(sp) && notes !== savedNotes);

  // PDF
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  let fetching = $state(false);
  async function uploadPdf(file: File | undefined) {
    if (!file || !paper) return;
    uploading = true;
    const body = new FormData();
    body.append("file", file, file.name);
    try {
      paper = (await api.post<{ paper: PaperDetail }>(`/library/papers/${paper.id}/pdf`, body)).paper;
      toasts.show(t("library.pdf.uploaded"), "success");
      onChanged?.();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = "";
    }
  }
  async function fetchPdf() {
    if (!paper) return;
    fetching = true;
    const r = await requestRaw<{ paper: PaperDetail }>("POST", `/library/papers/${paper.id}/fetch-pdf`, {});
    fetching = false;
    if (r.ok) {
      paper = r.data.paper;
      toasts.show(t("library.pdf.fetched"), "success");
      onChanged?.();
    } else toasts.show(r.data.error ?? t("common.error"), "error", 5000);
  }

  // AI
  let aiOpen = $state(false);
  let aiMarkdown = $state("");
  let aiNote = $state("");
  let aiHeading = $state("");
  let aiBusy = $state<"summary" | "relevance" | null>(null);
  async function runAi(kind: "summary" | "relevance") {
    if (!paper) return;
    aiBusy = kind;
    const path = kind === "summary" ? `/library/papers/${paper.id}/ai/summary` : `/studies/${study!.id}/papers/${paper.id}/ai/relevance`;
    const r = await requestRaw<{ markdown: string; usedPdf: boolean }>("POST", path, {});
    aiBusy = null;
    if (!r.ok) {
      toasts.show(r.data.error ?? t("common.error"), "error", 5000);
      return;
    }
    aiMarkdown = r.data.markdown;
    aiHeading = t(kind === "summary" ? "library.ai.summaryHeading" : "library.ai.relevanceHeading");
    aiNote = r.data.usedPdf ? t("library.ai.usedPdf") : t("library.ai.abstractOnly");
    if (!canEditStudy) aiNote += ` ${t("library.ai.needStudy")}`;
    aiOpen = true;
  }
  function insertAi(md: string) {
    const block = `## ${aiHeading}\n\n${md.trim()}\n`;
    notes = notes.trim() ? `${notes.trimEnd()}\n\n${block}` : block;
    toasts.show(t("library.ai.inserted"));
  }

  // Studies
  let myStudies = $state<StudyCard[] | null>(null);
  let target = $state("");
  let adding = $state(false);
  $effect(() => {
    if (!paper || myStudies) return;
    api.get<{ studies: StudyCard[] }>("/studies?member=me").then(r => (myStudies = r.studies.filter(s => s.my_role === "owner" || s.my_role === "member")), () => (myStudies = []));
  });
  const addable = $derived((myStudies ?? []).filter(s => !paper?.studies.some(x => x.id === s.id)));
  $effect(() => {
    if (addable.length && !addable.some(s => s.id === target)) target = addable[0]!.id;
  });
  async function addToStudy() {
    if (!paper || !target) return;
    adding = true;
    try {
      await api.post(`/studies/${target}/papers`, { paperId: paper.id });
      toasts.show(t("library.detail.added", { study: addable.find(s => s.id === target)?.title ?? "" }), "success");
      await load();
      onChanged?.();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      adding = false;
    }
  }

  // Edit / remove / delete
  let editOpen = $state(false);
  let removeOpen = $state(false);
  let deleteOpen = $state(false);
  const reportError = (e: unknown) => {
    toasts.show((e as Error).message, "error");
    throw e;
  };
  async function remove() {
    await api.del(`/studies/${study!.id}/papers/${paperId}`).catch(reportError);
    toasts.show(t("library.removed"));
    onChanged?.();
    onGone?.();
  }
  async function destroy() {
    await api.del(`/library/papers/${paperId}`).catch(reportError);
    toasts.show(t("library.detail.deleted"));
    onChanged?.();
    onGone?.();
  }

  const readerHref = $derived(`/library/${paperId}${study ? `?study=${encodeURIComponent(study.slug)}` : ""}`);
  const section = "flex flex-col gap-3 border-t border-line pt-5";
  const heading = "text-[13px] font-semibold tracking-[-0.01em] text-ink";
</script>

{#if error}
  <p class="py-8 text-center text-sm text-ink-3">{error}</p>
{:else if !paper}
  <div class="flex flex-col gap-3 py-2"><Skeleton class="h-7 w-3/4" /><Skeleton class="h-4 w-1/2" /><Skeleton class="h-32" /></div>
{:else}
  <div class="flex flex-col gap-5">
    <header class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <Pill tone="sky" size="sm">{t(`library.type.${paper.type}` as MessageKey)}</Pill>
        {#if paper.venue}<Pill tone="lilac" size="sm">{paper.venue}</Pill>{/if}
        {#if paper.year}<span class="text-[12.5px] text-ink-3 tabular-nums">{paper.year}</span>{/if}
      </div>
      <h2 class="text-[19px] leading-snug font-semibold tracking-[-0.015em] break-words text-ink {layout === 'page' ? 'sm:text-[24px]' : ''}">{paper.title}</h2>
      <p class="text-[13.5px] leading-relaxed break-words text-ink-2">{authorsFull(paper.authors) || t("library.noAuthors")}</p>
      {#if paper.container_title}<p class="text-[13px] break-words text-ink-3 italic">{paper.container_title}{paper.record.volume ? `, ${paper.record.volume}` : ""}{paper.record.issue ? `(${paper.record.issue})` : ""}{paper.record.pages ? `, ${paper.record.pages}` : ""}</p>{/if}
      <div class="flex flex-wrap gap-1.5 pt-1">
        {#if paper.doi}<a class="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12.5px] text-ink-2 hover:text-ink" href={doiUrl(paper.doi)} target="_blank" rel="noopener noreferrer"><Link2 class="size-3.5 shrink-0" /><span class="truncate">DOI {paper.doi}</span></a>{/if}
        {#if paper.arxiv_id}<a class="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12.5px] text-ink-2 hover:text-ink" href={arxivUrl(paper.arxiv_id)} target="_blank" rel="noopener noreferrer"><Link2 class="size-3.5" />arXiv {paper.arxiv_id}</a>{/if}
        {#if paper.url}<a class="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12.5px] text-ink-2 hover:text-ink" href={paper.url} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-3.5 shrink-0" /><span class="max-w-56 truncate">{paper.url.replace(/^https?:\/\//, "")}</span></a>{/if}
      </div>
    </header>

    {#if sp}
      <section class="flex flex-col gap-3 rounded-2xl bg-surface-2/70 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class={heading}>{t("library.status")}</span>
          {#if canEditStudy}
            <Segmented
              value={sp.reading_status}
              label={t("library.status")}
              options={STATUSES.map(s => ({ value: s, label: t(`library.status.${s}` as MessageKey) }))}
              onValueChange={(s: ReadingStatus) => patchStudyPaper({ reading_status: s })}
            />
          {:else}
            <span class="text-[13px] text-ink-2">{t(`library.status.${sp.reading_status}` as MessageKey)}</span>
          {/if}
        </div>
        <div class="flex items-end gap-2">
          <TextField bind:value={citeKey} label={t("library.citeKey")} hint={t("library.citeKey.hint")} class="min-w-0 flex-1" readonly={!canEditStudy} maxlength={100} />
          {#if canEditStudy && citeKey.trim() && citeKey.trim() !== sp.cite_key}
            <Button class="mb-[22px]" onclick={() => patchStudyPaper({ cite_key: citeKey.trim() }, t("library.citeKey.save"))}>{t("library.citeKey.save")}</Button>
          {/if}
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("library.tags")}</span>
          <TagInput tags={sp.tags} disabled={!canEditStudy} suggestions={tagSuggestions} onChange={tags => patchStudyPaper({ tags })} />
        </div>
      </section>
    {/if}

    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class={heading}>{t("library.pdf.title")}</h3>
        {#if paper.oa_url && !paper.has_pdf}<a class="text-[12.5px] text-ink-3 underline-offset-2 hover:underline" href={paper.oa_url} target="_blank" rel="noopener noreferrer">{t("library.pdf.oaFound")}</a>{/if}
      </div>
      {#if paper.has_pdf}
        <div class="flex flex-wrap gap-2">
          {#if layout === "sheet"}<Button variant="primary" href={readerHref}><BookOpen />{t("library.pdf.view")}</Button>{/if}
          <Button href={pdfUrl(paper.id)} target="_blank"><ExternalLink />{t("library.pdf.openTab")}</Button>
          <Button variant="ghost" href={pdfUrl(paper.id, true)}><Download />{t("library.pdf.download")}</Button>
          {#if paper.permissions.edit}<Button variant="ghost" loading={uploading} onclick={() => fileInput?.click()}><FileUp />{t("library.pdf.replace")}</Button>{/if}
        </div>
        <p class="text-[12px] text-ink-3">{t("library.pdf.privateNote")}</p>
      {:else}
        <div class="rounded-2xl border border-dashed border-line-2 p-4">
          <p class="text-sm font-medium text-ink">{t("library.pdf.none")}</p>
          <p class="mt-1 text-[12.5px] text-ink-3">{t("library.pdf.noneHint")}</p>
          {#if paper.permissions.edit}
            <div class="mt-3 flex flex-wrap gap-2">
              <Button loading={fetching} onclick={fetchPdf}><FileSearch />{fetching ? t("library.pdf.fetching") : t("library.pdf.fetch")}</Button>
              <Button variant="ghost" loading={uploading} onclick={() => fileInput?.click()}><FileUp />{t("library.pdf.upload")}</Button>
            </div>
          {/if}
        </div>
      {/if}
      <input bind:this={fileInput} type="file" accept=".pdf,application/pdf" class="sr-only" tabindex="-1" aria-hidden="true" onchange={() => uploadPdf(fileInput?.files?.[0])} />
    </section>

    <section class={section}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class={heading}>{sp ? t("library.notes") : t("library.detail.abstract")}</h3>
        <div class="flex flex-wrap gap-1.5">
          <AiGate role="analysis" inline>
            <Button size="sm" variant="outline" loading={aiBusy === "summary"} disabled={Boolean(aiBusy)} onclick={() => runAi("summary")}><Sparkles />{t("library.ai.summary")}</Button>
            {#if canEditStudy}<Button size="sm" variant="outline" loading={aiBusy === "relevance"} disabled={Boolean(aiBusy)} onclick={() => runAi("relevance")}><Waypoints />{t("library.ai.relevance")}</Button>{/if}
          </AiGate>
        </div>
      </div>
      {#if aiBusy}<p class="flex items-center gap-2 text-[12.5px] text-ink-3"><Spinner />{t("library.ai.working")}</p>{/if}
      {#if sp}
        {#if canEditStudy}
          <div class="min-h-56"><MarkdownEditor bind:value={notes} bind:layout={notesLayout} label={t("library.notes")} fontSize={session.user?.preferences.editor.fontSize ?? 15} /></div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <span class="mr-auto text-[12px] text-ink-3">
              {#if dirty}{t("library.notes.unsaved")}{:else if sp.notes_updated_at}{t("library.notes.updated", { name: sp.notes_updated_by ?? "", time: relativeTime(sp.notes_updated_at) })}{/if}
            </span>
            <Button variant="primary" size="sm" loading={savingNotes} disabled={!dirty} onclick={saveNotes}>{t("library.notes.save")}</Button>
          </div>
        {:else if sp.notes_md.trim()}
          <div class="rounded-2xl bg-surface-2/60 p-4"><MarkdownView source={sp.notes_md} fontSize={14} /></div>
        {:else}
          <p class="text-[13px] text-ink-3">{t("library.notes.readOnly")}</p>
        {/if}
      {/if}
      {#if sp}<h3 class="{heading} pt-2">{t("library.detail.abstract")}</h3>{/if}
      <p class="text-[13.5px] leading-relaxed whitespace-pre-line break-words text-ink-2">{paper.abstract || t("library.detail.noAbstract")}</p>
    </section>

    <section class={section}>
      <h3 class={heading}>{t("library.detail.cite")}</h3>
      <CitationBox citations={sp ? { ...paper.citations, bibtex: paper.citations.bibtex.replace(/^(@\w+\{)[^,]*/, `$1${sp.cite_key}`) } : paper.citations} />
    </section>

    <section class={section}>
      <h3 class={heading}>{t("library.detail.studies")}</h3>
      {#if paper.studies.length}
        <ul class="flex flex-col gap-1">
          {#each paper.studies as s (s.id)}
            <li>
              <a href="/studies/{s.slug}?tab=papers" class="flex min-h-10 items-center justify-between gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-2">
                <span class="min-w-0 truncate text-[13.5px] text-ink">{s.title}</span>
                <span class="flex shrink-0 items-center gap-2 text-[12px] text-ink-3"><code class="font-mono">{s.cite_key}</code>{t(`library.status.${s.reading_status}` as MessageKey)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-[13px] text-ink-3">{t("library.detail.noStudies")}</p>
      {/if}
      {#if myStudies && addable.length}
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select bind:value={target} label={t("library.detail.chooseStudy")} options={addable.map(s => ({ value: s.id, label: s.title }))} class="w-full min-w-0 sm:flex-1" />
          <Button loading={adding} onclick={addToStudy}><Plus />{t("library.detail.addToStudy")}</Button>
        </div>
      {:else if myStudies && !myStudies.length}
        <p class="text-[12.5px] text-ink-3">{t("library.detail.noEditableStudies")}</p>
      {/if}
    </section>

    <footer class="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      {#if paper.added_by}<span class="mr-auto text-[12px] text-ink-3">{t("library.detail.addedBy", { name: paper.added_by.name })} · {relativeTime(paper.created_at)}</span>{/if}
      {#if layout === "sheet"}<Button size="sm" variant="ghost" href={readerHref}><BookOpen />{t("library.detail.openFull")}</Button>{/if}
      {#if paper.permissions.edit}<Button size="sm" variant="ghost" onclick={() => (editOpen = true)}><Pencil />{t("library.detail.edit")}</Button>{/if}
      {#if canEditStudy}<Button size="sm" variant="ghost" onclick={() => (removeOpen = true)}><X />{t("library.removeFromStudy")}</Button>{/if}
      {#if paper.permissions.delete && !sp}<Button size="sm" variant="danger" onclick={() => (deleteOpen = true)}><Trash2 />{t("library.detail.delete")}</Button>{/if}
    </footer>
  </div>

  <PaperEditSheet bind:open={editOpen} {paper} onSaved={p => ((paper = p), onChanged?.())} />
  <AiDraftDialog bind:open={aiOpen} bind:markdown={aiMarkdown} note={aiNote} onInsert={canEditStudy ? insertAi : undefined} />
  <ConfirmDialog bind:open={removeOpen} title={t("library.removeConfirm", { title: paper.title })} description={t("library.removeHint")} confirmLabel={t("library.removeFromStudy")} onConfirm={remove} />
  <ConfirmDialog bind:open={deleteOpen} title={t("library.detail.deleteConfirm", { title: paper.title })} description={t("library.detail.deleteHint")} confirmLabel={t("library.detail.delete")} onConfirm={destroy} />
{/if}
