<script lang="ts">
  import { BookOpen, CalendarDays, FileCode, FileText, FlaskConical, Image, ListTodo, NotebookText, Presentation, ScrollText } from "@lucide/svelte";
  import type { ChipKind } from "./types.ts";

  /** Icon of an attachment kind (uploads: image vs document). */
  let { kind, upload = undefined, class: cls = "size-4" }: { kind: ChipKind; upload?: "document" | "image"; class?: string } = $props();
  const Icon = $derived(
    kind === "note" ? NotebookText
    : kind === "paper" ? BookOpen
    : kind === "deck" ? Presentation
    : kind === "meeting" ? CalendarDays
    : kind === "latex_project" ? ScrollText
    : kind === "latex_file" ? FileCode
    : kind === "study" ? FlaskConical
    : kind === "task" ? ListTodo
    : upload === "image" ? Image
    : FileText,
  );
</script>

<Icon class={cls} aria-hidden="true" />
