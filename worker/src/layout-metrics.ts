/**
 * Deterministic per-slide layout metrics (evaluated in the deck page while `captureShots` visits each slide; kept as
 * a string because it runs in the browser). Returned with the preview's shots manifest (`pages[].metrics`) and used by
 * the slides workflow's visual QA: overflow, font sizes, word count, bullets, visuals, raw diagram code.
 */
export type SlideMetrics = {
  /** Visible words: Latin words + CJK characters / 2 (headings included). */
  words: number;
  bullets: number;
  /** Smallest / largest computed font size (px, in deck coordinates) of visible text. */
  minFont: number | null;
  maxFont: number | null;
  /** Content extends past the slide (px beyond the bottom/right edge, deck coordinates; 0 = fits). */
  overflowY: number;
  overflowX: number;
  /** Images, SVG diagrams/charts, tables. */
  visuals: number;
  tables: number;
  /** Rendered Mermaid diagrams, Mermaid syntax errors, and code blocks that look like diagram source. */
  diagrams: number;
  diagramErrors: number;
  rawDiagramCode: number;
  codeBlocks: number;
};

export const SLIDE_METRICS = `(() => {
  const reveal = window.Reveal;
  const slide = reveal && reveal.getCurrentSlide ? reveal.getCurrentSlide() : null;
  if (!slide) return null;
  const cfg = reveal.getConfig ? reveal.getConfig() : {};
  const W = Number(cfg.width) || 1280, H = Number(cfg.height) || 800;
  const box = slide.getBoundingClientRect();
  const scale = box.width > 0 ? box.width / slide.offsetWidth : 1;
  const top = box.top, left = box.left;
  const visible = (el) => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0; };
  let words = 0, minFont = null, maxFont = null, overflowY = 0, overflowX = 0;
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest("aside.notes, script, style, svg, .mermaid, pre.mermaid-js") || !visible(el)) continue;
    const cjk = (text.match(/[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]/g) || []).length;
    const latin = (text.replace(/[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]/g, " ").match(/[A-Za-z0-9][\\w'.%-]*/g) || []).length;
    words += latin + cjk / 2;
    const size = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (size > 0) { minFont = minFont === null ? size : Math.min(minFont, size); maxFont = maxFont === null ? size : Math.max(maxFont, size); }
  }
  for (const el of slide.querySelectorAll("*")) {
    if (el.closest("aside.notes") || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    overflowY = Math.max(overflowY, (r.bottom - top) / scale - H);
    overflowX = Math.max(overflowX, (r.right - left) / scale - W);
  }
  const code = [...slide.querySelectorAll("pre")].filter((el) => !el.closest("aside.notes") && !el.closest(".mermaid"));
  const diagramSource = /^\\s*(flowchart|graph\\s+(TD|TB|LR|RL|BT)|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|digraph)\\b/m;
  const mermaids = [...slide.querySelectorAll(".mermaid, .cell-output-display svg[id^=mermaid], svg[aria-roledescription]")];
  const errors = [...slide.querySelectorAll("svg[aria-roledescription=error], .error-icon")].length
    + mermaids.filter((el) => /Syntax error in text|Parse error/i.test(el.textContent || "")).length;
  return {
    words: Math.round(words),
    bullets: [...slide.querySelectorAll("li")].filter((el) => !el.closest("aside.notes") && visible(el)).length,
    minFont: minFont === null ? null : Math.round(minFont * 10) / 10,
    maxFont: maxFont === null ? null : Math.round(maxFont * 10) / 10,
    overflowY: Math.max(0, Math.round(overflowY)),
    overflowX: Math.max(0, Math.round(overflowX)),
    visuals: [...slide.querySelectorAll("img, svg, table, canvas")].filter((el) => !el.closest("aside.notes") && !el.closest("svg svg") && el.getBoundingClientRect().width > 120).length,
    tables: [...slide.querySelectorAll("table")].filter((el) => !el.closest("aside.notes")).length,
    diagrams: [...slide.querySelectorAll("svg")].filter((el) => (el.id || "").startsWith("mermaid") || el.getAttribute("aria-roledescription")).length,
    diagramErrors: errors,
    rawDiagramCode: code.filter((el) => diagramSource.test(el.textContent || "")).length,
    codeBlocks: code.length,
  };
})()`;
