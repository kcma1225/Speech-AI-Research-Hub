<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Ellipsis, FileCode2, FilePlus2, FileText, Flag, Folder, ImagePlus, Image as ImageIcon, PencilLine, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import { isImage, treeRows } from "#lib/slides/source.ts";
  import type { SourceFile } from "#lib/slides/types.ts";
  import { formatBytes } from "#lib/slides/util.ts";

  /** Source tree of a deck: folders indented, the entry .qmd flagged; per-file menu for editors. */
  let { files, entry, activeId, canEdit, dirty = [], onOpen, onNew, onUpload, onRename, onDelete, onSetEntry }: {
    files: SourceFile[];
    entry: string;
    activeId: string | null;
    canEdit: boolean;
    /** Ids of files with unsaved changes. */
    dirty?: string[];
    onOpen: (file: SourceFile) => void;
    onNew: () => void;
    onUpload: (files: File[]) => void;
    onRename: (file: SourceFile) => void;
    onDelete: (file: SourceFile) => void;
    onSetEntry: (file: SourceFile) => void;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);
  const rows = $derived(treeRows(files));
  const iconFor = (file: SourceFile) => (isImage(file.path) ? ImageIcon : file.path.endsWith(".qmd") ? FileCode2 : FileText);
</script>

<div class="flex min-h-0 flex-col gap-2">
  <div class="flex items-center justify-between gap-2 px-1">
    <h2 class="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("slides.editor.files")}</h2>
    {#if canEdit}
      <div class="flex gap-1">
        <Button size="icon-sm" variant="ghost" title={t("slides.editor.newFile")} aria-label={t("slides.editor.newFile")} onclick={onNew}><FilePlus2 /></Button>
        <Button size="icon-sm" variant="ghost" title={t("slides.editor.upload")} aria-label={t("slides.editor.upload")} onclick={() => input?.click()}><ImagePlus /></Button>
        <input
          bind:this={input}
          type="file"
          multiple
          class="sr-only"
          tabindex="-1"
          accept=".png,.jpg,.jpeg,.gif,.svg,.webp,.pdf,.bib,.csl,.css,.scss,.yml,.yaml,.json,.csv,.txt,.md,.qmd,.woff,.woff2,.ttf,.otf,.mp4,.webm,.mp3,.wav,.m4a"
          onchange={e => {
            const list = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (list.length) onUpload(list);
          }}
        />
      </div>
    {/if}
  </div>
  <ul class="flex min-h-0 flex-col gap-0.5 overflow-y-auto" role="list">
    {#each rows as row (row.type === "dir" ? `d:${row.path}` : row.file.id)}
      {#if row.type === "dir"}
        <li class="flex h-8 items-center gap-1.5 text-[12.5px] text-ink-3" style="padding-left:{row.depth * 14 + 8}px"><Folder class="size-3.5 shrink-0" />{row.name}</li>
      {:else}
        {@const file = row.file}
        {@const Icon = iconFor(file)}
        <li class="group flex items-center rounded-xl {file.id === activeId ? 'bg-surface-3' : 'hover:bg-surface-2'}">
          <button
            type="button"
            class="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[13px] {file.id === activeId ? 'font-medium text-ink' : 'text-ink-2'}"
            style="padding-left:{row.depth * 14 + 8}px"
            aria-current={file.id === activeId ? "true" : undefined}
            title={file.path}
            onclick={() => onOpen(file)}
          >
            <Icon class="size-4 shrink-0 text-ink-3" />
            <span class="min-w-0 truncate">{row.name}</span>
            {#if dirty.includes(file.id)}<span class="size-1.5 shrink-0 rounded-full bg-[var(--pill-butter-ink)]" title={t("slides.editor.unsaved")}></span>{/if}
            {#if file.path === entry}<Flag class="size-3 shrink-0 text-ink-3" aria-label={t("slides.editor.entry")} />{/if}
            {#if file.kind === "binary"}<span class="ml-auto shrink-0 text-[11px] text-ink-3 tabular-nums">{formatBytes(file.bytes)}</span>{/if}
          </button>
          {#if canEdit}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger class="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 opacity-70 hover:bg-surface-3 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("slides.editor.fileMenu", { name: row.name })}>
                <Ellipsis class="size-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-52">
                  <DropdownMenu.Item class={menuItem} onSelect={() => onRename(file)}><PencilLine />{t("slides.editor.rename")}</DropdownMenu.Item>
                  {#if file.path.endsWith(".qmd") && file.path !== entry}
                    <DropdownMenu.Item class={menuItem} onSelect={() => onSetEntry(file)}><Flag />{t("slides.editor.setEntry")}</DropdownMenu.Item>
                  {/if}
                  {#if file.path !== entry}
                    <DropdownMenu.Item class="{menuItem} text-danger" onSelect={() => onDelete(file)}><Trash2 />{t("slides.editor.delete")}</DropdownMenu.Item>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
</div>
