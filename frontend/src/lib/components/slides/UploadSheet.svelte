<script lang="ts">
  import { CircleAlert, CircleCheck, FileSearch, Info } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideStatus, UploadLimits } from "#lib/slides/types.ts";
  import { DEFAULT_LIMITS, entryCandidates, formatBytes, isBusy, renderLog, SLUG_RE, slugify, uploadForm, watchStatus } from "#lib/slides/util.ts";
  import { FolderError, zipFolder, type Folder } from "#lib/slides/folder.ts";

  /**
   * Upload a new deck (`projectId` unset) or a new version of `projectId`, then follow its render.
   * A new deck belongs to a study: `studyId` fixes it (study page); otherwise the user picks one of the studies they edit.
   * `onUploaded` fires once the ZIP is accepted (202); `onRendered` when the render finishes either way.
   */
  let { open = $bindable(false), projectId, studyId, kind: initialKind, limits = DEFAULT_LIMITS, onUploaded, onRendered }: {
    open?: boolean;
    projectId?: string;
    studyId?: string;
    /** Preselected deck type for a new deck. */
    kind?: "progress" | "paper_report";
    limits?: UploadLimits;
    onUploaded?: (result: { id: string; slug?: string; version: number }) => void;
    onRendered?: (status: SlideStatus) => void;
  } = $props();

  const isVersion = $derived(Boolean(projectId));
  type Phase = "form" | "uploading" | "rendering" | "done" | "review" | "failed";
  let phase = $state<Phase>("form");
  let title = $state("");
  let slug = $state("");
  let slugTouched = $state(false);
  let publicView = $state(false);
  let chosenStudy = $state("");
  let deckKind = $state<"progress" | "paper_report">("progress");
  let studies = $state<{ id: string; title: string }[] | null>(null);
  const targetStudy = $derived(studyId ?? chosenStudy);
  let file = $state<File | null>(null);
  let entries = $state<string[] | null>(null);
  let entry = $state("");
  let error = $state<string | null>(null);
  let sent = $state(0);
  let status = $state<SlideStatus | null>(null);
  let created = $state<{ id: string; version: number } | null>(null);
  let stop: (() => void) | undefined;
  let zipping = $state<number | null>(null);
  let skipped = $state<string[]>([]);

  const maxBytes = $derived(limits.deckBytes ?? limits.zipBytes);
  const accept = $derived((limits.deckTypes ?? [".zip", ".pdf", ".pptx"]).join(","));
  const kind = $derived.by(() => {
    const name = file?.name.toLowerCase() ?? "";
    return name.endsWith(".pdf") ? "pdf" : name.endsWith(".pptx") ? "pptx" : name.endsWith(".zip") ? "quarto" : null;
  });

  async function takeFolder(folder: Folder) {
    error = null;
    skipped = [];
    zipping = 0;
    try {
      const result = await zipFolder(folder, limits.zipBytes, f => (zipping = f));
      file = result.file;
      skipped = result.unsupported;
    } catch (e) {
      error = e instanceof FolderError ? t(`slides.upload.folder.${e.code}`, { size: formatBytes(limits.zipBytes), path: e.detail, n: e.detail }) : (e as Error).message;
    } finally {
      zipping = null;
    }
  }

  $effect(() => {
    if (!slugTouched) slug = title.trim() ? slugify(title) : "";
  });
  // A finished upload shows its result until the sheet is reopened.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen && (phase === "done" || phase === "failed")) reset();
    if (open && !wasOpen && phase === "form" && initialKind) deckKind = initialKind;
    wasOpen = open;
  });
  $effect(() => () => stop?.());

  /** Slug the server refused as taken (409); the field shows it until the slug changes. */
  let takenSlug = $state<string | null>(null);
  const slugError = $derived(
    slug && (!SLUG_RE.test(slug) || slug.length > 80) ? t("slides.upload.slugInvalid") : slug && slug === takenSlug ? t("slides.upload.slugTaken") : null,
  );
  const canSubmit = $derived(Boolean(file) && (isVersion || (title.trim() && slug && !slugError && targetStudy)) && (!entries || entry));

  // Studies the user may add decks to (owner or member), for the picker.
  $effect(() => {
    if (!open || isVersion || studyId || studies) return;
    api.get<{ studies: { id: string; title: string; my_role: string | null }[] }>("/studies?member=me").then(
      r => {
        studies = r.studies.filter(s => s.my_role === "owner" || s.my_role === "member");
        if (!chosenStudy && studies[0]) chosenStudy = studies[0].id;
      },
      () => (studies = []),
    );
  });

  function reset() {
    phase = "form";
    title = slug = entry = "";
    slugTouched = publicView = false;
    deckKind = "progress";
    file = null;
    entries = null;
    error = null;
    skipped = [];
    status = null;
    created = null;
    takenSlug = null;
    sent = 0;
  }

  async function submit(event?: Event) {
    event?.preventDefault();
    if (!canSubmit || !file) return;
    error = null;
    const form = new FormData();
    if (!isVersion) {
      form.append("title", title.trim());
      form.append("slug", slug);
      form.append("public", publicView ? "true" : "false");
      form.append("studyId", targetStudy);
      form.append("kind", deckKind);
    }
    if (entries && entry) form.append("entry", entry);
    form.append("file", file, file.name);
    phase = "uploading";
    sent = 0;
    try {
      const path = isVersion ? `/slides/${projectId}/versions` : "/slides";
      const result = await uploadForm<{ id?: string; slug?: string; version: number; scan?: { skipped?: string[]; skippedCount?: number } | null }>(path, form, f => (sent = f));
      const skipped = result.scan?.skippedCount ?? 0;
      if (skipped) toasts.show(t("slides.upload.skippedFiles", { n: skipped, names: (result.scan?.skipped ?? []).slice(0, 3).join("、") }), "default", 6000);
      const id = result.id ?? projectId!;
      created = { id, version: result.version };
      void jobsStore.refresh();
      onUploaded?.({ id, slug: result.slug, version: result.version });
      phase = "rendering";
      stop?.();
      stop = watchStatus(id, s => {
        status = s;
        if (!isBusy(s.status)) {
          phase = s.status === "published" ? "done" : s.status === "review" ? "review" : "failed";
          void jobsStore.refresh();
          onRendered?.(s);
        }
      });
    } catch (e) {
      phase = "form";
      const message = e instanceof ApiError && e.status === 413 ? t("slides.upload.tooLarge", { size: formatBytes(maxBytes) }) : (e as Error).message;
      const candidates = entryCandidates(message);
      if (e instanceof ApiError && e.status === 409 && !isVersion) {
        takenSlug = slug;
        error = null;
      } else if (candidates?.length) {
        entries = candidates;
        entry = candidates.find(c => !c.includes("/")) ?? candidates[0]!;
        error = null;
      } else error = message;
    }
  }

  // Changing the file invalidates the entry choice made for the previous one.
  let lastFile: File | null = null;
  $effect(() => {
    if (file !== lastFile) {
      lastFile = file;
      entries = null;
      entry = "";
      if (!file) skipped = [];
    }
  });

  const renderLabel = $derived(status?.stage ?? t("slides.status.queued"));
