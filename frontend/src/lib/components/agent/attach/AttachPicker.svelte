<script lang="ts">
  import { Dialog } from "bits-ui";
  import { Check, ChevronLeft, ChevronRight, FolderOpen, MapPin, Search, Upload, X } from "@lucide/svelte";
  import { t, formatDate, relativeTime } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import type { PageContext } from "#lib/agent/types.ts";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import KindIcon from "./KindIcon.svelte";
  import { attachFormats, latexFiles, listItems, listStudies, resolveRefs } from "./api.ts";
  import type { AttachDraft } from "./state.svelte.ts";
  import { MAX_ATTACHMENTS, type Attachment, type AttachmentRef, type LatexFile, type PickerCategory, type PickerItem, type PickerStudy } from "./types.ts";

  /**
   * 「附加」 picker: upload files, or study → category (筆記／文獻／簡報／會議／論文) → items (multi-select; deck version,
   * LaTeX sections). Selections go straight into the draft (chips update live). Full-screen stepper on phones, a centred
   * panel from `sm`. Breadcrumb + back navigate between steps; Esc / 完成 closes.
   */
  let { open = $bindable(false), draft, context = null, conversationId = null }: {
    open?: boolean;
    draft: AttachDraft;
    context?: PageContext | null;
    conversationId?: string | null;
  } = $props();

  type Step = "home" | "studies" | "items" | "latex";
  const CATS: PickerCategory[] = ["note", "paper", "deck", "meeting", "latex_project"];
  let step = $state<Step>("home");
  let study = $state<{ id: string; slug: string; title: string } | null>(null);
  let cat = $state<PickerCategory>("note");
  let project = $state<{ id: string; title: string; study: Attachment["study"] } | null>(null);

  let q = $state("");
  let loading = $state(false);
  let failed = $state<string | null>(null);
  let studies = $state<PickerStudy[]>([]);
  let items = $state<PickerItem[]>([]);
  let files = $state<LatexFile[]>([]);
  let accept = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let current = $state<Attachment | null>(null);

  // ---------------------------------------------------------------- open / reset
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      step = "home";
      q = "";
      failed = null;
      void attachFormats().then((f) => (accept = f.accept)).catch(() => undefined);
      void loadCurrent();
    }
    wasOpen = open;
  });

  const ctxRef = $derived.by((): AttachmentRef | null => {
    const c = context;
    if (!c) return null;
    if (c.noteId) return { kind: "note", id: c.noteId };
    if (c.deckId) return { kind: "deck", id: c.deckId };
    if (c.meetingId) return { kind: "meeting", id: c.meetingId };
    if (c.paperId) return { kind: "paper", id: c.paperId };
    return null;
  });
  async function loadCurrent() {
    current = null;
    const ref = ctxRef;
    if (!ref) return;
    try {
      current = (await resolveRefs([ref], conversationId)).attachments[0] ?? null;
    } catch {
      current = null;
    }
  }

  // ---------------------------------------------------------------- loading (debounced search)
  let seq = 0;
  async function load() {
    const my = ++seq;
    loading = true;
    failed = null;
    try {
      if (step === "studies") {
        const r = await listStudies(q);
        if (my === seq) studies = r.studies;
      } else if (step === "items" && study) {
        const r = await listItems(study.id, cat, q);
        if (my === seq) items = r.items;
      } else if (step === "latex" && project) {
        const r = await latexFiles(project.id);
        if (my === seq) files = r.files;
      }
    } catch (e) {
      if (my === seq) failed = (e as Error).message;
    } finally {
      if (my === seq) loading = false;
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Re-load on step / study / category / query change.
    void step;
    void cat;
    void study?.id;
    void project?.id;
    const query = q;
    if (!open || step === "home") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(), query ? 220 : 0);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  function go(next: Step) {
    step = next;
    q = "";
    failed = null;
    if (next === "studies") studies = [];
    if (next === "items") items = [];
    if (next === "latex") files = [];
    queueMicrotask(() => {
      if (next !== "latex" && matchMedia("(pointer: fine)").matches) searchEl?.focus();
    });
  }
  function pickStudy(s: { id: string; slug: string; title: string }) {
    study = { id: s.id, slug: s.slug, title: s.title };
    go("items");
  }
  function back() {
    if (step === "latex") go("items");
    else if (step === "items") go(context?.studySlug && study?.slug === context.studySlug && !studies.length ? "home" : "studies");
    else go("home");
  }

  const mine = $derived(studies.filter((s) => s.mine));
  const lab = $derived(studies.filter((s) => !s.mine));

  // ---------------------------------------------------------------- selection
  function full() {
    toasts.show(t("attach.full", { max: MAX_ATTACHMENTS }), "error");
  }
  function toggle(a: Attachment) {
    if (!draft.toggle(a)) full();
  }
  const studyRef = $derived(study ? { id: study.id, slug: study.slug, title: study.title } : null);
  function itemAttachment(it: PickerItem): Attachment {
    const s = study!;
    const kind = cat;
    const url =
      kind === "note" ? `/studies/${encodeURIComponent(s.slug)}/notes/${it.id}`
      : kind === "deck" ? `/studies/${encodeURIComponent(s.slug)}/decks/${it.id}`
      : kind === "meeting" ? `/meetings/${it.id}`
      : kind === "paper" ? `/library?paper=${it.id}`
      : `/studies/${encodeURIComponent(s.slug)}/latex/${it.id}`;
    return { kind, id: it.id, title: it.title, study: kind === "paper" ? null : studyRef, url };
  }
  function setVersion(it: PickerItem, versionId: string) {
    const base = itemAttachment(it);
    const v = it.versions?.find((x) => x.id === versionId);
    const a: Attachment = versionId === "active" || !v ? base : { ...base, version: v.id, version_label: `v${v.version}` };
    if (!draft.add(a)) full();
  }
  function fileAttachment(f: LatexFile): Attachment {
    const p = project!;
    return { kind: "latex_file", id: f.id, project_id: p.id, title: `${p.title} · ${f.path}`, study: p.study, url: `/studies/${encodeURIComponent(p.study?.slug ?? "")}/latex/${p.id}?file=${f.id}` };
  }

  function meta(it: PickerItem): string {
    const bits: string[] = [];
    if (cat === "note") {
      if (it.note_kind) bits.push(t(`notes.kind.${it.note_kind}` as MessageKey));
      if (it.author) bits.push(it.author);
    } else if (cat === "paper") {
      if (it.authors) bits.push(it.authors.split(";")[0]!.trim() + (it.authors.includes(";") ? " et al." : ""));
      if (it.year) bits.push(String(it.year));
      if (it.venue) bits.push(it.venue);
    } else if (cat === "deck") {
      if (it.deck_kind) bits.push(t(`slides.kind.${it.deck_kind}` as MessageKey));
      const active = it.versions?.find((v) => v.id === it.active_version_id);
      if (active?.page_count) bits.push(t("attach.deck.pages", { n: active.page_count }));
    } else if (cat === "meeting") {
      if (it.date) return formatDate(it.date, { year: "numeric", month: "short", day: "numeric", weekday: "short" });
    } else if (cat === "latex_project") {
      if (it.latex_kind) bits.push(t(`latex.kind.${it.latex_kind}` as MessageKey));
      if (it.text_files) bits.push(t("attach.latex.files", { n: it.text_files }));
    }
    if (it.date && cat !== "meeting") bits.push(relativeTime(it.date));
    return bits.filter(Boolean).join(" · ");
  }
  function versionOptions(it: PickerItem) {
    const active = it.versions?.find((v) => v.id === it.active_version_id);
    return [
      { value: "active", label: active ? t("attach.deck.active", { n: active.version }) : t("attach.deck.version") },
      ...(it.versions ?? []).filter((v) => v.id !== it.active_version_id && (v.status === "published" || v.status === "review")).map((v) => ({ value: v.id, label: t("attach.deck.versionN", { n: v.version }), hint: formatDate(v.created_at) })),
    ];
  }

  // ---------------------------------------------------------------- uploads
  async function uploadFiles(list: FileList | File[] | null) {
    const arr = list ? [...list] : [];
    if (!arr.length) return;
    open = false;
    const r = await draft.upload(arr);
    if ("error" in r && r.error) toasts.show(r.error, "error");
    if (r.skipped) toasts.show(t("attach.skipped", { n: r.skipped }), "error");
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    void uploadFiles(e.dataTransfer?.files ?? null);
  }

  const catLabel = (c: PickerCategory) => t(`attach.cat.${c}` as MessageKey);
  const crumbs = $derived.by(() => {
    const out: { label: string; to: Step | null }[] = [{ label: t("attach.root"), to: step === "home" ? null : "home" }];
    if (step === "studies" || step === "items" || step === "latex") out.push({ label: t("attach.home.study"), to: step === "studies" ? null : "studies" });
    if ((step === "items" || step === "latex") && study) out.push({ label: study.title, to: step === "items" ? null : "items" });
    if (step === "latex" && project) out.push({ label: project.title, to: null });
    return out;
  });
  const searchLabel = $derived(step === "studies" ? t("attach.studies.search") : t("attach.items.search", { cat: catLabel(cat) }));

  function tabKeys(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = CATS.indexOf(cat);
    cat = CATS[(i + (e.key === "ArrowRight" ? 1 : CATS.length - 1)) % CATS.length]!;
    queueMicrotask(() => (document.getElementById(`attach-tab-${cat}`) as HTMLElement | null)?.focus());
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out] motion-reduce:animate-none" />
    <Dialog.Content
      class="picker fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(640px,calc(100dvh-48px))] sm:w-[min(640px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] sm:border sm:border-line sm:pt-0 sm:pb-0 sm:shadow-pop"
      ondragover={(e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          dragging = true;
        }
      }}
      ondragleave={(e: DragEvent) => {
        if (e.currentTarget === e.target) dragging = false;
      }}
      ondrop={onDrop}
    >
      <!-- Header: back, title / breadcrumb, close -->
      <header class="flex items-center gap-1 border-b border-line px-2 py-2 sm:px-3">
        {#if step !== "home"}
          <button type="button" class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink" aria-label={t("attach.back")} onclick={back}><ChevronLeft class="size-5" /></button>
        {:else}
          <span class="w-2"></span>
        {/if}
        <div class="min-w-0 flex-1">
          <Dialog.Title class="truncate text-[15px] font-semibold text-ink">{t("attach.title")}</Dialog.Title>
          <Dialog.Description class="sr-only">{t("attach.desc")}</Dialog.Description>
          {#if step !== "home"}
            <nav aria-label={t("attach.crumbs")} class="-mt-0.5">
              <ol class="flex min-w-0 items-center gap-0.5 overflow-hidden text-[12px] text-ink-3">
                {#each crumbs as c, i (i)}
                  {#if i > 0}<li aria-hidden="true"><ChevronRight class="size-3 shrink-0" /></li>{/if}
                  <li class="min-w-0 {i === crumbs.length - 1 ? 'truncate' : 'shrink-0 max-w-[40%] truncate'}">
                    {#if c.to}
                      <button type="button" class="max-w-full truncate rounded hover:text-ink hover:underline" onclick={() => go(c.to!)}>{c.label}</button>
                    {:else}
                      <span aria-current="page" class="text-ink-2">{c.label}</span>
                    {/if}
                  </li>
                {/each}
              </ol>
            </nav>
          {/if}
        </div>
        <Dialog.Close class="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")}><X class="size-4.5" /></Dialog.Close>
      </header>

      {#if step === "items"}
        <div class="border-b border-line px-3 pt-2">
          <div role="tablist" aria-label={t("attach.categories")} tabindex="-1" class="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2" onkeydown={tabKeys}>
            {#each CATS as c (c)}
              <button
                type="button"
                role="tab"
                id={`attach-tab-${c}`}
                aria-selected={cat === c}
                tabindex={cat === c ? 0 : -1}
                class="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors motion-reduce:transition-none {cat === c ? 'bg-ink text-primary-ink' : 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink'}"
                onclick={() => (cat = c)}
              >
                <KindIcon kind={c} class="size-4" />{catLabel(c)}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if step === "studies" || step === "items"}
        <div class="px-3 pt-3">
          <label class="relative block">
            <span class="sr-only">{searchLabel}</span>
            <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
            <input bind:this={searchEl} bind:value={q} type="search" placeholder={searchLabel} data-guard-ignore class="h-11 w-full rounded-xl border border-line-2 bg-surface pr-3 pl-10 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm" />
          </label>
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" aria-busy={loading}>
        {#if step === "home"}
          <ul class="flex flex-col gap-2">
            {#if current}
              {@const on = draft.has(current.kind, current.id)}
              <li>
                <button type="button" class="row {on ? 'row-on' : ''}" aria-pressed={on} onclick={() => toggle(current!)}>
                  <span class="icon bg-[var(--pill-sky)] text-[var(--pill-sky-ink)]"><MapPin class="size-5" /></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-[14px] font-medium text-ink">{t("attach.home.current")}</span>
                    <span class="flex items-center gap-1 truncate text-[12.5px] text-ink-3"><KindIcon kind={current.kind} class="size-3.5 shrink-0" /><span class="truncate">{current.title}</span></span>
                  </span>
                  <span class="grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] {on ? 'border-ink bg-ink text-surface' : 'border-line-2 text-transparent'}" aria-hidden="true"><Check class="size-3.5" strokeWidth={3} /></span>
                </button>
              </li>
            {/if}
            <li>
              <button type="button" class="row {dragging ? 'row-on' : ''}" onclick={() => fileInput?.click()}>
                <span class="icon bg-[var(--pill-mint)] text-[var(--pill-mint-ink)]"><Upload class="size-5" /></span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[14px] font-medium text-ink">{dragging ? t("attach.home.drop") : t("attach.home.upload")}</span>
                  <span class="block text-[12.5px] leading-snug text-ink-3">{t("attach.home.uploadHint")}</span>
                </span>
                <ChevronRight class="size-4 shrink-0 text-ink-3" />
              </button>
            </li>
            <li>
              <button type="button" class="row" onclick={() => go("studies")}>
                <span class="icon bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]"><FolderOpen class="size-5" /></span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[14px] font-medium text-ink">{t("attach.home.study")}</span>
                  <span class="block text-[12.5px] leading-snug text-ink-3">{t("attach.home.studyHint")}</span>
                </span>
                <ChevronRight class="size-4 shrink-0 text-ink-3" />
              </button>
            </li>
            {#if context?.studySlug}
              <li>
                <button type="button" class="row" onclick={() => pickStudy({ id: context!.studyId ?? context!.studySlug!, slug: context!.studySlug!, title: (context as { studyTitle?: string }).studyTitle ?? context!.studySlug! })}>
                  <span class="icon bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]"><MapPin class="size-5" /></span>
                  <span class="min-w-0 flex-1"><span class="block text-[14px] font-medium text-ink">{t("attach.home.currentStudy")}</span></span>
                  <ChevronRight class="size-4 shrink-0 text-ink-3" />
                </button>
              </li>
            {/if}
          </ul>
          <input bind:this={fileInput} type="file" multiple {accept} class="hidden" tabindex="-1" aria-hidden="true" onchange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            void uploadFiles(input.files);
            input.value = "";
          }} />
        {:else if failed}
          <div class="flex flex-col items-center gap-3 py-10 text-center text-[13px] text-ink-2" role="alert">
            <p>{t("attach.loadFailed")}：{failed}</p>
            <Button size="sm" variant="secondary" onclick={() => void load()}>{t("attach.retry")}</Button>
          </div>
        {:else if loading && ((step === "studies" && !studies.length) || (step === "items" && !items.length) || (step === "latex" && !files.length))}
          <div class="grid place-items-center py-12 text-ink-3"><Spinner class="size-5" /></div>
        {:else if step === "studies"}
          {#if !studies.length}
            <p class="py-10 text-center text-[13px] text-ink-3">{t("attach.studies.empty")}</p>
          {/if}
          {#each [{ label: t("attach.studies.mine"), list: mine }, { label: t("attach.studies.lab"), list: lab }] as group (group.label)}
            {#if group.list.length}
              <h3 class="px-1 pt-1 pb-1.5 text-[12px] font-medium tracking-wide text-ink-3">{group.label}</h3>
              <ul class="mb-3 flex flex-col gap-1">
                {#each group.list as s (s.id)}
                  <li>
                    <button type="button" class="row py-2.5" onclick={() => pickStudy(s)}>
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-2"><span class="truncate text-[14px] font-medium text-ink">{s.title}</span>{#if s.status === "archived"}<Pill size="sm">{t("attach.studies.archived")}</Pill>{/if}</span>
                        <span class="block truncate text-[12px] text-ink-3">{[s.owner ? t("attach.studies.owner", { name: s.owner }) : "", relativeTime(s.activity_at)].filter(Boolean).join(" · ")}</span>
                      </span>
                      <ChevronRight class="size-4 shrink-0 text-ink-3" />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
        {:else if step === "items"}
          {#if !items.length}
            <p class="py-10 text-center text-[13px] text-ink-3">{q ? t("attach.items.noMatch", { cat: catLabel(cat) }) : t("attach.items.empty", { cat: catLabel(cat) })}</p>
          {:else}
            <ul class="flex flex-col gap-1">
              {#each items as it (it.id)}
                {@const on = draft.has(cat, it.id)}
                {@const chosen = draft.find(cat, it.id)}
                <li class="item {on ? 'item-on' : ''}">
                  <div class="flex min-h-[56px] items-center gap-2.5 py-1.5 pr-2 pl-3">
                    <CheckCircle checked={on} label={it.title} disabled={!on && draft.full} onToggle={() => toggle(itemAttachment(it))} />
                    <button type="button" class="min-w-0 flex-1 py-1 text-left disabled:opacity-50" disabled={!on && draft.full} onclick={() => toggle(itemAttachment(it))}>
                      <span class="block truncate text-[14px] font-medium text-ink">{it.title}</span>
                      <span class="block truncate text-[12px] text-ink-3">{meta(it)}{#if cat === "paper" && it.has_pdf} · {t("attach.paper.pdf")}{/if}</span>
                    </button>
                    {#if cat === "latex_project" && (it.text_files ?? 0) > 0}
                      <button type="button" class="inline-flex h-10 shrink-0 items-center gap-1 rounded-full px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={() => {
                        project = { id: it.id, title: it.title, study: studyRef };
                        go("latex");
                      }}>{t("attach.latex.sections")}<ChevronRight class="size-3.5" /></button>
                    {/if}
                  </div>
                  {#if cat === "deck" && on && (it.versions?.length ?? 0) > 1}
                    <div class="flex items-center gap-2 pr-3 pb-2.5 pl-[52px]">
                      <span class="text-[12px] text-ink-3">{t("attach.deck.version")}</span>
                      <Select value={chosen?.version ?? "active"} options={versionOptions(it)} label={t("attach.deck.version")} onValueChange={(v) => setVersion(it, v)} class="w-44" />
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {:else if step === "latex" && project}
          {@const whole = { kind: "latex_project" as const, id: project.id, title: project.title, study: project.study, url: `/studies/${encodeURIComponent(project.study?.slug ?? "")}/latex/${project.id}` }}
          <ul class="flex flex-col gap-1">
            <li class="item {draft.has('latex_project', project.id) ? 'item-on' : ''}">
              <div class="flex min-h-[52px] items-center gap-2.5 py-1.5 pr-2 pl-3">
                <CheckCircle checked={draft.has("latex_project", project.id)} label={t("attach.latex.whole")} onToggle={() => toggle(whole)} />
                <button type="button" class="min-w-0 flex-1 py-1 text-left text-[14px] font-medium text-ink" onclick={() => toggle(whole)}>{t("attach.latex.whole")}</button>
              </div>
            </li>
            {#if !files.length}
              <li class="py-8 text-center text-[13px] text-ink-3">{t("attach.latex.empty")}</li>
            {/if}
            {#each files as f (f.id)}
              {@const on = draft.has("latex_file", f.id)}
              <li class="item {on ? 'item-on' : ''}">
                <div class="flex min-h-[52px] items-center gap-2.5 py-1.5 pr-2 pl-3">
                  <CheckCircle checked={on} label={f.path} disabled={!on && draft.full} onToggle={() => toggle(fileAttachment(f))} />
                  <button type="button" class="min-w-0 flex-1 py-1 text-left disabled:opacity-50" disabled={!on && draft.full} onclick={() => toggle(fileAttachment(f))}>
                    <span class="block truncate text-[14px] font-medium text-ink">{f.heading ?? f.path}</span>
                    <span class="block truncate font-mono text-[11.5px] text-ink-3">{f.path}{f.role === "main" ? ` · ${t("attach.latex.main")}` : ""}</span>
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <footer class="flex items-center gap-3 border-t border-line px-4 py-3">
        <span class="min-w-0 flex-1 truncate text-[12.5px] {draft.full ? 'text-danger' : 'text-ink-3'}" aria-live="polite">
          {draft.full ? t("attach.full", { max: MAX_ATTACHMENTS }) : t("attach.count", { n: draft.count, max: MAX_ATTACHMENTS })}
        </span>
        <Button variant="primary" onclick={() => (open = false)}>{t("attach.done")}</Button>
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.picker) {
    animation: picker-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes picker-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }
  @media (min-width: 640px) {
    @keyframes picker-in {
      from {
        opacity: 0;
        transform: translate(-50%, calc(-50% + 8px));
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.picker) {
      animation: none;
    }
  }
  .row {
    display: flex;
    width: 100%;
    min-height: 56px;
    align-items: center;
    gap: 12px;
    border-radius: 16px;
    border: 1px solid var(--line);
    background: var(--surface);
    padding: 10px 12px;
    text-align: left;
    transition: background-color 120ms, border-color 120ms;
  }
  .row:hover {
    background: var(--surface-2);
    border-color: var(--line-2);
  }
  .row-on {
    border-color: var(--ink);
  }
  .icon {
    display: grid;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    place-items: center;
    border-radius: 12px;
  }
  .item {
    border-radius: 14px;
    transition: background-color 120ms;
  }
  .item:hover {
    background: var(--surface-2);
  }
  .item-on {
    background: var(--surface-2);
  }
  .no-scrollbar {
    scrollbar-width: none;
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .row,
    .item {
      transition: none;
    }
  }
</style>
