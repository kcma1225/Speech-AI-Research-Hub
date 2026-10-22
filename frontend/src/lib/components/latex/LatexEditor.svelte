<script lang="ts">
  import { untrack } from "svelte";
  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import type { EditorView } from "@codemirror/view";
  import { DropdownMenu } from "bits-ui";
  import {
    ArrowLeft, ChevronDown, Crosshair, Download, Ellipsis, FileArchive, FileDown, FolderTree, History, Languages, ListTree, LoaderCircle, PanelRightClose, PanelRightOpen, Play,
    Scissors, Settings2, Sparkles, SpellCheck, Wand2, Zap,
  } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import ConnectionStatus from "#lib/collab/ConnectionStatus.svelte";
  import PresenceAvatars from "#lib/collab/PresenceAvatars.svelte";
  import type { CollabSession } from "#lib/collab/session.svelte.ts";
  import type { SuggestionReview } from "#lib/components/suggest/review.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import DeleteMenuItem from "#lib/components/ui/DeleteMenuItem.svelte";
  import SplitHandle from "#lib/components/workspace/SplitHandle.svelte";
  import { loadFlag, loadRatio, saveFlag, saveRatio } from "#lib/workspace/split.ts";
  import { goto } from "$app/navigation";
  import { menuContent, menuItem, menuLabel, menuSeparator } from "#lib/components/ui/menu.ts";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { SyncClient } from "#lib/latex/sync-client.ts";
  import LatexLayoutReview from "#lib/components/vision/LatexLayoutReview.svelte";
  import { isRunning, type Compile, type Diagnostic, type LatexFile, type ProjectDetail, type Section, type Symbols } from "#lib/latex/types.ts";
  import CompileBadge from "./CompileBadge.svelte";
  import CompileLog from "./CompileLog.svelte";
  import FilesSheet from "./FilesSheet.svelte";
  import LatexFileEditor from "./LatexFileEditor.svelte";
  import PdfViewer from "./PdfViewer.svelte";
  import SectionTabs from "./SectionTabs.svelte";
  import SettingsSheet from "./SettingsSheet.svelte";
  import VersionsSheet from "./VersionsSheet.svelte";

  /**
   * Overleaf-like LaTeX editor of one project: section tabs (the split files; drag to reorder `\input`s), a file
   * drawer, the collaborative CodeMirror editor, compile (⌘S / ⌘Enter) with a PDF preview (pdf.js, text layer,
   * SyncTeX both ways in a worker), the parsed log with zh hints and AI fixes, AI writing actions (suggestions),
   * versions and downloads. Phones: tabs become a picker and editor / PDF / log are switched, never side by side.
   */
  let { initial }: { initial: ProjectDetail } = $props();

  let detail = $state<ProjectDetail>(untrack(() => initial));
  const projectId = untrack(() => initial.project.id);
  const canEdit = $derived(detail.permissions.edit);
  // Header 刪除 (study editors; same as 設定 → 刪除專案).
  let deleteProjectOpen = $state(false);
  async function removeProject() {
    await api.del(`/latex/${projectId}`);
    toasts.show(t("crud.latex.deleted", { title: detail.project.title }), "success");
    await goto(`/studies/${encodeURIComponent(detail.study.slug)}?tab=latex`);
  }
  const files = $derived(detail.files);
  const root = $derived(files.find(f => f.id === detail.root_file_id) ?? null);
  const fileById = (id: string | null) => files.find(f => f.id === id) ?? null;

  let activeId = $state<string | null>(null);
  const active = $derived(fileById(activeId));
  const sectionIds = $derived(new Set(detail.sections.map(s => s.file_id).filter(Boolean) as string[]));
  const extra = $derived(active && active.id !== root?.id && !sectionIds.has(active.id) ? active : null);

  let view = $state<EditorView | null>(null);
  let collab = $state<CollabSession | null>(null);
  let review = $state<SuggestionReview | null>(null);
  let jump = $state<{ fileId: string; line: number; seq: number } | null>(null);
  let selectionEmpty = $state(true);

  let latest = $state<Compile | null>(untrack(() => initial.latest_compile));
  let pdfCompile = $state<Compile | null>(untrack(() => initial.pdf_compile));
  let symbols = $state<Symbols | null>(null);
  let compiling = $state(false);

  type Pane = "pdf" | "log";
  let pane = $state<Pane>("pdf");
  type MobileView = "edit" | "pdf" | "log";
  let mobileView = $state<MobileView>("edit");
  // Desktop: editor | PDF split (draggable, remembered per viewer); the PDF/log pane can be collapsed.
  let splitBox = $state<HTMLDivElement | null>(null);
  let split = $state(loadRatio("latex", 0.5));
  let splitting = $state(false);
  let previewHidden = $state(loadFlag("latex.previewHidden", false));
  function togglePreview(hidden = !previewHidden) {
    previewHidden = hidden;
    saveFlag("latex.previewHidden", hidden);
  }

  let filesOpen = $state(false);
  let versionsOpen = $state(false);
  let settingsOpen = $state(false);

  const sync = new SyncClient();
  let pdfViewer = $state<PdfViewer | null>(null);
  $effect(() => () => sync.destroy());
  $effect(() => aiStatus.watch());

  // ── loading ──
  async function reload() {
    try {
      const next = await api.get<ProjectDetail>(`/latex/${projectId}`);
      applyDetail(next);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  function applyDetail(next: ProjectDetail) {
    detail = next;
    if (next.latest_compile && (!latest || next.latest_compile.id !== latest.id || !isRunning(next.latest_compile.status))) latest = next.latest_compile;
    if (next.pdf_compile && next.pdf_compile.id !== pdfCompile?.id) pdfCompile = next.pdf_compile;
    if (activeId && !next.files.some(f => f.id === activeId)) open(next.root_file_id);
  }
  async function loadSymbols() {
    try {
      symbols = await api.get<Symbols>(`/latex/${projectId}/symbols`);
    } catch {
      /* completion just has less data */
    }
  }
  $effect(() => {
    untrack(() => {
      const wanted = page.url.searchParams.get("file");
      const first = detail.files.find(f => f.id === wanted && f.kind === "text") ? wanted : (detail.sections.find(s => s.file_id)?.file_id ?? detail.root_file_id);
      open(first);
      void loadSymbols();
      if (isRunning(latest?.status)) poll();
    });
  });
  // Refresh labels/cite keys now and then while editing.
  $effect(() => {
    const timer = setInterval(() => void loadSymbols(), 45_000);
    return () => clearInterval(timer);
  });

  function open(fileId: string | null) {
    const file = fileById(fileId);
    if (!file || file.kind !== "text") return;
    if (activeId === file.id) {
      mobileView = "edit";
      return;
    }
    activeId = file.id;
    selectionEmpty = true;
    mobileView = "edit";
    filesOpen = false;
    const url = new URL(page.url.href);
    url.searchParams.set("file", file.id);
    url.searchParams.delete("suggestion");
    if (url.search !== page.url.search) replaceState(url, page.state);
  }

  // ── compile ──
  async function flushed() {
    for (let i = 0; i < 60 && collab && collab.unsynced > 0; i++) await new Promise(r => setTimeout(r, 50));
  }
  async function compile(draft = false) {
    if (!canEdit || compiling) return;
    compiling = true;
    if (previewHidden) togglePreview(false);
    try {
      await flushed();
      const r = await api.post<{ compile: Compile }>(`/latex/${projectId}/compile`, draft ? { draft: true } : {});
      latest = r.compile;
      requestedId = r.compile.id;
      poll();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      compiling = false;
    }
  }
  /** Compile started here: on phones its result opens in the PDF (or log) view instead of leaving the editor shown. */
  let requestedId: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!latest) return;
      try {
        const c = (await api.get<{ compile: Compile }>(`/latex/${projectId}/compiles/${latest.id}`)).compile;
        if (latest?.id === c.id) finished(c);
      } catch {
        /* retry */
      }
      if (isRunning(latest?.status)) poll();
    }, document.hidden ? 4000 : 1000);
  }
  $effect(() => () => clearTimeout(pollTimer));
  function finished(c: Compile) {
    const was = latest;
    latest = c;
    if (isRunning(c.status) || (was && !isRunning(was.status) && was.id === c.id)) return;
    if (c.pdf_url) pdfCompile = c;
    if (c.status === "success") toasts.show(t("latex.compiled"), "success");
    else if (c.status === "partial") toasts.show(t("latex.compiledWithErrors", { n: c.errors.length }));
    else if (c.status !== "cancelled") {
      toasts.show(t(`latex.status.${c.status}` as MessageKey), "error");
      if (viewport.desktop) pane = "log";
    }
    if (c.errors.length && viewport.desktop) pane = "log";
    if (c.errors.length && previewHidden) togglePreview(false);
    if (!viewport.desktop && c.id === requestedId && c.status !== "cancelled") mobileView = c.pdf_url && !c.errors.length ? "pdf" : "log";
    if (c.id === requestedId) requestedId = null;
    void loadSymbols();
  }
  function onDocMessage(msg: Record<string, unknown>) {
    if (msg.type === "latex_compiled" && typeof msg.compileId === "string") {
      void api.get<{ compile: Compile }>(`/latex/${projectId}/compiles/${msg.compileId}`).then(r => {
        if (!latest || r.compile.id === latest.id || new Date(r.compile.created_at) > new Date(latest.created_at)) finished(r.compile);
      }).catch(() => {});
    }
    if (msg.type === "latex_meta") void reload();
  }

  // SyncTeX of the PDF on screen.
  $effect(() => {
    const c = pdfCompile;
    if (c?.synctex_url && sync.loadedKey !== c.id) void sync.load(c.id, c.synctex_url).catch(() => {});
  });

  async function forward() {
    if (!view || !active || !pdfCompile?.synctex_url) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    try {
      const rects = await sync.forward(active.path, line);
      if (!rects.length) return toasts.show(t("latex.sync.none"));
      if (!viewport.desktop) mobileView = "pdf";
      pane = "pdf";
      requestAnimationFrame(() => pdfViewer?.reveal(rects));
    } catch {
      toasts.show(t("latex.sync.none"));
    }
  }
  async function inverse(pageNo: number, x: number, y: number) {
    try {
      const hit = await sync.inverse(pageNo, x, y);
      if (!hit) return toasts.show(t("latex.sync.none"));
      reveal(hit.file, hit.line);
    } catch {
      toasts.show(t("latex.sync.none"));
    }
  }
  function reveal(path: string, line: number, compile?: Compile | null) {
    const id = compile?.file_map?.[path] ?? files.find(f => f.path === path)?.id;
    const file = fileById(id ?? null);
    if (!file || file.kind !== "text") return toasts.show(t("latex.sync.noFile", { path }));
    open(file.id);
    mobileView = "edit";
    jump = { fileId: file.id, line, seq: (jump?.seq ?? 0) + 1 };
  }
  function jumpTo(d: Diagnostic) {
    if (d.file && d.line) reveal(d.file, d.line, latest);
  }
  async function aiFix(d: Diagnostic, index: number) {
    if (!latest) return null;
    try {
      const r = await api.post<{ explanation: string; suggestion: unknown; file_id: string | null; line: number | null }>(`/latex/${projectId}/compiles/${latest.id}/ai/fix`, { index });
      if (r.suggestion && r.file_id) {
        const file = fileById(r.file_id);
        if (file) {
          open(file.id);
          jump = { fileId: file.id, line: r.line ?? 1, seq: (jump?.seq ?? 0) + 1 };
        }
        setTimeout(() => void review?.refresh(), 300);
      }
      return { explanation: r.explanation, suggested: !!r.suggestion };
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return null;
    }
  }

  // ── sections ──
  async function reorder(order: string[]) {
    // Optimistic: show the new order at once.
    const byId = new Map(detail.sections.map(s => [s.file_id, s]));
    const moved = order.map(id => byId.get(id)!).filter(Boolean);
    let k = 0;
    detail.sections = detail.sections.map(s => (s.managed && s.file_id ? moved[k++]! : s));
    try {
      applyDetail(await api.put<ProjectDetail>(`/latex/${projectId}/sections/order`, { order }));
      toasts.show(t("latex.section.moved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
      await reload();
    }
  }

  let sectionOpen = $state(false);
  let sectionEdit = $state<Section | null>(null);
  let sectionTitle = $state("");
  let sectionName = $state("");
  let sectionAfter = $state<string>("__end");
  let sectionBusy = $state(false);
  function addSection() {
    sectionEdit = null;
    sectionTitle = "";
    sectionName = "";
    sectionAfter = active && sectionIds.has(active.id) ? active.id : "__end";
    sectionOpen = true;
  }
  function renameSection(s: Section) {
    sectionEdit = s;
    sectionTitle = s.title ?? "";
    sectionName = s.path.replace(/^.*\//, "").replace(/\.tex$/, "");
    sectionOpen = true;
  }
  const nameValid = $derived(!sectionName.trim() || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sectionName.trim()));
  async function submitSection(event?: Event) {
    event?.preventDefault();
    if (!sectionTitle.trim() || !nameValid || sectionBusy) return;
    sectionBusy = true;
    try {
      if (sectionEdit?.file_id) {
        const body: Record<string, string> = {};
        if (sectionTitle.trim() !== (sectionEdit.title ?? "")) body.title = sectionTitle.trim();
        const oldName = sectionEdit.path.replace(/^.*\//, "").replace(/\.tex$/, "");
        if (sectionName.trim() && sectionName.trim() !== oldName) body.name = sectionName.trim();
        if (Object.keys(body).length) applyDetail(await api.patch<ProjectDetail>(`/latex/${projectId}/sections/${sectionEdit.file_id}`, body));
      } else {
        const r = await api.post<ProjectDetail & { file: LatexFile }>(`/latex/${projectId}/sections`, {
          title: sectionTitle.trim(),
          ...(sectionName.trim() ? { name: sectionName.trim() } : {}),
          ...(sectionAfter !== "__end" ? { after: sectionAfter } : {}),
        });
        applyDetail(r);
        open(r.file.id);
      }
      sectionOpen = false;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      sectionBusy = false;
    }
  }
  let deleting = $state<{ id: string; label: string; path: string } | null>(null);
  let deleteOpen = $state(false);
  function askDelete(fileId: string | null, label: string, path: string) {
    if (!fileId) return;
    deleting = { id: fileId, label, path };
    deleteOpen = true;
  }
  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.del(`/latex/${projectId}/files/${deleting.id}`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    }
    if (activeId === deleting.id) open(detail.root_file_id);
    await reload();
  }

  // ── files ──
  let fileDialog = $state<{ mode: "new" | "rename"; file: LatexFile | null } | null>(null);
  let fileDialogOpen = $state(false);
  let filePath = $state("");
  let uploading = $state(false);
  function newFile() {
    fileDialog = { mode: "new", file: null };
    filePath = "";
    fileDialogOpen = true;
  }
  function renameFile(file: LatexFile) {
    fileDialog = { mode: "rename", file };
    filePath = file.path;
    fileDialogOpen = true;
  }
  async function submitFile(event?: Event) {
    event?.preventDefault();
    if (!filePath.trim() || !fileDialog) return;
    try {
      if (fileDialog.mode === "new") {
        const r = await api.post<{ file: LatexFile }>(`/latex/${projectId}/files`, { path: filePath.trim(), content: "" });
        await reload();
        open(r.file.id);
      } else if (fileDialog.file) {
        await api.patch(`/latex/${projectId}/files/${fileDialog.file.id}`, { path: filePath.trim() });
        await reload();
      }
      fileDialogOpen = false;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function upload(list: File[]) {
    uploading = true;
    try {
      for (const f of list) {
        if (f.size > detail.limits.binaryBytes) {
          toasts.show(t("latex.files.tooLarge", { name: f.name }), "error");
          continue;
        }
        const form = new FormData();
        form.set("file", f);
        const r = await api.post<{ file: LatexFile }>(`/latex/${projectId}/files`, form);
        toasts.show(t("latex.files.uploaded", { path: r.file.path }), "success");
      }
      await reload();
      void loadSymbols();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      uploading = false;
    }
  }

  // ── AI ──
  let aiBusy = $state<string | null>(null);
  let draftOpen = $state(false);
  let draftInstruction = $state("");
  const isSection = $derived(!!active && active.id !== root?.id && /\.tex$/i.test(active.path) && !active.generated);
  async function runAi(label: string, path: string, body: Record<string, unknown>) {
    if (aiBusy) return;
    aiBusy = label;
    try {
      await flushed();
      await api.post(path, body);
      await review?.refresh();
      toasts.show(t("latex.ai.ready"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      aiBusy = null;
    }
  }
  function rewrite(mode: string) {
    if (!view || !active) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return toasts.show(t("latex.ai.selectFirst"));
    void runAi(t(`latex.ai.${mode}` as MessageKey), `/latex/${projectId}/files/${active.id}/ai/rewrite`, { from, to, before: view.state.sliceDoc(from, to), mode });
  }
  function draft() {
    if (!active) return;
    draftOpen = false;
    void runAi(t("latex.ai.draft"), `/latex/${projectId}/files/${active.id}/ai/draft`, draftInstruction.trim() ? { instruction: draftInstruction.trim() } : {});
  }
  const rewriteItems = [
    { mode: "rewrite", icon: Wand2 },
    { mode: "polish", icon: SpellCheck },
    { mode: "shorten", icon: Scissors },
    { mode: "expand", icon: ListTree },
    { mode: "translate_en", icon: Languages },
    { mode: "translate_zh", icon: Languages },
  ];

  const running = $derived(isRunning(latest?.status));
  const errorCount = $derived(latest?.errors.length ?? 0);
  const sectionAfterOptions = $derived([
    ...detail.sections.filter(s => s.file_id && s.managed).map(s => ({ value: s.file_id!, label: s.title || s.path })),
    { value: "__end", label: t("latex.section.end") },
  ]);
  const paneOptions = $derived([
    { value: "pdf" as const, label: t("latex.view.pdf") },
    { value: "log" as const, label: errorCount ? `${t("latex.view.log")} · ${errorCount}` : t("latex.view.log") },
  ]);
  const mobileOptions = $derived([
    { value: "edit" as const, label: t("latex.view.editor") },
    { value: "pdf" as const, label: t("latex.view.pdf") },
    { value: "log" as const, label: errorCount ? `${t("latex.view.log")} · ${errorCount}` : t("latex.view.log") },
  ]);
  // Chrome on macOS keeps ⌘⌥J for its console, so Macs use ⌃⌥J (LatexFileEditor binds both).
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = mac ? { mod: "⌘", fwd: "⌃⌥J" } : { mod: "Ctrl+", fwd: "Ctrl+Alt+J" };
  const showEditor = $derived(viewport.desktop || mobileView === "edit");
  const showPdf = $derived(viewport.desktop ? pane === "pdf" : mobileView === "pdf");
  const showLog = $derived(viewport.desktop ? pane === "log" : mobileView === "log");
</script>

<svelte:head><title>{detail.project.title} · Speech-AI Hub</title></svelte:head>

<a href="/studies/{detail.study.slug}?tab=latex" class="-ml-2 mb-1 inline-flex h-10 max-w-full items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink">
  <ArrowLeft class="size-4 shrink-0" /><span class="truncate">{detail.study.title}</span>
</a>

<header class="mb-3 flex flex-col gap-2.5">
  <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
    <h1 class="min-w-0 flex-1 basis-64 font-display text-[26px] leading-tight text-balance text-ink sm:text-[32px]">{detail.project.title}</h1>
    <div class="flex shrink-0 items-center gap-2 pt-1.5">
      {#if collab}<PresenceAvatars peers={collab.peers} />{/if}
    </div>
  </div>
  <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12.5px] text-ink-3">
    <CompileBadge status={latest?.status ?? null} />
    {#if running && latest?.stage}<span class="tabular-nums">{latest.stage}</span>{/if}
    <span class="inline-flex h-6 items-center rounded-full bg-surface-3 px-2 text-[11px] font-semibold text-ink-2 uppercase" title={t("latex.compiler")}>{detail.project.compiler}</span>
    {#if latest?.finished_at && !running}<span class="hidden sm:inline">{t("latex.compiledAt", { when: relativeTime(latest.finished_at) })}</span>{/if}
    {#if collab}<ConnectionStatus session={collab} compact />{/if}
    <div class="ml-auto flex flex-wrap items-center gap-1">
      <Button variant="ghost" size={viewport.desktop ? "sm" : "md"} aria-label={t("latex.files.title")} title={t("latex.files.title")} onclick={() => (filesOpen = true)}><FolderTree /><span class="max-sm:hidden">{t("latex.files.title")}</span></Button>
      {#if viewport.desktop}
      <Button variant="ghost" size="sm" onclick={() => (versionsOpen = true)}><History />{t("latex.versions")}</Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink lg:h-8" aria-label={t("latex.download")}><Download class="size-4" /><span class="hidden sm:inline">{t("latex.download")}</span></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-52">
            <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={!pdfCompile?.pdf_url} onSelect={() => pdfCompile?.pdf_url && (window.location.href = `${pdfCompile.pdf_url}?download=1`)}><FileDown />{t("latex.downloadPdf")}</DropdownMenu.Item>
            <DropdownMenu.Item class={menuItem} onSelect={() => (window.location.href = `/api/latex/${projectId}/export.zip`)}><FileArchive />{t("latex.downloadZip")}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DeleteButton class="lg:size-8 lg:min-h-8" label={t("crud.latex.delete")} reason={canEdit ? null : t("crud.deny.study")} onclick={() => (deleteProjectOpen = true)} />
      {#if canEdit}
        <Button variant="ghost" size="icon-sm" aria-label={t("latex.settings")} title={t("latex.settings")} onclick={() => (settingsOpen = true)}><Settings2 /></Button>
      {/if}
      {:else}
      <!-- Phones/tablets: the secondary actions share one menu so the toolbar stays on one row. -->
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink" aria-label={t("crud.more")} title={t("crud.more")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-56">
            <DropdownMenu.Item class={menuItem} onSelect={() => (versionsOpen = true)}><History />{t("latex.versions")}</DropdownMenu.Item>
            <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={!pdfCompile?.pdf_url} onSelect={() => pdfCompile?.pdf_url && (window.location.href = `${pdfCompile.pdf_url}?download=1`)}><FileDown />{t("latex.downloadPdf")}</DropdownMenu.Item>
            <DropdownMenu.Item class={menuItem} onSelect={() => (window.location.href = `/api/latex/${projectId}/export.zip`)}><FileArchive />{t("latex.downloadZip")}</DropdownMenu.Item>
            {#if canEdit}<DropdownMenu.Item class={menuItem} onSelect={() => (settingsOpen = true)}><Settings2 />{t("latex.settings")}</DropdownMenu.Item>{/if}
            <DeleteMenuItem label={t("crud.latex.delete")} reason={canEdit ? null : t("crud.deny.study")} onSelect={() => (deleteProjectOpen = true)} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {/if}
      {#if canEdit}
        <AiGate role="writing" inline>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger class="inline-flex h-10 items-center gap-1.5 rounded-full border border-line-2 px-3.5 text-[12.5px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-40 lg:h-8" disabled={!!aiBusy || !active || active.generated}>
              <Sparkles class="size-3.5" />{t("latex.ai.button")}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-60">
                <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={!isSection} onSelect={() => (draftOpen = true)}><Sparkles />{t("latex.ai.draft")}</DropdownMenu.Item>
                {#if !isSection}<p class="px-2.5 pb-1 text-[11.5px] text-ink-3">{t("latex.ai.sectionOnly")}</p>{/if}
                <DropdownMenu.Separator class={menuSeparator} />
                <p class={menuLabel}>{t("latex.ai.selection")}</p>
                {#each rewriteItems as item (item.mode)}
                  <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={selectionEmpty} onSelect={() => rewrite(item.mode)}><item.icon />{t(`latex.ai.${item.mode}` as MessageKey)}</DropdownMenu.Item>
                {/each}
                {#if selectionEmpty}<p class="px-2.5 pt-1 pb-1.5 text-[11.5px] text-ink-3">{t("latex.ai.selectFirst")}</p>{/if}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <LatexLayoutReview {projectId} compile={pdfCompile} {sync} compact={!viewport.desktop} currentPage={() => pdfViewer?.currentPage() ?? 1} onReveal={(path, line) => reveal(path, line)} />
        </AiGate>
        <div class="inline-flex items-center">
          <button
            type="button"
            class="inline-flex h-10 items-center gap-1.5 rounded-l-full bg-ink pr-3 pl-4 text-[13px] font-semibold text-surface hover:opacity-90 disabled:opacity-60 lg:h-8"
            disabled={compiling}
            title={t("latex.compileShortcut", keys)}
            onclick={() => compile()}
          >
            {#if compiling || running}<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />{:else}<Play class="size-3.5" />{/if}
            {running ? t("latex.compiling") : t("latex.compile")}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger class="inline-flex h-10 items-center rounded-r-full border-l border-surface/25 bg-ink px-2 text-surface hover:opacity-90 lg:h-8" aria-label={t("latex.compileOptions")}><ChevronDown class="size-4" /></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-60">
                <DropdownMenu.Item class={menuItem} onSelect={() => compile(true)}><Zap />{t("latex.compileDraft")}</DropdownMenu.Item>
                {#if running && latest}
                  <DropdownMenu.Item class={menuItem} onSelect={() => latest && api.del(`/latex/${projectId}/compiles/${latest.id}`).then(poll).catch(e => toasts.show((e as Error).message, "error"))}>{t("latex.compileCancel")}</DropdownMenu.Item>
                {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      {/if}
    </div>
  </div>
</header>

<div class="flex flex-col overflow-clip rounded-[22px] border border-line-2 bg-surface shadow-card lg:h-[calc(100dvh-236px)] lg:min-h-[560px]">
  <div class="flex items-center gap-2 border-b border-line bg-surface-2/70 px-2 pt-1.5 max-sm:pb-1.5">
    <SectionTabs
      sections={detail.sections}
      {root}
      {extra}
      {activeId}
      {canEdit}
      peersByFile={activeId && collab ? { [activeId]: collab.peers } : {}}
      onOpen={open}
      onReorder={reorder}
      onAdd={addSection}
      onRename={renameSection}
      onDelete={s => askDelete(s.file_id, s.title || s.path, s.path)}
    />
    {#if viewport.desktop}
      <button
        type="button"
        class="mb-1.5 ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink {previewHidden ? 'bg-surface-3 text-ink' : ''}"
        aria-pressed={previewHidden}
        aria-label={previewHidden ? t("latex.preview.show") : t("latex.preview.hide")}
        title={previewHidden ? t("latex.preview.show") : t("latex.preview.hide")}
        onclick={() => togglePreview()}
      >
        {#if previewHidden}<PanelRightOpen class="size-4" />{:else}<PanelRightClose class="size-4" />{/if}
      </button>
    {/if}
  </div>
  {#if !viewport.desktop}
    <div class="border-b border-line px-2 py-1.5">
      <Segmented bind:value={mobileView} options={mobileOptions} label={t("latex.view")} class="w-full [&_button]:h-10" />
    </div>
  {/if}
  <div bind:this={splitBox} class="flex min-h-0 flex-1 {splitting ? 'cursor-col-resize select-none' : ''}">
    <div
      class="min-h-[65dvh] min-w-0 flex-1 lg:min-h-0 {showEditor ? '' : 'hidden'}"
      style={viewport.desktop && !previewHidden ? `flex:0 0 calc(${(split * 100).toFixed(2)}% - 6px)` : undefined}
    >
      {#if active}
        {#key active.id}
          <LatexFileEditor
            {projectId}
            file={active}
            {canEdit}
            symbols={() => symbols}
            bind:view
            bind:session={collab}
            bind:review
            {jump}
            onCompile={() => compile()}
            onForward={forward}
            onMessage={onDocMessage}
            onSelection={e => (selectionEmpty = e)}
          />
        {/key}
      {:else}
        <p class="p-6 text-[13px] text-ink-3">{t("latex.noFile")}</p>
      {/if}
    </div>
    {#if viewport.desktop && !previewHidden}
      <SplitHandle container={splitBox} bind:ratio={split} bind:dragging={splitting} label={t("latex.split")} onCommit={r => saveRatio("latex", r)} />
    {/if}
    <div class="flex min-h-[65dvh] min-w-0 flex-1 flex-col lg:min-h-0 {(showPdf || showLog) && !(viewport.desktop && previewHidden) ? '' : 'hidden'} {splitting ? 'pointer-events-none' : ''}">
      {#if viewport.desktop}
        <div class="flex items-center gap-2 border-b border-line px-2 py-1.5">
          <Segmented bind:value={pane} options={paneOptions} label={t("latex.view")} class="[&_button]:h-8 [&_button]:text-[12px]" />
          {#if pdfCompile?.synctex_url}
            <button type="button" class="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-3" title={t("latex.sync.forwardKey", keys)} onclick={forward}><Crosshair class="size-3.5" />{t("latex.sync.forward")}</button>
          {/if}
        </div>
      {:else if showPdf && pdfCompile?.synctex_url}
        <p class="border-b border-line px-3 py-2 text-[12px] text-ink-3">{t("latex.sync.inverseHint")}</p>
      {/if}
      <PdfViewer bind:this={pdfViewer} url={pdfCompile?.pdf_url ?? null} onInverse={inverse} class="min-h-0 flex-1 {showPdf ? '' : 'hidden'}" />
      {#if showLog}
        <div class="min-h-0 flex-1 overflow-hidden"><CompileLog compile={latest} {canEdit} onJump={jumpTo} onFix={aiFix} /></div>
      {/if}
    </div>
  </div>
</div>
<p class="mt-2 hidden text-[11.5px] text-ink-3 lg:block">{t("latex.keys", keys)}</p>

{#if aiBusy}
  <div class="fixed inset-x-4 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-lg items-center gap-2 rounded-2xl border border-line bg-popover p-3.5 shadow-pop lg:bottom-6" role="status" aria-live="polite">
    <LoaderCircle class="size-4 animate-spin text-ink-2 motion-reduce:animate-none" />
    <p class="flex-1 text-[13px] font-semibold text-ink">{t("latex.ai.working", { action: aiBusy })}</p>
  </div>
{/if}

<FilesSheet bind:open={filesOpen} {files} {projectId} {activeId} {canEdit} {uploading} onOpen={f => open(f.id)} onNew={newFile} onUpload={upload} onRename={renameFile} onDelete={f => askDelete(f.id, f.path, f.path)} />
<VersionsSheet bind:open={versionsOpen} {projectId} {canEdit} onRestored={applyDetail} />
<ConfirmDialog bind:open={deleteProjectOpen} title={t("crud.latex.deleteTitle", { title: detail.project.title })} description={t("crud.latex.deleteDescription")} confirmLabel={t("crud.latex.delete")} onConfirm={removeProject} />
{#if canEdit}
  <SettingsSheet bind:open={settingsOpen} {detail} onSaved={reload} />
  <Sheet bind:open={sectionOpen} side="center" title={sectionEdit ? t("latex.section.rename") : t("latex.section.add")} description={sectionEdit ? undefined : t("latex.section.addHint")}>
    <form class="flex flex-col gap-4" onsubmit={submitSection}>
      <TextField label={t("latex.section.title")} bind:value={sectionTitle} maxlength={200} required />
      <TextField label={t("latex.section.name")} bind:value={sectionName} maxlength={64} hint={t("latex.section.nameHint")} error={nameValid ? null : t("latex.section.nameInvalid")} autocapitalize="off" spellcheck={false} />
      {#if !sectionEdit}
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("latex.section.after")}</span>
          <Select bind:value={sectionAfter} label={t("latex.section.after")} options={sectionAfterOptions} class="w-full" />
        </div>
      {/if}
      <button type="submit" class="hidden" aria-hidden="true" tabindex="-1"></button>
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (sectionOpen = false)}>{t("notes.cancel")}</Button>
      <Button variant="primary" loading={sectionBusy} disabled={!sectionTitle.trim() || !nameValid} onclick={() => submitSection()}>{sectionEdit ? t("latex.save") : t("latex.section.create")}</Button>
    {/snippet}
  </Sheet>
  <Sheet bind:open={fileDialogOpen} side="center" title={fileDialog?.mode === "rename" ? t("latex.files.rename") : t("latex.files.newFile")} description={t("latex.files.pathHint")}>
    <form onsubmit={submitFile}>
      <TextField label={t("latex.files.path")} bind:value={filePath} maxlength={255} placeholder="sections/appendix.tex" autocapitalize="off" spellcheck={false} />
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (fileDialogOpen = false)}>{t("notes.cancel")}</Button>
      <Button variant="primary" disabled={!filePath.trim()} onclick={() => submitFile()}>{t("latex.save")}</Button>
    {/snippet}
  </Sheet>
  <Sheet bind:open={draftOpen} side="center" title={t("latex.ai.draft")} description={t("latex.ai.draftHint")}>
    <Textarea label={t("latex.ai.instruction")} bind:value={draftInstruction} rows={3} maxlength={1000} placeholder={t("latex.ai.instructionPlaceholder")} />
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (draftOpen = false)}>{t("notes.cancel")}</Button>
      <Button variant="primary" onclick={draft}><Sparkles />{t("latex.ai.generate")}</Button>
    {/snippet}
  </Sheet>
  <ConfirmDialog
    bind:open={deleteOpen}
    title={t("latex.deleteTitle", { title: deleting?.label ?? "" })}
    description={t("latex.deleteBody", { path: deleting?.path ?? "" })}
    confirmLabel={t("latex.delete")}
    onConfirm={confirmDelete}
  />
{/if}
