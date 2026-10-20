<script lang="ts">
  import { ArrowUpRight, Check, Pencil, Plus, Search, Tag as TagIcon, Trash2, X } from "@lucide/svelte";
  import { tick } from "svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { tagNamespaces, tc, type ManagedTag, type TagKind } from "./manage.ts";

  /** One tag namespace (`/tags` or `/slide-tags`): filter, sort, create, rename inline, delete. */
  let { kind, tags = $bindable(null), canEdit }: { kind: TagKind; tags?: ManagedTag[] | null; canEdit: boolean } = $props();
  const ns = $derived(tagNamespaces[kind]);

  let query = $state("");
  let sort = $state<"name" | "usage">("name");
  const collator = new Intl.Collator("zh-Hant", { sensitivity: "base", numeric: true });
  const visible = $derived.by(() => {
    if (!tags) return [];
    const q = query.trim().toLowerCase();
    const list = q ? tags.filter(tag => tag.name.toLowerCase().includes(q)) : [...tags];
    return list.sort((a, b) => (sort === "usage" ? b.count - a.count : 0) || collator.compare(a.name, b.name));
  });
  const unused = $derived(tags?.filter(tag => !tag.count).length ?? 0);

  let board = $state<HTMLElement | null>(null);
  /** Puts focus back on a card's rename button after its inline editor closes (else it falls to <body>). */
  async function focusRename(id: string) {
    await tick();
    board?.querySelector<HTMLElement>(`[data-tag="${id}"] [data-action="rename"]`)?.focus();
  }

  // Create
  let newName = $state("");
  let createError = $state<string | null>(null);
  let creating = $state(false);
  async function create(e: SubmitEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    creating = true;
    createError = null;
    try {
      const { tag } = await api.post<{ tag: ManagedTag }>(ns.api, { name });
      tags = [...(tags ?? []), { ...tag, count: tag.count ?? 0 }];
      newName = "";
      toasts.show(t("manage.tags.created", { name: tag.name }), "success");
    } catch (err) {
      createError = (err as Error).message;
    } finally {
      creating = false;
    }
  }

  // Rename
  let editingId = $state<string | null>(null);
  let draft = $state("");
  let renameError = $state<string | null>(null);
  let renaming = $state(false);
  function startRename(tag: ManagedTag) {
    editingId = tag.id;
    draft = tag.name;
    renameError = null;
  }
  function cancelRename() {
    const id = editingId;
    editingId = null;
    renameError = null;
    if (id) void focusRename(id);
  }
  async function commitRename(tag: ManagedTag) {
    const name = draft.trim();
    if (!name || name === tag.name) return cancelRename();
    renaming = true;
    renameError = null;
    try {
      const result = await api.patch<{ tag: ManagedTag }>(`${ns.api}/${tag.id}`, { name });
      tags = (tags ?? []).map(x => (x.id === tag.id ? { ...x, name: result.tag.name } : x));
      editingId = null;
      void focusRename(tag.id);
      toasts.show(t("manage.tags.renamed", { name: result.tag.name }), "success");
    } catch (err) {
      renameError = (err as Error).message;
    } finally {
      renaming = false;
    }
  }
  function onRenameKey(e: KeyboardEvent, tag: ManagedTag) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename(tag);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  }
  function focusOnMount(node: HTMLInputElement) {
    // Next frame: the value binding lands after the action and would drop the selection.
    requestAnimationFrame(() => {
      node.focus();
      node.select();
    });
  }

  // Delete
  let pending = $state<ManagedTag | null>(null);
  let confirmOpen = $state(false);
  function askDelete(tag: ManagedTag) {
    pending = tag;
    confirmOpen = true;
  }
  async function remove() {
    const tag = pending;
    if (!tag) return;
    try {
      await api.del(`${ns.api}/${tag.id}`);
      tags = (tags ?? []).filter(x => x.id !== tag.id);
      toasts.show(t("manage.tags.deleted", { name: tag.name }), "success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) tags = (tags ?? []).filter(x => x.id !== tag.id);
      toasts.show((err as Error).message, "error");
    }
  }

  const inputClass =
    "h-10 w-full rounded-full border border-line-2 bg-surface text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm";
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
    <div class="flex items-center gap-2 sm:gap-3">
      <label class="relative block min-w-0 flex-1 sm:w-64 sm:flex-none">
        <span class="sr-only">{t("manage.tags.filter")}</span>
        <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
        <input type="search" bind:value={query} placeholder={t("manage.tags.filter")} class="{inputClass} pr-3.5 pl-10" />
      </label>
      <Segmented
        bind:value={sort}
        label={t("manage.tags.sort")}
        class="shrink-0"
        options={[
          { value: "name", label: t("manage.tags.sort.name") },
          { value: "usage", label: t("manage.tags.sort.usage") },
        ]}
      />
    </div>
    {#if canEdit}
      <form class="flex flex-col gap-1.5 lg:w-[360px]" onsubmit={create}>
        <div class="flex gap-2">
          <label class="min-w-0 flex-1">
            <span class="sr-only">{t("manage.tags.new")}</span>
            <input
              bind:value={newName}
              maxlength="40"
              placeholder={t("manage.tags.new")}
              aria-invalid={createError ? true : undefined}
              oninput={() => (createError = null)}
              class="{inputClass} px-4 {createError ? 'border-danger' : ''}"
            />
          </label>
          <Button type="submit" variant="primary" loading={creating} disabled={!newName.trim()}><Plus />{t("manage.tags.add")}</Button>
        </div>
        {#if createError}<p class="px-4 text-[12.5px] text-danger" role="alert">{createError}</p>{/if}
      </form>
    {/if}
  </div>

  {#if tags}
    <p class="text-[13px] text-ink-3">{tc("manage.tags.summary", tags.length, { unused })}</p>
  {/if}

  {#if !tags}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton class="h-[74px] rounded-2xl" />{/each}</div>
  {:else if !tags.length}
    <div class="rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card">
      <EmptyState title={t("manage.tags.empty")} hint={canEdit ? t("manage.tags.emptyHint") : undefined}>
        {#snippet icon()}<TagIcon />{/snippet}
      </EmptyState>
    </div>
  {:else if !visible.length}
    <div class="rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card">
      <EmptyState title={t("manage.tags.noMatch", { q: query.trim() })}>
        {#snippet icon()}<Search />{/snippet}
      </EmptyState>
    </div>
  {:else}
    <ul bind:this={board} class="grid gap-2.5 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">
      {#each visible as tag (tag.id)}
        {@const tone = tagTone(tag)}
        <li
          data-tag={tag.id}
          class="group flex min-h-[66px] items-center gap-3 rounded-2xl border bg-surface px-3.5 py-2.5 shadow-card sm:min-h-[74px] sm:px-4 sm:py-3 transition-colors {editingId === tag.id
            ? 'border-ink'
            : 'border-line/70 hover:border-line-2'}"
        >
          <span class="grid size-9 shrink-0 place-items-center rounded-xl sm:size-10" style="background:var(--pill-{tone});color:var(--pill-{tone}-ink)">
            <TagIcon class="size-[18px]" />
          </span>
          {#if editingId === tag.id}
            <div class="min-w-0 flex-1">
              <input
                use:focusOnMount
                bind:value={draft}
                maxlength="40"
                aria-label={t("manage.tags.rename")}
                aria-invalid={renameError ? true : undefined}
                onkeydown={e => onRenameKey(e, tag)}
                oninput={() => (renameError = null)}
                class="h-8 w-full rounded-lg border bg-surface px-2.5 text-[15px] text-ink outline-none focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm {renameError
                  ? 'border-danger'
                  : 'border-line-2 focus:border-ink'}"
              />
              <p class="mt-1 truncate text-[12px] {renameError ? 'text-danger' : 'text-ink-3'}" role={renameError ? "alert" : undefined}>
                {renameError ?? t("manage.tags.renameHint")}
              </p>
            </div>
            <div class="flex shrink-0 gap-0.5">
              <Button size="icon-sm" variant="ghost" aria-label={t("action.save")} loading={renaming} onclick={() => commitRename(tag)}>{#if !renaming}<Check />{/if}</Button>
              <Button size="icon-sm" variant="ghost" aria-label={t("action.cancel")} onclick={cancelRename}><X /></Button>
            </div>
          {:else}
            <div class="flex min-w-0 flex-1 flex-col items-start gap-1">
              <span class="max-w-full" title={tag.name}><Pill {tone}><span class="truncate">{tag.name}</span></Pill></span>
              {#if tag.count}
                <a
                  href="{ns.list}?tags={tag.id}"
                  class="inline-flex items-center gap-0.5 rounded px-0.5 text-[12.5px] text-ink-2 tabular-nums hover:text-ink hover:underline"
                >
                  {tc(ns.count, tag.count)}<ArrowUpRight class="size-3.5 text-ink-3" />
                </a>
              {:else}
                <span class="px-0.5 text-[12.5px] text-ink-3">{t("manage.tags.unused")}</span>
              {/if}
            </div>
            {#if canEdit}
              <div class="flex shrink-0 gap-0.5 transition-opacity md:pointer-fine:opacity-0 md:pointer-fine:group-focus-within:opacity-100 md:pointer-fine:group-hover:opacity-100">
                <Button size="icon-sm" variant="ghost" data-action="rename" aria-label="{t('manage.tags.rename')} {tag.name}" onclick={() => startRename(tag)}><Pencil /></Button>
                <Button size="icon-sm" variant="ghost" class="hover:!text-danger" aria-label="{t('manage.tags.delete')} {tag.name}" onclick={() => askDelete(tag)}><Trash2 /></Button>
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title={t("manage.tags.confirmTitle", { name: pending?.name ?? "" })}
  description={pending?.count ? tc(ns.confirm, pending.count) : t("manage.tags.confirmUnused")}
  confirmLabel={t("manage.tags.delete")}
  onConfirm={remove}
/>
