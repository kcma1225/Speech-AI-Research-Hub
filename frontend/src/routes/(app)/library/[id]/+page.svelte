<script lang="ts">
  import { page } from "$app/state";
  import { ArrowLeft, ExternalLink, FileText, Info } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { pdfUrl } from "#lib/library/format.ts";
  import type { PaperDetail } from "#lib/library/types.ts";
  import type { StudyDetail } from "#lib/studies/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import PaperDetailBody from "#lib/components/library/PaperDetailBody.svelte";

  /** Reader: the PDF next to the paper's details and (with ?study=<slug>) the study's notes. */
  const paperId = $derived(page.params.id ?? "");
  const studyRef = $derived(page.url.searchParams.get("study"));
  let study = $state<{ id: string; slug: string; title: string; canEdit: boolean } | null>(null);
  let studyLoaded = $state(false);
  let paper = $state<PaperDetail | null>(null);
  let pane = $state<"pdf" | "info">("info");

  $effect(() => {
    const ref = studyRef;
    studyLoaded = false;
    if (!ref) {
      study = null;
      studyLoaded = true;
      return;
    }
    api.get<StudyDetail>(`/studies/${encodeURIComponent(ref)}`).then(
      d => ((study = { id: d.study.id, slug: d.study.slug, title: d.study.title, canEdit: d.permissions.edit }), (studyLoaded = true)),
      () => ((study = null), (studyLoaded = true)),
    );
  });
  async function refresh() {
    paper = (await api.get<{ paper: PaperDetail }>(`/library/papers/${paperId}`).catch(() => ({ paper: null }))).paper;
  }
  $effect(() => {
    void paperId;
    void refresh();
  });
  $effect(() => {
    if (paper?.has_pdf && pane === "info" && typeof matchMedia === "function" && matchMedia("(min-width: 1024px)").matches) pane = "pdf";
  });
  const back = $derived(study ? `/studies/${study.slug}?tab=papers` : "/library");
</script>

<svelte:head><title>{paper?.title ?? t("library.detail.title")} · Speech-AI Hub</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <Button variant="ghost" href={back} class="-ml-2"><ArrowLeft />{study ? study.title : t("library.title")}</Button>
  {#if paper?.has_pdf}
    <span class="ml-auto lg:hidden">
      <Segmented bind:value={pane} label={t("library.pdf.title")} options={[{ value: "info", label: t("library.detail.title"), icon: Info }, { value: "pdf", label: "PDF", icon: FileText }]} />
    </span>
  {/if}
</div>

<div class="grid grid-cols-[minmax(0,1fr)] gap-5 {paper?.has_pdf ? 'lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,1fr)]' : 'mx-auto max-w-3xl'}">
  {#if paper?.has_pdf}
    <section class="{pane === 'pdf' ? 'flex' : 'hidden'} min-w-0 flex-col gap-2 lg:sticky lg:top-4 lg:flex lg:h-[calc(100dvh-7rem)] lg:self-start">
      <iframe title={paper.title} src={pdfUrl(paper.id)} class="h-[75dvh] w-full rounded-[var(--radius-card)] border border-line bg-surface-2 lg:h-full"></iframe>
      <div class="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" href={pdfUrl(paper.id)} target="_blank"><ExternalLink />{t("library.pdf.openTab")}</Button>
      </div>
    </section>
  {/if}
  <section class="{paper?.has_pdf && pane === 'pdf' ? 'hidden lg:block' : ''} min-w-0 rounded-[var(--radius-card)] border border-line/70 bg-surface p-5 shadow-card sm:p-6">
    {#if studyLoaded}
      <PaperDetailBody {paperId} {study} layout="page" onChanged={refresh} />
    {/if}
  </section>
</div>
