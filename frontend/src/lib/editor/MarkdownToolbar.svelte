<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import type { EditorState } from "@codemirror/state";
  import type { EditorView } from "@codemirror/view";
  import { DropdownMenu } from "bits-ui";
  import {
    BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, ChevronDown, Ellipsis, Heading, Table, TableProperties, TextAlignCenter, TextAlignEnd,
    TextAlignStart, Trash2,
  } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { menuContent, menuItem, menuLabel, menuSeparator } from "#lib/components/ui/menu.ts";
  import { formatKey, type EditorAction, type ToolItem } from "./editor-actions.ts";
  import { table as tableOps, findTable } from "./markdown-table.ts";
  import ToolbarButton from "./ToolbarButton.svelte";

  /**
   * Responsive Markdown toolbar. Buttons are ranked: as many as fit the measured width are shown in their usual
   * order, the rest move to the 「更多」 menu (so phones keep the essentials reachable without horizontal scroll).
   * Headings are one dropdown; the table button turns into table tools while the cursor is in a table.
   * `tools` are trailing buttons (outline, import, help, fullscreen…) that also collapse into the menu.
   */
  let { view, editorState, actions, tools = [], disabled = false, end }: {
    view: EditorView | null;
    /** Latest editor state (for enabled/active flags); pass the view's state on every update. */
    editorState: EditorState | null;
    actions: EditorAction[];
    tools?: ToolItem[];
    disabled?: boolean;
    /** Always-visible trailing content (AI menu, voice…). */
    end?: Snippet;
  } = $props();

  let bar = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  $effect(() => {
    if (!bar) return;
    const ro = new ResizeObserver(([entry]) => (width = entry!.contentRect.width));
    ro.observe(bar);
    return () => ro.disconnect();
  });

  const byId = $derived(new Map(actions.map(a => [a.id, a])));
  const inTable = $derived(!!editorState && !!findTable(editorState, editorState.selection.main.head));
  // Display order with a priority per slot (lower = more important). "headings" and "table" are composite slots.
  type Slot = { id: string; priority: number; sep?: boolean };
  const slots: Slot[] = [
    { id: "undo", priority: 9 },
    { id: "redo", priority: 10 },
    { id: "headings", priority: 2, sep: true },
    { id: "bold", priority: 1 },
    { id: "italic", priority: 3 },
    { id: "strike", priority: 13 },
    { id: "code", priority: 12 },
    { id: "link", priority: 4, sep: true },
    { id: "bullet", priority: 5 },
    { id: "ordered", priority: 8 },
    { id: "task", priority: 7 },
    { id: "quote", priority: 14 },
    { id: "image", priority: 6, sep: true },
    { id: "table", priority: 11 },
    { id: "codeblock", priority: 15 },
    { id: "math", priority: 16 },
    { id: "mathblock", priority: 30 },
    { id: "hr", priority: 31 },
    { id: "footnote", priority: 32 },
    { id: "mermaid", priority: 33 },
    { id: "find", priority: 17, sep: true },
  ];
  const unit = $derived(viewport.desktop ? 34 : 42);
  // Room for the 「更多」 button and the group separators.
  const capacity = $derived(Math.max(3, Math.floor((width - unit - (viewport.desktop ? 40 : 8)) / unit)));
  const shown = $derived.by(() => {
    const ranked = [...slots].sort((a, b) => a.priority - b.priority);
    const toolSlots = tools.map((tool, i) => ({ id: `tool:${tool.id}`, priority: 18 + i }));
    const all = [...ranked, ...toolSlots].sort((a, b) => a.priority - b.priority);
    return new Set(all.slice(0, Math.max(0, capacity)).map(s => s.id));
  });
  const overflow = $derived(slots.filter(s => !shown.has(s.id)));
  const overflowTools = $derived(tools.filter(tool => !shown.has(`tool:${tool.id}`)));
  const callouts = $derived(actions.filter(a => a.id.startsWith("callout-")));
  const headings = $derived(["h1", "h2", "h3", "h4", "paragraph"].map(id => byId.get(id)!).filter(Boolean));

  const title = (a: EditorAction) => (a.key ? `${a.label} (${formatKey(a.key)})` : a.label);
  const run = (a: EditorAction | undefined) => () => {
    if (view && a) a.run(view);
  };
  const enabled = (a: EditorAction | undefined) => !!a && !disabled && !!view && (!a.enabled || !editorState || a.enabled(editorState));
  const trigger =
    "inline-flex h-10 shrink-0 items-center justify-center gap-0.5 rounded-lg px-1.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-surface-3 lg:h-8 [&_svg]:size-4";
  const tableItems = $derived([
    { label: t("mdx.table.rowAbove"), icon: BetweenHorizontalStart, run: tableOps.addRowAbove },
    { label: t("mdx.table.rowBelow"), icon: BetweenHorizontalEnd, run: tableOps.addRowBelow },
    { label: t("mdx.table.colLeft"), icon: BetweenVerticalStart, run: tableOps.addColLeft },
    { label: t("mdx.table.colRight"), icon: BetweenVerticalEnd, run: tableOps.addColRight },
    { sep: true },
    { label: t("mdx.table.alignLeft"), icon: TextAlignStart, run: (v: EditorView) => tableOps.align(v, "left") },
    { label: t("mdx.table.alignCenter"), icon: TextAlignCenter, run: (v: EditorView) => tableOps.align(v, "center") },
    { label: t("mdx.table.alignRight"), icon: TextAlignEnd, run: (v: EditorView) => tableOps.align(v, "right") },
    { label: t("mdx.table.format"), icon: TableProperties, run: tableOps.format },
    { sep: true },
    { label: t("mdx.table.deleteRow"), icon: Trash2, run: tableOps.deleteRow, danger: true },
    { label: t("mdx.table.deleteCol"), icon: Trash2, run: tableOps.deleteCol, danger: true },
  ] as ({ sep: true } | { label: string; icon: Component; run: (v: EditorView) => boolean; danger?: boolean; sep?: undefined })[]);
