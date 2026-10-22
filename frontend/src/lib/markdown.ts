import MarkdownIt from "markdown-it";
import type { StateBlock, StateCore, StateInline, Token } from "markdown-it";
import DOMPurify from "dompurify";
import katex from "katex";
import footnote from "markdown-it-footnote";
import cjkFriendly from "markdown-it-cjk-friendly";
import { t } from "./i18n.svelte.ts";
import { parseChartSpec, renderChartSvg } from "./chart.ts";

/**
 * Markdown → sanitized HTML used by notes (and reusable elsewhere, e.g. the settings preview).
 * - Math with KaTeX: `$…$` / `\\(…\\)` inline, `$$…$$` / `\\[…\\]` / ```math display (centered, scrollable, with a
 *   copy-LaTeX button `.md-math-copy` and the TeX in `data-tex`); currency (`US$3`, `$5 and $10`) stays text.
 *   Callers must load `katex/dist/katex.min.css` (`MarkdownView.svelte` does).
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
  // `US$3`, `NT$500`: a `$` glued to a letter or digit is a currency sign, not math.
  if (!display && start > 0 && /[\p{L}\p{N}]/u.test(src[start - 1]!)) return false;
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
  const content = src.slice(from, end);
  // `$5 to buy a $` / `$3 and more$`: an amount followed by words is prose, not math.
  if (!display && /^\d[\d.,]*\s+[\p{L}]/u.test(content) && !/[\\^_{}=]/.test(content)) return false;
  if (!silent) {
    const token = state.push(display ? "math_display_inline" : "math_inline", "math", 0);
    token.content = content;
    token.markup = marker;
  }
  state.pos = end + marker.length;
  return true;
}

/** `\(…\)` inline and `\[…\]` display math inside a paragraph (runs before the backslash-escape rule). */
function mathParen(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5c /* \ */) return false;
  const open = src[start + 1];
  if (open !== "(" && open !== "[") return false;
  const close = open === "(" ? "\\)" : "\\]";
  const from = start + 2;
  const end = src.indexOf(close, from);
  if (end === -1 || end >= state.posMax || !src.slice(from, end).trim()) return false;
  if (!silent) {
    const token = state.push(open === "(" ? "math_inline" : "math_display_inline", "math", 0);
    token.content = src.slice(from, end).trim();
    token.markup = open === "(" ? "\\(" : "\\[";
  }
  state.pos = end + 2;
  return true;
}

/** Display math blocks: `$$ … $$` and `\[ … \]` (one or more lines; the delimiters may share lines with the TeX). */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  let max = state.eMarks[startLine]!;
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const head = state.src.slice(pos, pos + 2);
  if (head !== "$$" && head !== "\\[") return false;
  const closer = head === "$$" ? "$$" : "\\]";
  let first = state.src.slice(pos + 2, max).trim();
  let last = "";
  let next = startLine;
  let found = false;
  if (first.endsWith(closer)) {
    first = first.slice(0, -2);
    found = true;
  } else if (first.includes(closer)) return false; // `$$a$$ text` / `\[a\] text`: inline display math in a paragraph
  if (silent) return true;
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = state.bMarks[next]! + state.tShift[next]!;
    max = state.eMarks[next]!;
    if (pos < max && state.sCount[next]! < state.blkIndent) break;
    const line = state.src.slice(pos, max).trim();
    if (line.endsWith(closer)) {
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
  token.markup = head;
  token.map = [startLine, state.line];
  return true;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** A display formula: centered KaTeX, horizontally scrollable, with a copy-LaTeX button (wired in MarkdownView). */
function displayMath(raw: string, attrs = "") {
  const tex = raw.trim();
  const label = escapeHtml(t("mdx.copyTex"));
  return `<div class="md-math" data-tex="${escapeHtml(tex)}"${attrs}><div class="md-math-body">${renderMath(tex, true)}</div><button type="button" class="md-math-copy" aria-label="${label}" title="${label}">${COPY_ICON}</button></div>\n`;
}

/** Display width of a table cell's text: CJK / full-width characters count double. */
export function cellWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

/** Table cells with sentence-length text wrap (`md-wrap`); short cells (numbers, names) stay on one line. */
function tableCells(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    const open = tokens[i]!;
    if (open.type !== "td_open" && open.type !== "th_open") continue;
    const inline = tokens[i + 1]!;
    if (inline.type === "inline" && cellWidth(inline.content) > 28) open.attrJoin("class", "md-wrap");
  }
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
  // `**粗體**：` / `（**重點**）`: CommonMark flanking rules fail next to CJK punctuation; this relaxes them for CJK.
  md.use(cjkFriendly);
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.inline.ruler.before("escape", "math_paren", mathParen);
  md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.core.ruler.push("task_lists", taskLists); // after text_join, so "[ ]" is one text token
  md.core.ruler.push("callouts", callouts);
  md.core.ruler.push("table_cells", tableCells);
  if (withLines) md.core.ruler.push("source_lines", sourceLines);
  const line = (token: Token) => (token.attrGet("data-line") ? ` data-line="${token.attrGet("data-line")}"` : "");
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, false);
  md.renderer.rules.math_display_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx]!.content, true);
  md.renderer.rules.math_block = (tokens: Token[], idx: number) => displayMath(tokens[idx]!.content, line(tokens[idx]!));
  md.renderer.rules.math_pending = (tokens: Token[], idx: number) =>
    `<div class="md-math-pending" aria-busy="true"><span class="md-math-pending-label">${escapeHtml(t("mdx.mathPending"))}</span><code>${escapeHtml(tokens[idx]!.content)}</code></div>\n`;
  md.renderer.rules.table_open = (tokens: Token[], idx: number) => `<div class="md-table"${line(tokens[idx]!)}><table>\n`;
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "math") return displayMath(token.content.trim(), line(token));
    if (lang === "chart") {
      const spec = parseChartSpec(token.content);
      const svg = spec ? renderChartSvg(spec) : "";
      if (svg) return `<div class="md-chart-wrap"${line(token)}>${svg}</div>\n`;
    }
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

