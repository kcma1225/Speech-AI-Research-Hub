<script lang="ts">
  import { FileText, Hash, PenLine, Search } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { requestRaw } from "#lib/library/api.ts";
  import { draftOf, emptyDraft, recordOf } from "#lib/library/draft.ts";
  import { authorsShort, recordVenue, venueLine } from "#lib/library/format.ts";
  import type { ConfirmResult, DuplicateResponse, ImportBatch, MatchLevel, PaperDetail, PaperRecord, PaperSummary } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import PaperForm, { type PaperDraft } from "./PaperForm.svelte";

  /** Add one paper: by identifier, from a PDF, or by hand. With `study`, it also goes into that study's library. */
  let { open = $bindable(false), study = null, onAdded }: {
    open?: boolean;
    study?: { id: string; slug: string; title: string } | null;
    onAdded?: (paperId: string) => void;
  } = $props();

  type Mode = "id" | "pdf" | "manual";
  let mode = $state<Mode>("id");
  let busy = $state(false);
  let error = $state<string | null>(null);

  // identifier
  let identifier = $state("");
  type Resolved = { record: PaperRecord; sources: string[]; matches: { level: MatchLevel; paper: PaperSummary }[] };
  let found = $state<Resolved | null>(null);

  // pdf
  let pdf = $state<File | null>(null);
  let batch = $state<ImportBatch | null>(null);
  let method = $state<string | null>(null);

  // manual / pdf form
  let draft = $state<PaperDraft>(emptyDraft());
  let errors = $state<Partial<Record<keyof PaperDraft, string>>>({});

  // duplicate prompt (manual / identifier)
  let dup = $state<DuplicateResponse | null>(null);
  let pending = $state<Record<string, unknown> | null>(null);

  function reset() {
    identifier = "";
    found = null;
    pdf = null;
    batch = null;
    method = null;
    draft = emptyDraft();
    errors = {};
    dup = null;
    pending = null;
    error = null;
  }
  $effect(() => {
    if (!open) reset();
  });

  const levelTone = (l: MatchLevel) => (l === "same" ? "mint" : l === "likely" ? "butter" : "peach");

  async function lookup() {
    if (!identifier.trim()) return;
    busy = true;
    error = null;
    found = null;
    const r = await requestRaw<Resolved>("POST", "/library/resolve", { identifier: identifier.trim() });
    busy = false;
    if (r.ok) found = r.data;
    else error = r.data.error ?? t("common.error");
  }

  async function submit(body: Record<string, unknown>) {
    busy = true;
    error = null;
    const r = await requestRaw<{ paper: PaperDetail; created: boolean }>("POST", "/library/papers", { ...body, ...(study ? { study: study.id } : {}) });
    busy = false;
    if (r.ok) {
      toasts.show(r.data.created ? t("library.addSheet.done") : t("library.addSheet.linked"), "success");
      onAdded?.(r.data.paper.id);
      open = false;
    } else if (r.status === 409 && r.data.code === "duplicate") {
      dup = r.data as unknown as DuplicateResponse;
      pending = body;
    } else error = r.data.error ?? t("common.error");
  }

  async function uploadPdf(file: File) {
    busy = true;
    error = null;
    const form = new FormData();
    if (study) form.append("study", study.id);
    form.append("file", file, file.name);
    const r = await requestRaw<{ batch: ImportBatch; extraction: { method: string } }>("POST", "/library/pdf", form);
    busy = false;
    if (!r.ok) {
      error = r.data.error ?? t("common.error");
      pdf = null;
      return;
    }
    batch = r.data.batch;
    method = r.data.extraction.method;
    draft = draftOf(r.data.batch.items[0]!.record);
  }
  $effect(() => {
    if (pdf && !batch && !busy) void uploadPdf(pdf);
  });

  async function confirmPdf(action: "add" | "link") {
    if (!batch) return;
    const item = batch.items[0]!;
    const r0 = recordOf(draft, item.record);
    errors = r0.errors;
    if (!r0.record) return;
    busy = true;
    const r = await requestRaw<{ result: ConfirmResult }>("POST", `/library/imports/${batch.id}/confirm`, {
      decisions: [{ index: 0, action, record: r0.record, ...(action === "link" && item.match ? { paperId: item.match.paper.id } : {}) }],
    });
    busy = false;
    if (!r.ok) {
      error = r.data.error ?? t("common.error");
      return;
    }
    const added = r.data.result.papers[0];
    toasts.show(action === "link" ? t("library.addSheet.linked") : t("library.addSheet.done"), "success");
    if (added) onAdded?.(added.paperId);
    open = false;
  }

  function submitManual() {
    const r = recordOf(draft);
    errors = r.errors;
    if (r.record) void submit({ record: r.record });
  }

  const pdfMatch = $derived(batch?.items[0]?.match ?? null);
</script>

