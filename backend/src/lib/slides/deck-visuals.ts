/**
 * Visual building blocks of generated decks (slides workflow):
 *  - ```chart JSON specs → clean SVG files in the deck palette (server side, no browser; ported from
 *    frontend/src/lib/chart.ts and extended with grouped bars, horizontal bars and heatmaps);
 *  - Mermaid: ```mermaid fences → Quarto's executable ```{mermaid} cells (a plain fence renders as raw code), plus a
 *    cheap syntax lint with safe auto-fixes (unquoted labels with brackets/parentheses) before render;
 *  - paper figure references `![caption](paper-fig:<page>@<top>-<bottom>)` (fractions of the page height) that the
 *    playbook turns into cropped page images (pdftoppm).
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------- palette & theme

/** Deck palette (Lab-Hub blue first; colour-blind-safe order). */
export const DECK_PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#64748b"];
export const DECK_INK = "#1f2937";
export const DECK_MUTED = "#6b7280";
export const DECK_GRID = "#e5e7eb";
const FONT = "'Source Sans Pro','Source Sans 3','Noto Sans CJK TC','Noto Sans TC',Helvetica,Arial,sans-serif";
/** Mermaid (fallback only) measures and draws its labels with a system font that never swaps after layout. */
const MERMAID_FONT = "Arial, Helvetica, 'Liberation Sans', 'Noto Sans CJK TC', 'Microsoft JhengHei', sans-serif";
export const MERMAID_INIT = `%%{init: {"theme": "neutral", "themeVariables": {"fontFamily": "${MERMAID_FONT.replace(/"/g, "'")}", "fontSize": "18px"}, "flowchart": {"htmlLabels": true, "padding": 16, "wrappingWidth": 210, "nodeSpacing": 44, "rankSpacing": 52}}}%%`;

/**
 * Stylesheet of generated decks (`hub-deck.css`, referenced from the YAML). Type scale at 1280×800: title 40px,
 * body 26px, small 20px, tables 20px, captions 16px. Layout helpers: `.columns`, `.callout-*`, `.takeaway`,
 * `.big-number`, `.source`, `.figure-frame`.
 */
