<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { BookMarked, Ellipsis, ExternalLink, FileCode2, FilePlus2, FileText, Folder, Image as ImageIcon, Paintbrush, PencilLine, Trash2, Upload } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import type { LatexFile } from "#lib/latex/types.ts";

  /** 「檔案」 drawer: every file of the project (sections are also tabs), uploads (images, PDF, .sty/.cls/.bst/.bib), new text files. */
  let { open = $bindable(false), files, projectId, activeId, canEdit, uploading = false, onOpen, onNew, onUpload, onRename, onDelete }: {
    open?: boolean;
    files: LatexFile[];
    projectId: string;
    activeId: string | null;
    canEdit: boolean;
    uploading?: boolean;
    onOpen: (file: LatexFile) => void;
    onNew: () => void;
    onUpload: (files: File[]) => void;
    onRename: (file: LatexFile) => void;
    onDelete: (file: LatexFile) => void;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);
  type Row = { type: "dir"; path: string; name: string; depth: number } | { type: "file"; file: LatexFile; name: string; depth: number };
  const rows = $derived.by(() => {
    const sorted = [...files].sort((a, b) => {
      const pa = a.path.split("/");
      const pb = b.path.split("/");
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] === pb[i]) continue;
        const aDir = i < pa.length - 1;
        const bDir = i < pb.length - 1;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return pa[i]!.localeCompare(pb[i]!);
      }
      return pa.length - pb.length;
    });
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const file of sorted) {
      const parts = file.path.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join("/");
        if (!seen.has(dir)) {
          seen.add(dir);
          out.push({ type: "dir", path: dir, name: parts[i]!, depth: i });
        }
      }
      out.push({ type: "file", file, name: parts.at(-1)!, depth: parts.length - 1 });
    }
    return out;
  });
  const iconFor = (f: LatexFile) => (f.role === "main" ? FileCode2 : f.role === "bib" ? BookMarked : f.role === "style" ? Paintbrush : f.kind === "binary" ? ImageIcon : FileText);
  const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
</script>

<Sheet bind:open side="right" title={t("latex.files.title")} description={t("latex.files.hint")}>
  {#if canEdit}
    <div class="mb-3 flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onclick={() => input?.click()} loading={uploading}><Upload />{t("latex.files.upload")}</Button>
      <Button variant="ghost" size="sm" onclick={onNew}><FilePlus2 />{t("latex.files.newFile")}</Button>
      <input
        bind:this={input}
        type="file"
        multiple
        class="sr-only"
        tabindex="-1"
        accept=".png,.jpg,.jpeg,.gif,.svg,.webp,.pdf,.eps,.bib,.sty,.cls,.bst,.bbx,.cbx,.tex,.txt,.csv,.dat,.ttf,.otf"
        onchange={e => {
          const list = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (list.length) onUpload(list);
        }}
      />
    </div>
  {/if}
  <ul class="flex flex-col gap-0.5" role="list">
    {#each rows as row (row.type === "dir" ? `d:${row.path}` : row.file.id)}
      {#if row.type === "dir"}
        <li class="flex h-9 items-center gap-1.5 text-[12.5px] text-ink-3" style="padding-left:{row.depth * 14 + 8}px"><Folder class="size-3.5 shrink-0" />{row.name}</li>
      {:else}
        {@const file = row.file}
        {@const Icon = iconFor(file)}
        <li class="group flex items-center gap-1 rounded-xl {activeId === file.id ? 'bg-surface-3' : 'hover:bg-surface-2'}">
          {#if file.kind === "text"}
            <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[13.5px] text-ink" style="padding-left:{row.depth * 14 + 8}px" onclick={() => onOpen(file)}>
              <Icon class="size-4 shrink-0 text-ink-3" />
              <span class="min-w-0 flex-1 truncate">{row.name}{#if file.title && file.role === "section"}<span class="ml-1.5 text-[12px] text-ink-3">{file.title}</span>{/if}</span>
              {#if file.generated}<span class="shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold" style="background:var(--pill-mint);color:var(--pill-mint-ink)">{t("latex.files.generated")}</span>{/if}
            </button>
          {:else}
            <a href="/api/latex/{projectId}/files/{file.id}/raw" target="_blank" rel="noopener" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1.5 text-[13.5px] text-ink" style="padding-left:{row.depth * 14 + 8}px">
              <Icon class="size-4 shrink-0 text-ink-3" />
              <span class="min-w-0 flex-1 truncate">{row.name}</span>
              <span class="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{size(file.bytes)}</span>
              <ExternalLink class="size-3.5 shrink-0 text-ink-3" />
            </a>
          {/if}
          {#if canEdit && file.role !== "main"}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger class="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("latex.files.actions", { path: file.path })}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-52">
                  <DropdownMenu.Item class={menuItem} onSelect={() => onRename(file)}><PencilLine />{t("latex.files.rename")}</DropdownMenu.Item>
                  <DropdownMenu.Separator class={menuSeparator} />
                  <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={() => onDelete(file)}><Trash2 />{t("latex.files.delete")}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
</Sheet>
