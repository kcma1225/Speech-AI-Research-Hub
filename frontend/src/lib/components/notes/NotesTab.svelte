<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { page } from "$app/state";
  import { DropdownMenu } from "bits-ui";
  import { Ellipsis, FileText, ListChecks, Plus, Search, Sparkles, Trash2, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { menuContent } from "#lib/components/ui/menu.ts";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import DeleteMenuItem from "#lib/components/ui/DeleteMenuItem.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { StudyTabProps } from "#lib/components/study/tabs/registry.ts";
  import NewNoteSheet from "./NewNoteSheet.svelte";
  import { kindIcon, kindTone, templateName, type NoteCard, type NoteTemplate } from "./types.ts";

  let { detail }: StudyTabProps = $props();
  const canEdit = $derived(detail.permissions.edit);
  const slug = $derived(detail.study.slug);

  let q = $state("");
  let debounced = $state("");
  let template = $state("all");
  let author = $state("all");
  let notes = $state<NoteCard[] | null>(null);
  let templates = $state<NoteTemplate[]>([]);
  let error = $state<string | null>(null);
  let creating = $state(false);

  $effect(() => {
    const next = q;
    const timer = setTimeout(() => (debounced = next.trim()), 250);
    return () => clearTimeout(timer);
  });

  // Delete without opening the note: the row's trash (hover / focus, always on touch) or ⋯ → 刪除筆記 (study
  // editors; DELETE /notes/:id). Non-members see the ⋯ entry disabled with the reason.
  let deleting = $state<NoteCard | null>(null);
  let deleteOpen = $state(false);
  async function removeNote() {
    const note = deleting;
    if (!note) return;
    await api.del(`/notes/${note.id}`);
    notes = notes?.filter(x => x.id !== note.id) ?? null;
    toasts.show(t("crud.note.deleted"), "success");
  }

  // 選取 mode: tick several notes, then 刪除所選 (one DELETE per note; partial failures are reported).
  let selecting = $state(false);
  let selected = $state<Set<string>>(new Set());
  let bulkOpen = $state(false);
  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = next;
  }
  function stopSelecting() {
    selecting = false;
    selected = new Set();
  }
  async function removeSelected() {
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map(id => api.del(`/notes/${id}`)));
    const done = new Set(ids.filter((_, i) => results[i]!.status === "fulfilled"));
    notes = notes?.filter(x => !done.has(x.id)) ?? null;
    const failed = ids.length - done.size;
    if (!done.size) throw new Error((results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason?.message ?? t("common.error"));
    toasts.show(failed ? t("crud.notes.deleteManyPartial", { ok: done.size, failed }) : t("crud.notes.deletedMany", { n: done.size }), failed ? "error" : "success");
    stopSelecting();
  }

  async function load() {
    const params = new URLSearchParams();
    if (debounced) params.set("q", debounced);
    if (template !== "all") params.set("template", template);
    if (author !== "all") params.set("author", author);
    try {
      notes = (await api.get<{ notes: NoteCard[] }>(`/studies/${encodeURIComponent(slug)}/notes?${params}`)).notes;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void [slug, debounced, template, author];
    void load();
  });
  const loadTemplates = () => void api.get<{ templates: NoteTemplate[] }>("/note-templates").then(r => (templates = r.templates)).catch(() => {});
  $effect(loadTemplates);
  // `?tab=notes&new=1` opens the create sheet.
  $effect(() => {
    if (page.url.searchParams.get("new") === "1" && canEdit) creating = true;
  });

  const templateOptions = $derived([{ value: "all", label: t("notes.filter.allTemplates") }, ...templates.map(x => ({ value: x.id, label: templateName(x.name, x.scope) }))]);
  const authorOptions = $derived([
    { value: "all", label: t("notes.filter.everyone") },
    ...(session.user ? [{ value: "me", label: t("notes.filter.mine") }] : []),
    ...detail.members.filter(m => m.role !== "advisor" && m.id !== session.user?.id).map(m => ({ value: m.id, label: m.name })),
  ]);
  const filtered = $derived(!!debounced || template !== "all" || author !== "all");
  const href = (n: NoteCard) => `/studies/${encodeURIComponent(slug)}/notes/${n.id}`;
</script>