export const DECK_CSS = `/* Speech-AI Hub generated deck theme (Lab-Hub layout, 1280×800). */
.reveal { font-size: 26px; color: ${DECK_INK}; }
.reveal .slides section { line-height: 1.35; }
.reveal h1, .reveal h2, .reveal h3 { color: #0f172a; font-weight: 700; letter-spacing: -0.01em; text-transform: none; }
.reveal h2 { font-size: 40px; line-height: 1.2; margin: 0 0 22px; padding-bottom: 10px; border-bottom: 3px solid ${DECK_PALETTE[0]}; }
.reveal h3 { font-size: 30px; margin: 0 0 12px; color: ${DECK_PALETTE[0]}; }
.reveal .slides section .title { font-size: 52px; line-height: 1.15; }
.reveal .slides section .subtitle { font-size: 30px; color: ${DECK_MUTED}; }
.reveal .slides section .quarto-title-author-name, .reveal .slides section .date { font-size: 24px; }
.reveal p { margin: 0 0 14px; }
.reveal ul, .reveal ol { margin: 0 0 12px 1.1em; }
.reveal li { margin: 0 0 10px; line-height: 1.3; }
.reveal li > ul, .reveal li > ol { margin-top: 6px; font-size: 0.85em; }
.reveal strong { color: #0f172a; }
.reveal em { color: ${DECK_PALETTE[0]}; font-style: normal; font-weight: 600; }
.reveal .smaller, .reveal .slides section.smaller { font-size: 20px; }
.reveal table { font-size: 22px; border-collapse: collapse; margin: 8px auto; }
.reveal table th { background: #eff6ff; color: #0f172a; font-weight: 700; border-bottom: 2px solid ${DECK_PALETTE[0]}; padding: 6px 14px; }
.reveal table td { border-bottom: 1px solid ${DECK_GRID}; padding: 6px 14px; }
.reveal table tr.best td, .reveal table td.best, .reveal table td strong { color: ${DECK_PALETTE[0]}; font-weight: 700; }
.reveal .columns { display: flex; gap: 36px; align-items: flex-start; }
.reveal .column { min-width: 0; }
.reveal .slides section img, .reveal .slides section svg { max-width: 100%; }
.reveal .slides section img { max-height: 520px; object-fit: contain; }
.reveal .figure-frame img { border: 1px solid ${DECK_GRID}; border-radius: 6px; background: #fff; }
.reveal figcaption, .reveal .caption, .reveal .source { font-size: 16px; color: ${DECK_MUTED}; margin-top: 6px; }
.reveal .source { position: absolute; bottom: -8px; left: 0; }
.reveal .cell-output-display svg[id^=mermaid], .reveal svg.mermaid-js { width: 100% !important; max-width: 1150px !important; height: auto; max-height: 470px; }
.reveal svg[id^=mermaid] foreignObject div, .reveal svg[id^=mermaid] foreignObject span, .reveal svg[id^=mermaid] foreignObject p { font-family: ${MERMAID_FONT} !important; font-size: 18px !important; line-height: 1.4 !important; margin: 0 !important; }
.reveal .slides section img.hub-diagram, .reveal .slides section img.hub-chart { max-height: 600px; border: 0; box-shadow: none; background: none; }
.reveal .cell-output-display figure, .reveal div.quarto-figure { margin: 0 auto; }
.reveal .cell-output-display figure { margin: 0 auto; }
.reveal pre.mermaid { background: none; border: 0; box-shadow: none; text-align: center; }
.reveal .takeaway { margin-top: 18px; padding: 14px 20px; background: #eff6ff; border-left: 6px solid ${DECK_PALETTE[0]}; border-radius: 6px; font-size: 24px; font-weight: 600; }
.reveal .big-number { font-size: 96px; font-weight: 800; color: ${DECK_PALETTE[0]}; line-height: 1; margin: 12px 0; }
.reveal .big-number-label { font-size: 24px; color: ${DECK_MUTED}; }
.reveal .callout { font-size: 22px; margin: 10px 0; }
.reveal .callout-title-container { font-size: 22px; }
.reveal blockquote { font-size: 30px; border-left: 6px solid ${DECK_PALETTE[1]}; background: #fffbeb; padding: 16px 24px; width: auto; box-shadow: none; font-style: normal; }
.reveal .katex { font-size: 1.05em; }
#MathJax_Message { display: none !important; }
/* Per-page source line of topic decks: inside the slide (never past its edge), one line. */
.reveal .slides section .page-source { position: absolute; bottom: 0; left: 0; right: 0; font-size: 16px; color: ${DECK_MUTED}; white-space: nowrap; overflow: hidden; }
.reveal .slides section .page-source p { margin: 0; }
/* Fit variants (slides workflow, visual QA): a page that overflows gets the next one; never below 16px. */
.reveal .slides section.fit-90 { font-size: 23px; }
.reveal .slides section.fit-90 table { font-size: 20px; }
.reveal .slides section.fit-90 img { max-height: 460px; }
.reveal .slides section.fit-90 img.hub-diagram, .reveal .slides section.fit-90 img.hub-chart { max-height: 500px; }
.reveal .slides section.fit-80 { font-size: 21px; }
.reveal .slides section.fit-80 h2 { font-size: 36px; margin-bottom: 16px; }
.reveal .slides section.fit-80 table { font-size: 18px; }
.reveal .slides section.fit-80 .takeaway { font-size: 21px; padding: 10px 16px; }
.reveal .slides section.fit-80 img { max-height: 400px; }
.reveal .slides section.fit-80 img.hub-diagram, .reveal .slides section.fit-80 img.hub-chart { max-height: 420px; }
.reveal .slides section.fit-70 { font-size: 19px; }
.reveal .slides section.fit-70 h2 { font-size: 32px; margin-bottom: 12px; }
.reveal .slides section.fit-70 table { font-size: 17px; }
.reveal .slides section.fit-70 .takeaway { font-size: 19px; padding: 8px 14px; margin-top: 10px; }
.reveal .slides section.fit-70 .big-number { font-size: 72px; }
.reveal .slides section.fit-70 img { max-height: 330px; }
.reveal .slides section.fit-70 img.hub-diagram, .reveal .slides section.fit-70 img.hub-chart { max-height: 340px; }
`;

// ---------------------------------------------------------------- charts