</script>

{#snippet tableMenu()}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class={trigger} disabled={disabled || !view} aria-label={t("mdx.tableTools")} title={t("mdx.tableTools")}><Table /><ChevronDown class="!size-3" /></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" sideOffset={6} class="{menuContent} w-60">
        {#each tableItems as item, i (i)}
          {#if item.sep}<DropdownMenu.Separator class={menuSeparator} />{:else}
            <DropdownMenu.Item class="{menuItem} {item.danger ? 'text-danger [&_svg]:text-danger' : ''}" onSelect={() => view && item.run(view)}><item.icon />{item.label}</DropdownMenu.Item>
          {/if}
        {/each}
        <p class="px-2.5 pt-1 pb-1.5 text-[11.5px] text-ink-3">{t("mdx.table.keys")}</p>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/snippet}

<div bind:this={bar} class="flex min-w-0 flex-1 items-center gap-0.5" role="toolbar" aria-label={t("md.toolbar")} aria-orientation="horizontal">
  {#each slots as slot, i (slot.id)}
    {#if shown.has(slot.id)}
      {#if slot.sep && i > 0}<span class="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>{/if}
      {#if slot.id === "headings"}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class={trigger} disabled={disabled || !view} aria-label={t("md.heading")} title={t("md.heading")}><Heading /><ChevronDown class="!size-3" /></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={6} class="{menuContent} w-56">
              {#each headings as h (h.id)}
                <DropdownMenu.Item class={menuItem} onSelect={run(h)}><h.icon /><span class="flex-1">{h.label}</span>{#if h.key}<span class="text-[11px] text-ink-3">{formatKey(h.key)}</span>{/if}</DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {:else if slot.id === "table" && inTable}
        {@render tableMenu()}
      {:else}
        {@const a = byId.get(slot.id)}
        {#if a}<ToolbarButton icon={a.icon} label={a.label} shortcut={a.key ? formatKey(a.key) : undefined} disabled={!enabled(a)} onclick={run(a)} />{/if}
      {/if}
    {/if}
  {/each}
  {#if tools.some(tool => shown.has(`tool:${tool.id}`))}<span class="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>{/if}
  {#each tools as tool (tool.id)}
    {#if shown.has(`tool:${tool.id}`)}
      <ToolbarButton icon={tool.icon} label={tool.label} shortcut={tool.key ? formatKey(tool.key) : undefined} active={tool.active} disabled={tool.disabled} onclick={tool.run} />
    {/if}
  {/each}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="{trigger} min-w-10 lg:min-w-8" aria-label={t("mdx.more")} title={t("mdx.more")}><Ellipsis /></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} max-h-[min(70dvh,560px)] w-64 overflow-y-auto">
        {#if overflow.length}
          {#each overflow as slot (slot.id)}
            {#if slot.id === "headings"}
              <div class={menuLabel}>{t("md.heading")}</div>
              {#each headings as h (h.id)}<DropdownMenu.Item class={menuItem} onSelect={run(h)} disabled={disabled || !view}><h.icon />{h.label}</DropdownMenu.Item>{/each}
              <DropdownMenu.Separator class={menuSeparator} />
            {:else if slot.id === "table" && inTable}
              <div class={menuLabel}>{t("mdx.tableTools")}</div>
              {#each tableItems as item, i (i)}
                {#if !item.sep}<DropdownMenu.Item class="{menuItem} {item.danger ? 'text-danger [&_svg]:text-danger' : ''}" onSelect={() => view && item.run(view)}><item.icon />{item.label}</DropdownMenu.Item>{/if}
              {/each}
              <DropdownMenu.Separator class={menuSeparator} />
            {:else}
              {@const a = byId.get(slot.id)}
              {#if a}
                <DropdownMenu.Item class="{menuItem} data-disabled:opacity-45" disabled={!enabled(a)} onSelect={run(a)}>
                  <a.icon /><span class="flex-1 truncate">{a.label}</span>{#if a.key && viewport.desktop}<span class="text-[11px] text-ink-3">{formatKey(a.key)}</span>{/if}
                </DropdownMenu.Item>
              {/if}
            {/if}
          {/each}
        {/if}
        <div class={menuLabel}>{t("mdx.callouts")}</div>
        {#each callouts as a (a.id)}<DropdownMenu.Item class={menuItem} disabled={!enabled(a)} onSelect={run(a)}><a.icon />{a.label}</DropdownMenu.Item>{/each}
        {#if overflowTools.length}
          <DropdownMenu.Separator class={menuSeparator} />
          {#each overflowTools as tool (tool.id)}
            <DropdownMenu.Item class="{menuItem} data-disabled:opacity-45" disabled={tool.disabled} onSelect={tool.run}><tool.icon /><span class="flex-1">{tool.label}</span>{#if tool.active}<span class="size-1.5 rounded-full bg-ink" aria-hidden="true"></span>{/if}</DropdownMenu.Item>
          {/each}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
</div>
{#if end}<div class="flex shrink-0 items-center gap-1 pl-1">{@render end()}</div>{/if}