</script>

<!-- No discard prompt: closing keeps the form (and a running upload continues); reopening shows it again. -->
<Sheet
  bind:open
  dirty={false}
  side="right"
  title={isVersion ? t("slides.upload.versionTitle") : t("slides.upload.title")}
  description={isVersion ? t("slides.upload.versionDescription") : t("slides.upload.description")}
>
  {#if phase === "form" || phase === "uploading"}
    <form id="slide-upload" class="flex flex-col gap-4 pt-2" onsubmit={submit}>
      {#if !isVersion}
        <TextField label={t("slides.upload.name")} placeholder={t("slides.upload.namePlaceholder")} bind:value={title} maxlength={160} required disabled={phase === "uploading"} />
        <TextField
          label={t("slides.upload.slug")}
          bind:value={slug}
          maxlength={80}
          autocapitalize="off"
          spellcheck={false}
          error={slugError}
          hint={t("slides.upload.slugHint", { slug: slug || "…" })}
          disabled={phase === "uploading"}
          oninput={() => (slugTouched = true)}
        />
        {#if !studyId}
          <div class="flex flex-col gap-1.5">
            <span class="text-[13px] font-medium text-ink-2">{t("slides.upload.study")}</span>
            {#if studies && !studies.length}
              <p class="text-[13px] text-ink-3">{t("slides.upload.noStudy")}</p>
            {:else}
              <Select bind:value={chosenStudy} label={t("slides.upload.study")} class="w-full" options={(studies ?? []).map(s => ({ value: s.id, label: s.title }))} />
            {/if}
          </div>
        {/if}
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("slides.upload.kind")}</span>
          <Segmented bind:value={deckKind} label={t("slides.upload.kind")} class="w-full" options={[{ value: "progress", label: t("slides.kind.progress") }, { value: "paper_report", label: t("slides.kind.paper_report") }]} />
        </div>
        <div class="flex items-center justify-between gap-4 rounded-2xl border border-line p-3.5">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("slides.upload.public")}</p>
            <p class="mt-0.5 text-[12.5px] text-ink-3">{t("slides.upload.publicHint")}</p>
          </div>
          <Switch bind:checked={publicView} label={t("slides.upload.public")} disabled={phase === "uploading"} />
        </div>
      {/if}

      {#if zipping !== null}
        <div class="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-4">
          <p class="text-[13px] font-medium text-ink-2">{t("slides.upload.zipping", { pct: Math.round(zipping * 100) })}</p>
          <Progress value={zipping * 100} />
        </div>
      {:else}
        <FileDrop
          bind:file
          {accept}
          label={t("slides.upload.file")}
          hint={t("slides.upload.fileHint", { size: formatBytes(maxBytes) })}
          {maxBytes}
          onError={m => (error = m)}
          onFolder={phase === "uploading" ? undefined : takeFolder}
          folderLabel={t("slides.upload.folder")}
        >
          {#snippet details()}
            {#if kind}<p class="mt-0.5 text-[12px] text-ink-2">{t(`slides.upload.kind.${kind}`)}</p>{/if}
          {/snippet}
        </FileDrop>
      {/if}
      {#if kind}
        <p class="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-3"><Info class="mt-0.5 size-3.5 shrink-0" />{t(`slides.upload.hint.${kind}`)}</p>
      {/if}
      {#if skipped.length}
        <p class="rounded-xl bg-surface-2 px-3 py-2.5 text-[12.5px] text-ink-2" title={skipped.slice(0, 20).join("\n")}>{t("slides.upload.skipped", { n: skipped.length, list: skipped.slice(0, 3).join("、") + (skipped.length > 3 ? "…" : "") })}</p>
      {/if}

      {#if entries}
        <div class="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface-2 p-3.5">
          <span class="text-[13px] font-medium text-ink-2">{t("slides.upload.entry")}</span>
          <p class="text-[12.5px] text-ink-3">{t("slides.upload.entryHint")}</p>
          <Select bind:value={entry} label={t("slides.upload.entry")} options={entries.map(e => ({ value: e, label: e }))} class="mt-1 w-full" />
        </div>
      {/if}

      {#if error}
        <p class="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger"><CircleAlert class="mt-0.5 size-4 shrink-0" />{error}</p>
      {/if}

      {#if phase === "uploading"}
        <div class="flex flex-col gap-2">
          <p class="text-[13px] text-ink-2">{t("slides.upload.uploading", { pct: Math.round(sent * 100) })}</p>
          <Progress value={sent * 100} />
        </div>
      {/if}
      <Button type="submit" variant="primary" size="lg" class="mt-1 w-full" disabled={!canSubmit || zipping !== null} loading={phase === "uploading"}>{t("slides.upload.submit")}</Button>
    </form>
  {:else}
    <div class="flex flex-col gap-5 pt-4">
      <div class="rounded-2xl border border-line bg-surface-2 p-4">
        <div class="flex items-center gap-3">
          {#if phase === "review"}
            <span class="grid size-10 place-items-center rounded-xl" style="background:var(--pill-lilac);color:var(--pill-lilac-ink)"><FileSearch class="size-5" /></span>
          {:else if phase === "done"}
            <span class="grid size-10 place-items-center rounded-xl" style="background:var(--pill-mint);color:var(--pill-mint-ink)"><CircleCheck class="size-5" /></span>
          {:else if phase === "failed"}
            <span class="grid size-10 place-items-center rounded-xl" style="background:var(--pill-rose);color:var(--pill-rose-ink)"><CircleAlert class="size-5" /></span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">
              {phase === "done" ? t("slides.upload.done") : phase === "review" ? t("slides.upload.review") : phase === "failed" ? t("slides.upload.failed") : t("slides.upload.rendering")}
              {#if created}<span class="ml-1 text-ink-3">{t("slides.version", { n: created.version })}</span>{/if}
            </p>
            {#if phase === "rendering"}<p class="mt-0.5 text-[12.5px] text-ink-3">{renderLabel} · {status?.progress ?? 0}%</p>{/if}
            {#if phase === "review"}<p class="mt-0.5 text-[12.5px] text-ink-3">{t("slides.upload.reviewHint")}</p>{/if}
          </div>
        </div>
        {#if phase === "rendering"}<Progress class="mt-4" value={status?.progress || null} />{/if}
        {#if phase === "failed" && status?.error}
          <pre class="mt-3 max-h-48 overflow-auto rounded-xl bg-surface p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-ink-2">{renderLog(status.error)}</pre>
        {/if}
      </div>
      {#if phase === "rendering"}<p class="text-[12.5px] text-ink-3">{t("slides.upload.background")}</p>{/if}
      <div class="flex flex-col gap-2 sm:flex-row-reverse">
        {#if created && !isVersion}
          <Button variant="primary" href="/slides/{created.id}" onclick={() => (open = false)} class="sm:flex-1">{phase === "review" ? t("slides.upload.openReview") : t("slides.upload.open")}</Button>
        {:else if phase === "review"}
          <Button variant="primary" onclick={() => (open = false)} class="sm:flex-1">{t("slides.upload.openReview")}</Button>
        {:else}
          <Button variant="primary" onclick={() => (open = false)} class="sm:flex-1">{t("slides.upload.close")}</Button>
        {/if}
        <Button variant="ghost" onclick={reset} class="sm:flex-1">{t("slides.upload.another")}</Button>
      </div>
    </div>
  {/if}
</Sheet>
