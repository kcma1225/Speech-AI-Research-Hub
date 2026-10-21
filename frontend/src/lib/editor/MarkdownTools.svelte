<script lang="ts">
  import type { EditorView } from "@codemirror/view";
  import { Bold, Code, Heading2, Italic, Link, List, ListChecks, ListOrdered, Quote, Sigma } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { md } from "./markdown-commands.ts";
  import ToolbarButton from "./ToolbarButton.svelte";

  /** Markdown formatting buttons for a CodeMirror view (same shortcuts as the editor keymap). */
  let { view, disabled = false }: { view: EditorView | null; disabled?: boolean } = $props();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl+";
  const run = (fn: (v: EditorView) => boolean) => () => view && fn(view);
  const tools = $derived([
    { label: t("md.bold"), key: `${mod}B`, icon: Bold, run: run(v => md.bold(v, t("md.boldText"))) },
    { label: t("md.italic"), key: `${mod}I`, icon: Italic, run: run(v => md.italic(v, t("md.italicText"))) },
    { label: t("md.heading"), icon: Heading2, run: run(md.heading) },
    { label: t("md.list"), icon: List, run: run(md.list) },
    { label: t("editor.ordered"), icon: ListOrdered, run: run(md.ordered) },
    { label: t("md.task"), icon: ListChecks, run: run(md.task) },
    { label: t("editor.quote"), icon: Quote, run: run(md.quote) },
    { label: t("md.link"), key: `${mod}K`, icon: Link, run: run(v => md.link(v, t("md.linkText"))) },
    { label: t("md.code"), key: `${mod}E`, icon: Code, run: run(md.code) },
    { label: t("md.math"), key: `${mod}⇧M`, icon: Sigma, run: run(md.math) },
  ]);
</script>

{#each tools as tool (tool.label)}
  <ToolbarButton icon={tool.icon} label={tool.label} shortcut={tool.key} disabled={disabled || !view} onclick={tool.run} />
{/each}
