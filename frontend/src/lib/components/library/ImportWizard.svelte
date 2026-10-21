<script lang="ts">
  import { untrack } from "svelte";
  import { CircleCheck, FileUp, Library, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { requestRaw } from "#lib/library/api.ts";
  import { authorsShort, recordVenue } from "#lib/library/format.ts";
  import type { ConfirmResult, ImportBatch, ImportItem } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import WideSheet from "./WideSheet.svelte";

  /** File / Zotero import into a study: choose → preview (duplicates, actions) → confirm. */
  let { open = $bindable(false), study, onImported }: { open?: boolean; study: { id: string; title: string }; onImported?: () => void } = $props();

  type Step = "choose" | "preview" | "done";
  let step = $state<Step>("choose");
  let source = $state<"file" | "zotero">("file");
  let file = $state<File | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let batch = $state<ImportBatch | null>(null);
  let actions = $state<Record<number, ImportItem["action"]>>({});
  let fetchPdfs = $state(true);
  let filter = $state<"all" | "attention">("all");
  let limit = $state(100);
  let result = $state<{ result: ConfirmResult; pdfFetch: string | null } | null>(null);

  // Zotero
  type ZoteroState = { account: { username: string | null; key_last4: string } | null; lab: { library: { type: string; id: string; name?: string } } | null };
  let zotero = $state<ZoteroState | null>(null);
  let zSource = $state<"mine" | "lab" | "key">("key");
  let zKey = $state("");
  let zRemember = $state(true);
  let zLibraries = $state<{ type: "user" | "group"; id: string; name: string }[]>([]);
  let zCollections = $state<{ key: string; name: string }[]>([]);
  let zLibrary = $state("");
  let zCollection = $state("");

  function reset() {
    step = "choose";
    file = null;
    error = null;
    batch = null;
    actions = {};
    result = null;
    filter = "all";
    limit = 100;
    zLibraries = [];
    zCollections = [];
    zLibrary = zCollection = "";
  }
  $effect(() => {
    if (!open) {
      if (untrack(() => batch?.status === "preview" && step === "preview")) void api.del(`/library/imports/${untrack(() => batch!.id)}`).catch(() => {});
      reset();
    }
  });

  $effect(() => {
    if (open && source === "zotero" && !zotero) {
      api.get<ZoteroState>("/library/zotero").then(
        z => {
          zotero = z;
          zSource = z.account ? "mine" : z.lab ? "lab" : "key";
        },
        () => (zotero = { account: null, lab: null }),
      );
    }
  });

  const libRef = $derived.by(() => {
    const l = zLibraries.find(x => `${x.type}:${x.id}` === zLibrary);
    return l ? { type: l.type, id: l.id } : undefined;
  });

  async function browse() {
    busy = true;
    error = null;
    const r = await requestRaw<{ libraries: typeof zLibraries; collections: typeof zCollections }>("POST", "/library/zotero/browse", {
      source: zSource,
      ...(zSource === "key" ? { apiKey: zKey.trim() } : {}),
      ...(libRef ? { library: libRef } : {}),
    });
    busy = false;
    if (!r.ok) {
      error = r.data.error ?? t("common.error");
      return;
    }
    zLibraries = r.data.libraries;
    zCollections = r.data.collections;
    if (!zLibraries.some(l => `${l.type}:${l.id}` === zLibrary)) zLibrary = zLibraries[0] ? `${zLibraries[0].type}:${zLibraries[0].id}` : "";
    zCollection = "";
  }
  $effect(() => {
    if (open && source === "zotero" && zotero && zSource !== "key" && !zLibraries.length && !busy) untrack(() => void browse());
  });

  function adopt(b: ImportBatch) {
    batch = b;
    actions = Object.fromEntries(b.items.map(i => [i.index, i.action]));
    step = "preview";
  }

  async function readFile() {
    if (!file) return;
    busy = true;
    error = null;
    const form = new FormData();
    form.append("file", file, file.name);
    const r = await requestRaw<{ batch: ImportBatch }>("POST", `/studies/${study.id}/imports`, form);
    busy = false;
    if (r.ok) adopt(r.data.batch);
    else error = r.data.error ?? t("common.error");
  }

  async function readZotero() {
    busy = true;
    error = null;
    const r = await requestRaw<{ batch: ImportBatch }>("POST", `/studies/${study.id}/imports/zotero`, {
      source: zSource,
      ...(zSource === "key" ? { apiKey: zKey.trim(), remember: zRemember } : {}),
      ...(libRef ? { library: libRef } : {}),
      ...(zCollection ? { collectionKey: zCollection } : {}),
    });
    busy = false;
    if (r.ok) adopt(r.data.batch);
    else error = r.data.error ?? t("common.error");
  }

  async function confirm() {
    if (!batch) return;
    busy = true;
    error = null;
    const decisions = batch.items.map(i => ({ index: i.index, action: actions[i.index] ?? i.action }));
    const r = await requestRaw<{ result: ConfirmResult; pdfFetch: string | null }>("POST", `/library/imports/${batch.id}/confirm`, { decisions, fetchPdfs });
    busy = false;
    if (!r.ok) {
      error = r.data.error ?? t("common.error");
      return;
    }
    result = r.data;
    step = "done";
    batch = { ...batch, status: "done" };
    onImported?.();
  }

  async function disconnect() {
    await api.del("/library/zotero").catch(e => toasts.show((e as Error).message, "error"));
    zotero = { account: null, lab: zotero?.lab ?? null };
    zSource = zotero.lab ? "lab" : "key";
    zLibraries = [];
  }

  const inLab = $derived((batch?.items ?? []).filter(i => !i.inStudy && (i.match?.level === "same" || i.match?.level === "likely")).length);
  const needsLook = (i: ImportItem) => Boolean(i.match || i.duplicateOf !== null || i.inStudy);
  const visible = $derived((batch?.items ?? []).filter(i => filter === "all" || needsLook(i)));
  const importCount = $derived((batch?.items ?? []).filter(i => (actions[i.index] ?? i.action) !== "skip").length);
  const levelTone = { same: "mint", likely: "butter", possible: "peach" } as const;
  const actionOptions = (i: ImportItem) => [
    { value: "add" as const, label: t("library.import.action.add") },
    ...(i.match && !i.inStudy ? [{ value: "link" as const, label: t("library.import.action.link") }] : []),
    { value: "skip" as const, label: t("library.import.action.skip") },
  ];
</script>

<WideSheet
  bind:open
  title={t("library.import.title")}
  description={step === "preview" && batch ? t("library.import.previewSubtitle", { file: batch.file_name ?? batch.format, n: batch.items.length }) : study.title}
>
  {#snippet children()}
    {#if step === "choose"}
      <div class="flex flex-col gap-4 pt-1">
        <Segmented
          bind:value={source}
          label={t("library.import.title")}
          options={[{ value: "file", label: t("library.import.fileTab"), icon: FileUp }, { value: "zotero", label: t("library.import.zoteroTab"), icon: Library }]}
        />
        {#if source === "file"}
          <FileDrop bind:file accept=".bib,.bibtex,.biblatex,.ris,.xml,.json,.rdf,.txt,.enl,.enlx" label={t("library.import.fileLabel")} hint={t("library.import.fileHint")} maxBytes={20 * 1024 * 1024} onError={m => (error = m)} />
          <p class="text-[12.5px] text-ink-3">{t("library.import.enlHint")}</p>
        {:else if !zotero}
          <p class="text-[13px] text-ink-3">…</p>
        {:else}
          <div class="flex flex-col gap-3.5">
            {#if zotero.account || zotero.lab}
              <div class="flex flex-col gap-1.5">
                <span class="text-[13px] font-medium text-ink-2">{t("library.import.zotero.source")}</span>
                <Segmented
                  bind:value={zSource}
                  label={t("library.import.zotero.source")}
                  onValueChange={() => ((zLibraries = []), (zCollections = []), (zLibrary = ""))}
                  options={[
                    ...(zotero.account ? [{ value: "mine" as const, label: t("library.import.zotero.mine") }] : []),
                    ...(zotero.lab ? [{ value: "lab" as const, label: t("library.import.zotero.lab") }] : []),
                    { value: "key" as const, label: t("library.import.zotero.key") },
                  ]}
                />
              </div>
            {/if}
            {#if zSource === "mine" && zotero.account}
              <div class="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-surface-2/70 p-3 text-[13px] text-ink-2">
                <span>{t("library.import.zotero.saved", { name: zotero.account.username ?? `…${zotero.account.key_last4}` })}</span>
                <Button size="sm" variant="ghost" onclick={disconnect}>{t("library.import.zotero.disconnect")}</Button>
              </div>
            {/if}
            {#if zSource === "key"}
              <TextField bind:value={zKey} label={t("library.import.zotero.key")} hint={t("library.import.zotero.keyHint")} type="password" autocomplete="off" />
              <label class="flex min-h-10 items-center gap-2.5 text-[13px] text-ink-2"><Switch bind:checked={zRemember} label={t("library.import.zotero.remember")} />{t("library.import.zotero.remember")}</label>
              <div><Button loading={busy && !zLibraries.length} disabled={zKey.trim().length < 10} onclick={browse}>{t("library.import.zotero.connect")}</Button></div>
            {/if}
            {#if zLibraries.length}
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <span class="text-[13px] font-medium text-ink-2">{t("library.import.zotero.library")}</span>
                  <Select bind:value={zLibrary} label={t("library.import.zotero.library")} options={zLibraries.map(l => ({ value: `${l.type}:${l.id}`, label: l.name }))} onValueChange={() => void browse()} class="w-full" />
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[13px] font-medium text-ink-2">{t("library.import.zotero.collection")}</span>
                  <Select bind:value={zCollection} label={t("library.import.zotero.collection")} options={[{ value: "", label: t("library.import.zotero.allItems") }, ...zCollections.map(c => ({ value: c.key, label: c.name }))]} class="w-full" />
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {:else if step === "preview" && batch}
      <div class="flex flex-col gap-3 pt-1">
        <div class="flex flex-wrap gap-1.5">
          <Pill tone="sky">{t("library.import.summary.new", { n: batch.summary.new })}</Pill>
          {#if inLab}<Pill tone="mint">{t("library.import.summary.same", { n: inLab })}</Pill>{/if}
          {#if batch.summary.possible}<Pill tone="peach">{t("library.import.summary.possible", { n: batch.summary.possible })}</Pill>{/if}
          {#if batch.summary.inStudy}<Pill tone="stone">{t("library.import.summary.inStudy", { n: batch.summary.inStudy })}</Pill>{/if}
          {#if batch.summary.inFile}<Pill tone="stone">{t("library.import.summary.inFile", { n: batch.summary.inFile })}</Pill>{/if}
        </div>
        {#if batch.warnings.length}
          <details class="rounded-2xl bg-surface-2/70 px-3.5 py-2.5 text-[12.5px] text-ink-2">
            <summary class="flex min-h-8 cursor-pointer items-center gap-2 font-medium"><TriangleAlert class="size-4 text-ink-3" />{t("library.import.warnings", { n: batch.warnings.length })}</summary>
            <ul class="mt-1.5 flex flex-col gap-1 pl-6">{#each batch.warnings.slice(0, 50) as w, i (i)}<li>{w.index >= 0 ? `#${w.index + 1}${w.key ? ` (${w.key})` : ""}: ` : ""}{w.message}</li>{/each}</ul>
          </details>
        {/if}
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Segmented bind:value={filter} label={t("library.import.action")} options={[{ value: "all", label: t("library.import.filter.all") }, { value: "attention", label: t("library.import.filter.attention") }]} />
          <span class="text-[12px] text-ink-3">{t("library.import.showing", { n: Math.min(limit, visible.length), total: visible.length })}</span>
        </div>
        <ul class="flex flex-col divide-y divide-line rounded-2xl border border-line">
          {#each visible.slice(0, limit) as item (item.index)}
            {@const action = actions[item.index] ?? item.action}
            <li class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4 sm:p-3.5 {action === 'skip' ? 'opacity-60' : ''}">
              <div class="min-w-0 flex-1">
                <p class="text-[14px] leading-snug font-medium break-words text-ink">{item.record.title}</p>
                <p class="mt-0.5 text-[12.5px] break-words text-ink-3">{authorsShort(item.record.authors)}{recordVenue(item.record) ? ` · ${recordVenue(item.record)}` : ""}</p>
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {#if item.citeKey}<code class="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{item.citeKey}</code>{/if}
                  {#if item.inStudy}<Pill tone="stone" size="sm">{t("library.import.inStudy")}</Pill>
                  {:else if item.match}<Pill tone={levelTone[item.match.level]} size="sm">{t(`library.match.${item.match.level}` as MessageKey)}</Pill>{/if}
                  {#if item.duplicateOf !== null}<Pill tone="stone" size="sm">{t("library.import.dupInFile", { n: item.duplicateOf + 1 })}</Pill>{/if}
                </div>
                {#if item.match && item.match.level !== "same"}<p class="mt-1 text-[12px] break-words text-ink-3">{t("library.import.matchWith", { title: item.match.paper.title })}</p>{/if}
              </div>
              <Select value={action} label={t("library.import.action")} options={actionOptions(item)} onValueChange={v => (actions[item.index] = v)} class="w-full min-w-0 sm:w-36" />
            </li>
          {/each}
        </ul>
        {#if visible.length > limit}<div class="flex justify-center"><Button variant="ghost" onclick={() => (limit += 200)}>{t("library.loadMore")}</Button></div>{/if}
        <label class="flex items-start gap-3 rounded-2xl bg-surface-2/70 p-3.5">
          <Switch bind:checked={fetchPdfs} label={t("library.import.fetchPdfs")} />
          <span class="flex flex-col"><span class="text-[13.5px] font-medium text-ink">{t("library.import.fetchPdfs")}</span><span class="text-[12px] text-ink-3">{t("library.import.fetchPdfsHint")}</span></span>
        </label>
      </div>
    {:else if step === "done" && result}
      <div class="flex flex-col items-center gap-3 py-10 text-center">
        <span class="grid size-12 place-items-center rounded-2xl bg-surface-2 text-success"><CircleCheck class="size-6" /></span>
        <p class="text-[15px] font-semibold text-ink">{t("library.import.done", { added: result.result.added, linked: result.result.linked, skipped: result.result.skipped })}</p>
        {#if result.pdfFetch === "queued"}<p class="max-w-sm text-[13px] text-ink-3">{t("library.import.pdfQueued")}</p>{/if}
      </div>
    {/if}
    {#if error}<p class="mt-3 text-[13px] text-danger" role="alert">{error}</p>{/if}
  {/snippet}
  {#snippet footer()}
    {#if step === "choose"}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      {#if source === "file"}
        <Button variant="primary" loading={busy} disabled={!file} onclick={readFile}>{busy ? t("library.import.parsing") : t("library.import.parse")}</Button>
      {:else}
        <Button variant="primary" loading={busy && zLibraries.length > 0} disabled={!zLibraries.length} onclick={readZotero}>{t("library.import.zotero.read")}</Button>
      {/if}
    {:else if step === "preview"}
      <Button
        variant="ghost"
        class="mr-auto"
        onclick={() => {
          if (batch) void api.del(`/library/imports/${batch.id}`).catch(() => {});
          batch = null;
          file = null;
          step = "choose";
        }}>{t("library.import.back")}</Button
      >
      <Button variant="primary" loading={busy} disabled={!importCount} onclick={confirm}>{t("library.import.confirm", { n: importCount })}</Button>
    {:else}
      <Button variant="primary" onclick={() => (open = false)}>{t("common.close")}</Button>
    {/if}
  {/snippet}
</WideSheet>
