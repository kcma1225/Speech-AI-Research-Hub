import MarkdownIt from "markdown-it";
import type { StateBlock, StateCore, StateInline, Token } from "markdown-it";
import DOMPurify from "dompurify";
import katex from "katex";
import footnote from "markdown-it-footnote";
import { t } from "./i18n.svelte.ts";

/**
 * Markdown → sanitized HTML used by notes (and reusable elsewhere, e.g. the settings preview).
 * - `$…$` inline and `$$…$$` block math rendered with KaTeX (callers must load `katex/dist/katex.min.css`;
 *   `MarkdownView.svelte` does).
 * - GFM tables (wrapped in `.md-table` for horizontal scroll), fenced code, task lists rendered as
 *   `<span class="md-task" data-checked>` glyphs instead of native checkboxes.
 * - Footnotes (`[^1]`), GitHub-style callouts (`> [!NOTE]`, TIP, IMPORTANT, WARNING, CAUTION), fenced code with a
 *   language label (`data-lang`), and ```mermaid fences as `.md-mermaid` placeholders that `MarkdownView` renders
 *   lazily (the diagram source stays escaped text until then).
 * - `sourceLines`: block elements carry `data-line` (1-based source line) for editor ↔ preview scroll sync.
 * - Raw HTML in the source is not parsed; the output is passed through DOMPurify anyway, and absolute links
 *   open in a new tab with `rel="noopener noreferrer"`.
 */

function renderMath(source: string, displayMode: boolean) {
  return katex.renderToString(source, { throwOnError: false, displayMode, output: "htmlAndMathml", strict: "ignore", trust: false });
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  const display = src.charCodeAt(start + 1) === 0x24;
  const marker = display ? "$$" : "$";
  const from = start + marker.length;
  if (from >= state.posMax) return false;
  // Pandoc rule: `$` must hug its content, and a closing `$` followed by a digit is a price, not math.
  if (!display && /\s/.test(src[from]!)) return false;
  let end = from;
  for (;;) {
    end = src.indexOf(marker, end);
    if (end === -1 || end >= state.posMax) return false;
    if (src[end - 1] === "\\") {
      end += 1;
      continue;
    }
    break;
  }
  if (end === from) return false;
  if (!display && (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? ""))) return false;
  if (!silent) {
    const token = state.push(display ? "math_display_inline" : "math_inline", "math", 0);
    token.content = src.slice(from, end);
    token.markup = marker;
  }
  state.pos = end + marker.length;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  let max = state.eMarks[startLine]!;
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  let first = state.src.slice(pos + 2, max).trim();
  let last = "";
  let next = startLine;
  let found = false;
  if (first.endsWith("$$")) {
    first = first.slice(0, -2);
    found = true;
  }
  if (silent) return true;
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = state.bMarks[next]! + state.tShift[next]!;
    max = state.eMarks[next]!;
    if (pos < max && state.sCount[next]! < state.blkIndent) break;
    const line = state.src.slice(pos, max).trim();
    if (line.endsWith("$$")) {
      last = line.slice(0, -2);
      found = true;
    }
  }
  if (!found) return false;
  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  const middle = next > startLine ? state.getLines(startLine + 1, next, state.tShift[startLine]!, true) : "";
  token.content = [first, middle, last].filter(part => part.trim()).join("\n");
  token.markup = "$$";
  token.map = [startLine, state.line];
  return true;
}

/** `- [ ] item` / `- [x] item` → custom glyph + `md-task-item` class on the list item. */
function taskLists(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]!;
    if (inline.type !== "inline" || tokens[i - 1]!.type !== "paragraph_open" || tokens[i - 2]!.type !== "list_item_open") continue;
    const match = /^\[([ xX])\][  ]/.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || !first || first.type !== "text" || !/^\[([ xX])\][  ]/.test(first.content)) continue;
    const checked = match[1] !== " ";
    first.content = first.content.slice(4);
    const glyph = new state.Token("html_inline", "", 0);
    glyph.content = `<span class="md-task"${checked ? ' data-checked="true"' : ""} role="img" aria-label="${checked ? "done" : "todo"}"></span>`;
    inline.children!.unshift(glyph);
    tokens[i - 2]!.attrJoin("class", "md-task-item");
    // Mark the parent list so bullets can be hidden.
    for (let j = i - 3; j >= 0; j--) {
      const token = tokens[j]!;
      if ((token.type === "bullet_list_open" || token.type === "ordered_list_open") && token.level === tokens[i - 2]!.level - 1) {
        token.attrJoin("class", "md-task-list");
        break;
      }
    }
  }
}

