<script lang="ts">
  import { goto } from "$app/navigation";
  import { CircleAlert, FileCode2, Sparkles, Upload } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { DeckKind } from "#lib/slides/types.ts";
  import { deckUrl } from "#lib/slides/util.ts";

  /**
   * New deck in a study: pick the type (進度報告 / 論文報告) and how it starts — upload a file (hands over to
   * UploadSheet via `onUpload`), edit Quarto in the platform from the Lab-Hub template, or let AI draft it.
   */
  let { open = $bindable(false), study, kind: initialKind = "progress", onUpload }: {
    open?: boolean;
    study: { id: string; slug: string; title: string };
    kind?: DeckKind;
    onUpload: (kind: DeckKind) => void;
  } = $props();

  type Source = "editor" | "ai" | "upload";
  type PaperOption = { id: string; title: string; year: number | null; venue: string | null };
  const MANUAL = "__manual";

  let kind = $state<DeckKind>("progress");
  let source = $state<Source>("editor");
  let title = $state("");
  let titleTouched = $state(false);
  let paperChoice = $state(MANUAL);
  let paperTitle = $state("");
  let paperUrl = $state("");
  let paperAbstract = $state("");
  let instructions = $state("");
  let papers = $state<PaperOption[] | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => aiStatus.watch());
  const aiReady = $derived(aiStatus.available("slides"));

  const yymmdd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()).slice(2).replace(/-/g, "");
  const chosenPaper = $derived(papers?.find(p => p.id === paperChoice) ?? null);
  // Suggested title until the user types one.
  $effect(() => {
    if (titleTouched) return;
    if (kind === "progress") title = t("slides.create.progressTitle", { date: yymmdd() });
    else title = chosenPaper?.title ?? paperTitle.trim();
  });

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      kind = initialKind;
      source = "editor";
      titleTouched = false;
      paperChoice = MANUAL;
      paperTitle = paperUrl = paperAbstract = instructions = "";
      error = null;
      busy = false;
    }
    wasOpen = open;
  });

  // Papers of the study's library (when the library module is there).
  $effect(() => {
    if (!open || kind !== "paper_report" || papers) return;
    api.get<{ papers: { paper: { id: string; title: string; year?: number | null; venue?: string | null } }[] }>(`/studies/${study.id}/papers`).then(
      r => {
        papers = r.papers.map(p => ({ id: p.paper.id, title: p.paper.title, year: p.paper.year ?? null, venue: p.paper.venue ?? null }));
        if (papers.length && paperChoice === MANUAL) paperChoice = papers[0]!.id;
      },
      () => (papers = []),
    );
  });
  $effect(() => {
    if (source === "ai" && !aiReady) source = "editor";
  });

  const paperOptions = $derived([
    ...(papers ?? []).map(p => ({ value: p.id, label: p.title, hint: [p.venue, p.year].filter(Boolean).join(" ") || undefined })),
    { value: MANUAL, label: t("slides.create.paperManual") },
  ]);
  const manualPaper = $derived(kind === "paper_report" && paperChoice === MANUAL);
  const urlInvalid = $derived(Boolean(paperUrl.trim()) && !/^https?:\/\//i.test(paperUrl.trim()));
  const canSubmit = $derived(
    source === "upload" || (title.trim().length > 0 && (!manualPaper || (paperTitle.trim().length > 0 && !urlInvalid)) && (source !== "ai" || aiReady)),
  );

  async function submit(event?: Event) {
    event?.preventDefault();
    if (!canSubmit || busy) return;
    if (source === "upload") {
      open = false;
      onUpload(kind);
      return;
    }
    busy = true;
    error = null;
    try {
      const body: Record<string, unknown> = { studyId: study.id, title: title.trim(), kind, source };
      if (kind === "paper_report") {
        if (manualPaper) body.paper = { title: paperTitle.trim(), ...(paperUrl.trim() ? { url: paperUrl.trim() } : {}), ...(paperAbstract.trim() ? { abstract: paperAbstract.trim() } : {}) };
        else body.paperId = paperChoice;
      }
      const created = await api.post<{ id: string }>("/slides", body);
      if (source === "ai") {
        try {
          await api.post(`/slides/${created.id}/ai/generate`, instructions.trim() ? { instructions: instructions.trim() } : {});
        } catch (e) {
          toasts.show((e as Error).message, "error");
        }
      }
      open = false;
      await goto(deckUrl(study.slug, created.id, "edit"));
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const sources = $derived<{ value: Source; icon: typeof Upload; title: string; hint: string; disabled?: boolean }[]>([
    { value: "editor", icon: FileCode2, title: t("slides.create.source.editor"), hint: t(kind === "progress" ? "slides.create.source.editorHint.progress" : "slides.create.source.editorHint.paper") },
    { value: "ai", icon: Sparkles, title: t("slides.create.source.ai"), hint: aiReady ? t(kind === "progress" ? "slides.create.source.aiHint.progress" : "slides.create.source.aiHint.paper") : t("ai.maintenance"), disabled: !aiReady },
    { value: "upload", icon: Upload, title: t("slides.create.source.upload"), hint: t("slides.create.source.uploadHint") },
  ]);
</script>

<Sheet bind:open side="right" title={t("slides.create.title")} description={t("slides.create.description", { study: study.title })}>
  <form class="flex flex-col gap-5 pt-2" onsubmit={submit}>
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("slides.upload.kind")}</span>
      <Segmented bind:value={kind} label={t("slides.upload.kind")} class="w-full" options={[{ value: "progress", label: t("slides.kind.progress") }, { value: "paper_report", label: t("slides.kind.paper_report") }]} />
    </div>

    <fieldset class="flex flex-col gap-2">
      <legend class="mb-1.5 text-[13px] font-medium text-ink-2">{t("slides.create.source")}</legend>
      {#each sources as option (option.value)}
        <label
          class="flex min-h-[64px] cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-[border-color,background-color] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink/30 {source === option.value ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2'} {option.disabled ? 'cursor-not-allowed opacity-55' : ''}"
        >
          <input type="radio" name="deck-source" value={option.value} bind:group={source} disabled={option.disabled} class="sr-only" />
          <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><option.icon class="size-4.5" /></span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-ink">{option.title}</span>
            <span class="mt-0.5 block text-[12.5px] leading-relaxed text-ink-3">{option.hint}</span>
          </span>
          <span class="mt-1 grid size-5 shrink-0 place-items-center rounded-full border-2 {source === option.value ? 'border-ink' : 'border-line-2'}" aria-hidden="true">
            {#if source === option.value}<span class="size-2.5 rounded-full bg-ink"></span>{/if}
          </span>
        </label>
      {/each}
    </fieldset>

    {#if source !== "upload"}
      {#if kind === "paper_report"}
        <div class="flex flex-col gap-3 rounded-2xl border border-line p-3.5">
          <span class="text-[13px] font-medium text-ink-2">{t("slides.create.paper")}</span>
          {#if papers?.length}
            <Select bind:value={paperChoice} label={t("slides.create.paper")} options={paperOptions} class="w-full" />
          {/if}
          {#if manualPaper}
            <TextField label={t("slides.create.paperTitle")} bind:value={paperTitle} maxlength={300} required />
            <TextField label={t("slides.create.paperUrl")} bind:value={paperUrl} maxlength={2000} type="url" inputmode="url" error={urlInvalid ? t("slides.create.paperUrlInvalid") : null} />
            <Textarea label={t("slides.create.paperAbstract")} bind:value={paperAbstract} rows={3} maxlength={8000} hint={t("slides.create.paperAbstractHint")} />
          {/if}
        </div>
      {/if}
      <TextField label={t("slides.upload.name")} bind:value={title} maxlength={160} required oninput={() => (titleTouched = true)} />
      {#if source === "ai"}
        <Textarea label={t("slides.create.instructions")} bind:value={instructions} rows={3} maxlength={2000} placeholder={t("slides.create.instructionsPlaceholder")} hint={t("slides.create.instructionsHint")} />
      {/if}
    {/if}

    {#if error}
      <p class="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger"><CircleAlert class="mt-0.5 size-4 shrink-0" />{error}</p>
    {/if}
    <Button type="submit" variant="primary" size="lg" class="mt-1 w-full" disabled={!canSubmit} loading={busy}>
      {source === "upload" ? t("slides.create.chooseFile") : source === "ai" ? t("slides.create.submitAi") : t("slides.create.submit")}
    </Button>
  </form>
</Sheet>