export type DeckChart = {
  type: "bar" | "hbar" | "line" | "scatter" | "heatmap";
  title?: string;
  labels?: string[];
  series: { name?: string; data: Array<number | null | [number, number]> }[];
  /** heatmap: row labels (labels = columns), values[row][col]. */
  rows?: string[];
  values?: Array<Array<number | null>>;
  x_label?: string;
  y_label?: string;
  /** "max" | "min": which value is best (highlighted); default none. */
  best?: "max" | "min";
  unit?: string;
  /** Source of the numbers (e.g. "Table 2"), drawn under the chart. */
  source?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, n = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

/** Parses a ```chart JSON spec; null when invalid. Accepts "grouped_bar"/"bar_grouped" as bar, "horizontal_bar" as hbar. */
export function parseDeckChart(source: string): DeckChart | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const t = String(r.type ?? "bar").toLowerCase();
  const type: DeckChart["type"] | null = /^(bar|grouped_?bar|bar_?grouped|column)$/.test(t) ? "bar" : /^(hbar|horizontal_?bar|barh)$/.test(t) ? "hbar" : t === "line" ? "line" : t === "scatter" ? "scatter" : /^(heatmap|table_?heatmap)$/.test(t) ? "heatmap" : null;
  if (!type) return null;
  const labels = Array.isArray(r.labels) ? (r.labels as unknown[]).slice(0, 40).map((l) => String(l).slice(0, 40)) : undefined;
  const base = { type, title: str(r.title), labels, x_label: str(r.x_label, 60), y_label: str(r.y_label, 60), unit: str(r.unit, 12), source: str(r.source, 80), best: r.best === "max" || r.best === "min" ? (r.best as "max" | "min") : undefined };
  if (type === "heatmap") {
    if (!Array.isArray(r.values) || !labels?.length) return null;
    const values = (r.values as unknown[]).slice(0, 16).map((row) => (Array.isArray(row) ? row.slice(0, labels.length).map((v) => (isNum(v) ? v : null)) : null));
    if (values.some((v) => !v) || !values.length) return null;
    const rows = Array.isArray(r.rows) ? (r.rows as unknown[]).map((x) => String(x).slice(0, 40)) : values.map((_, i) => `#${i + 1}`);
    return { ...base, series: [], rows, values: values as Array<Array<number | null>> };
  }
  if (!Array.isArray(r.series) || !r.series.length || r.series.length > 7) return null;
  const series: DeckChart["series"] = [];
  for (const s of r.series as unknown[]) {
    if (!s || typeof s !== "object" || !Array.isArray((s as { data?: unknown }).data)) return null;
    const data = (s as { data: unknown[] }).data.slice(0, 60).map((d) =>
      type === "scatter" ? (Array.isArray(d) && isNum(d[0]) && isNum(d[1]) ? ([d[0], d[1]] as [number, number]) : null) : isNum(d) ? d : null,
    );
    if (!data.some((d) => d !== null)) return null;
    series.push({ name: str((s as { name?: unknown }).name, 60), data });
  }
  if (type !== "scatter" && !labels?.length) return null;
  return { ...base, series };
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; out.length < 20; v += step) {
    out.push(Number(v.toFixed(10)));
    if (v >= max - step * 1e-9) break;
  }
  return out;
}

const tick = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Number(v.toPrecision(4))));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Rough text width (px) at `size`: CJK ≈ 1em, Latin ≈ 0.55em. */
const textWidth = (s: string, size: number) => [...s].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? size : size * 0.56), 0);

/** Smallest font size used by chart SVGs (px at their natural size). */
export const CHART_MIN_FONT = 16;

/**
 * Standalone SVG, laid out for `size` (deck px; default 960×540) so it is shown at ≈ 1:1 on its slide (fonts are
 * absolute: 16–26 px). The image is embedded at its natural size with `data-font` for the layout metrics.
 */
