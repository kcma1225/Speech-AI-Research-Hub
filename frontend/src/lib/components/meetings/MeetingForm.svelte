<script lang="ts">
  import { untrack } from "svelte";
  import { ArrowLeft, ArrowRight, Check, Presentation, Search, UserPlus, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import type { DirectoryUser, StudyCard } from "#lib/studies/types.ts";
  import type { DeckOption } from "#lib/meetings/types.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { taipeiIso, type MeetingFormValue } from "#lib/meetings/util.ts";

  /**
   * Meeting details form. `wizard`: steps 基本資料 → 研究 → 參與者 → 簡報 (the create page); `stacked`: every section
   * at once (the edit sheet). Studies are searched across the whole lab and show their owner (林雅婷的研究2 · 林雅婷).
   */
  let {
    value = $bindable(),
    mode = "wizard",
    submitLabel,
    busy = false,
    onSubmit,
    onCancel,
  }: { value: MeetingFormValue; mode?: "wizard" | "stacked"; submitLabel: string; busy?: boolean; onSubmit: (body: Record<string, unknown>) => void; onCancel?: () => void } = $props();

  const STEPS = ["basics", "studies", "people", "decks"] as const;
  type Step = (typeof STEPS)[number];
  let step = $state<Step>("basics");
  let errors = $state<{ title?: string; date?: string; studies?: string }>({});

  // ---------------------------------------------------------------- studies
  let studyQuery = $state("");
  let studyResults = $state<StudyCard[] | null>(null);
  let seq = 0;
  $effect(() => {
    const q = studyQuery.trim();
    const timer = setTimeout(async () => {
      const id = ++seq;
      try {
        const r = await api.get<{ studies: StudyCard[] }>(`/studies${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        if (id === seq) studyResults = r.studies;
      } catch {
        if (id === seq) studyResults = [];
      }
    }, studyResults ? 200 : 0);
    return () => clearTimeout(timer);
  });
  const selectedStudy = (id: string) => value.studies.some(s => s.id === id);
  function toggleStudy(s: StudyCard) {
    if (selectedStudy(s.id)) value.studies = value.studies.filter(x => x.id !== s.id);
    else value.studies = [...value.studies, { id: s.id, slug: s.slug, title: s.title, owner: s.members.find(m => m.role === "owner")?.name ?? null, members: s.members.map(m => ({ id: m.id, name: m.name, role: m.role })) }];
    errors.studies = undefined;
  }

  // ---------------------------------------------------------------- people
  let directory = $state<DirectoryUser[]>([]);
  let peopleQuery = $state("");
  $effect(() => {
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (directory = r.users), () => {});
  });
  const me = $derived(session.user?.id ?? "");
  const memberIds = $derived([...new Set(value.studies.flatMap(s => s.members.map(m => m.id)))]);
  const peopleList = $derived.by(() => {
    const q = peopleQuery.trim().toLowerCase();
    // Matches the real name or the username (with or without a leading @).
    const handle = q.replace(/^@/, "");
    const list = directory.filter(u => !q || u.name.toLowerCase().includes(q) || (!!handle && u.username?.includes(handle)));
    // Members of the chosen studies first.
    return [...list].sort((a, b) => Number(memberIds.includes(b.id)) - Number(memberIds.includes(a.id)));
  });
  const togglePerson = (id: string) => (value.participants = value.participants.includes(id) ? value.participants.filter(x => x !== id) : [...value.participants, id]);
  function addMembers() {
    value.participants = [...new Set([...value.participants, ...memberIds.filter(id => directory.some(u => u.id === id))])];
  }

  // ---------------------------------------------------------------- decks
  let deckOptions = $state<DeckOption[] | null>(null);
  $effect(() => {
    const ids = value.studies.map(s => s.id).join(",");
    if (!ids) {
      deckOptions = [];
      return;
    }
    untrack(() => (deckOptions = deckOptions ?? null));
    api.get<{ decks: DeckOption[] }>(`/meetings/deck-options?studies=${ids}`).then(
      r => {
        deckOptions = r.decks;
        // Drop picks of studies no longer selected.
        untrack(() => (value.decks = value.decks.filter(d => r.decks.some(o => o.id === d.deck_id))));
      },
      () => (deckOptions = []),
    );
  });
  const deckPick = (id: string) => value.decks.find(d => d.deck_id === id);
  function toggleDeck(d: DeckOption) {
    if (deckPick(d.id)) value.decks = value.decks.filter(x => x.deck_id !== d.id);
    else value.decks = [...value.decks, { deck_id: d.id, version_id: d.active_version_id ?? d.versions[0]?.id ?? null }];
  }
  function setVersion(deckId: string, versionId: string) {
    value.decks = value.decks.map(d => (d.deck_id === deckId ? { ...d, version_id: versionId || null } : d));
  }

  // ---------------------------------------------------------------- submit
  function validate(upTo: Step = "decks") {
    const e: typeof errors = {};
    if (!value.title.trim()) e.title = t("meet.form.titleRequired");
    if (!value.date) e.date = t("meet.form.dateRequired");
    if (STEPS.indexOf(upTo) >= 1 && !value.studies.length) e.studies = t("meet.form.studyRequired");
    errors = e;
    return Object.keys(e).length === 0;
  }
  function next() {
    if (!validate(step)) return;
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) step = STEPS[i + 1]!;
    else submit();
  }
  function submit() {
    if (!validate()) {
      if (errors.title || errors.date) step = "basics";
      else if (errors.studies) step = "studies";
      return;
    }
    onSubmit({
      title: value.title.trim(),
      held_at: taipeiIso(value.date, value.time),
      notes: value.notes,
      language: value.language,
      study_ids: value.studies.map(s => s.id),
      participant_ids: value.participants,
      decks: value.decks,
    });
  }

  const languageOptions = $derived([
    { value: "zh-TW", label: t("meet.form.lang.zh") },
    { value: "en", label: t("meet.form.lang.en") },
    { value: "auto", label: t("meet.form.lang.auto") },
  ]);
  const show = (s: Step) => mode === "stacked" || step === s;
  const stepLabel: Record<Step, MessageKey> = { basics: "meet.form.step.basics", studies: "meet.form.step.studies", people: "meet.form.step.people", decks: "meet.form.step.decks" };
</script>

<form
  class="flex flex-col gap-6"
  onsubmit={e => {
    e.preventDefault();
    if (mode === "wizard") next();
    else submit();
  }}
  novalidate
>
  {#if mode === "wizard"}
    <ol class="grid grid-cols-4 gap-2" aria-label={t("meet.form.steps")}>
      {#each STEPS as s, i (s)}
        {@const done = STEPS.indexOf(step) > i}
        <li>
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1.5 rounded-xl px-1 py-1 text-left"
            aria-current={step === s ? "step" : undefined}
            onclick={() => {
              if (i <= STEPS.indexOf(step) || validate(STEPS[i - 1] ?? "basics")) step = s;
            }}
          >
            <span class="h-1 w-full rounded-full transition-colors {step === s || done ? 'bg-ink' : 'bg-line-2'}"></span>
            <span class="flex items-center gap-1 text-[12px] font-medium {step === s ? 'text-ink' : 'text-ink-3'}">
              {#if done}<Check class="size-3.5" />{:else}<span class="tabular-nums">{i + 1}</span>{/if}
              <span class="truncate">{t(stepLabel[s])}</span>
            </span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}

  {#if show("basics")}
    <section class="flex flex-col gap-4" aria-label={t("meet.form.step.basics")}>
      {#if mode === "stacked"}<h3 class="text-[13px] font-semibold text-ink-3">{t("meet.form.step.basics")}</h3>{/if}
      <TextField label={t("meet.form.title")} bind:value={value.title} placeholder={t("meet.form.titlePlaceholder")} error={errors.title} maxlength={160} required />
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-3">
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("meet.form.date")}</span>
          <DatePicker bind:value={value.date} label={t("meet.form.date")} />
          {#if errors.date}<p class="text-[12.5px] text-danger" role="alert">{errors.date}</p>{/if}
        </div>
        <TextField label={t("meet.form.time")} type="time" bind:value={value.time} />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("meet.form.language")}</span>
        <Select bind:value={value.language} label={t("meet.form.language")} options={languageOptions} class="w-full sm:w-64" />
      </div>
      <Textarea label={t("meet.form.notes")} bind:value={value.notes} rows={3} placeholder={t("meet.form.notesPlaceholder")} maxlength={20000} />
    </section>
  {/if}

  {#if show("studies")}
    <section class="flex flex-col gap-3" aria-label={t("meet.form.step.studies")}>
      <div>
        <h3 class="text-[15px] font-semibold text-ink">{t("meet.form.studiesTitle")}</h3>
        <p class="mt-0.5 text-[13px] text-ink-3">{t("meet.form.studiesHint")}</p>
      </div>
      {#if value.studies.length}
        <ul class="flex flex-wrap gap-2" aria-label={t("meet.form.selected")}>
          {#each value.studies as s (s.id)}
            <li class="inline-flex max-w-full items-center gap-1 rounded-full bg-ink py-1 pr-1 pl-3 text-[13px] text-surface">
              <span class="truncate">{s.title}</span>{#if s.owner}<span class="shrink-0 opacity-70">· {s.owner}</span>{/if}
              <button type="button" class="grid size-7 shrink-0 place-items-center rounded-full hover:bg-white/15" aria-label={t("meet.form.remove", { name: s.title })} onclick={() => (value.studies = value.studies.filter(x => x.id !== s.id))}><X class="size-3.5" /></button>
            </li>
          {/each}
        </ul>
      {/if}
      <label class="relative">
        <span class="sr-only">{t("meet.form.searchStudies")}</span>
        <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
        <input bind:value={studyQuery} type="search" placeholder={t("meet.form.searchStudies")} class="h-11 w-full rounded-xl border border-line-2 bg-surface pr-3 pl-10 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm [&::-webkit-search-cancel-button]:hidden" />
      </label>
      {#if errors.studies}<p class="text-[12.5px] text-danger" role="alert">{errors.studies}</p>{/if}
      <div class="max-h-[340px] overflow-y-auto overscroll-contain rounded-2xl border border-line/80">
        {#if !studyResults}
          <div class="grid place-items-center py-8 text-ink-3"><Spinner class="size-5" /></div>
        {:else if !studyResults.length}
          <p class="px-4 py-6 text-center text-[13px] text-ink-3">{t("meet.form.noStudies")}</p>
        {:else}
          <ul class="divide-y divide-line/70">
            {#each studyResults as s (s.id)}
              {@const owner = s.members.find(m => m.role === "owner")}
              <li class="flex items-center gap-3 px-3 py-1.5">
                <CheckCircle checked={selectedStudy(s.id)} label={s.title} onToggle={() => toggleStudy(s)} />
                <button type="button" class="flex min-w-0 flex-1 flex-col items-start py-1.5 text-left" onclick={() => toggleStudy(s)}>
                  <span class="w-full truncate text-[14px] font-medium text-ink">{s.title}</span>
                  <span class="w-full truncate text-[12.5px] text-ink-3">{owner ? t("meet.form.owner", { name: owner.name }) : ""}{s.current_stage ? ` · ${s.current_stage.name}` : ""}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  {/if}

  {#if show("people")}
    <section class="flex flex-col gap-3" aria-label={t("meet.form.step.people")}>
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 class="text-[15px] font-semibold text-ink">{t("meet.form.peopleTitle")}</h3>
          <p class="mt-0.5 text-[13px] text-ink-3">{t("meet.form.peopleHint")}</p>
        </div>
        {#if memberIds.length}<Button size="sm" onclick={addMembers}><UserPlus />{t("meet.form.addMembers")}</Button>{/if}
      </div>
      <label class="relative">
        <span class="sr-only">{t("meet.form.searchPeople")}</span>
        <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
        <input bind:value={peopleQuery} type="search" placeholder={t("meet.form.searchPeople")} class="h-11 w-full rounded-xl border border-line-2 bg-surface pr-3 pl-10 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm [&::-webkit-search-cancel-button]:hidden" />
      </label>
      <div class="max-h-[340px] overflow-y-auto overscroll-contain rounded-2xl border border-line/80">
        <ul class="divide-y divide-line/70">
          {#each peopleList as u (u.id)}
            <li class="flex items-center gap-3 px-3 py-1.5">
              <CheckCircle checked={u.id === me || value.participants.includes(u.id)} disabled={u.id === me} label={u.name} onToggle={() => togglePerson(u.id)} />
              <button type="button" class="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left disabled:cursor-default" disabled={u.id === me} onclick={() => togglePerson(u.id)}>
                <Avatar name={u.name} size={28} />
                <span class="min-w-0 truncate text-[14px] text-ink">{u.name}</span>
                <span class="shrink-0 text-[12px] text-ink-3">{u.id === me ? t("meet.form.you") : u.role === "professor" ? t("meet.form.professor") : memberIds.includes(u.id) ? t("meet.form.member") : ""}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {/if}

  {#if show("decks")}
    <section class="flex flex-col gap-3" aria-label={t("meet.form.step.decks")}>
      <div>
        <h3 class="text-[15px] font-semibold text-ink">{t("meet.form.decksTitle")}</h3>
        <p class="mt-0.5 text-[13px] text-ink-3">{t("meet.form.decksHint")}</p>
      </div>
      {#if !deckOptions}
        <div class="grid place-items-center py-8 text-ink-3"><Spinner class="size-5" /></div>
      {:else if !deckOptions.length}
        <p class="rounded-2xl border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-ink-3">{value.studies.length ? t("meet.form.noDecks") : t("meet.form.pickStudiesFirst")}</p>
      {:else}
        <ul class="divide-y divide-line/70 rounded-2xl border border-line/80">
          {#each deckOptions as d (d.id)}
            {@const pick = deckPick(d.id)}
            <li class="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <CheckCircle checked={Boolean(pick)} label={d.title} onToggle={() => toggleDeck(d)} />
                <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" onclick={() => toggleDeck(d)}>
                  <Presentation class="size-4 shrink-0 text-ink-3" />
                  <span class="min-w-0">
                    <span class="block truncate text-[14px] text-ink">{d.title}</span>
                    <span class="block truncate text-[12px] text-ink-3">{d.study_title}</span>
                  </span>
                </button>
              </div>
              {#if pick && d.versions.length}
                <Select
                  value={pick.version_id ?? ""}
                  label={t("meet.form.version")}
                  options={d.versions.map(v => ({ value: v.id, label: `v${v.version}${v.id === d.active_version_id ? ` · ${t("meet.form.active")}` : ""}` }))}
                  onValueChange={v => setVersion(d.id, v)}
                  class="ml-12 w-auto min-w-32 sm:ml-0"
                />
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <div class="flex flex-col-reverse gap-2 border-t border-line/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
    <div>
      {#if mode === "wizard" && step !== "basics"}
        <Button variant="ghost" onclick={() => (step = STEPS[STEPS.indexOf(step) - 1]!)} class="w-full sm:w-auto"><ArrowLeft />{t("meet.form.back")}</Button>
      {:else if onCancel}
        <Button variant="ghost" onclick={onCancel} class="w-full sm:w-auto">{t("meet.cancel")}</Button>
      {/if}
    </div>
    <div class="flex flex-col gap-2 sm:flex-row">
      {#if mode === "wizard" && step !== "decks"}
        {#if step !== "basics" && value.studies.length}<Button onclick={submit} loading={busy} class="w-full sm:w-auto">{t("meet.form.createNow")}</Button>{/if}
        <Button variant="primary" type="submit" class="w-full sm:w-auto">{t("meet.form.next")}<ArrowRight /></Button>
      {:else}
        <Button variant="primary" type="submit" loading={busy} class="w-full sm:w-auto"><Check />{submitLabel}</Button>
      {/if}
    </div>
  </div>
</form>
