import MarkdownIt from "markdown-it";
import type { StateBlock, StateCore, StateInline, Token } from "markdown-it";
import DOMPurify from "dompurify";
import katex from "katex";

/**
 * Markdown → sanitized HTML used by notes (and reusable elsewhere, e.g. the settings preview).
 * - `$…$` inline and `$$…$$` block math rendered with KaTeX (callers must load `katex/dist/katex.min.css`;
 *   `MarkdownView.svelte` does).
 * - GFM tables (wrapped in `.md-table` for horizontal scroll), fenced code, task lists rendered as
 *   `<span class="md-task" data-checked>` glyphs instead of native checkboxes.
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

function createParser() {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.core.ruler.push("task_lists", taskLists); // after text_join, so "[ ]" is one text token
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, false);
  md.renderer.rules.math_display_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, true);
  md.renderer.rules.math_block = (tokens: Token[], idx: number) => `<div class="md-math">${renderMath(tokens[idx]!.content, true)}</div>\n`;
  md.renderer.rules.table_open = () => '<div class="md-table"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md;
}

let parser: ReturnType<typeof createParser> | null = null;
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
export function renderMarkdown(source: string): string {
  parser ??= createParser();
  return sanitize(parser.render(source));
}