export function renderDeckChartSvg(spec: DeckChart, size: { w: number; h: number } = { w: 960, h: 540 }): string {
  // Value labels use the data's own precision (4 → "4.00" next to 4.11), at most 3 decimals.
  const decimals = Math.min(3, Math.max(0, ...[...spec.series.flatMap((s) => s.data.flatMap((d) => (Array.isArray(d) ? [d[1]] : isNum(d) ? [d] : []))), ...(spec.values ?? []).flat().filter(isNum)].map((v) => (String(v).split(".")[1] ?? "").length)));
  const fmt = (v: number, unit = "") => `${Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(decimals)}${unit}`;
  const W = Math.round(Math.max(520, Math.min(1180, size.w)));
  const H = Math.round(Math.max(330, Math.min(580, size.h, W * 0.66)));
  const parts: string[] = [];
  const unit = spec.unit ?? "";
  // One series needs no legend: its name becomes the value axis label instead (when there is none).
  if (spec.series.length === 1 && spec.series[0]?.name && spec.type !== "heatmap") {
    const name = spec.series[0].name;
    if (spec.type === "hbar") spec = { ...spec, x_label: spec.x_label ?? name };
    else if (spec.type !== "scatter") spec = { ...spec, y_label: spec.y_label ?? name };
  }
  const legendItems = spec.type !== "heatmap" && spec.series.length > 1 ? spec.series.map((s, i) => ({ name: s.name ?? `#${i + 1}`, color: DECK_PALETTE[i % DECK_PALETTE.length]! })) : [];
  // Value labels sit above the tallest bar / point: keep them clear of the title and legend.
  const top = (spec.title ? 52 : 18) + (legendItems.length ? 34 : 0) + (spec.type === "bar" || spec.type === "line" ? 24 : 0);
  const bottom = (spec.x_label ? 78 : 50) + (spec.source ? 26 : 0);
  if (spec.title) parts.push(`<text x="${W / 2}" y="34" text-anchor="middle" font-size="26" font-weight="700" fill="${DECK_INK}">${esc(spec.title)}</text>`);
  if (legendItems.length) {
    let x = 0;
    const widths = legendItems.map((l) => 28 + textWidth(l.name, 19) + 24);
    const total = widths.reduce((a, b) => a + b, 0);
    x = Math.max(10, (W - total) / 2);
    const ly = (spec.title ? 52 : 18) + 14;
    legendItems.forEach((l, i) => {
      parts.push(`<rect x="${x.toFixed(1)}" y="${ly - 9}" width="18" height="18" rx="3" fill="${l.color}"/><text x="${(x + 26).toFixed(1)}" y="${ly + 6}" font-size="19" fill="${DECK_INK}">${esc(l.name)}</text>`);
      x += widths[i]!;
    });
  }
  if (spec.source) parts.push(`<text x="${W - 8}" y="${H - 8}" text-anchor="end" font-size="16" fill="${DECK_MUTED}">${esc(`Source: ${spec.source}`)}</text>`);

  if (spec.type === "heatmap") return wrap(W, H, spec, [...parts, ...heatmap(spec, W, H, top, bottom, fmt)]);

  const values: number[] = [];
  const xs: number[] = [];
  for (const s of spec.series) for (const d of s.data) if (Array.isArray(d)) (xs.push(d[0]), values.push(d[1])); else if (isNum(d)) values.push(d);
  if (!values.length) return wrap(W, H, spec, parts);
  const n = Math.max(spec.labels?.length ?? 0, ...spec.series.map((s) => s.data.length));
  // Best value per series (a grouped chart compares methods within one metric).
  const bests = spec.series.map((s) => {
    const v = s.data.filter(isNum);
    return spec.best && v.length > 1 ? (spec.best === "max" ? Math.max(...v) : Math.min(...v)) : null;
  });

  if (spec.type === "hbar") {
    // Long category names wrap onto two lines instead of being cut.
    const lines = (l: string) => (l.length > 26 && l.includes(" ") ? splitTwo(clip(l, 56)).map((w) => clip(w, 30)) : [clip(l, 30)]);
    const labelW = Math.min(340, Math.max(80, ...(spec.labels ?? []).flatMap((l) => lines(l).map((w) => textWidth(w, 19) + 16))));
    const m = { l: labelW, r: 70, t: top, b: bottom - 20 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    let lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const xt = niceTicks(lo, hi);
    lo = xt[0]!;
    const x1 = xt.at(-1)!;
    const x = (v: number) => m.l + ((v - lo) / (x1 - lo || 1)) * pw;
    for (const v of xt) parts.push(`<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${m.t}" y2="${m.t + ph}" stroke="${DECK_GRID}"/><text x="${x(v).toFixed(1)}" y="${m.t + ph + 24}" text-anchor="middle" font-size="17" fill="${DECK_MUTED}">${tick(v)}</text>`);
    const band = ph / Math.max(1, n);
    const k = spec.series.length;
    const bh = Math.min(44, (band * 0.72) / k);
    for (let i = 0; i < n; i++) {
      const cy = m.t + band * (i + 0.5);
      const ls = lines(spec.labels?.[i] ?? String(i + 1));
      ls.forEach((w, wi) => parts.push(`<text x="${m.l - 12}" y="${(cy + 6 + (wi - (ls.length - 1) / 2) * 22).toFixed(1)}" text-anchor="end" font-size="19" fill="${DECK_INK}">${esc(w)}</text>`));
      spec.series.forEach((s, si) => {
        const d = s.data[i];
        if (!isNum(d)) return;
        const yPos = cy - (bh * k) / 2 + bh * si;
        const best = bests[si] !== null && d === bests[si];
        const color = DECK_PALETTE[si % DECK_PALETTE.length]!;
        parts.push(`<rect x="${Math.min(x(0), x(d)).toFixed(1)}" y="${yPos.toFixed(1)}" width="${Math.max(1, Math.abs(x(d) - x(0))).toFixed(1)}" height="${(bh - 3).toFixed(1)}" rx="3" fill="${color}"${best ? ` stroke="${DECK_INK}" stroke-width="2"` : ""}/>`);
        parts.push(`<text x="${(x(d) + (d >= 0 ? 8 : -8)).toFixed(1)}" y="${(yPos + bh / 2 + 5).toFixed(1)}" text-anchor="${d >= 0 ? "start" : "end"}" font-size="17" font-weight="${best ? 700 : 400}" fill="${DECK_INK}">${fmt(d, unit)}</text>`);
      });
    }
    if (spec.x_label) parts.push(`<text x="${m.l + pw / 2}" y="${m.t + ph + 54}" text-anchor="middle" font-size="18" fill="${DECK_MUTED}">${esc(spec.x_label)}</text>`);
    return wrap(W, H, spec, parts);
  }

  const m = { l: 78, r: 24, t: top, b: bottom };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // Bars of nearly equal height hide the difference the slide is about (e.g. WER 4.33 vs 4.00 on a 0–5 axis): such a
  // chart is drawn as a dot plot on a zoomed axis instead (dots, unlike bars, do not need a zero baseline).
  const dots = spec.type === "bar" && lo > 0 && (hi - lo) / hi < 0.2 && values.length >= 3;
  if (spec.type === "bar" && !dots) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  } else {
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    lo -= pad;
    hi += pad;
  }
  const yt = niceTicks(lo, hi);
  const y0 = yt[0]!;
  const y1 = yt.at(-1)!;
  const y = (v: number) => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  for (const v of yt) parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${DECK_GRID}"/><text x="${m.l - 10}" y="${(y(v) + 6).toFixed(1)}" text-anchor="end" font-size="17" fill="${DECK_MUTED}">${tick(v)}</text>`);
  if (spec.y_label) parts.push(`<text transform="translate(20 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="18" fill="${DECK_MUTED}">${esc(spec.y_label)}</text>`);
  if (spec.x_label) parts.push(`<text x="${m.l + pw / 2}" y="${m.t + ph + 62}" text-anchor="middle" font-size="18" fill="${DECK_MUTED}">${esc(spec.x_label)}</text>`);

  if (spec.type === "scatter") {
    const xt = niceTicks(Math.min(...xs), Math.max(...xs));
    const x0 = xt[0]!;
    const x1 = xt.at(-1)!;
    const x = (v: number) => m.l + ((v - x0) / (x1 - x0 || 1)) * pw;
    for (const v of xt) parts.push(`<text x="${x(v).toFixed(1)}" y="${m.t + ph + 26}" text-anchor="middle" font-size="17" fill="${DECK_MUTED}">${tick(v)}</text>`);
    spec.series.forEach((s, si) => {
      for (const d of s.data) if (Array.isArray(d)) parts.push(`<circle cx="${x(d[0]).toFixed(1)}" cy="${y(d[1]).toFixed(1)}" r="7" fill="${DECK_PALETTE[si % DECK_PALETTE.length]}" fill-opacity="0.85"/>`);
      // Point labels from `labels` (one per point of the first series).
      if (si === 0 && spec.labels?.length) s.data.forEach((d, i) => { if (Array.isArray(d) && spec.labels![i]) parts.push(`<text x="${(x(d[0]) + 10).toFixed(1)}" y="${(y(d[1]) - 8).toFixed(1)}" font-size="16" fill="${DECK_INK}">${esc(clip(spec.labels![i]!, 22))}</text>`); });
    });
  } else {
    const band = pw / Math.max(1, n);
    const cx = (i: number) => m.l + band * (i + 0.5);
    const maxChars = Math.max(4, Math.floor(band / 10));
    for (let i = 0; i < n; i++) {
      const label = clip(spec.labels?.[i] ?? String(i + 1), maxChars * 2);
      const words = label.length > maxChars && label.includes(" ") ? splitTwo(label) : [label];
      words.forEach((w, wi) => parts.push(`<text x="${cx(i).toFixed(1)}" y="${m.t + ph + 26 + wi * 21}" text-anchor="middle" font-size="18" fill="${DECK_INK}">${esc(clip(w, maxChars + 6))}</text>`));
    }
    if (dots) {
      const k = spec.series.length;
      const off = (si: number) => (k > 1 ? (si - (k - 1) / 2) * Math.min(28, band / (k + 1)) : 0);
      spec.series.forEach((s, si) =>
        s.data.forEach((d, i) => {
          if (!isNum(d)) return;
          const best = bests[si] !== null && d === bests[si];
          const color = DECK_PALETTE[si % DECK_PALETTE.length]!;
          const x0 = cx(i) + off(si);
          parts.push(`<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${(m.t + ph).toFixed(1)}" y2="${y(d).toFixed(1)}" stroke="${color}" stroke-opacity="0.25" stroke-width="2"/>`);
          parts.push(`<circle cx="${x0.toFixed(1)}" cy="${y(d).toFixed(1)}" r="${best ? 11 : 9}" fill="${color}"${best ? ` stroke="${DECK_INK}" stroke-width="2.5"` : ""}/>`);
          if (k * n <= 18) parts.push(`<text x="${x0.toFixed(1)}" y="${(y(d) - 18).toFixed(1)}" text-anchor="middle" font-size="17" font-weight="${best ? 700 : 500}" fill="${DECK_INK}">${fmt(d, unit)}</text>`);
        }),
      );
    } else if (spec.type === "bar") {
      const k = spec.series.length;
      const bw = Math.min(90, (band * 0.74) / k);
      spec.series.forEach((s, si) =>
        s.data.forEach((d, i) => {
          if (!isNum(d)) return;
          const t = y(Math.max(0, d));
          const h = Math.abs(y(d) - y(0));
          const xPos = cx(i) - (bw * k) / 2 + bw * si;
          const best = bests[si] !== null && d === bests[si];
          parts.push(`<rect x="${xPos.toFixed(1)}" y="${t.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${DECK_PALETTE[si % DECK_PALETTE.length]}"${best ? ` stroke="${DECK_INK}" stroke-width="2.5"` : ""}/>`);
          // Value labels never go below the 16 px floor; with too many bars there are none (the axis carries it).
          if (k * n <= 18 && bw >= 34) parts.push(`<text x="${(xPos + bw / 2 - 1.5).toFixed(1)}" y="${(d >= 0 ? t - 8 : t + h + 20).toFixed(1)}" text-anchor="middle" font-size="${k * n > 12 ? 16 : 17}" font-weight="${best ? 700 : 500}" fill="${DECK_INK}">${fmt(d, unit)}</text>`);
        }),
      );
      parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${DECK_MUTED}" stroke-width="1.5"/>`);
    } else {
      spec.series.forEach((s, si) => {
        const color = DECK_PALETTE[si % DECK_PALETTE.length]!;
        const pts = s.data.map((d, i) => (isNum(d) ? `${cx(i).toFixed(1)},${y(d).toFixed(1)}` : "|"));
        for (const run of pts.join(" ").split("|").map((r) => r.trim()).filter((r) => r.includes(" "))) parts.push(`<polyline points="${run}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`);
        s.data.forEach((d, i) => {
          if (!isNum(d)) return;
          const best = bests[si] !== null && d === bests[si];
          parts.push(`<circle cx="${cx(i).toFixed(1)}" cy="${y(d).toFixed(1)}" r="${best ? 8 : 5.5}" fill="${color}" stroke="#fff" stroke-width="2"/>`);
          if (spec.series.length <= 2 && n <= 10) parts.push(`<text x="${cx(i).toFixed(1)}" y="${(y(d) - 14).toFixed(1)}" text-anchor="middle" font-size="16" font-weight="${best ? 700 : 400}" fill="${DECK_INK}">${fmt(d, unit)}</text>`);
        });
      });
    }
  }
  return wrap(W, H, spec, parts);
}