const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*/i;
const calloutTitle = (kind: string) => t(`mdx.callout.${kind}` as Parameters<typeof t>[0]);

/** `> [!NOTE]` blockquotes → `.md-callout.md-callout-note` with a localized title line. */
function callouts(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    const open = tokens[i]!;
    if (open.type !== "blockquote_open" || tokens[i + 1]!.type !== "paragraph_open") continue;
    const inline = tokens[i + 2]!;
    const match = CALLOUT.exec(inline.content);
    if (inline.type !== "inline" || !match) continue;
    const kind = match[1]!.toLowerCase();
    open.attrJoin("class", `md-callout md-callout-${kind}`);
    inline.content = inline.content.slice(match[0].length).replace(/^\n/, "");
    const children = inline.children ?? [];
    const first = children[0];
    if (first?.type === "text") {
      first.content = first.content.replace(CALLOUT, "");
      if (!first.content) children.shift();
      if (children[0]?.type === "softbreak" || children[0]?.type === "hardbreak") children.shift();
    }
    const title = new state.Token("html_block", "", 0);
    title.content = `<p class="md-callout-title">${escapeHtml(calloutTitle(kind))}</p>\n`;
    tokens.splice(i + 1, 0, title);
    // A callout with only the marker line: drop the empty paragraph.
    if (!children.length) tokens.splice(i + 2, 3);
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `data-line` on block-level openers (used by the editor's scroll sync). */
function sourceLines(state: StateCore) {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.block && token.type !== "inline" && token.level <= 3) token.attrSet("data-line", String(token.map[0] + 1));
  }
}

function createParser(withLines: boolean) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.use(footnote);
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.core.ruler.push("task_lists", taskLists); // after text_join, so "[ ]" is one text token
  md.core.ruler.push("callouts", callouts);
  if (withLines) md.core.ruler.push("source_lines", sourceLines);
  const line = (token: Token) => (token.attrGet("data-line") ? ` data-line="${token.attrGet("data-line")}"` : "");
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, false);
  md.renderer.rules.math_display_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, true);
  md.renderer.rules.math_block = (tokens: Token[], idx: number) => `<div class="md-math"${line(tokens[idx]!)}>${renderMath(tokens[idx]!.content, true)}</div>\n`;
  md.renderer.rules.table_open = (tokens: Token[], idx: number) => `<div class="md-table"${line(tokens[idx]!)}><table>\n`;
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "mermaid") return `<div class="md-mermaid"${line(token)}><pre class="md-mermaid-src">${escapeHtml(token.content)}</pre></div>\n`;
    const html = fence(tokens, idx, options, env, self);
    return lang ? html.replace(/^<pre/, `<pre data-lang="${escapeHtml(lang.slice(0, 20))}"`) : html;
  };
  // Footnote markup without the plugin's "↩︎" emoji variation and with a localized label.
  md.renderer.rules.footnote_block_open = () => `<section class="md-footnotes" aria-label="${escapeHtml(t("mdx.footnotes"))}"><ol class="md-footnotes-list">\n`;
  md.renderer.rules.footnote_block_close = () => "</ol></section>\n";
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md;
}

const parsers: Partial<Record<"plain" | "lines", ReturnType<typeof createParser>>> = {};
let hooked = false;

function sanitize(html: string) {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", node => {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        const href = node.getAttribute("href") ?? "";
        if (/^(https?:)?\/\//i.test(href)) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      }
    });
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, mathMl: true }, ADD_ATTR: ["target"] });
}

/** Renders Markdown to sanitized HTML, safe for `{@html}`. */
export function renderMarkdown(source: string, options: { sourceLines?: boolean } = {}): string {
  const key = options.sourceLines ? "lines" : "plain";
  const parser = (parsers[key] ??= createParser(key === "lines"));
  return sanitize(parser.render(source));
}

/** Sanitizes an SVG produced by the Mermaid renderer before it is inserted. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}
