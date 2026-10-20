<script lang="ts">
  import "katex/dist/katex.min.css";
  import { renderMarkdown } from "#lib/notes/markdown.ts";

  /** Rendered, sanitized Markdown with the hub's prose styles. `fontSize` scales the whole block (px). */
  let { source, fontSize, class: cls = "" }: { source: string; fontSize?: number; class?: string } = $props();
  const html = $derived(renderMarkdown(source));
</script>

<!-- sanitized by DOMPurify in renderMarkdown -->
<div class="md {cls}" style={fontSize ? `font-size:${fontSize}px` : undefined}>{@html html}</div>

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
  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
    color: var(--ink-2);
  }
  .md :global(tr:last-child td) {
    border-bottom: 0;
  }
  .md :global(.md-math) {
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.2em 0;
  }
  .md :global(.katex) {
    font-size: 1.08em;
  }
  .md :global(.katex-display) {
    margin: 0;
  }
  .md :global(img) {
    max-width: 100%;
    border-radius: 12px;
  }
</style>