function splitTwo(label: string) {
  const mid = label.length / 2;
  let at = -1;
  for (let i = 0; i < label.length; i++) if (label[i] === " " && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i;
  return at < 0 ? [label] : [label.slice(0, at), label.slice(at + 1)];
}

function heatmap(spec: DeckChart, W: number, H: number, top: number, bottom: number, fmt: (v: number, unit?: string) => string): string[] {
  const parts: string[] = [];
  const rows = spec.rows ?? [];
  const cols = spec.labels ?? [];
  const values = spec.values ?? [];
  const labelW = Math.min(300, Math.max(80, ...rows.map((r) => textWidth(clip(r, 26), 19) + 18)));
  const cw = (W - labelW - 16) / Math.max(1, cols.length);
  const ch = Math.min(64, (H - top - bottom - 36) / Math.max(1, rows.length));
  const all = values.flat().filter(isNum);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const bestVal = spec.best ? (spec.best === "max" ? hi : lo) : null;
  cols.forEach((c, j) => parts.push(`<text x="${(labelW + cw * (j + 0.5)).toFixed(1)}" y="${top + 22}" text-anchor="middle" font-size="18" font-weight="700" fill="${DECK_INK}">${esc(clip(c, Math.max(5, Math.floor(cw / 10))))}</text>`));
  rows.forEach((r, i) => {
    const yPos = top + 36 + ch * i;
    parts.push(`<text x="${labelW - 12}" y="${(yPos + ch / 2 + 6).toFixed(1)}" text-anchor="end" font-size="19" fill="${DECK_INK}">${esc(clip(r, 26))}</text>`);
    (values[i] ?? []).forEach((v, j) => {
      const tt = isNum(v) ? (v - lo) / (hi - lo || 1) : 0;
      const fill = isNum(v) ? mix("#eff6ff", "#1d4ed8", tt) : "#f3f4f6";
      const dark = tt > 0.55;
      const best = bestVal !== null && v === bestVal;
      parts.push(`<rect x="${(labelW + cw * j + 2).toFixed(1)}" y="${(yPos + 2).toFixed(1)}" width="${(cw - 4).toFixed(1)}" height="${(ch - 4).toFixed(1)}" rx="4" fill="${fill}"${best ? ` stroke="${DECK_PALETTE[1]}" stroke-width="3"` : ""}/>`);
      parts.push(`<text x="${(labelW + cw * (j + 0.5)).toFixed(1)}" y="${(yPos + ch / 2 + 6).toFixed(1)}" text-anchor="middle" font-size="18" font-weight="${best ? 700 : 500}" fill="${dark ? "#fff" : DECK_INK}">${isNum(v) ? fmt(v, spec.unit ?? "") : "—"}</text>`);
    });
  });
  return parts;
}

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function wrap(W: number, H: number, spec: DeckChart, parts: string[]) {
  const label = esc(spec.title ?? "chart");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}" font-family="${esc(FONT)}"><rect width="${W}" height="${H}" fill="#ffffff"/>${parts.join("")}</svg>\n`;
}