<div class="mb-4 flex flex-wrap items-center gap-2 sm:mb-5">
  <label class="relative flex h-10 min-w-0 flex-1 basis-full items-center sm:basis-64 sm:flex-none lg:w-72">
    <Search class="pointer-events-none absolute left-3.5 size-4 text-ink-3" />
    <span class="sr-only">{t("notes.search")}</span>
    <input
      type="search"
      bind:value={q}
      placeholder={t("notes.search")}
      class="h-10 w-full rounded-full border border-line-2 bg-surface pr-4 pl-10 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
    />
  </label>
  <Select bind:value={template} label={t("notes.filter.template")} options={templateOptions} class="min-w-0 max-w-[44vw] sm:max-w-48" />
  <Select bind:value={author} label={t("notes.filter.author")} options={authorOptions} class="min-w-0 max-w-[44vw] sm:max-w-44" />
  {#if canEdit}
    <div class="ml-auto flex items-center gap-2">
      {#if notes && notes.length > 1}
        <Button variant={selecting ? "secondary" : "ghost"} aria-pressed={selecting} onclick={() => (selecting ? stopSelecting() : (selecting = true))}>{#if selecting}<X />{t("crud.notes.cancelSelect")}{:else}<ListChecks />{t("crud.notes.select")}{/if}</Button>
      {/if}
      <Button variant="primary" onclick={() => (creating = true)}><Plus />{t("notes.new")}</Button>
    </div>
  {/if}
</div>

{#if selecting}
  <div class="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-full border border-line bg-surface px-4 py-1.5 shadow-pop" role="toolbar" aria-label={t("crud.notes.select")}>
    <span class="text-[13.5px] font-medium text-ink tabular-nums" aria-live="polite">{t("crud.notes.selected", { n: selected.size })}</span>
    <span class="flex-1"></span>
    <Button variant="danger" size="sm" class="min-h-10" disabled={!selected.size} onclick={() => (bulkOpen = true)}><Trash2 />{t("crud.notes.deleteSelected")}</Button>
  </div>
{/if}

{#if error}
  <Card><EmptyState title={t("common.error")} hint={error} /></Card>
{:else if !notes}
  <Card padded={false} class="p-2 sm:p-3"><div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-[76px]" />{/each}</div></Card>
{:else if !notes.length}
  <Card>
    <EmptyState title={filtered ? t("notes.noMatch") : t("notes.empty")} hint={filtered ? undefined : canEdit ? t("notes.emptyHint") : t("notes.emptyReadOnly")} class="py-10">
      {#snippet icon()}<FileText />{/snippet}
      {#snippet action()}{#if canEdit && !filtered}<Button size="sm" variant="secondary" onclick={() => (creating = true)}><Plus />{t("notes.new")}</Button>{/if}{/snippet}
    </EmptyState>
  </Card>
{:else}
  <Card padded={false} class="p-1.5 sm:p-2">
    <ul class="flex flex-col">
      {#each notes as n (n.id)}
        {@const Icon = kindIcon[n.kind]}
        <li class="group relative flex items-start">
          {#if selecting}
            <span class="grid shrink-0 place-items-center pt-6 pl-3.5"><CheckCircle checked={selected.has(n.id)} label={t("crud.notes.selectNote", { title: n.title })} onToggle={v => toggle(n.id, v)} /></span>
          {/if}
          <a
            href={href(n)}
            onclick={e => {
              if (!selecting) return;
              e.preventDefault();
              toggle(n.id, !selected.has(n.id));
            }}
            class="flex min-h-[72px] min-w-0 flex-1 {canEdit ? 'pr-24' : 'pr-12'} items-start gap-3 rounded-2xl px-2.5 py-3 transition-colors hover:bg-surface-2 sm:gap-3.5 sm:px-3.5"
          >
            <span class="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-{kindTone[n.kind]});color:var(--pill-{kindTone[n.kind]}-ink)" title={n.template_name ? templateName(n.template_name) : t(`notes.kind.${n.kind}` as MessageKey)}>
              <Icon class="size-4.5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline gap-2">
                <span class="truncate text-[14.5px] font-semibold text-ink group-hover:underline">{n.title}</span>
                {#if n.pending_suggestions}<Pill size="sm" tone="butter" class="shrink-0"><Sparkles class="size-3" />{t("notes.pendingSuggestions", { n: n.pending_suggestions })}</Pill>{/if}
              </span>
              {#if n.excerpt}<span class="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-ink-3">{n.excerpt}</span>{/if}
              <span class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-3">
                {#if n.event_date}<span class="font-medium text-ink-2 tabular-nums">{formatDate(`${n.event_date}T00:00:00+08:00`)}</span>{/if}
                <span>{n.template_name ? templateName(n.template_name) : t(`notes.kind.${n.kind}` as MessageKey)}</span>
                {#if n.creator_name}<span>{displayName(n.creator_name)}</span>{/if}
                <span>{t("notes.edited", { when: relativeTime(n.updated_at) })}{n.updater_name && n.updater_name !== n.creator_name ? ` · ${displayName(n.updater_name)}` : ""}</span>
              </span>
            </span>
          </a>
          {#if !selecting}
            <div class="absolute top-3 right-1.5 flex items-center sm:right-2.5">
              {#if canEdit}<DeleteButton reveal label={t("crud.note.delete")} onclick={() => ((deleting = n), (deleteOpen = true))} />{/if}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger class="grid size-10 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("crud.more")} title={t("crud.more")}>
                  <Ellipsis class="size-4" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={4} class={menuContent}>
                    <DeleteMenuItem separator={false} label={t("crud.note.delete")} reason={canEdit ? null : t("crud.deny.study")} onSelect={() => ((deleting = n), (deleteOpen = true))} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </Card>
{/if}

{#if canEdit}<NewNoteSheet bind:open={creating} studySlug={slug} {templates} onTemplatesChanged={loadTemplates} />{/if}
<ConfirmDialog bind:open={deleteOpen} title={t("crud.note.deleteTitle", { title: deleting?.title ?? "" })} description={t("crud.note.deleteDescription")} confirmLabel={t("crud.note.delete")} onConfirm={removeNote} />
<ConfirmDialog bind:open={bulkOpen} title={t("crud.notes.deleteManyTitle", { n: selected.size })} description={t("crud.notes.deleteManyDescription")} confirmLabel={t("crud.notes.deleteSelected")} onConfirm={removeSelected} />
