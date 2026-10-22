<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Download, Ellipsis, FileStack, Layers, PencilLine } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { ProjectCard } from "#lib/latex/types.ts";
  import CompileBadge from "./CompileBadge.svelte";
  import PdfThumb from "./PdfThumb.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import DeleteButton from "#lib/components/ui/DeleteButton.svelte";
  import DeleteMenuItem from "#lib/components/ui/DeleteMenuItem.svelte";

  /**
   * ⋯ menu beside the card's link (ZIP, `onRename`, 刪除). `canDelete` (study editors) enables 刪除 and adds a trash
   * button on hover (always on touch); others see the entry disabled with the reason.
   */
  let { project, href, onRename, onDelete, canDelete = false }: { project: ProjectCard; href: string; onRename?: () => void; onDelete?: () => void; canDelete?: boolean } = $props();
</script>

<div class="group relative flex flex-col">
<a {href} class="flex flex-1 flex-col overflow-hidden rounded-[22px] border border-line/70 bg-surface shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
  <div class="relative aspect-[16/10] overflow-hidden border-b border-line/70">
    <PdfThumb url={project.pdf_url} />
    <div class="absolute top-2.5 left-2.5 {onDelete || onRename ? (canDelete && onDelete ? 'right-24' : 'right-14') : 'right-2.5'} flex items-start justify-between gap-2">
      <CompileBadge status={project.last_compile_status} class="shadow-card" />
      <span class="inline-flex h-6 items-center rounded-full bg-surface/90 px-2 text-[11px] font-semibold text-ink-2 uppercase shadow-card backdrop-blur">{project.compiler}</span>
    </div>
  </div>
  <div class="flex flex-1 flex-col gap-3 p-4 sm:p-[18px]">
    <h3 class="line-clamp-2 text-[15px] leading-snug font-semibold text-ink group-hover:underline">{project.title}</h3>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
      <span class="inline-flex items-center gap-1"><Layers class="size-3.5" />{t("latex.sectionCount", { n: project.section_count })}</span>
      <span class="inline-flex items-center gap-1"><FileStack class="size-3.5" />{t("latex.fileCount", { n: project.file_count })}</span>
    </div>
    <div class="mt-auto flex items-center justify-between gap-2 text-[12px] text-ink-3">
      <Pill size="sm" tone={project.kind === "thesis" ? "lilac" : project.kind === "paper" ? "sky" : "stone"}>{t(`latex.kind.${project.kind}` as MessageKey)}</Pill>
      <span class="truncate">{t("latex.edited", { when: relativeTime(project.updated_at) })}{project.updated_by_name ? ` · ${project.updated_by_name}` : ""}</span>
    </div>
  </div>
</a>
{#if onRename || onDelete}
  {#if onDelete && canDelete}
    <!-- The backdrop chip fades in with the button (an always-visible empty chip looked like a broken icon). -->
    <div class="absolute top-1.5 right-12.5 rounded-full bg-surface/90 opacity-0 shadow-card backdrop-blur transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"><DeleteButton reveal label={t("crud.latex.delete")} onclick={onDelete} /></div>
  {/if}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="absolute top-1.5 right-1.5 grid size-10 cursor-pointer place-items-center rounded-full bg-surface/90 text-ink-2 shadow-card backdrop-blur hover:bg-surface hover:text-ink" aria-label={t("crud.more")} title={t("crud.more")}>
      <Ellipsis class="size-4" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={4} class={menuContent}>
        {#if onRename}<DropdownMenu.Item class={menuItem} onSelect={onRename}><PencilLine />{t("crud.rename")}</DropdownMenu.Item>{/if}
        <DropdownMenu.Item class={menuItem} onSelect={() => (location.href = `/api/latex/${project.id}/export.zip`)}><Download />ZIP</DropdownMenu.Item>
        {#if onDelete}
          <DeleteMenuItem label={t("crud.latex.delete")} reason={canDelete ? null : t("crud.deny.study")} onSelect={onDelete} />
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
</div>
