<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Ellipsis, FileCode2, FileWarning, PencilLine, Plus, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import type { CollabPeer } from "#lib/collab/session.svelte.ts";
  import type { LatexFile, Section } from "#lib/latex/types.ts";

  /**
   * The editor's tabs ARE the split files (spec §13 #14): the root file, then each `\input` section in document
   * order. Drag a tab (pointer) or press Alt+←/→ on it to reorder (rewrites the `\input` lines of main.tex);
   * ←/→ move focus. On phones the strip becomes a picker sheet with move up/down buttons.
   */
  let { sections, root, extra, activeId, canEdit, peersByFile = {}, onOpen, onReorder, onAdd, onRename, onDelete }: {
    sections: Section[];
    root: LatexFile | null;
    /** An open file that is neither the root nor a section (shown as a trailing tab). */
    extra: LatexFile | null;
    activeId: string | null;
    canEdit: boolean;
    peersByFile?: Record<string, CollabPeer[]>;
    onOpen: (fileId: string) => void;
    onReorder: (order: string[]) => void;
    onAdd: () => void;
    onRename: (s: Section) => void;
    onDelete: (s: Section) => void;
  } = $props();

  const movable = (s: Section) => canEdit && s.managed && !!s.file_id;
  const managed = $derived(sections.filter(s => s.managed && s.file_id));
  const label = (s: Section) => s.title || s.path.replace(/^sections\//, "").replace(/\.tex$/, "");

  let strip = $state<HTMLDivElement | null>(null);
  let pickerOpen = $state(false);

  // ── reorder helpers ──
  function moved(fileId: string, delta: number): string[] | null {
    const ids = managed.map(s => s.file_id!);
    const i = ids.indexOf(fileId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return null;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return ids;
  }
  function move(s: Section, delta: number) {
    const order = s.file_id ? moved(s.file_id, delta) : null;
    if (order) onReorder(order);
  }

  // ── pointer drag ──
  let drag = $state<{ id: string; startX: number; x: number; active: boolean; target: number } | null>(null);
  let suppressClick = false;
  function tabsEls() {
    return strip ? [...strip.querySelectorAll<HTMLElement>("[data-drag-id]")] : [];
  }
  function down(e: PointerEvent, s: Section) {
    if (!movable(s) || e.button !== 0) return;
    drag = { id: s.file_id!, startX: e.clientX, x: e.clientX, active: false, target: -1 };
  }
  function moveDrag(e: PointerEvent) {
    if (!drag) return;
    drag.x = e.clientX;
    if (!drag.active && Math.abs(e.clientX - drag.startX) > 6) {
      drag.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (!drag.active) return;
    const els = tabsEls();
    let target = els.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        target = i;
        break;
      }
    }
    drag.target = target;
  }
  function up() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const ids = managed.map(s => s.file_id!);
    const from = ids.indexOf(d.id);
    if (from < 0) return;
    let to = d.target;
    ids.splice(from, 1);
    if (to > from) to--;
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, d.id);
    if (ids.join() !== managed.map(s => s.file_id!).join()) onReorder(ids);
  }
  function open(id: string | null) {
    if (suppressClick || !id) return;
    onOpen(id);
  }

  // ── keyboard ──
  function key(e: KeyboardEvent, s: Section | null) {
    if (e.altKey && s && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      move(s, e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      const tabs = strip ? [...strip.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
      const i = tabs.indexOf(e.currentTarget as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : i + (e.key === "ArrowLeft" ? -1 : 1);
      tabs[Math.max(0, Math.min(tabs.length - 1, next))]?.focus();
      e.preventDefault();
    }
  }
  // Keep focus on a tab that moved (the list re-renders).
  let refocus: string | null = null;
  $effect(() => {
    void sections;
    if (!refocus || !strip) return;
    strip.querySelector<HTMLElement>(`[data-tab-id="${refocus}"]`)?.focus();
    refocus = null;
  });

  const current = $derived(
    activeId === root?.id ? { label: root?.path ?? "main.tex", main: true } : sections.find(s => s.file_id === activeId) ? { label: label(sections.find(s => s.file_id === activeId)!), main: false } : extra ? { label: extra.path, main: false } : { label: "", main: false },
  );
  const insertAt = $derived(drag?.active ? drag.target : -1);
</script>

<!-- ≥ sm: tab strip -->
<div class="hidden min-w-0 flex-1 items-center gap-1 sm:flex">
  <div
    bind:this={strip}
    class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:thin]"
    role="tablist"
    aria-label={t("latex.tabs")}
    tabindex="-1"
    onpointermove={moveDrag}
    onpointerup={up}
    onpointercancel={() => (drag = null)}
  >
    {#if root}
      <button
        type="button"
        role="tab"
        data-tab-id={root.id}
        aria-selected={activeId === root.id}
        tabindex={activeId === root.id ? 0 : -1}
        class="tab {activeId === root.id ? 'tab-active' : ''}"
        onclick={() => open(root.id)}
        onkeydown={e => key(e, null)}
        title={root.path}
      ><FileCode2 class="size-3.5 shrink-0 opacity-70" /><span class="truncate font-mono text-[12px]">{root.path}</span></button>
    {/if}
    {#each sections as s, i (s.path)}
      {@const peers = s.file_id ? peersByFile[s.file_id] ?? [] : []}
      {#if insertAt === managed.indexOf(s) && movable(s)}<span class="drop-mark" aria-hidden="true"></span>{/if}
      <button
        type="button"
        role="tab"
        data-tab-id={s.file_id ?? s.path}
        data-drag-id={movable(s) ? s.file_id : undefined}
        aria-selected={activeId === s.file_id}
        aria-describedby={canEdit ? "latex-tab-hint" : undefined}
        tabindex={activeId === s.file_id ? 0 : -1}
        class="tab {activeId === s.file_id ? 'tab-active' : ''} {s.disabled ? 'opacity-55' : ''} {drag?.active && drag.id === s.file_id ? 'opacity-40' : ''} {movable(s) ? 'cursor-grab active:cursor-grabbing' : ''}"
        disabled={!s.file_id}
        title={s.file_id ? `${s.path}${s.disabled ? ` · ${t("latex.tab.disabled")}` : ""}` : t("latex.tab.missing", { path: s.path })}
        onpointerdown={e => down(e, s)}
        onclick={() => open(s.file_id)}
        onkeydown={e => {
          if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) refocus = s.file_id;
          key(e, s);
        }}
      >
        {#if !s.file_id}<FileWarning class="size-3.5 shrink-0 text-danger" />{/if}
        <span class="text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
        <span class="max-w-[14rem] truncate {s.disabled ? 'line-through' : ''}">{label(s)}</span>
        {#if peers.length}<span class="flex -space-x-1">{#each peers.slice(0, 3) as p (p.clientId)}<span class="size-2 rounded-full ring-1 ring-surface" style="background:{p.color}" title={p.name}></span>{/each}</span>{/if}
      </button>
    {/each}
    {#if insertAt >= managed.length}<span class="drop-mark" aria-hidden="true"></span>{/if}
    {#if extra}
      <button type="button" role="tab" data-tab-id={extra.id} aria-selected={activeId === extra.id} tabindex={activeId === extra.id ? 0 : -1} class="tab {activeId === extra.id ? 'tab-active' : ''}" onkeydown={e => key(e, null)} onclick={() => open(extra.id)}>
        <span class="truncate font-mono text-[12px]">{extra.path}</span>
      </button>
    {/if}
  </div>
  {#if canEdit}
    {@const active = sections.find(s => s.file_id === activeId)}
    {#if active}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink lg:size-8" aria-label={t("latex.section.actions")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-56">
            <DropdownMenu.Item class={menuItem} onSelect={() => onRename(active)}><PencilLine />{t("latex.section.rename")}</DropdownMenu.Item>
            {#if movable(active)}
              <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={managed[0]?.file_id === active.file_id} onSelect={() => move(active, -1)}><ArrowLeft />{t("latex.section.moveLeft")}</DropdownMenu.Item>
              <DropdownMenu.Item class="{menuItem} data-disabled:opacity-40" disabled={managed.at(-1)?.file_id === active.file_id} onSelect={() => move(active, 1)}><ArrowRight />{t("latex.section.moveRight")}</DropdownMenu.Item>
            {/if}
            <DropdownMenu.Separator class={menuSeparator} />
            <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={() => onDelete(active)}><Trash2 />{t("latex.section.delete")}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/if}
    <button type="button" class="inline-flex h-10 shrink-0 items-center gap-1 rounded-full px-3 text-[12.5px] font-semibold text-ink-2 hover:bg-surface-3 hover:text-ink lg:h-8" onclick={onAdd}><Plus class="size-4" />{t("latex.section.add")}</button>
  {/if}
  <span id="latex-tab-hint" class="sr-only">{t("latex.section.reorderHint")}</span>
</div>

<!-- < sm: picker -->
<div class="flex min-w-0 flex-1 items-center gap-1 sm:hidden">
  <button type="button" class="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl border border-line-2 bg-surface px-3.5 text-left text-[14px] font-medium text-ink" aria-haspopup="dialog" onclick={() => (pickerOpen = true)}>
    <span class="min-w-0 flex-1 truncate {current.main ? 'font-mono text-[13px]' : ''}">{current.label || t("latex.section.pick")}</span>
    <ChevronDown class="size-4 shrink-0 text-ink-3" />
  </button>
  {#if canEdit}
    <button type="button" class="grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("latex.section.add")} onclick={onAdd}><Plus class="size-5" /></button>
  {/if}
</div>

<Sheet bind:open={pickerOpen} title={t("latex.section.pick")} description={canEdit ? t("latex.section.reorderHintTouch") : undefined}>
  <ul class="flex flex-col gap-1 pb-2" role="list">
    {#if root}
      <li>
        <button type="button" class="pick {activeId === root.id ? 'pick-active' : ''}" onclick={() => { onOpen(root.id); pickerOpen = false; }}>
          <FileCode2 class="size-4 shrink-0 text-ink-3" /><span class="min-w-0 flex-1 truncate font-mono text-[13px]">{root.path}</span>
        </button>
      </li>
    {/if}
    {#each sections as s, i (s.path)}
      <li class="flex items-center gap-1">
        <button type="button" class="pick {activeId === s.file_id ? 'pick-active' : ''}" disabled={!s.file_id} onclick={() => { if (s.file_id) onOpen(s.file_id); pickerOpen = false; }}>
          <span class="w-5 text-[12px] text-ink-3 tabular-nums">{i + 1}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate {s.disabled ? 'line-through opacity-60' : ''}">{label(s)}</span>
            <span class="block truncate font-mono text-[11.5px] text-ink-3">{s.file_id ? s.path : t("latex.tab.missing", { path: s.path })}</span>
          </span>
        </button>
        {#if movable(s)}
          <button type="button" class="grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-30" aria-label={t("latex.section.moveUp", { title: label(s) })} disabled={managed[0]?.file_id === s.file_id} onclick={() => move(s, -1)}><ArrowUp class="size-4" /></button>
          <button type="button" class="grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 disabled:opacity-30" aria-label={t("latex.section.moveDown", { title: label(s) })} disabled={managed.at(-1)?.file_id === s.file_id} onclick={() => move(s, 1)}><ArrowDown class="size-4" /></button>
        {/if}
      </li>
    {/each}
    {#if extra}
      <li><button type="button" class="pick pick-active"><span class="min-w-0 flex-1 truncate font-mono text-[13px]">{extra.path}</span></button></li>
    {/if}
  </ul>
  {#if canEdit}
    {@const active = sections.find(s => s.file_id === activeId)}
    {#if active}
      <div class="flex gap-2 border-t border-line pt-3">
        <button type="button" class="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-3 text-[13px] font-medium text-ink" onclick={() => { pickerOpen = false; onRename(active); }}><PencilLine class="size-4" />{t("latex.section.rename")}</button>
        <button type="button" class="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-danger-soft text-[13px] font-medium text-danger" onclick={() => { pickerOpen = false; onDelete(active); }}><Trash2 class="size-4" />{t("latex.section.delete")}</button>
      </div>
    {/if}
  {/if}
</Sheet>

<style>
  .tab {
    display: inline-flex;
    height: 2.5rem;
    max-width: 18rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.4rem;
    border-radius: 0.85rem 0.85rem 0 0;
    border: 1px solid transparent;
    border-bottom: none;
    padding: 0 0.8rem;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-2);
    touch-action: pan-x;
    user-select: none;
  }
  .tab:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--ink);
  }
  .tab:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--ink) 40%, transparent);
    outline-offset: -2px;
  }
  .tab-active {
    background: var(--surface);
    border-color: var(--line-2);
    color: var(--ink);
    font-weight: 600;
  }
  .drop-mark {
    width: 3px;
    height: 1.9rem;
    margin: 0 -1.5px;
    align-self: center;
    border-radius: 2px;
    background: var(--ink);
  }
  .pick {
    display: flex;
    min-height: 3rem;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.6rem;
    border-radius: 1rem;
    padding: 0.4rem 0.8rem;
    text-align: left;
    font-size: 14px;
    color: var(--ink);
  }
  .pick:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .pick-active {
    background: var(--surface-3);
    font-weight: 600;
  }
  .pick:disabled {
    opacity: 0.5;
  }
</style>