<Sheet bind:open title={study ? t("library.addSheet.toStudy", { study: study.title }) : t("library.addSheet.title")} side="right">
  {#snippet children()}
    <div class="flex flex-col gap-4 pt-1">
      {#if !dup}
        <Segmented
          bind:value={mode}
          guardIgnore
          label={t("library.addSheet.title")}
          class="w-full"
          options={[
            { value: "id", label: t("library.addSheet.tab.id"), icon: Hash },
            { value: "pdf", label: t("library.addSheet.tab.pdf"), icon: FileText },
            { value: "manual", label: t("library.addSheet.tab.manual"), icon: PenLine },
          ]}
        />
      {/if}

      {#if dup}
        <div class="flex flex-col gap-3">
          <div>
            <p class="text-sm font-semibold text-ink">{t("library.dup.title")}</p>
            <p class="mt-1 text-[13px] text-ink-3">{t("library.dup.hint")}</p>
          </div>
          {#each dup.duplicates as d (d.paper.id)}
            <div class="flex flex-col gap-2 rounded-2xl border border-line p-3.5">
              <Pill tone={levelTone(d.level)} size="sm">{t(`library.match.${d.level}` as MessageKey)}</Pill>
              <p class="text-sm font-medium break-words text-ink">{d.paper.title}</p>
              <p class="text-[12.5px] text-ink-3">{authorsShort(d.paper.authors)}{venueLine(d.paper) ? ` · ${venueLine(d.paper)}` : ""}</p>
              <div><Button size="sm" variant="primary" loading={busy} onclick={() => submit({ ...pending, onDuplicate: "link", paperId: d.paper.id })}>{t("library.dup.useExisting")}</Button></div>
            </div>
          {/each}
          <div class="flex justify-end"><Button variant="ghost" loading={busy} onclick={() => submit({ ...pending, onDuplicate: "add" })}>{t("library.dup.addAnyway")}</Button></div>
        </div>
      {:else if mode === "id"}
        <form
          class="flex flex-col gap-2"
          onsubmit={e => {
            e.preventDefault();
            void lookup();
          }}
        >
          <TextField bind:value={identifier} label={t("library.addSheet.identifier")} hint={t("library.addSheet.identifierHint")} autocomplete="off" spellcheck={false} />
          <div><Button type="submit" loading={busy && !found} disabled={!identifier.trim()}><Search />{t("library.addSheet.lookup")}</Button></div>
        </form>
        {#if found}
          <div class="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/60 p-4">
            <span class="text-[12px] font-medium text-ink-3">{t("library.addSheet.found")} · {t("library.addSheet.sources", { sources: found.sources.join(", ") })}</span>
            <p class="text-[15px] font-semibold break-words text-ink">{found.record.title}</p>
            <p class="text-[13px] text-ink-2">{authorsShort(found.record.authors, 6)}</p>
            {#if recordVenue(found.record)}<p class="text-[12.5px] text-ink-3">{recordVenue(found.record)}</p>{/if}
            {#if found.matches.some(m => m.level === "same")}<p class="text-[12.5px] text-ink-2">{t("library.addSheet.alreadyInLab")}</p>{/if}
            <div class="pt-1"><Button variant="primary" loading={busy} onclick={() => submit({ identifier: identifier.trim() })}>{study ? t("library.addSheet.add") : t("library.addSheet.addToLab")}</Button></div>
          </div>
        {/if}
      {:else if mode === "pdf"}
        {#if !batch}
          <FileDrop bind:file={pdf} accept=".pdf,application/pdf" label={t("library.addSheet.pdfLabel")} hint={t("library.addSheet.pdfHint")} maxBytes={50 * 1024 * 1024} onError={m => (error = m)} />
          {#if busy}<p class="flex items-center gap-2 text-[13px] text-ink-3"><Spinner />{t("library.addSheet.extracting")}</p>{/if}
        {:else}
          <div class="rounded-2xl bg-surface-2/70 p-3 text-[12.5px] text-ink-2">
            {t(`library.addSheet.method.${method ?? "none"}` as MessageKey)}
            {#each batch.warnings as w, i (i)}<p class="mt-1 text-ink-3">{w.message}</p>{/each}
          </div>
          {#if pdfMatch}
            <div class="flex flex-col gap-2 rounded-2xl border border-line p-3.5">
              <Pill tone={levelTone(pdfMatch.level)} size="sm">{t(`library.match.${pdfMatch.level}` as MessageKey)}</Pill>
              <p class="text-sm font-medium break-words text-ink">{pdfMatch.paper.title}</p>
              <p class="text-[12.5px] text-ink-3">{authorsShort(pdfMatch.paper.authors)}{venueLine(pdfMatch.paper) ? ` · ${venueLine(pdfMatch.paper)}` : ""}</p>
              <div><Button size="sm" variant="primary" loading={busy} onclick={() => confirmPdf("link")}>{t("library.dup.useExisting")}</Button></div>
            </div>
          {/if}
          <PaperForm bind:draft {errors} />
        {/if}
      {:else}
        <PaperForm bind:draft {errors} />
      {/if}
      {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}
    </div>
  {/snippet}
  {#snippet footer()}
    {#if dup}
      <Button variant="ghost" onclick={() => ((dup = null), (pending = null))}>{t("action.cancel")}</Button>
    {:else if mode === "manual"}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      <Button variant="primary" loading={busy} onclick={submitManual}>{study ? t("library.addSheet.add") : t("library.addSheet.addToLab")}</Button>
    {:else if mode === "pdf" && batch}
      <Button variant="ghost" onclick={() => ((batch = null), (pdf = null))}>{t("library.import.back")}</Button>
      <Button variant={pdfMatch ? "secondary" : "primary"} loading={busy} onclick={() => confirmPdf("add")}>{pdfMatch ? t("library.dup.addAnyway") : study ? t("library.addSheet.add") : t("library.addSheet.addToLab")}</Button>
    {:else}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    {/if}
  {/snippet}
</Sheet>