// ---------------------------------------------------------------- body transforms

export type ChartBlock = { start: number; end: number; source: string; spec: DeckChart | null; caption?: string };

const CHART_RE = /^```[ \t]*\{?\.?chart\}?[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** ```chart blocks of a body (with an optional caption = the `caption` key of the spec). */
export function chartBlocks(body: string): ChartBlock[] {
  return [...body.matchAll(CHART_RE)].map((m) => {
    const spec = parseDeckChart(m[1]!.trim());
    return { start: m.index!, end: m.index! + m[0].length, source: m[1]!.trim(), spec, caption: spec ? (str((JSON.parse(m[1]!) as { caption?: unknown }).caption, 160) ?? undefined) : undefined };
  });
}

export const chartFileName = (source: string, size?: { w: number; h: number }) => `charts/chart-${createHash("sha256").update(size ? `${source}\n${Math.round(size.w)}x${Math.round(size.h)}` : source).digest("hex").slice(0, 12)}.svg`;

export type FigureRef = { start: number; end: number; caption: string; page: number; top: number; bottom: number; attrs: string };
const FIG_RE = /!\[([^\]\n]*)\]\(paper-fig:(\d{1,3})(?:@([01](?:\.\d+)?)-([01](?:\.\d+)?))?\)(\{[^}\n]*\})?/g;

