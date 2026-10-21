<script lang="ts">
  import { Bold, Code, Columns2, Eye, Heading2, Italic, Link, List, ListChecks, PenLine, Sigma } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import MarkdownView from "./MarkdownView.svelte";

  type Layout = "split" | "edit" | "preview";
  /**
   * Markdown textarea with toolbar and live preview. `layout` is per session (initialised from the user's editor
   * preference by the caller); phones fall back to an edit/preview toggle.
   */
  let { value = $bindable(""), layout = $bindable("split"), fontSize = 15, label, fill = false }: { value?: string; layout?: Layout; fontSize?: number; label: string; fill?: boolean } = $props();

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let preview = $state<HTMLElement | null>(null);
  let previewSource = $state(value);
  const effective = $derived<Layout>(!viewport.desktop && layout === "split" ? "edit" : layout);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl+";

  // Debounced preview so typing stays smooth on long notes.
  $effect(() => {
    const next = value;
    if (effective === "edit") return;
    const timer = setTimeout(() => (previewSource = next), previewSource === next ? 0 : 140);
    return () => clearTimeout(timer);
  });

  function insert(text: string, selectFrom: number, selectTo: number) {
    const ta = textarea!;
    const start = ta.selectionStart;
    ta.focus();
    // execCommand keeps the native undo stack; fall back to setRangeText where unsupported.
    if (!document.execCommand?.("insertText", false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      value = ta.value;
    }
    ta.setSelectionRange(start + selectFrom, start + selectTo);
  }

  function wrap(before: string, after: string, placeholder: string) {
    const ta = textarea;
    if (!ta) return;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const body = selected || placeholder;
    insert(before + body + after, before.length, before.length + body.length);
  }

  /** Toggles a prefix on every selected line (headings, lists). */
  function prefixLines(prefix: string, pattern: RegExp) {
    const ta = textarea;
    if (!ta) return;
    const from = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let to = ta.value.indexOf("\n", ta.selectionEnd);
    if (to === -1) to = ta.value.length;
    const lines = ta.value.slice(from, to).split("\n");
    const all = lines.every(line => pattern.test(line));
    const next = lines.map(line => (all ? line.replace(pattern, "") : prefix + line.replace(pattern, ""))).join("\n");
    ta.setSelectionRange(from, to);
    insert(next, next.length, next.length);
  }

  function code() {
    const ta = textarea;
    if (!ta) return;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (selected.includes("\n")) wrap("```\n", "\n```", "");
    else wrap("`", "`", "code");
  }
  function math() {
    const ta = textarea;
    if (!ta) return;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (selected.includes("\n")) wrap("$$\n", "\n$$", "");
    else wrap("$", "$", "x^2");
  }
  function link() {
    const ta = textarea;
    if (!ta) return;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd) || t("md.linkText");
    const text = `[${selected}](https://)`;
    insert(text, selected.length + 3, text.length - 1);
  }

  const tools = $derived([
    { label: t("md.bold"), key: "B", icon: Bold, run: () => wrap("**", "**", t("md.boldText")) },
    { label: t("md.italic"), key: "I", icon: Italic, run: () => wrap("*", "*", t("md.italicText")) },
    { label: t("md.heading"), key: null, icon: Heading2, run: () => prefixLines("## ", /^#{1,6}\s+/) },
    { label: t("md.list"), key: null, icon: List, run: () => prefixLines("- ", /^\s*[-*+]\s+(?!\[[ xX]\])/) },
    { label: t("md.task"), key: null, icon: ListChecks, run: () => prefixLines("- [ ] ", /^\s*[-*+]\s+\[[ xX]\]\s+/) },
    { label: t("md.link"), key: "K", icon: Link, run: link },
    { label: t("md.code"), key: "E", icon: Code, run: code },
    { label: t("md.math"), key: "M", icon: Sigma, run: math },
  ]);

  function onKeydown(event: KeyboardEvent) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const tool = tools.find(x => x.key && x.key.toLowerCase() === event.key.toLowerCase());
    if (tool) {
      event.preventDefault();
      tool.run();
    }
  }

  function syncScroll() {
    if (effective !== "split" || !textarea || !preview) return;
    const max = textarea.scrollHeight - textarea.clientHeight;
    preview.scrollTop = max > 0 ? (textarea.scrollTop / max) * (preview.scrollHeight - preview.clientHeight) : 0;
  }

  const layoutOptions = $derived(
    viewport.desktop
      ? [
          { value: "edit" as const, label: t("md.edit"), icon: PenLine },
          { value: "split" as const, label: t("md.split"), icon: Columns2 },
          { value: "preview" as const, label: t("md.preview"), icon: Eye },
        ]
      : [
          { value: "edit" as const, label: t("md.edit"), icon: PenLine },
          { value: "preview" as const, label: t("md.preview"), icon: Eye },
        ],
  );
  let segmentValue = $state<Layout>("edit");
  $effect(() => {
    segmentValue = effective;
  });
</script>

<!-- overflow-clip (not hidden) keeps the rounded corners without creating a scroll container, so the toolbar can stick. -->
<div class="flex flex-col overflow-clip rounded-2xl border border-line-2 bg-surface focus-within:border-ink {fill ? 'min-h-0 flex-1' : ''}">
  <!-- Phones/tablets: the page scrolls with the growing textarea, so the toolbar sticks below the top bar. -->
  <div class="flex flex-wrap items-center gap-1 border-b border-line px-1.5 py-1.5 lg:flex-nowrap {fill ? 'bg-surface-2/70' : 'sticky top-[calc(max(12px,env(safe-area-inset-top))+52px)] z-10 bg-surface-2'}">
    <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] {effective === 'preview' ? 'pointer-events-none opacity-40' : ''}" role="toolbar" aria-label={t("md.toolbar")}>
      {#each tools as tool (tool.label)}
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink [&_svg]:size-4"
          aria-label={tool.label}
          title={tool.key ? `${tool.label} (${mod}${tool.key})` : tool.label}
          tabindex={effective === "preview" ? -1 : 0}
          onclick={tool.run}><tool.icon /></button
        >
      {/each}
    </div>
    <Segmented bind:value={segmentValue} options={layoutOptions} label={t("md.layout")} onValueChange={v => (layout = v)} class="order-first w-full shrink-0 lg:order-none lg:w-auto [&_button]:h-7 [&_button]:px-2.5 [&_button]:text-[12px]" />
  </div>
  <div class="grid min-h-0 flex-1 {effective === 'split' ? 'grid-cols-2 divide-x divide-line' : 'grid-cols-1'}">
    <textarea
      bind:this={textarea}
      bind:value
      aria-label={label}
      spellcheck="false"
      onkeydown={onKeydown}
      onscroll={syncScroll}
      placeholder={t("md.placeholder")}
      class="block w-full resize-none bg-surface px-4 py-3.5 font-mono leading-[1.7] text-ink outline-none placeholder:text-ink-3 sm:px-5 {effective === 'preview' ? 'hidden' : ''} {fill ? 'h-full min-h-0' : 'min-h-[55dvh] [field-sizing:content]'}"
      style="font-size:{fontSize}px"
    ></textarea>
    {#if effective !== "edit"}
      <div bind:this={preview} class="min-w-0 overflow-y-auto px-4 py-3.5 sm:px-6 sm:py-4 {fill ? 'min-h-0' : 'min-h-[55dvh]'}">
        {#if previewSource.trim()}
          <MarkdownView source={previewSource} fontSize={fontSize} />
        {:else}
          <p class="text-[13px] text-ink-3">{t("md.previewEmpty")}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
