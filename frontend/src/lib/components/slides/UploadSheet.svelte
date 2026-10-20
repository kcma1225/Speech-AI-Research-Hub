<script lang="ts">
  import { CircleAlert, CircleCheck } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Pill, { toneFor } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TagPicker from "#lib/components/ui/TagPicker.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideStatus, UploadLimits } from "#lib/slides/types.ts";
  import { DEFAULT_LIMITS, entryCandidates, formatBytes, SLUG_RE, slugify, stripAnsi, uploadForm, watchStatus } from "#lib/slides/util.ts";

  /**
   * Upload a new deck (`projectId` unset) or a new version of `projectId`, then follow its render.
   * `onUploaded` fires once the ZIP is accepted (202); `onRendered` when the render finishes either way.
   */
  let { open = $bindable(false), projectId, limits = DEFAULT_LIMITS, onUploaded, onRendered }: {
    open?: boolean;
    projectId?: string;
    limits?: UploadLimits;
    onUploaded?: (result: { id: string; slug?: string; version: number }) => void;
    onRendered?: (status: SlideStatus) => void;
  } = $props();

  const isVersion = $derived(Boolean(projectId));
  type Phase = "form" | "uploading" | "rendering" | "done" | "failed";
  let phase = $state<Phase>("form");
  let title = $state("");
  let slug = $state("");
  let slugTouched = $state(false);
  let publicView = $state(false);
  let tagIds = $state<string[]>([]);
  let tagNames = $state<Record<string, string>>({});
  let file = $state<File | null>(null);
  let entries = $state<string[] | null>(null);
  let entry = $state("");
  let error = $state<string | null>(null);
  let sent = $state(0);
  let status = $state<SlideStatus | null>(null);
  let created = $state<{ id: string; version: number } | null>(null);
  let stop: (() => void) | undefined;

  $effect(() => {
    if (!slugTouched) slug = title.trim() ? slugify(title) : "";
  });
  // A finished upload shows its result until the sheet is reopened.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen && (phase === "done" || phase === "failed")) reset();
    wasOpen = open;
  });
  $effect(() => () => stop?.());

  const slugError = $derived(slug && (!SLUG_RE.test(slug) || slug.length > 80) ? t("slides.upload.slugInvalid") : null);
  const canSubmit = $derived(Boolean(file) && (isVersion || (title.trim() && slug && !slugError)) && (!entries || entry));

  async function loadTagNames() {
    if (tagIds.every(id => tagNames[id])) return;
    const { tags } = await api.get<{ tags: { id: string; name: string }[] }>("/slide-tags");
    tagNames = Object.fromEntries(tags.map(tag => [tag.id, tag.name]));
  }

  function reset() {
    phase = "form";
    title = slug = entry = "";
    slugTouched = publicView = false;
    tagIds = [];
    file = null;
    entries = null;
    error = null;
    status = null;
    created = null;
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
      form.append("tagIds", JSON.stringify(tagIds));
    }
    if (entries && entry) form.append("entry", entry);
    form.append("file", file, file.name);
    phase = "uploading";
    sent = 0;
    try {
      const path = isVersion ? `/slides/${projectId}/versions` : "/slides";
      const result = await uploadForm<{ id?: string; slug?: string; version: number }>(path, form, f => (sent = f));
      const id = result.id ?? projectId!;
      created = { id, version: result.version };
      void jobsStore.refresh();
      onUploaded?.({ id, slug: result.slug, version: result.version });
      phase = "rendering";
      stop?.();
      stop = watchStatus(id, s => {
        status = s;
        if (s.status === "published" || s.status === "failed") {
          phase = s.status === "published" ? "done" : "failed";
          void jobsStore.refresh();
          onRendered?.(s);
        }
      });
    } catch (e) {
      phase = "form";
      const message = e instanceof ApiError && e.status === 413 ? t("slides.upload.tooLarge", { size: formatBytes(limits.zipBytes) }) : (e as Error).message;
      const candidates = entryCandidates(message);
      if (candidates?.length) {
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
    }
  });

  const renderLabel = $derived(status?.stage ?? t("slides.status.queued"));
</script>

<Sheet
  bind:open
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
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t("slides.info.tags")}</span>
          <div class="flex flex-wrap items-center gap-1.5">
            {#each tagIds as id (id)}{#if tagNames[id]}<Pill tone={toneFor(tagNames[id])} size="sm">{tagNames[id]}</Pill>{/if}{/each}
            <TagPicker endpoint="/slide-tags" bind:selected={tagIds} label={t("slides.info.addTag")} onChange={() => void loadTagNames()} />
          </div>
        </div>
        <div class="flex items-center justify-between gap-4 rounded-2xl border border-line p-3.5">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("slides.upload.public")}</p>
            <p class="mt-0.5 text-[12.5px] text-ink-3">{t("slides.upload.publicHint")}</p>
          </div>
          <Switch bind:checked={publicView} label={t("slides.upload.public")} disabled={phase === "uploading"} />
        </div>
      {/if}

      <FileDrop bind:file accept=".zip" label={t("slides.upload.file")} hint={t("slides.upload.fileHint", { size: formatBytes(limits.zipBytes) })} maxBytes={limits.zipBytes} onError={m => (error = m)} />

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
      <Button type="submit" variant="primary" size="lg" class="mt-1 w-full" disabled={!canSubmit} loading={phase === "uploading"}>{t("slides.upload.submit")}</Button>
    </form>
  {:else}
    <div class="flex flex-col gap-5 pt-4">
      <div class="rounded-2xl border border-line bg-surface-2 p-4">
        <div class="flex items-center gap-3">
          {#if phase === "done"}
            <span class="grid size-10 place-items-center rounded-xl" style="background:var(--pill-mint);color:var(--pill-mint-ink)"><CircleCheck class="size-5" /></span>
          {:else if phase === "failed"}
            <span class="grid size-10 place-items-center rounded-xl" style="background:var(--pill-rose);color:var(--pill-rose-ink)"><CircleAlert class="size-5" /></span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">
              {phase === "done" ? t("slides.upload.done") : phase === "failed" ? t("slides.upload.failed") : t("slides.upload.rendering")}
              {#if created}<span class="ml-1 text-ink-3">{t("slides.version", { n: created.version })}</span>{/if}
            </p>
            {#if phase === "rendering"}<p class="mt-0.5 text-[12.5px] text-ink-3">{renderLabel} · {status?.progress ?? 0}%</p>{/if}
          </div>
        </div>
        {#if phase === "rendering"}<Progress class="mt-4" value={status?.progress || null} />{/if}
        {#if phase === "failed" && status?.error}
          <pre class="mt-3 max-h-48 overflow-auto rounded-xl bg-surface p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{stripAnsi(status.error)}</pre>
        {/if}
      </div>
      {#if phase === "rendering"}<p class="text-[12.5px] text-ink-3">{t("slides.upload.background")}</p>{/if}
      <div class="flex flex-col gap-2 sm:flex-row-reverse">
        {#if created && !isVersion}
          <Button variant="primary" href="/slides/{created.id}" onclick={() => (open = false)} class="sm:flex-1">{t("slides.upload.open")}</Button>
        {:else}
          <Button variant="primary" onclick={() => (open = false)} class="sm:flex-1">{t("slides.upload.close")}</Button>
        {/if}
        <Button variant="ghost" onclick={reset} class="sm:flex-1">{t("slides.upload.another")}</Button>
      </div>
    </div>
  {/if}
</Sheet>