/** `![caption](paper-fig:<page>@<top>-<bottom>){attrs}` references (top/bottom: fractions of the page height). */
export function figureRefs(body: string): FigureRef[] {
  return [...body.matchAll(FIG_RE)].map((m) => {
    let top = m[3] === undefined ? 0 : Math.max(0, Math.min(1, Number(m[3])));
    let bottom = m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])));
    if (bottom - top < 0.08) [top, bottom] = [0, 1];
    return { start: m.index!, end: m.index! + m[0].length, caption: m[1]!.trim(), page: Number(m[2]), top, bottom, attrs: m[5] ?? "" };
  });
}

export const figureFileName = (f: Pick<FigureRef, "page" | "top" | "bottom">) => `figures/p${f.page}-${Math.round(f.top * 100)}-${Math.round(f.bottom * 100)}.jpg`;

/** Replaces matches (sorted, non-overlapping) by `replace(match)`. */
export function replaceRanges<T extends { start: number; end: number }>(text: string, items: T[], replace: (item: T) => string): string {
  let out = "";
  let cursor = 0;
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    if (it.start < cursor) continue;
    out += text.slice(cursor, it.start) + replace(it);
    cursor = it.end;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------- mermaid

const MERMAID_TYPES = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey|quadrantChart|xychart-beta|block-beta|sankey-beta)\b/;
const MERMAID_FENCE = /^```[ \t]*(?:\{[ \t]*)?\.?mermaid[ \t]*\}?[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** Diagram code that should have been a Mermaid cell (```mermaid, ```{.mermaid}, or a bare fence starting with `flowchart`). */
export function normalizeDiagrams(body: string): string {
  let out = body.replace(MERMAID_FENCE, (_all, code: string) => `\`\`\`{mermaid}\n${fixMermaid(code.replace(/^%%\|.*\n/gm, "")).code.trimEnd()}\n\`\`\``);
  out = out.replace(/^```[ \t]*(?:text|txt|plain)?[ \t]*\n((?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)[\s\S]*?)^```\s*$/gm, (_a, code: string) => `\`\`\`{mermaid}\n${fixMermaid(code).code.trimEnd()}\n\`\`\``);
  return out;
}

