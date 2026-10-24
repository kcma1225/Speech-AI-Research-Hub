/**
 * Deterministic per-slide layout metrics (evaluated in the deck page while `captureShots` visits each slide; kept as
 * a string because it runs in the browser). Returned with the preview's shots manifest (`pages[].metrics`) and used by
 * the slides workflow's visual QA: overflow (slide edges and labels inside diagram boxes), font sizes (HTML text,
 * inline SVG text and SVG images that declare their own minimum font), word count, bullets, visuals, raw diagram
 * code, and the largest empty vertical band of the slide body.
 */
export type SlideMetrics = {
  /** Visible words: Latin words + CJK characters / 2 (headings included). */
  words: number;
  bullets: number;
  /** Smallest / largest computed font size (px, in deck coordinates) of visible HTML text. */
  minFont: number | null;
  maxFont: number | null;
  /** Content extends past the slide (px beyond the bottom/right — or top/left — edge, deck coordinates; 0 = fits). */
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
  /** Labels of inline SVG diagrams (Mermaid) that stick out of their node shape or are clipped (count + examples). */
  textOverflow?: number;
  overflowLabels?: string[];
  /** Smallest rendered font of inline SVG text and of `<img data-font>` diagrams/charts (font × display scale). */
  minVisualFont?: number | null;
  /** Largest empty horizontal band of the slide body (below the title), as a fraction of the body height. */
  emptyBand?: number;
  /** Lowest content edge as a fraction of the slide height. */
  contentBottom?: number;
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
  const inNotes = (el) => !!el.closest("aside.notes");
  let words = 0, minFont = null, maxFont = null, overflowY = 0, overflowX = 0;
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  const bands = [];
  const addBand = (r) => { if (r.width > 0 && r.height > 0) bands.push([(r.top - top) / scale, (r.bottom - top) / scale]); };
  let node;
  while ((node = walker.nextNode())) {
    // Zero-width characters are not text (KaTeX's 1px \`.vlist-s\` struts hold a U+200B: every slide with a sub- or
    // superscript measured "1px text"); KaTeX's MathML copy is clipped to 1px for screen readers.
    const text = (node.nodeValue || "").replace(/[\\u200b-\\u200d\\u2060\\ufeff]/g, "").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest("aside.notes, script, style, svg, .mermaid, pre.mermaid-js, .katex-mathml") || !visible(el)) continue;
    const cjk = (text.match(/[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]/g) || []).length;
    const latin = (text.replace(/[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]/g, " ").match(/[A-Za-z0-9][\\w'.%-]*/g) || []).length;
    words += latin + cjk / 2;
    const size = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (size > 0) { minFont = minFont === null ? size : Math.min(minFont, size); maxFont = maxFont === null ? size : Math.max(maxFont, size); }
    if (!el.closest("h1, h2")) { const range = document.createRange(); range.selectNodeContents(node); for (const r of range.getClientRects()) addBand(r); }
  }
  for (const el of slide.querySelectorAll("*")) {
    if (inNotes(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    overflowY = Math.max(overflowY, (r.bottom - top) / scale - H, (top - r.top) / scale);
    overflowX = Math.max(overflowX, (r.right - left) / scale - W, (left - r.left) / scale);
  }
  // Visual blocks count as content for the empty-band check.
  const blocks = [...slide.querySelectorAll("img, svg, table, canvas, video, iframe, .big-number, blockquote, .takeaway")].filter((el) => !inNotes(el) && !el.closest("svg svg, table table") && visible(el));
  for (const el of blocks) addBand(el.getBoundingClientRect());
  const code = [...slide.querySelectorAll("pre")].filter((el) => !inNotes(el) && !el.closest(".mermaid"));
  const diagramSource = /^\\s*(flowchart|graph\\s+(TD|TB|LR|RL|BT)|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|digraph)\\b/m;
  const mermaids = [...slide.querySelectorAll(".mermaid, .cell-output-display svg[id^=mermaid], svg[aria-roledescription]")];
  const errors = [...slide.querySelectorAll("svg[aria-roledescription=error], .error-icon")].length
    + mermaids.filter((el) => /Syntax error in text|Parse error/i.test(el.textContent || "")).length;
  // Inline SVG labels vs. their node shape, and their rendered font size.
  let textOverflow = 0, minVisualFont = null;
  const overflowLabels = [];
  const noteFont = (px) => { if (px > 0) minVisualFont = minVisualFont === null ? px : Math.min(minVisualFont, px); };
  for (const svg of slide.querySelectorAll("svg")) {
    if (inNotes(svg) || svg.closest("svg svg") || !visible(svg)) continue;
    const sr = svg.getBoundingClientRect();
    if (sr.width < 40) continue;
    for (const t of svg.querySelectorAll("text, foreignObject")) {
      const tr = t.getBoundingClientRect();
      if (!tr.width || !tr.height || !(t.textContent || "").trim()) continue;
      const el = t.tagName.toLowerCase() === "foreignobject" ? (t.querySelector("span, p, div") || t) : t;
      const ctm = t.getScreenCTM ? t.getScreenCTM() : null;
      noteFont((parseFloat(getComputedStyle(el).fontSize) || 0) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1) / scale);
      const g = t.closest("g.node, g.cluster, g.label") ? t.closest("g.node, g.cluster") : null;
      const shape = g ? g.querySelector(":scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path, :scope > g > rect, :scope > g > path") : null;
      let bad = false;
      if (shape) {
        const s = shape.getBoundingClientRect();
        const m = 2 * scale;
        if (tr.left < s.left - m || tr.right > s.right + m || tr.top < s.top - m || tr.bottom > s.bottom + m) bad = true;
      }
      if (t.tagName.toLowerCase() === "foreignobject") {
        const inner = t.firstElementChild;
        if (inner && (inner.scrollWidth > t.getAttribute("width") * 1 + 2 || inner.scrollHeight > t.getAttribute("height") * 1 + 2)) bad = true;
      }
      if (bad) { textOverflow++; if (overflowLabels.length < 3) overflowLabels.push((t.textContent || "").trim().slice(0, 40)); }
    }
  }
  for (const img of slide.querySelectorAll("img[data-font]")) {
    if (inNotes(img) || !visible(img)) continue;
    const r = img.getBoundingClientRect();
    const f = parseFloat(img.getAttribute("data-font") || "");
    if (r.width && img.naturalWidth && f > 0) noteFont(f * (r.width / scale) / img.naturalWidth);
  }
  // Largest empty band of the body: between the title and the slide bottom.
  const h2 = slide.querySelector("h1, h2");
  const bodyTop = h2 && visible(h2) ? (h2.getBoundingClientRect().bottom - top) / scale : 0;
  const ivs = bands.map(([a, b]) => [Math.max(bodyTop, a), Math.min(H, b)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let emptyBand = 0, cursor = bodyTop, bottom = bodyTop;
  for (const [a, b] of ivs) { if (a > cursor) emptyBand = Math.max(emptyBand, a - cursor); cursor = Math.max(cursor, b); bottom = Math.max(bottom, b); }
  emptyBand = Math.max(emptyBand, H - 24 - cursor);
  const bodyH = Math.max(1, H - 24 - bodyTop);
  return {
    words: Math.round(words),
    bullets: [...slide.querySelectorAll("li")].filter((el) => !inNotes(el) && visible(el)).length,
    minFont: minFont === null ? null : Math.round(minFont * 10) / 10,
    maxFont: maxFont === null ? null : Math.round(maxFont * 10) / 10,
    overflowY: Math.max(0, Math.round(overflowY)),
    overflowX: Math.max(0, Math.round(overflowX)),
    visuals: [...slide.querySelectorAll("img, svg, table, canvas")].filter((el) => !inNotes(el) && !el.closest("svg svg") && el.getBoundingClientRect().width > 120).length,
    tables: [...slide.querySelectorAll("table")].filter((el) => !inNotes(el)).length,
    diagrams: [...slide.querySelectorAll("svg")].filter((el) => (el.id || "").startsWith("mermaid") || el.getAttribute("aria-roledescription")).length + [...slide.querySelectorAll("img[data-font]")].length,
    diagramErrors: errors,
    rawDiagramCode: code.filter((el) => diagramSource.test(el.textContent || "")).length,
    codeBlocks: code.length,
    textOverflow,
    overflowLabels,
    minVisualFont: minVisualFont === null ? null : Math.round(minVisualFont * 10) / 10,
    emptyBand: ivs.length ? Math.round((emptyBand / bodyH) * 100) / 100 : 1,
    contentBottom: Math.round((bottom / H) * 100) / 100,
  };
})()`;
