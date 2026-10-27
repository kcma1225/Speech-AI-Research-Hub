<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { EditorView } from "@codemirror/view";
  import { ArrowLeft, Check, CircleAlert, Copy, FileCode2, FolderTree, LoaderCircle, PanelRightClose, PanelRightOpen, Send, Sparkles, Wand2, X } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import CodeEditor from "#lib/editor/CodeEditor.svelte";
  import { setHunks, suggestionReview } from "#lib/components/suggest/extension.ts";
  import type { LiveHunk, Suggestion } from "#lib/components/suggest/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { debounce, isImage, languageFor, slideIndexAt } from "#lib/slides/source.ts";
  import type { AiDraftJob, DeckTemplate, PreviewInfo, SlideDetail, SourceFile, SourceResponse } from "#lib/slides/types.ts";
  import { copyText, deckUrl } from "#lib/slides/util.ts";
  import FileTree from "./FileTree.svelte";
  import PreviewPane from "./PreviewPane.svelte";
  import SlideLayoutReview from "#lib/components/vision/SlideLayoutReview.svelte";
  import SplitHandle from "#lib/components/workspace/SplitHandle.svelte";
  import { viewport } from "#lib/media.svelte.ts";
  import { loadFlag, loadRatio, saveFlag, saveRatio } from "#lib/workspace/split.ts";

  /**
   * In-app Quarto editor of a deck: file tree, CodeMirror (shared editor base), autosave with optimistic versions,
   * debounced quick previews (~2 s after the last save), AI draft (`ai_slides_generate`) and 「請 AI 修改」 suggestions
   * (target `deck_source`, reviewed inline), and 「發布新版本」 (packs the tree into a normal Quarto version).
   */
  let { deck, studySlug }: { deck: SlideDetail; studySlug: string } = $props();
  const deckId = $derived(deck.project.id);

  type Buffer = { text: string; saved: string; version: number };
  let data = $state<SourceResponse | null>(null);
  let loadError = $state<string | null>(null);
  let buffers = $state<Record<string, Buffer>>({});
  let activeId = $state<string | null>(null);
  let text = $state("");
  let view = $state<EditorView | null>(null);
  let cursorSlide = $state(0);
  let saving = $state(false);
  let saveError = $state<{ message: string; conflict: boolean } | null>(null);
  let preview = $state<PreviewInfo | null>(null);
  let aiJob = $state<AiDraftJob | null>(null);
  let suggestions = $state<Suggestion[]>([]);
  let mobileTab = $state<"edit" | "preview" | "files">("edit");
  let filesSheet = $state(false);
  // Desktop workspace: collapsible file tree, editor | preview split (draggable), collapsible preview; remembered per viewer.
  let treeOpen = $state(loadFlag("quarto.tree", typeof window !== "undefined" && window.innerWidth >= 1536));
  let previewHidden = $state(loadFlag("quarto.previewHidden", false));
  let splitBox = $state<HTMLDivElement | null>(null);
  let split = $state(loadRatio("quarto", 0.5));
  let splitting = $state(false);
  const sideBySide = $derived(viewport.desktop && !previewHidden);

  const canEdit = $derived(Boolean(data?.permissions.edit));
  const files = $derived(data?.files ?? []);
  const active = $derived(files.find(f => f.id === activeId) ?? null);
  const dirtyIds = $derived(Object.entries(buffers).filter(([, b]) => b.text !== b.saved).map(([id]) => id));
  const revision = $derived(data?.source?.revision ?? 0);
  const unpublished = $derived(Boolean(data?.source && data.source.revision !== data.source.published_revision));
  const aiRunning = $derived(aiJob?.status === "queued" || aiJob?.status === "running");
  const liveHunks = $derived<LiveHunk[]>(
    suggestions.flatMap(s =>
      s.hunks
        .filter(h => h.state === "pending" && h.current)
        .map(h => ({ suggestionId: s.id, hunkId: h.id, from: h.current!.from, to: h.current!.to, before: h.before, after: h.after, stale: false, title: s.title, author: s.creator_name })),
    ),
  );
  const staleCount = $derived(suggestions.reduce((n, s) => n + s.stale, 0));
  const reviewing = $derived(liveHunks.length > 0 || staleCount > 0);
  const readOnly = $derived(!canEdit || aiRunning || reviewing);

  // ── loading ────────────────────────────────────────────────────────────────────────────
  async function load(keepActive = true) {
    try {
      const next = await api.get<SourceResponse>(`/slides/${deckId}/source`);
      const nextBuffers: Record<string, Buffer> = {};
      for (const file of next.files) {
        if (file.kind !== "text") continue;
        const old = buffers[file.id];
        // Unsaved local text survives a reload of other files.
        const keep = old && old.text !== old.saved && old.version === file.version;
        nextBuffers[file.id] = { text: keep ? old.text : file.content ?? "", saved: file.content ?? "", version: file.version };
      }
      buffers = nextBuffers;
      data = next;
      preview = next.preview;
      pollPreview();
      loadError = null;
      const wanted = keepActive && activeId && next.files.some(f => f.id === activeId) ? activeId : (page.url.searchParams.get("file") ?? null);
      const target = next.files.find(f => f.id === wanted) ?? next.files.find(f => f.path === next.source?.entry) ?? next.files[0] ?? null;
      open(target, true);
    } catch (e) {
      loadError = (e as Error).message;
    }
  }
  $effect(() => {
    void deckId;
    untrack(() => {
      void load(false);
      void loadAiJob();
    });
  });

  function open(file: SourceFile | null, force = false) {
    if (!file || (!force && file.id === activeId)) {
      if (file) mobileTab = "edit";
      return;
    }
    if (activeId && activeId !== file.id) void save.flush();
    activeId = file.id;
    text = buffers[file.id]?.text ?? "";
    mobileTab = "edit";
    filesSheet = false;
    suggestions = [];
    if (file.kind === "text") void loadSuggestions(file.id);
  }

  // ── saving & preview ───────────────────────────────────────────────────────────────────
  let chain: Promise<unknown> = Promise.resolve();
  function persist(fileId: string) {
    chain = chain.then(async () => {
      const buffer = buffers[fileId];
      const file = data?.files.find(f => f.id === fileId);
      if (!buffer || !file || buffer.text === buffer.saved || !canEdit) return;
      const sent = buffer.text;
      saving = true;
      try {
        const result = await api.put<{ file: SourceFile; revision: number }>(`/slides/${deckId}/source/files`, { path: file.path, content: sent, baseVersion: buffer.version });
        buffer.saved = sent;
        buffer.version = result.file.version;
        file.version = result.file.version;
        file.bytes = result.file.bytes;
        file.updated_at = result.file.updated_at;
        if (data?.source) data.source.revision = result.revision;
        saveError = null;
        schedulePreview();
      } catch (e) {
        const conflict = e instanceof ApiError && e.status === 409;
        saveError = { message: (e as Error).message, conflict };
      } finally {
        saving = false;
      }
    });
    return chain;
  }
  const save = debounce(() => {
    if (activeId) void persist(activeId);
  }, 800);
  async function flushAll() {
    save.cancel();
    for (const id of Object.keys(buffers)) await persist(id);
  }

  function onEdit(next: string) {
    if (!activeId || !buffers[activeId]) return;
    buffers[activeId]!.text = next;
    text = next;
    if (canEdit) save();
  }

  let polling: ReturnType<typeof setTimeout> | undefined;
  async function requestPreview() {
    if (!canEdit || !data?.source) return;
    try {
      preview = (await api.post<{ preview: PreviewInfo }>(`/slides/${deckId}/source/preview`)).preview;
      pollPreview();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  const schedulePreview = debounce(() => void requestPreview(), 2000);
  function pollPreview() {
    clearTimeout(polling);
    const busy = preview?.latest?.status === "queued" || preview?.latest?.status === "rendering";
    if (!busy) return;
    polling = setTimeout(async () => {
      try {
        preview = (await api.get<{ preview: PreviewInfo }>(`/slides/${deckId}/source/preview`)).preview;
      } catch {}
      pollPreview();
    }, document.hidden ? 5000 : 1500);
  }
  $effect(() => () => clearTimeout(polling));
  // First visit of an editor: render once when there is no preview yet.
  $effect(() => {
    if (data?.source && canEdit && !untrack(() => preview?.latest) && !untrack(() => aiRunning)) untrack(() => void requestPreview());
  });
  const previewStale = $derived(Boolean(dirtyIds.length || (preview?.ready && preview.ready.revision !== revision)));

  // Leaving with unsaved text: save first (SPA), warn on reload/close.
  beforeNavigate(() => {
    if (dirtyIds.length) void flushAll();
  });
  $effect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyIds.length) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });
  // ⌘S / Ctrl+S: save and preview now.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushAll().then(() => {
          schedulePreview.cancel();
          void requestPreview();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── editor extensions ──────────────────────────────────────────────────────────────────
  const cursorTracker = EditorView.updateListener.of(update => {
    if (!update.selectionSet && !update.docChanged) return;
    if (!active?.path.endsWith(".qmd")) return;
    cursorSlide = slideIndexAt(update.state.doc.toString(), update.state.selection.main.head);
  });
  const review = suggestionReview({
    accept: h => void decide(h.suggestionId, h.hunkId, "accept"),
    reject: h => void decide(h.suggestionId, h.hunkId, "reject"),
    labels: { accept: t("slides.editor.ai.accept"), reject: t("slides.editor.ai.reject"), stale: t("slides.editor.ai.stale"), by: h => h.author ?? "AI" },
    canReview: () => canEdit,
  });
  let revealed = "";
  $effect(() => {
    const hunks = liveHunks;
    if (!view) return;
    view.dispatch({ effects: setHunks.of({ hunks, focus: null }) });
    // Bring a newly arrived suggestion into view (the YAML header often fills the first screen).
    const first = hunks[0];
    if (first && first.suggestionId !== revealed) {
      revealed = first.suggestionId;
      // Scroll inside the editor only (CodeMirror's scrollIntoView would also scroll the page).
      const v = view;
      const reveal = () => {
        const block = v.lineBlockAt(Math.min(first.from, v.state.doc.length));
        v.scrollDOM.scrollTo({ top: Math.max(0, block.top - v.scrollDOM.clientHeight / 4) });
      };
      // Again once the review widgets and the banner above the editor have been laid out.
      requestAnimationFrame(reveal);
      setTimeout(reveal, 250);
    }
  });

  // ── suggestions (請 AI 修改) ──────────────────────────────────────────────────────────
  async function loadSuggestions(fileId: string) {
    try {
      const result = await api.get<{ suggestions: Suggestion[] }>(`/suggestions?target_type=deck_source&target_id=${fileId}`);
      if (activeId === fileId) suggestions = result.suggestions;
    } catch {
      suggestions = [];
    }
  }
  async function reloadFile(fileId: string) {
    const next = await api.get<SourceResponse>(`/slides/${deckId}/source`);
    const file = next.files.find(f => f.id === fileId);
    if (data) {
      data.files = next.files;
      data.source = next.source;
    }
    if (file && file.kind === "text") {
      buffers[fileId] = { text: file.content ?? "", saved: file.content ?? "", version: file.version };
      if (activeId === fileId) text = file.content ?? "";
    }
    schedulePreview();
  }
  async function decide(suggestionId: string, hunkId: string | "all", decision: "accept" | "reject") {
    try {
      const path = hunkId === "all" ? `/suggestions/${suggestionId}/${decision}-all` : `/suggestions/${suggestionId}/hunks/${hunkId}/${decision}`;
      await api.post(path);
      if (activeId) {
        if (decision === "accept") await reloadFile(activeId);
        await loadSuggestions(activeId);
      }
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function decideAll(decision: "accept" | "reject") {
    for (const s of suggestions) await decide(s.id, "all", decision);
  }

  let aiEditOpen = $state(false);
  let aiInstruction = $state("");
  let aiSelection = $state<{ from: number; to: number } | null>(null);
  let aiEditing = $state(false);
  function openAiEdit() {
    const range = view?.state.selection.main;
    aiSelection = range && !range.empty ? { from: range.from, to: range.to } : null;
    aiInstruction = "";
    aiEditOpen = true;
  }
  async function submitAiEdit(event?: Event) {
    event?.preventDefault();
    if (!active || !aiInstruction.trim()) return;
    aiEditing = true;
    try {
      await flushAll();
      await api.post(`/slides/${deckId}/source/files/${active.id}/ai-edit`, { instruction: aiInstruction.trim(), ...(aiSelection ? { selection: aiSelection } : {}) });
      aiEditOpen = false;
      await loadSuggestions(active.id);
      toasts.show(t("slides.editor.ai.suggested"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      aiEditing = false;
    }
  }

  // ── AI draft (ai_slides_generate) ──────────────────────────────────────────────────────
  let aiDraftOpen = $state(false);
  let draftInstructions = $state("");
  let drafting = $state(false);
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadAiJob() {
    try {
      const previous = aiJob;
      aiJob = (await api.get<{ job: AiDraftJob | null }>(`/slides/${deckId}/ai/generate`)).job;
      const running = aiJob?.status === "queued" || aiJob?.status === "running";
      if (previous && (previous.status === "queued" || previous.status === "running") && !running && aiJob) onDraftDone(aiJob);
      clearTimeout(jobTimer);
      if (running) jobTimer = setTimeout(loadAiJob, document.hidden ? 5000 : 1500);
    } catch {}
  }
  $effect(() => () => clearTimeout(jobTimer));
  function onDraftDone(job: AiDraftJob) {
    if (job.status === "succeeded") {
      const r = job.result;
      if (r?.partial && r.warning) toasts.show(r.warning, "error");
      else toasts.show(r?.valid === false ? t("slides.editor.ai.draftInvalid") : r?.fixed ? t("slides.editor.ai.draftFixed") : t("slides.editor.ai.draftDone"), r?.valid === false ? "error" : "success");
      void load(false);
    } else if (job.status === "failed") toasts.show(job.error ?? t("slides.editor.ai.draftFailed"), "error");
  }
  async function submitDraft(event?: Event) {
    event?.preventDefault();
    drafting = true;
    try {
      await flushAll();
      const result = await api.post<{ job: AiDraftJob }>(`/slides/${deckId}/ai/generate`, { replace: true, ...(draftInstructions.trim() ? { instructions: draftInstructions.trim() } : {}) });
      aiJob = result.job;
      aiDraftOpen = false;
      void loadAiJob();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      drafting = false;
    }
  }
  async function cancelDraft() {
    try {
      await api.del(`/slides/${deckId}/ai/generate`);
      void loadAiJob();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  const stageLabel = (stage: string) => {
    const known = ["context", "generating", "continuing", "writing", "validating", "fixing", "visual_check", "publishing", "waiting_llm", "queued", "starting", "done"];
    return known.includes(stage) ? t(`slides.editor.ai.stage.${stage}` as "slides.editor.ai.stage.context") : stage;
  };

  // ── files ──────────────────────────────────────────────────────────────────────────────
  let pathOpen = $state(false);
  let pathMode = $state<"new" | "rename">("new");
  let pathValue = $state("");
  let pathTarget = $state<SourceFile | null>(null);
  let pathBusy = $state(false);
  let pathError = $state<string | null>(null);
  let deleteTarget = $state<SourceFile | null>(null);
  let deleteOpen = $state(false);

  function askNew() {
    pathMode = "new";
    pathValue = "";
    pathTarget = null;
    pathError = null;
    pathOpen = true;
  }
  function askRename(file: SourceFile) {
    pathMode = "rename";
    pathValue = file.path;
    pathTarget = file;
    pathError = null;
    pathOpen = true;
  }
  async function submitPath(event?: Event) {
    event?.preventDefault();
    const value = pathValue.trim();
    if (!value) return;
    pathBusy = true;
    pathError = null;
    try {
      if (pathMode === "new") {
        const content = value.endsWith(".qmd") || value.endsWith(".md") ? t("slides.editor.newPage") : "";
        const result = await api.put<{ file: SourceFile }>(`/slides/${deckId}/source/files`, { path: value, content, baseVersion: 0 });
        pathOpen = false;
        await load();
        open(data?.files.find(f => f.id === result.file.id) ?? null);
      } else if (pathTarget) {
        await flushAll();
        await api.patch(`/slides/${deckId}/source/files/${pathTarget.id}`, { path: value });
        pathOpen = false;
        await load();
      }
      schedulePreview();
    } catch (e) {
      pathError = (e as Error).message;
    } finally {
      pathBusy = false;
    }
  }
  async function removeFile() {
    if (!deleteTarget) return;
    await api.del(`/slides/${deckId}/source/files/${deleteTarget.id}`);
    if (activeId === deleteTarget.id) activeId = null;
    await load(false);
    schedulePreview();
  }
  async function setEntry(file: SourceFile) {
    try {
      await flushAll();
      await api.patch(`/slides/${deckId}/source`, { entry: file.path });
      await load();
      schedulePreview();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function upload(list: File[]) {
    let last: SourceFile | null = null;
    for (const file of list) {
      const form = new FormData();
      form.append("file", file, file.name);
      try {
        last = (await api.post<{ file: SourceFile }>(`/slides/${deckId}/source/files`, form)).file;
        // An image uploaded while writing a slide goes in at the cursor.
        if (last && isImage(last.path) && active?.kind === "text" && /\.(q?md)$/.test(active.path) && view && !readOnly) {
          const at = view.state.selection.main.head;
          view.dispatch({ changes: { from: at, insert: `![](${last.path})` }, selection: { anchor: at + last.path.length + 5 } });
        }
      } catch (e) {
        toasts.show(`${file.name}：${(e as Error).message}`, "error");
      }
    }
    await load();
    if (last) toasts.show(t("slides.editor.uploaded", { n: list.length }), "success");
    schedulePreview();
  }

  // ── start / publish ────────────────────────────────────────────────────────────────────
  let template = $state<DeckTemplate>(untrack(() => (deck.project.kind === "paper_report" ? "paper_report" : "progress")));
  let starting = $state(false);
  async function start() {
    starting = true;
    try {
      await api.post(`/slides/${deckId}/source`, { template });
      await load(false);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      starting = false;
    }
  }
  let publishing = $state(false);
  async function publish() {
    publishing = true;
    try {
      await flushAll();
      if (saveError) throw new Error(saveError.message);
      const result = await api.post<{ version: number }>(`/slides/${deckId}/source/publish`);
      toasts.show(t("slides.editor.published", { n: result.version }), "success");
      await goto(deckUrl(studySlug, deckId) + "#versions");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      publishing = false;
    }
  }
  async function discardLocal() {
    if (!activeId) return;
    saveError = null;
    await reloadFile(activeId);
  }

  const tabOptions = $derived([
    { value: "edit" as const, label: t("slides.editor.tab.edit") },
    { value: "preview" as const, label: t("slides.editor.tab.preview") },
    { value: "files" as const, label: t("slides.editor.tab.files") },
  ]);
  const rawUrl = (file: SourceFile) => `/api/slides/${deckId}/source/files/${file.id}/raw?v=${file.version}`;
</script>

<div class="flex flex-col gap-4">
  <header class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
    <div class="min-w-0">
      <a href={deckUrl(studySlug, deckId)} class="-ml-2 mb-1 inline-flex h-10 max-w-full items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink">
        <ArrowLeft class="size-4 shrink-0" /><span class="truncate">{t("slides.editor.back")}</span>
      </a>
      <h1 class="font-display text-[26px] leading-tight text-balance text-ink sm:text-[32px]">{deck.project.title}</h1>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-3" aria-live="polite">
        <span class="inline-flex items-center gap-1.5"><FileCode2 class="size-3.5" />Quarto · Lab-Hub</span>
        {#if data?.source}
          <span aria-hidden="true">·</span>
          {#if saving}
            <span class="inline-flex items-center gap-1.5"><LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />{t("slides.editor.saving")}</span>
          {:else if saveError}
            <span class="inline-flex items-center gap-1.5 text-danger"><CircleAlert class="size-3.5" />{t("slides.editor.saveFailed")}</span>
          {:else if dirtyIds.length}
            <span>{t("slides.editor.unsaved")}</span>
          {:else}
            <span class="inline-flex items-center gap-1.5"><Check class="size-3.5" />{t("slides.editor.saved")}{data.source.updated_by_name ? ` · ${data.source.updated_by_name} ${relativeTime(data.source.updated_at)}` : ""}</span>
          {/if}
          {#if unpublished}<Pill tone="butter" size="sm">{t("slides.edit.unpublished")}</Pill>{/if}
        {/if}
      </div>
    </div>
    {#if data?.source && canEdit}
      <div class="flex shrink-0 items-center gap-1.5 max-sm:w-full sm:flex-wrap sm:gap-2">
        <AiGate role="slides" inline>
          <!-- Phones: the AI actions are icon buttons (title + accessible name), so the row stays one line with 發布. -->
          <Button variant="secondary" title={t("slides.editor.ai.draft")} disabled={aiRunning} onclick={() => ((draftInstructions = ""), (aiDraftOpen = true))}><Sparkles /><span class="max-sm:sr-only">{t("slides.editor.ai.draft")}</span></Button>
          <Button variant="secondary" title={t("slides.editor.ai.edit")} disabled={aiRunning || reviewing || active?.kind !== "text"} onclick={openAiEdit}><Wand2 /><span class="max-sm:sr-only">{t("slides.editor.ai.edit")}</span></Button>
          <SlideLayoutReview
            {deckId}
            hasSource
            iconOnlyMobile
            onOpenFile={ref => open(files.find(f => f.id === ref.fileId || f.path === ref.path) ?? null)}
            onSuggested={fileId => fileId === activeId && void loadSuggestions(fileId)}
          />
        </AiGate>
        <Button variant="primary" class="max-sm:min-w-0 max-sm:flex-1" title={t("slides.editor.publish")} loading={publishing} disabled={aiRunning || reviewing} onclick={publish}><Send /><span class="truncate">{t("slides.editor.publish")}</span></Button>
      </div>
    {/if}
  </header>

  {#if loadError}
    <Card><EmptyState title={t("common.error")} hint={loadError} class="py-12" /></Card>
  {:else if !data}
    <div class="grid gap-4 lg:grid-cols-2"><Skeleton class="h-[60vh] rounded-[22px]" /><Skeleton class="aspect-[16/10] rounded-[22px]" /></div>
  {:else if !data.source}
    <Card>
      <EmptyState title={t("slides.editor.empty")} hint={canEdit ? t("slides.editor.emptyHint") : t("slides.editor.emptyViewer")} class="py-12">
        {#snippet icon()}<FileCode2 />{/snippet}
        {#snippet action()}
          {#if canEdit}
            <div class="flex w-full max-w-md flex-col items-stretch gap-3">
              <Segmented bind:value={template} label={t("slides.editor.template")} class="w-full" options={[
                { value: "progress", label: t("slides.kind.progress") },
                { value: "paper_report", label: t("slides.kind.paper_report") },
                { value: "blank", label: t("slides.editor.template.blank") },
              ]} />
              <Button variant="primary" loading={starting} onclick={start}><FileCode2 />{t("slides.editor.start")}</Button>
            </div>
          {/if}
        {/snippet}
      </EmptyState>
    </Card>
  {:else}
    {#if aiJob && (aiRunning || aiJob.status === "failed")}
      <div class="flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center" style="border-color:var(--pill-lilac-ink);background:var(--pill-lilac);color:var(--pill-lilac-ink)" role="status">
        <span class="hidden size-10 shrink-0 place-items-center rounded-xl bg-surface/70 sm:grid">{#if aiRunning}<LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" />{:else}<CircleAlert class="size-5" />{/if}</span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{aiRunning ? t("slides.editor.ai.running") : t("slides.editor.ai.draftFailed")}</p>
          <p class="mt-0.5 text-[12.5px] opacity-90">{aiRunning ? `${stageLabel(aiJob.stage)} · ${aiJob.progress}%` : aiJob.error}</p>
          {#if aiRunning}<Progress class="mt-2" value={aiJob.progress || null} />{/if}
        </div>
        {#if aiRunning && canEdit}<Button size="sm" variant="ghost" onclick={cancelDraft}><X />{t("slides.editor.ai.cancel")}</Button>{/if}
      </div>
    {/if}
    {#if reviewing && canEdit}
      <div class="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3.5 sm:flex-row sm:items-center">
        <p class="min-w-0 flex-1 text-[13px] text-ink-2">{t("slides.editor.ai.reviewHint", { n: liveHunks.length })}{staleCount ? ` ${t("slides.editor.ai.staleHint", { n: staleCount })}` : ""}</p>
        <div class="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onclick={() => decideAll("reject")}>{t("slides.editor.ai.rejectAll")}</Button>
          {#if liveHunks.length}<Button size="sm" variant="primary" onclick={() => decideAll("accept")}><Check />{t("slides.editor.ai.acceptAll")}</Button>{/if}
        </div>
      </div>
    {/if}
    {#if saveError}
      <div class="flex flex-col gap-2 rounded-2xl bg-danger-soft p-3.5 text-[13px] text-danger sm:flex-row sm:items-center">
        <p class="min-w-0 flex-1">{saveError.message}</p>
        {#if saveError.conflict}<Button size="sm" variant="secondary" onclick={discardLocal}>{t("slides.editor.reloadFile")}</Button>{/if}
      </div>
    {/if}

    <div class="lg:hidden"><Segmented bind:value={mobileTab} label={t("slides.editor.view")} options={tabOptions} class="w-full" /></div>

    <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-3">
      <aside class="min-w-0 rounded-[22px] border border-line/70 bg-surface p-2.5 shadow-card {mobileTab === 'files' ? '' : 'max-lg:hidden'} {treeOpen ? 'lg:block' : 'lg:hidden'} lg:w-56 lg:shrink-0 lg:self-stretch lg:overflow-y-auto">
        <FileTree {files} entry={data.source.entry} {activeId} {canEdit} dirty={dirtyIds} onOpen={f => open(f)} onNew={askNew} onUpload={upload} onRename={askRename}
          onDelete={f => ((deleteTarget = f), (deleteOpen = true))} onSetEntry={setEntry} />
      </aside>

      <div bind:this={splitBox} class="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row lg:items-start lg:gap-0 {splitting ? 'cursor-col-resize select-none' : ''}">
      <section
        class="flex min-w-0 flex-col overflow-hidden rounded-[22px] border border-line/70 bg-surface shadow-card lg:flex-1 {mobileTab === 'edit' ? '' : 'max-lg:hidden'}"
        style={sideBySide ? `flex:0 0 calc(${(split * 100).toFixed(2)}% - 6px)` : undefined}
        aria-label={t("slides.editor.tab.edit")}
      >
        <div class="flex min-h-12 items-center gap-1 border-b border-line px-2 py-1.5">
          <span class="hidden lg:contents">
            <Button size="icon-sm" variant={treeOpen ? "secondary" : "ghost"} aria-pressed={treeOpen} title={t("slides.editor.files")} aria-label={t("slides.editor.files")} onclick={() => ((treeOpen = !treeOpen), saveFlag("quarto.tree", treeOpen))}><FolderTree /></Button>
          </span>
          <span class="ml-1 min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-2" title={active?.path}>{active?.path ?? ""}</span>
          {#if readOnly && active?.kind === "text"}<Pill size="sm">{t("slides.editor.readOnly")}</Pill>{/if}
          <span class="hidden lg:contents">
            <Button size="icon-sm" variant={previewHidden ? "secondary" : "ghost"} aria-pressed={previewHidden} title={previewHidden ? t("slides.editor.preview.show") : t("slides.editor.preview.hide")} aria-label={previewHidden ? t("slides.editor.preview.show") : t("slides.editor.preview.hide")} onclick={() => ((previewHidden = !previewHidden), saveFlag("quarto.previewHidden", previewHidden))}>
              {#if previewHidden}<PanelRightOpen />{:else}<PanelRightClose />{/if}
            </Button>
          </span>
        </div>
        <div class="h-[62dvh] min-h-[360px] lg:h-[calc(100dvh-14.5rem)] lg:min-h-[420px]">
          {#if active?.kind === "text"}
            {#key active.id}
              {#await languageFor(active.path) then language}
                <CodeEditor
                  bind:view
                  value={text}
                  {language}
                  {readOnly}
                  mono
                  fontSize={14}
                  label={t("slides.editor.label", { path: active.path })}
                  placeholder={t("slides.editor.placeholder")}
                  extensions={[cursorTracker, review]}
                  class="h-full"
                  onchange={onEdit}
                />
              {/await}
            {/key}
          {:else if active}
            <div class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
              {#if isImage(active.path)}
                <img src={rawUrl(active)} alt={active.path} class="max-h-[50vh] max-w-full rounded-xl border border-line bg-[repeating-conic-gradient(var(--surface-2)_0%_25%,var(--surface)_0%_50%)] bg-[length:16px_16px] object-contain" />
              {/if}
              <p class="font-mono text-[12.5px] text-ink-3">{active.path}</p>
              <Button size="sm" variant="secondary" onclick={async () => (await copyText(`![](${active!.path})`)) && toasts.show(t("slides.editor.copied"), "success")}><Copy />{t("slides.editor.copyMarkdown")}</Button>
            </div>
          {/if}
        </div>
      </section>

      {#if sideBySide}
        <SplitHandle container={splitBox} bind:ratio={split} bind:dragging={splitting} label={t("slides.editor.split")} onCommit={r => saveRatio("quarto", r)} class="self-stretch" />
      {/if}
      <section
        class="min-w-0 rounded-[22px] border border-line/70 bg-surface p-3 shadow-card lg:sticky lg:top-4 lg:flex-1 {mobileTab === 'preview' ? '' : 'max-lg:hidden'} {previewHidden ? 'lg:hidden' : ''} {splitting ? 'pointer-events-none' : ''}"
        aria-label={t("slides.editor.tab.preview")}
      >
        <PreviewPane {preview} slide={cursorSlide} stale={previewStale} canRefresh={canEdit} notes onRefresh={() => void flushAll().then(requestPreview)} />
        <p class="mt-2.5 px-1 text-[12px] leading-relaxed text-ink-3">{t("slides.editor.preview.hint")}</p>
      </section>
      </div>
    </div>
  {/if}
</div>

<Sheet bind:open={filesSheet} side="right" title={t("slides.editor.files")}>
  {#if data?.source}
    <FileTree {files} entry={data.source.entry} {activeId} {canEdit} dirty={dirtyIds} onOpen={f => open(f)} onNew={askNew} onUpload={upload} onRename={askRename}
      onDelete={f => ((deleteTarget = f), (deleteOpen = true))} onSetEntry={setEntry} />
  {/if}
</Sheet>

<Sheet bind:open={pathOpen} side="right" title={pathMode === "new" ? t("slides.editor.newFile") : t("slides.editor.rename")} description={t("slides.editor.pathHint")}>
  <form class="flex flex-col gap-4 pt-2" onsubmit={submitPath}>
    <TextField label={t("slides.editor.path")} bind:value={pathValue} maxlength={200} required autocapitalize="off" spellcheck={false} placeholder="sections/intro.qmd" error={pathError} />
    <Button type="submit" variant="primary" size="lg" class="w-full" loading={pathBusy} disabled={!pathValue.trim()}>{pathMode === "new" ? t("slides.editor.create") : t("slides.editor.rename")}</Button>
  </form>
</Sheet>

<Sheet bind:open={aiEditOpen} side="right" title={t("slides.editor.ai.edit")} description={aiSelection ? t("slides.editor.ai.editSelection", { n: aiSelection.to - aiSelection.from }) : t("slides.editor.ai.editFile", { path: active?.path ?? "" })}>
  <form class="flex flex-col gap-4 pt-2" onsubmit={submitAiEdit}>
    <Textarea label={t("slides.editor.ai.instruction")} bind:value={aiInstruction} rows={4} maxlength={2000} required placeholder={t("slides.editor.ai.instructionPlaceholder")} hint={t("slides.editor.ai.instructionHint")} />
    <Button type="submit" variant="primary" size="lg" class="w-full" loading={aiEditing} disabled={!aiInstruction.trim()}><Wand2 />{t("slides.editor.ai.editSubmit")}</Button>
  </form>
</Sheet>

<Sheet bind:open={aiDraftOpen} side="right" title={t("slides.editor.ai.draft")} description={t(deck.project.kind === "paper_report" ? "slides.create.source.aiHint.paper" : "slides.create.source.aiHint.progress")}>
  <form class="flex flex-col gap-4 pt-2" onsubmit={submitDraft}>
    {#if revision > 1}
      <p class="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2"><CircleAlert class="mt-0.5 size-4 shrink-0" />{t("slides.editor.ai.replaceWarning", { path: data?.source?.entry ?? "index.qmd" })}</p>
    {/if}
    <Textarea label={t("slides.create.instructions")} bind:value={draftInstructions} rows={4} maxlength={2000} placeholder={t("slides.create.instructionsPlaceholder")} hint={t("slides.create.instructionsHint")} />
    <Button type="submit" variant="primary" size="lg" class="w-full" loading={drafting}><Sparkles />{t("slides.create.submitAi")}</Button>
  </form>
</Sheet>

<ConfirmDialog
  bind:open={deleteOpen}
  title={t("slides.editor.deleteTitle", { path: deleteTarget?.path ?? "" })}
  description={t("slides.editor.deleteDescription")}
  confirmLabel={t("slides.editor.delete")}
  onConfirm={removeFile}
/>