export type RenderOptions = {
  sourceLines?: boolean;
  /**
   * The source is still being streamed (assistant replies): a trailing display formula whose closing delimiter has
   * not arrived yet (`$$`, `\\[`, ```math) is shown as a muted placeholder instead of flickering half-rendered TeX.
   */
  streaming?: boolean;
};

/**
 * Where an unclosed display-math block starts (index into `source`), or -1. Code fences and inline code spans are
 * skipped; an unclosed ```math fence counts too.
 */
export function unclosedMathStart(source: string): number {
  let offset = 0;
  let fence: { marker: string; math: boolean; at: number } | null = null;
  let open: { closer: string; at: number } | null = null;
  for (const line of source.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence.marker) && !trimmed.slice(fence.marker.length).trim()) fence = null;
      continue;
    }
    const f = !open && /^(`{3,}|~{3,})\s*([\w-]*)/.exec(trimmed);
    if (f) {
      fence = { marker: f[1]!, math: f[2]!.toLowerCase() === "math", at };
      continue;
    }
    // Ignore inline code, escaped dollars and inline `\(…\)`.
    const text = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)).replace(/\\\$/g, "  ");
    const re = /\$\$|\\\[|\\\]/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const tok = m[0];
      if (open) {
        if (tok === open.closer) open = null;
      } else if (tok === "$$") open = { closer: "$$", at: at + m.index };
      else if (tok === "\\[") open = { closer: "\\]", at: at + m.index };
    }
  }
  if (fence?.math) return fence.at;
  return open ? open.at : -1;
}

/** Markdown → HTML **without** sanitising (tests; everything else uses `renderMarkdown`). */
export function markdownToHtml(source: string, options: RenderOptions = {}): string {
  const key = options.sourceLines ? "lines" : "plain";
  const parser = (parsers[key] ??= createParser(key === "lines"));
  if (options.streaming) {
    const cut = unclosedMathStart(source);
    if (cut >= 0) {
      const tail = source.slice(cut).replace(/^(\$\$|\\\[|`{3,}\s*math|~{3,}\s*math)/i, "").trim();
      const env = {};
      const tokens = parser.parse(source.slice(0, cut), env);
      const token = new new parser.core.State("", parser, env).Token("math_pending", "div", 0);
      token.block = true;
      token.content = tail.slice(-400);
      tokens.push(token);
      return parser.renderer.render(tokens, parser.options, env);
    }
  }
  return parser.render(source);
}

/** Renders Markdown to sanitized HTML, safe for `{@html}`. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  return sanitize(markdownToHtml(source, options));
}

/** Sanitizes an SVG produced by the Mermaid renderer before it is inserted. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}
