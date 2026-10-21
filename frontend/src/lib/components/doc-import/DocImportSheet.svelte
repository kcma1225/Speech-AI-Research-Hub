<script lang="ts">
  import { FileText, Sparkles, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import type { Suggestion } from "#lib/components/suggest/types.ts";
  import { DEFAULT_ACCEPT, ImportError, importDocument, importFormats, importIntoSummary, MAX_IMPORT_BYTES, type ImportedDocument, type ImportMode, type ImportPurpose } from "./api.ts";

  /**
   * 「從檔案匯入」: pick a document (PDF, Word, PowerPoint, OpenDocument, RTF, EPUB, HTML, Markdown, text,
   * spreadsheets — validated on the server with Magika), then either convert it to Markdown or let AI (role
   * `writing`) condense it. Targets:
   * - `{ kind: "summary", studyId }` → a `study_summary` suggestion (`onSuggestion`), placement append/replace;
   * - `{ kind: "draft", purpose }` → Markdown handed to `onMarkdown` (new-study form, note editor).
   */
  type Target = { kind: "summary"; studyId: string; hasText: boolean } | { kind: "draft"; purpose: ImportPurpose; studyId?: string };
  let {
    open = $bindable(false),
    target,
    onMarkdown,
    onSuggestion,
  }: {
    open?: boolean;
    target: Target;
    onMarkdown?: (markdown: string, doc: ImportedDocument) => void;
    onSuggestion?: (suggestion: Suggestion, doc: ImportedDocument) => void;
  } = $props();

  let file = $state<File | null>(null);
  let mode = $state<ImportMode>("markdown");
  let placement = $state<"append" | "replace">("append");
  let busy = $state(false);
  let error = $state<{ message: string; hint?: string } | null>(null);
  let accept = $state(DEFAULT_ACCEPT);
  let maxBytes = $state(MAX_IMPORT_BYTES);
  const purpose = $derived<ImportPurpose>(target.kind === "summary" ? "study_summary" : target.purpose);
  const aiOk = $derived(aiStatus.available("writing"));

  $effect(() => aiStatus.watch());
  $effect(() => {
    if (!open) return;
    file = null;
    error = null;
    busy = false;
    placement = target.kind === "summary" && target.hasText ? "append" : "replace";
    void importFormats().then(f => {
      accept = f.accept;
      maxBytes = f.maxBytes;
    });
  });
  $effect(() => {
    if (mode === "condense" && !aiOk) mode = "markdown";
  });

  async function submit() {
    if (!file || busy) return;
    busy = true;
    error = null;
    try {
      if (target.kind === "summary") {
        const r = await importIntoSummary(target.studyId, file, { mode, placement });
        onSuggestion?.(r.suggestion, r.document);
      } else {
        const r = await importDocument(file, { mode, purpose, studyId: target.studyId });
        onMarkdown?.(r.markdown, r.document);
      }
      open = false;
    } catch (e) {
      error = e instanceof ImportError ? { message: e.message, hint: e.hint } : { message: (e as Error).message };
    } finally {
      busy = false;
    }
  }

  const modeOptions = $derived([
    { value: "markdown" as const, label: t("docimport.mode.markdown"), icon: FileText },
    ...(aiOk ? [{ value: "condense" as const, label: purpose === "note" ? t("docimport.mode.condenseNote") : t("docimport.mode.condense"), icon: Sparkles }] : []),
  ]);
</script>

<Sheet bind:open title={t("docimport.title")} description={t("docimport.description", { formats: t("docimport.formatsHint") })} side="center">
  <div class="flex flex-col gap-4 pt-1" aria-busy={busy}>
    <FileDrop bind:file {accept} {maxBytes} label={t("docimport.pick")} hint={t("docimport.formatsHint")} onError={m => (error = { message: m })} />

    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("docimport.mode")}</span>
      <Segmented bind:value={mode} options={modeOptions} label={t("docimport.mode")} class="w-full [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-1.5 [&_button]:text-[12.5px]" />
      <p class="text-[12px] text-ink-3">{mode === "condense" ? t("docimport.mode.condenseHint") : t("docimport.mode.markdownHint")}</p>
      {#if !aiOk && aiStatus.loaded}<p class="text-[12px] text-ink-3">{t("docimport.aiUnavailable")}</p>{/if}
    </div>

    {#if target.kind === "summary" && target.hasText}
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("docimport.placement")}</span>
        <Segmented bind:value={placement} label={t("docimport.placement")} class="w-full [&_button]:text-[12.5px]" options={[{ value: "append", label: t("docimport.placement.append") }, { value: "replace", label: t("docimport.placement.replace") }]} />
      </div>
    {/if}

    {#if error}
      <div class="flex gap-2.5 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-3 text-[13px] text-danger" role="alert">
        <TriangleAlert class="mt-0.5 size-4 shrink-0" />
        <div><p class="font-medium">{error.message}</p>{#if error.hint}<p class="mt-0.5 text-[12.5px] opacity-90">{error.hint}</p>{/if}</div>
      </div>
    {/if}
    {#if busy && file}
      <p class="text-[13px] text-ink-2" role="status">{mode === "condense" ? t("docimport.workingAi", { name: file.name }) : t("docimport.working", { name: file.name })}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)} disabled={busy}>{t("action.cancel")}</Button>
    <Button variant="primary" loading={busy} disabled={!file} onclick={submit}>{t("docimport.submit")}</Button>
  {/snippet}
</Sheet>
