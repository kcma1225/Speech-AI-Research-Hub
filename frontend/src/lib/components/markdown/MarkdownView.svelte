<script lang="ts">
  import "katex/dist/katex.min.css";
  import { renderMarkdown } from "#lib/markdown.ts";
  import { theme } from "#lib/theme.svelte.ts";
  import { renderMermaidIn } from "./mermaid.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /**
   * Rendered, sanitized Markdown with the hub's prose styles. `fontSize` scales the whole block (px).
   * `sourceLines` adds `data-line` attributes (editor scroll sync); ```mermaid blocks render lazily. `streaming`: a trailing
   * display formula without its closing delimiter shows as a muted placeholder. Display formulas get a copy-LaTeX button.
   */
  let { source, fontSize, class: cls = "", sourceLines = false, streaming = false, element = $bindable(null) }: { source: string; fontSize?: number; class?: string; sourceLines?: boolean; streaming?: boolean; element?: HTMLElement | null } = $props();
  const html = $derived(renderMarkdown(source, { sourceLines, streaming }));

  async function onclick(e: MouseEvent) {
    const button = (e.target as HTMLElement | null)?.closest?.(".md-math-copy");
    if (!button || !element?.contains(button)) return;
    e.preventDefault();
    e.stopPropagation();
    const tex = button.closest<HTMLElement>(".md-math")?.dataset.tex ?? "";
    try {
      await navigator.clipboard.writeText(tex);
      toasts.show(t("mdx.copiedTex"), "success");
    } catch {
      // clipboard unavailable (insecure context)
    }
  }

  $effect(() => {
    void html;
    const dark = theme.resolved === "dark";
    if (element && element.querySelector(".md-mermaid")) void renderMermaidIn(element, dark);
  });
</script>

<!-- sanitized by DOMPurify in renderMarkdown -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={element} {onclick} class="md {cls}" style={fontSize ? `font-size:${fontSize}px` : undefined}>{@html html}</div>

<style>
  .md {
    font-size: 15px;
    line-height: 1.75;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .md > :global(:first-child) {
    margin-top: 0;
  }
  .md > :global(:last-child) {
    margin-bottom: 0;
  }
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(pre),
  .md :global(.md-table),
  .md :global(.md-math) {
    margin: 0.85em 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4),
  .md :global(h5),
  .md :global(h6) {
    margin: 1.6em 0 0.55em;
    font-weight: 650;
    line-height: 1.3;
    letter-spacing: -0.012em;
    color: var(--ink);
  }
  .md :global(h1) {
    font-size: 1.6em;
  }
  .md :global(h2) {
    font-size: 1.32em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--line);
  }
  .md :global(h3) {
    font-size: 1.12em;
  }
  .md :global(h4),
  .md :global(h5),
  .md :global(h6) {
    font-size: 1em;
  }
  .md :global(a) {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--line-2);
    text-underline-offset: 3px;
  }
  .md :global(a:hover) {
    text-decoration-color: var(--ink);
  }
  .md :global(strong) {
    font-weight: 650;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
  }
  .md :global(ul) {
    list-style: disc;
  }
  .md :global(ol) {
    list-style: decimal;
  }
  .md :global(li) {
    margin: 0.25em 0;
  }
  .md :global(li::marker) {
    color: var(--ink-3);
  }
  .md :global(li > p) {
    margin: 0.25em 0;
  }
  .md :global(ul.md-task-list) {
    list-style: none;
    padding-left: 0.2em;
  }
  /* Hanging indent: wrapped lines line up with the text after the checkbox (glyph 1.05em + 0.55em gap). */
  .md :global(li.md-task-item) {
    display: block;
    padding-left: 1.6em;
    text-indent: -1.6em;
  }
  .md :global(li.md-task-item > :is(ul, ol)) {
    text-indent: 0;
  }
  .md :global(.md-task) {
    position: relative;
    display: inline-block;
    width: 1.05em;
    height: 1.05em;
    margin-right: 0.55em;
    vertical-align: -0.17em;
    border: 1.5px solid var(--line-2);
    border-radius: 0.32em;
    background: var(--surface);
  }
  .md :global(.md-task[data-checked]) {
    border-color: var(--ink);
    background: var(--ink);
  }
  .md :global(.md-task[data-checked]::after) {
    content: "";
    position: absolute;
    left: 0.3em;
    top: 0.1em;
    width: 0.3em;
    height: 0.55em;
    border: solid var(--surface);
    border-width: 0 0.13em 0.13em 0;
    transform: rotate(45deg);
  }
  .md :global(li.md-task-item:has(> .md-task[data-checked])),
  .md :global(li.md-task-item:has(> p > .md-task[data-checked])) {
    color: var(--ink-3);
  }
  .md :global(blockquote) {
    padding: 0.1em 0 0.1em 1em;
    border-left: 3px solid var(--line-2);
    color: var(--ink-2);
  }
  .md :global(hr) {
    margin: 1.8em 0;
    border: 0;
    border-top: 1px solid var(--line);
  }
  .md :global(code) {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 0.86em;
  }
  .md :global(:not(pre) > code) {
    padding: 0.12em 0.4em;
    border-radius: 0.4em;
    background: var(--surface-3);
    color: var(--ink);
  }
  .md :global(pre) {
    overflow-x: auto;
    padding: 0.95em 1.1em;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface-2);
    line-height: 1.6;
  }
  .md :global(pre code) {
    font-size: 0.84em;
    color: var(--ink-2);
  }
  .md :global(.md-table) {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 14px;
  }
  .md :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92em;
    font-variant-numeric: tabular-nums;
  }
  .md :global(th),
  .md :global(td) {
    padding: 0.55em 0.9em;
    border-bottom: 1px solid var(--line);
    text-align: left;
    white-space: nowrap;
  }
  /* Sentence-length cells (lib/markdown.ts `md-wrap`) wrap instead of pushing the table off-screen. */
  .md :global(:is(th, td).md-wrap) {
    white-space: normal;
    min-width: 12em;
    max-width: 36em;
    overflow-wrap: anywhere;
  }
  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
    color: var(--ink-2);
  }
  .md :global(tr:last-child td) {
    border-bottom: 0;
  }
  .md :global(.md-math) {
    position: relative;
    border-radius: 12px;
  }
  .md :global(.md-math-body) {
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.35em 0.5em;
    text-align: center;
    overscroll-behavior-x: contain;
  }
  .md :global(.md-math:hover),
  .md :global(.md-math:focus-within) {
    background: var(--surface-2);
  }
  .md :global(.md-math-copy) {
    position: absolute;
    top: 2px;
    right: 2px;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-3);
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms;
  }
  .md :global(.md-math-copy:hover) {
    color: var(--ink);
  }
  .md :global(.md-math:hover .md-math-copy),
  .md :global(.md-math-copy:focus-visible) {
    opacity: 1;
  }
  @media (pointer: coarse) {
    .md :global(.md-math-copy) {
      opacity: 0.85;
      width: 40px;
      height: 40px;
      top: -4px;
      right: -4px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .md :global(.md-math-copy) {
      transition: none;
    }
  }
  .md :global(.md-math-pending) {
    margin: 0.85em 0;
    padding: 0.6em 0.9em;
    border-left: 3px solid var(--line-2);
    border-radius: 0 10px 10px 0;
    background: var(--surface-2);
    color: var(--ink-3);
    font-size: 0.86em;
    overflow-x: auto;
  }
  .md :global(.md-math-pending-label) {
    display: block;
    margin-bottom: 0.2em;
    font-size: 0.9em;
    font-weight: 600;
  }
  .md :global(.md-math-pending code) {
    white-space: pre-wrap;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .md :global(.katex) {
    font-size: 1.08em;
  }
  .md :global(.katex-display) {
    margin: 0;
  }
  /* Inline \\[…\\] / $$…$$ inside a paragraph: its own centered, scrollable line. */
  .md :global(p .katex-display) {
    display: block;
    overflow-x: auto;
    overflow-y: hidden;
    margin: 0.5em 0;
    text-align: center;
  }
  .md :global(img) {
    max-width: 100%;
    border-radius: 12px;
  }
  .md :global(pre[data-lang]) {
    position: relative;
  }
  .md :global(pre[data-lang])::before {
    content: attr(data-lang);
    position: absolute;
    top: 0.45em;
    right: 0.8em;
    font-family: "Inter Variable", "Noto Sans TC Variable", sans-serif;
    font-size: 0.68em;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  /* GitHub-style callouts: a tinted card with a title line, tones from the pill palette (light/dark aware). */
  .md :global(blockquote.md-callout) {
    --tone: var(--pill-sky);
    --tone-ink: var(--pill-sky-ink);
    padding: 0.7em 1em 0.75em;
    border: 1px solid color-mix(in srgb, var(--tone-ink) 22%, transparent);
    border-left: 4px solid var(--tone-ink);
    border-radius: 12px;
    background: color-mix(in srgb, var(--tone) 55%, transparent);
    color: var(--ink);
  }
  .md :global(blockquote.md-callout > :nth-child(2)) {
    margin-top: 0.25em;
  }
  .md :global(blockquote.md-callout > :last-child) {
    margin-bottom: 0;
  }
  .md :global(.md-callout-title) {
    margin: 0;
    font-size: 0.86em;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--tone-ink);
  }
  .md :global(.md-callout-tip) {
    --tone: var(--pill-mint);
    --tone-ink: var(--pill-mint-ink);
  }
  .md :global(.md-callout-important) {
    --tone: var(--pill-lilac);
    --tone-ink: var(--pill-lilac-ink);
  }
  .md :global(.md-callout-warning) {
    --tone: var(--pill-butter);
    --tone-ink: var(--pill-butter-ink);
  }
  .md :global(.md-callout-caution) {
    --tone: var(--pill-peach);
    --tone-ink: var(--danger);
  }
  .md :global(.md-footnotes) {
    margin-top: 2em;
    padding-top: 0.8em;
    border-top: 1px solid var(--line);
    font-size: 0.88em;
    color: var(--ink-2);
  }
  .md :global(.md-footnotes-list) {
    list-style: decimal;
  }
  .md :global(.footnote-ref a),
  .md :global(a.footnote-backref) {
    text-decoration: none;
    font-weight: 600;
  }
  .md :global(.footnote-ref) {
    font-size: 0.75em;
    line-height: 0;
  }
  /* ```chart (lib/chart.ts): inline SVG, series colours from the pill inks (light/dark aware). */
  .md :global(.md-chart-wrap) {
    margin: 0.85em 0;
    padding: 0.7em 0.8em 0.6em;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
  }
  .md :global(.md-chart) {
    margin: 0;
  }
  .md :global(.md-chart svg) {
    display: block;
    width: 100%;
    height: auto;
    max-height: 420px;
    font-family: "Inter Variable", "Noto Sans TC Variable", sans-serif;
  }
  .md :global(.md-chart .t) {
    font-size: 14px;
    font-weight: 600;
    fill: var(--ink);
  }
  .md :global(.md-chart .a),
  .md :global(.md-chart .v) {
    font-size: 11px;
    fill: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .md :global(.md-chart .v) {
    fill: var(--ink-2);
  }
  .md :global(.md-chart .g) {
    stroke: var(--line);
    stroke-width: 1;
  }
  .md :global(.md-chart .z) {
    stroke: var(--line-2);
    stroke-width: 1;
  }
  .md :global(.md-chart .l) {
    fill: none;
    stroke-width: 2.25;
    stroke-linejoin: round;
  }
  .md :global(.md-chart .s0) {
    --c: var(--pill-sky-ink);
  }
  .md :global(.md-chart .s1) {
    --c: var(--pill-peach-ink);
  }
  .md :global(.md-chart .s2) {
    --c: var(--pill-mint-ink);
  }
  .md :global(.md-chart .s3) {
    --c: var(--pill-lilac-ink);
  }
  .md :global(.md-chart .s4) {
    --c: var(--pill-butter-ink);
  }
  .md :global(.md-chart .f) {
    fill: var(--c);
  }
  .md :global(.md-chart .l) {
    stroke: var(--c);
  }
  .md :global(.md-chart-legend) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em 1em;
    margin-top: 0.3em;
    font-size: 12px;
    color: var(--ink-2);
  }
  .md :global(.md-chart-legend i) {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    margin-right: 0.4em;
    border-radius: 3px;
    vertical-align: -0.05em;
    background: var(--c);
  }
  .md :global(.md-mermaid) {
    margin: 0.85em 0;
    overflow-x: auto;
    padding: 0.8em;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    text-align: center;
  }
  .md :global(.md-mermaid svg) {
    max-width: 100%;
    height: auto;
  }
  .md :global(.md-mermaid-src) {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    white-space: pre-wrap;
    font-size: 0.84em;
    color: var(--ink-3);
  }
  .md :global(.md-mermaid-error) {
    margin-top: 0.5em;
    font-size: 0.8em;
    color: var(--danger);
    text-align: left;
  }
</style>
