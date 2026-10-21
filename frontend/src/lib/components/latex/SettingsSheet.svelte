<script lang="ts">
  import { goto } from "$app/navigation";
  import { RefreshCw, Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { LatexCompiler, LatexKind, ProjectDetail } from "#lib/latex/types.ts";

  /** 專案設定: title, kind, compiler, root file, bibliography mode (auto from the study library | manual), stop at first error. */
  let { open = $bindable(false), detail, onSaved }: { open?: boolean; detail: ProjectDetail; onSaved: () => Promise<void> } = $props();

  let title = $state("");
  let kind = $state<LatexKind>("paper");
  let compiler = $state<LatexCompiler>("xelatex");
  let bibMode = $state<"auto" | "manual">("auto");
  let rootFile = $state("main.tex");
  let halt = $state(false);
  let saving = $state(false);
  let refreshing = $state(false);
  let deleting = $state(false);

  $effect(() => {
    if (!open) return;
    const p = detail.project;
    title = p.title;
    kind = p.kind;
    compiler = p.compiler;
    bibMode = p.bib_mode;
    rootFile = p.root_file;
    halt = !!p.settings.haltOnError;
  });

  const texFiles = $derived(detail.files.filter(f => f.kind === "text" && /\.(tex|ltx)$/i.test(f.path)).map(f => ({ value: f.path, label: f.path })));

  async function save(event?: Event) {
    event?.preventDefault();
    saving = true;
    try {
      const p = detail.project;
      const patch: Record<string, unknown> = {};
      if (title.trim() && title.trim() !== p.title) patch.title = title.trim();
      if (kind !== p.kind) patch.kind = kind;
      if (compiler !== p.compiler) patch.compiler = compiler;
      if (bibMode !== p.bib_mode) patch.bib_mode = bibMode;
      if (rootFile !== p.root_file) patch.root_file = rootFile;
      if (halt !== !!p.settings.haltOnError) patch.halt_on_error = halt;
      if (Object.keys(patch).length) await api.patch(`/latex/${p.id}`, patch);
      await onSaved();
      toasts.show(t("latex.settings.saved"), "success");
      open = false;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
  async function refreshBib() {
    refreshing = true;
    try {
      const r = await api.post<{ changed: boolean; count: number }>(`/latex/${detail.project.id}/bib/refresh`);
      toasts.show(r.count ? t("latex.settings.bibRefreshed", { n: r.count }) : t("latex.settings.bibEmpty"), r.count ? "success" : "default");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      refreshing = false;
    }
  }
  async function remove() {
    await api.del(`/latex/${detail.project.id}`);
    open = false;
    await goto(`/studies/${detail.study.slug}?tab=latex`);
  }
</script>

<Sheet bind:open side="right" title={t("latex.settings")}>
  <form class="flex flex-col gap-5 pt-1" onsubmit={save}>
    <TextField label={t("latex.titleLabel")} bind:value={title} maxlength={200} required />
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("latex.kindLabel")}</span>
      <Segmented bind:value={kind} label={t("latex.kindLabel")} class="w-full" options={(["thesis", "paper", "other"] as const).map(k => ({ value: k, label: t(`latex.kind.${k}` as MessageKey) }))} />
    </div>
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("latex.compiler")}</span>
      <Select bind:value={compiler} label={t("latex.compiler")} class="w-full" options={[
        { value: "xelatex", label: "XeLaTeX", hint: t("latex.compiler.xelatex") },
        { value: "pdflatex", label: "pdfLaTeX", hint: t("latex.compiler.pdflatex") },
        { value: "lualatex", label: "LuaLaTeX", hint: t("latex.compiler.lualatex") },
      ]} />
    </div>
    {#if texFiles.length}
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("latex.settings.root")}</span>
        <Select bind:value={rootFile} label={t("latex.settings.root")} class="w-full" options={texFiles} />
      </div>
    {/if}
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("latex.settings.bib")}</span>
      <Segmented bind:value={bibMode} label={t("latex.settings.bib")} class="w-full" options={[{ value: "auto", label: t("latex.settings.bibAuto") }, { value: "manual", label: t("latex.settings.bibManual") }]} />
      <p class="text-[12.5px] leading-relaxed text-ink-3">{bibMode === "auto" ? t("latex.settings.bibAutoHint", { file: detail.project.bib_file }) : t("latex.settings.bibManualHint")}</p>
      {#if detail.project.bib_mode === "auto" && detail.permissions.edit}
        <Button variant="ghost" size="sm" class="self-start" loading={refreshing} onclick={refreshBib}><RefreshCw />{t("latex.settings.bibRefresh")}</Button>
      {/if}
    </div>
    <div class="flex items-center justify-between gap-3 rounded-2xl border border-line p-3.5">
      <span class="text-[13.5px] text-ink">{t("latex.settings.halt")}</span>
      <Switch bind:checked={halt} label={t("latex.settings.halt")} />
    </div>
    <Button type="submit" variant="primary" size="lg" class="w-full" loading={saving}>{t("latex.settings.save")}</Button>
    <div class="border-t border-line pt-4">
      <Button variant="danger" class="w-full" onclick={() => (deleting = true)}><Trash2 />{t("latex.settings.delete")}</Button>
    </div>
  </form>
</Sheet>

<ConfirmDialog bind:open={deleting} title={t("latex.settings.deleteTitle", { title: detail.project.title })} description={t("latex.settings.deleteBody")} confirmLabel={t("latex.settings.delete")} onConfirm={remove} />
