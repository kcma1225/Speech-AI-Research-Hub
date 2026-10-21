<script lang="ts">
  import { onDestroy } from "svelte";
  import { Camera, EyeOff, RefreshCw, ScanEye } from "@lucide/svelte";
  import { aiApi, toErrorBody, type AiErrorBody } from "#lib/ai/admin.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import AiErrorPanel from "#lib/components/ai/AiErrorPanel.svelte";
  import ReviewResults, { type LayoutReview, type ReviewIssue } from "./ReviewResults.svelte";

  /**
   * 「AI 檢查排版與設計」 (role `slides` with vision). Sources: the editor's current source (`hasSource`: screenshots
   * captured by a preview job) and/or a rendered version (`version`: its page images). Without vision the button is
   * replaced by a short hint. Fixes become `deck_source` suggestions (`onSuggested` lets the editor reload them).
   */
  let {
    deckId,
    hasSource = false,
    version = null,
    size = "md",
    onOpenFile,
    onSuggested,
    onPage,
  }: {
    deckId: string;
    hasSource?: boolean;
    version?: { id: string; version: number; pageCount: number | null; thumb?: (n: number) => string | null } | null;
    size?: "sm" | "md";
    onOpenFile?: (ref: { fileId: string | null; path: string; line: number | null }) => void;
    onSuggested?: (fileId: string) => void;
    onPage?: (page: number) => void;
  } = $props();

  type Capture = { state: "none" | "capturing" | "ready" | "failed"; preview_id: string | null; revision: number | null; current_revision: number | null; count: number; total: number | null; truncated: boolean; error: string | null; progress: number | null };

  $effect(() => aiStatus.watch());
  const vision = $derived(aiStatus.vision("slides"));
  const canVersion = $derived(Boolean(version?.pageCount));
  const usable = $derived(hasSource || canVersion);

  let open = $state(false);
  // svelte-ignore state_referenced_locally
  let source = $state<"preview" | "version">(hasSource ? "preview" : "version");
  let capture = $state<Capture | null>(null);
  let review = $state<LayoutReview | null>(null);
  let error = $state<AiErrorBody | null>(null);
  let running = $state(false);
  let capturing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  const pageCount = $derived(source === "preview" ? (capture?.count ?? 0) : Math.min(version?.pageCount ?? 0, 20));

  async function loadCapture() {
    try {
      capture = (await aiApi.get<{ capture: Capture }>(`/slides/${deckId}/ai/layout-review/capture`)).capture;
      clearTimeout(timer);
      if (capture.state === "capturing" && open) timer = setTimeout(loadCapture, 2000);
    } catch (e) {
      error = toErrorBody(e);
    }
  }

  async function startCapture() {
    capturing = true;
    error = null;
    try {
      capture = (await aiApi.post<{ capture: Capture }>(`/slides/${deckId}/ai/layout-review/capture`)).capture;
      if (capture.state === "capturing") timer = setTimeout(loadCapture, 2000);
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      capturing = false;
    }
  }

  function show() {
    open = true;
    error = null;
    if (hasSource) void loadCapture();
  }

  async function run() {
    running = true;
    error = null;
    try {
      const body = source === "preview" ? { source } : { source, versionId: version!.id };
      review = (await aiApi.post<{ review: LayoutReview }>(`/slides/${deckId}/ai/layout-review`, body)).review;
    } catch (e) {
      error = toErrorBody(e);
      if (error.code === "capture_required") void loadCapture();
    } finally {
      running = false;
    }
  }

  async function suggest(issue: ReviewIssue) {
    if (!issue.fix) return;
    try {
      await aiApi.post(`/slides/${deckId}/ai/layout-review/suggest`, { file_id: issue.fix.file_id, find: issue.fix.find, replace: issue.fix.replace, title: issue.title });
      toasts.show(t("vision.suggested"), "success");
      onSuggested?.(issue.fix.file_id);
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
      throw e;
    }
  }

  const thumb = (n: number) =>
    source === "preview" ? (capture?.state === "ready" && n <= capture.count ? `/api/slides/${deckId}/ai/layout-review/shots/${n}?p=${capture.preview_id}` : null) : (version?.thumb?.(n) ?? null);
  const fileIssue = (issue: ReviewIssue) => {
    if (!issue.path) return;
    open = false;
    onOpenFile?.({ fileId: issue.fix?.file_id ?? null, path: issue.path, line: issue.line });
  };
</script>

{#if usable}
  {#if vision}
    <Button variant="secondary" {size} onclick={show}><ScanEye />{t("vision.slides.button")}</Button>
  {:else if aiStatus.available("slides")}
    <span class="inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border border-dashed border-line-2 px-3 text-[12.5px] text-ink-3" title={t("vision.unsupported")}>
      <EyeOff class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{t("vision.unsupported")}</span>
    </span>
  {/if}
{/if}

<Sheet bind:open guard={false} title={t("vision.slides.title")} description={t("vision.slides.desc")} side="right">
  <div class="flex flex-col gap-4">
    {#if hasSource && canVersion}
      <Segmented
        bind:value={source}
        label={t("vision.source")}
        options={[{ value: "preview", label: t("vision.source.preview") }, { value: "version", label: t("vision.source.version", { n: version!.version }) }]}
        onValueChange={() => ((review = null), (error = null))}
      />
    {/if}

    {#if source === "preview"}
      <div class="rounded-2xl border border-line p-3.5 text-[13px] text-ink-2">
        {#if !capture}
          <p class="flex items-center gap-2 text-ink-3"><Spinner class="size-4" />{t("common.loading")}</p>
        {:else if capture.state === "capturing"}
          <p class="flex items-center gap-2" aria-live="polite"><Spinner class="size-4" />{t("vision.capturing")}</p>
        {:else}
          {#if capture.state === "ready"}
            <p>{t("vision.captureReady", { n: capture.count, rev: capture.revision ?? "?" })}</p>
            {#if capture.truncated}<p class="mt-1 text-ink-3">{t("vision.captureTruncated", { total: capture.total ?? "?", n: capture.count })}</p>{/if}
            {#if capture.revision !== capture.current_revision}<p class="mt-1 text-ink-3">{t("vision.captureStale")}</p>{/if}
          {:else if capture.state === "failed"}
            <p class="text-danger">{capture.error}</p>
          {:else}
            <p class="text-ink-3">{t("vision.captureNone")}</p>
          {/if}
          <Button class="mt-3" size="sm" variant={capture.state === "ready" ? "ghost" : "secondary"} loading={capturing} disabled={running} onclick={startCapture}>
            {#if capture.state === "ready"}<RefreshCw />{t("vision.recapture")}{:else}<Camera />{t("vision.capture")}{/if}
          </Button>
        {/if}
      </div>
    {/if}

    {#if error}<AiErrorPanel {error} compact />{/if}

    <Button variant="primary" size="lg" class="w-full" loading={running} disabled={!pageCount || capture?.state === "capturing" && source === "preview"} onclick={run}>
      <ScanEye />{review ? t("vision.rerun") : t("vision.run")}
    </Button>
    {#if running}<p class="text-center text-[12.5px] text-ink-3" aria-live="polite">{t("vision.running", { n: pageCount })}</p>{/if}

    {#if review && !running}
      <ReviewResults {review} onSuggest={suggest} onGoto={onOpenFile ? fileIssue : undefined} {thumb} onPage={onPage ? (n) => ((open = false), onPage?.(n)) : undefined} />
    {/if}
  </div>
</Sheet>
