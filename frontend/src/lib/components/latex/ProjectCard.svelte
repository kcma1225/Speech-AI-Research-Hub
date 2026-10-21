<script lang="ts">
  import { FileStack, Layers } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { ProjectCard } from "#lib/latex/types.ts";
  import CompileBadge from "./CompileBadge.svelte";
  import PdfThumb from "./PdfThumb.svelte";

  let { project, href }: { project: ProjectCard; href: string } = $props();
</script>

<a {href} class="group flex flex-col overflow-hidden rounded-[22px] border border-line/70 bg-surface shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
  <div class="relative aspect-[16/10] overflow-hidden border-b border-line/70">
    <PdfThumb url={project.pdf_url} />
    <div class="absolute inset-x-2.5 top-2.5 flex items-start justify-between gap-2">
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
