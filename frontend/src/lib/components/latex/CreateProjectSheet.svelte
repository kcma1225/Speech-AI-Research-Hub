<script lang="ts">
  import { goto } from "$app/navigation";
  import { CircleAlert, FileArchive, FileText, GraduationCap, Newspaper } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { LatexKind, LatexTemplate } from "#lib/latex/types.ts";

  /** 「新增論文」: a project from a template (中文碩士論文, IEEE conference, articles) or an imported ZIP. */
  let { open = $bindable(false), study, templates, onCreated }: {
    open?: boolean;
    study: { id: string; slug: string; title: string };
    templates: LatexTemplate[];
    onCreated?: () => void;
  } = $props();

  type Source = "template" | "import";
  let source = $state<Source>("template");
  let template = $state("zh-thesis");
  let title = $state("");
  let kind = $state<LatexKind>("thesis");
  let file = $state<File | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const tpl = templates.find(x => x.id === template);
    if (tpl) kind = tpl.kind;
  });
  $effect(() => {
    if (open) {
      error = null;
      busy = false;
    }
  });

  const iconFor = (id: string) => (id === "zh-thesis" ? GraduationCap : id === "ieee-conference" ? Newspaper : FileText);
  const canSubmit = $derived(source === "import" ? !!file : title.trim().length > 0);

  async function submit(event?: Event) {
    event?.preventDefault();
    if (!canSubmit || busy) return;
    busy = true;
    error = null;
    try {
      let url: string;
      if (source === "import") {
        const form = new FormData();
        if (title.trim()) form.set("title", title.trim());
        form.set("kind", kind);
        form.set("file", file!);
        const r = await api.post<{ url: string; files: number; skipped: string[] }>(`/studies/${study.slug}/latex/import`, form);
        toasts.show(t("latex.imported", { n: r.files }) + (r.skipped.length ? ` · ${t("latex.importSkipped", { n: r.skipped.length })}` : ""), "success");
        url = r.url;
      } else {
        url = (await api.post<{ url: string }>(`/studies/${study.slug}/latex`, { title: title.trim(), template, kind })).url;
      }
      open = false;
      onCreated?.();
      await goto(url);
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open side="right" title={t("latex.new")} description={t("latex.newHint", { study: study.title })}>
  <form class="flex flex-col gap-5 pt-2" onsubmit={submit}>
    <Segmented bind:value={source} label={t("latex.source")} class="w-full" options={[{ value: "template", label: t("latex.fromTemplate") }, { value: "import", label: t("latex.import") }]} />

    {#if source === "template"}
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1.5 text-[13px] font-medium text-ink-2">{t("latex.template")}</legend>
        {#each templates as option (option.id)}
          {@const Icon = iconFor(option.id)}
          <label
            class="flex min-h-[64px] cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-[border-color,background-color] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink/30 {template === option.id ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2'}"
          >
            <input type="radio" name="latex-template" value={option.id} bind:group={template} class="sr-only" />
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><Icon class="size-4.5" /></span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-x-2 text-sm font-medium text-ink">{i18n.locale === "en" ? option.name_en : option.name_zh}<span class="text-[11px] font-semibold text-ink-3 uppercase">{option.compiler}</span></span>
              <span class="mt-0.5 block text-[12.5px] leading-relaxed text-ink-3">{i18n.locale === "en" ? (option.description_en ?? option.description_zh) : option.description_zh}</span>
            </span>
            <span class="mt-1 grid size-5 shrink-0 place-items-center rounded-full border-2 {template === option.id ? 'border-ink' : 'border-line-2'}" aria-hidden="true">
              {#if template === option.id}<span class="size-2.5 rounded-full bg-ink"></span>{/if}
            </span>
          </label>
        {/each}
      </fieldset>
    {:else}
      <FileDrop bind:file accept=".zip,application/zip" label={t("latex.importDrop")} hint={t("latex.importHint")} maxBytes={300 * 1024 * 1024} onError={m => (error = m)} />
    {/if}

    <TextField label={source === "import" ? t("latex.titleOptional") : t("latex.titleLabel")} bind:value={title} maxlength={200} required={source === "template"} />
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("latex.kindLabel")}</span>
      <Segmented bind:value={kind} label={t("latex.kindLabel")} class="w-full" options={(["thesis", "paper", "other"] as const).map(k => ({ value: k, label: t(`latex.kind.${k}` as MessageKey) }))} />
    </div>

    {#if error}
      <p class="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger"><CircleAlert class="mt-0.5 size-4 shrink-0" />{error}</p>
    {/if}
    <Button type="submit" variant="primary" size="lg" class="mt-1 w-full" disabled={!canSubmit} loading={busy}>
      {#if source === "import"}<FileArchive />{t("latex.importSubmit")}{:else}{t("latex.create")}{/if}
    </Button>
  </form>
</Sheet>
