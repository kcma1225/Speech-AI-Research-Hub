<script lang="ts">
  import { BookOpen, CalendarDays, FileCode, FileText, Image, NotebookText, Presentation, ScrollText } from "@lucide/svelte";
  import type { AttachmentKind } from "./types.ts";

  /** Icon of an attachment kind (uploads: image vs document). */
  let { kind, upload = undefined, class: cls = "size-4" }: { kind: AttachmentKind; upload?: "document" | "image"; class?: string } = $props();
  const Icon = $derived(
    kind === "note" ? NotebookText
    : kind === "paper" ? BookOpen
    : kind === "deck" ? Presentation
    : kind === "meeting" ? CalendarDays
    : kind === "latex_project" ? ScrollText
    : kind === "latex_file" ? FileCode
    : upload === "image" ? Image
    : FileText,
  );
</script>

<Icon class={cls} aria-hidden="true" />