/** Mermaid cells get the label font / wrapping config (render-time only; the source keeps the writer's code). */
export function withMermaidInit(body: string): string {
  return body.replace(/^(```\{mermaid\}[^\n]*\n)(?!%%\{init)/gm, `$1${MERMAID_INIT}\n`);
}

/** Mermaid cells of a body. */
export const mermaidBlocks = (body: string) => [...body.matchAll(/^```\{mermaid\}[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]!);

/**
 * Safe auto-fixes for the most common model mistakes in flowcharts: labels with ( ) / " ; or : inside [ ] / { } /
 * ( ) shapes become quoted labels; `-->|x|>` typos; HTML <br> kept. Returns the code and what was fixed.
 */
export function fixMermaid(code: string): { code: string; fixed: number } {
  let fixed = 0;
  const first = code.trim().split("\n")[0]?.trim() ?? "";
  if (!/^(flowchart|graph)\b/.test(first)) return { code, fixed };
  const lines = code.split("\n").map((line) => {
    if (/^\s*(style|classDef|class|linkStyle|click|subgraph|end\b|%%)/.test(line)) return line;
    const quote = (all: string, id: string, open: string, label: string, close: string) => {
      const t = label.trim();
      if (!t || /^["(\/\\[{]/.test(t) || !/[()"';:{}|<>#&]/.test(t.replace(/<br\s*\/?>/g, ""))) return all;
      fixed++;
      return `${id}${open}"${t.replace(/"/g, "'")}"${close}`;
    };
    return line
      .replace(/\b([A-Za-z_][\w-]*)(\[)([^\]\n]+)(\])/g, quote)
      .replace(/\b([A-Za-z_][\w-]*)(\{)([^}\n]+)(\})/g, quote);
  });
  return { code: lines.join("\n"), fixed };
}

/** Cheap lint (the real parse is Mermaid in the render; its errors come back in the layout metrics). */
export function lintMermaid(code: string): string[] {
  const issues: string[] = [];
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  if (!lines.length) return ["Mermaid 圖是空的"];
  if (!MERMAID_TYPES.test(lines[0]!)) issues.push(`Mermaid 第一行必須是圖的類型（例如 flowchart LR），目前是「${lines[0]!.slice(0, 40)}」`);
  if (/^(flowchart|graph)\b/.test(lines[0]!)) {
    let depth = 0;
    for (const l of lines) {
      if (/^subgraph\b/.test(l)) depth++;
      else if (/^end\s*$/.test(l)) depth--;
    }
    if (depth !== 0) issues.push("subgraph 與 end 數量不一致");
    const opens = (code.match(/\[/g) ?? []).length;
    const closes = (code.match(/\]/g) ?? []).length;
    if (opens !== closes) issues.push(`方括號不成對（[ ${opens} 個、] ${closes} 個）`);
    const nodes = new Set([...code.matchAll(/(?:^|\s|>|-)([A-Za-z_][\w]*)\s*[[({>]/gm)].map((m) => m[1]));
    if (nodes.size > 14) issues.push(`節點太多（${nodes.size} 個），投影片上會太小；請 ≤ 12 個節點，或拆成兩張圖`);
    for (const l of lines) if (l.length > 160) issues.push(`有一行太長（${l.length} 字元）：節點標籤請 ≤ 4 個英文字或 8 個中文字`);
  }
  return [...new Set(issues)].slice(0, 6);
}
