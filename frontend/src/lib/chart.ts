/**
 * ```chart fences in Markdown (assistant replies and notes): a small JSON spec rendered to an inline SVG, no library.
 *
 *   { "type": "bar" | "line" | "scatter", "title"?: string, "labels"?: string[],
 *     "series": [{ "name": string, "data": number[] | [number, number][] }], "x_label"?: string, "y_label"?: string }
 *
 * Bars and lines use `labels` as categories (data[i] ↔ labels[i]); scatter uses [x, y] pairs. Colours come from the
 * theme's pill inks (CSS classes `.md-chart .s0…s4`), so light/dark follow the app. Invalid specs return null and the
 * caller shows the source as code.
 */
export type ChartSpec = {
  type: "bar" | "line" | "scatter";
  title?: string;
  labels?: string[];
  series: { name?: string; data: Array<number | null | [number, number]> }[];
  x_label?: string;
  y_label?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseChartSpec(source: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === "line" || r.type === "scatter" ? r.type : r.type === "bar" || r.type === undefined ? "bar" : null;
  if (!type) return null;
  if (!Array.isArray(r.series) || !r.series.length || r.series.length > 8) return null;
  const series: ChartSpec["series"] = [];
  for (const s of r.series as unknown[]) {
    if (!s || typeof s !== "object" || !Array.isArray((s as { data?: unknown }).data)) return null;
    const data = ((s as { data: unknown[] }).data).slice(0, 200).map((d) =>
      type === "scatter" ? (Array.isArray(d) && num(d[0]) && num(d[1]) ? ([d[0], d[1]] as [number, number]) : null) : num(d) ? d : null,
    );
    series.push({ name: typeof (s as { name?: unknown }).name === "string" ? String((s as { name: string }).name).slice(0, 60) : undefined, data });
  }
  const labels = Array.isArray(r.labels) ? (r.labels as unknown[]).slice(0, 200).map((l) => String(l).slice(0, 40)) : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : undefined);
  return { type, title: str(r.title), labels, series, x_label: str(r.x_label), y_label: str(r.y_label) };
}

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
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

const clipLabel = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Number(v.toPrecision(4))));

/** SVG markup for a spec (viewBox 640×360, scales with the container). */
export function renderChartSvg(spec: ChartSpec): string {
  const W = 640;
  const H = 360;
  const m = { l: 56, r: 16, t: spec.title ? 44 : 22, b: spec.x_label ? 62 : 44 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const values: number[] = [];
  const xs: number[] = [];
  for (const s of spec.series)
    for (const d of s.data) {
      if (Array.isArray(d)) {
        xs.push(d[0]);
        values.push(d[1]);
      } else if (num(d)) values.push(d);
    }
  if (!values.length) return "";
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (spec.type === "bar") {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const yt = niceTicks(lo, hi);
  const y0 = yt[0]!;
  const y1 = yt.at(-1)!;
  const y = (v: number) => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const parts: string[] = [];
  if (spec.title) parts.push(`<text class="t" x="${W / 2}" y="20" text-anchor="middle">${esc(spec.title)}</text>`);
  for (const v of yt) parts.push(`<line class="g" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="a" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  if (spec.y_label) parts.push(`<text class="a" transform="translate(14 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">${esc(spec.y_label)}</text>`);
  if (spec.x_label) parts.push(`<text class="a" x="${m.l + pw / 2}" y="${H - 8}" text-anchor="middle">${esc(spec.x_label)}</text>`);

  if (spec.type === "scatter") {
    const xt = niceTicks(Math.min(...xs), Math.max(...xs));
    const x0 = xt[0]!;
    const x1 = xt.at(-1)!;
    const x = (v: number) => m.l + ((v - x0) / (x1 - x0 || 1)) * pw;
    for (const v of xt) parts.push(`<text class="a" x="${x(v)}" y="${m.t + ph + 18}" text-anchor="middle">${fmt(v)}</text>`);
    spec.series.forEach((s, si) => {
      for (const d of s.data) if (Array.isArray(d)) parts.push(`<circle class="s${si % 5} f" cx="${x(d[0]).toFixed(1)}" cy="${y(d[1]).toFixed(1)}" r="4"><title>${esc(`${s.name ?? ""} (${fmt(d[0])}, ${fmt(d[1])})`)}</title></circle>`);
    });
  } else {
    const n = Math.max(spec.labels?.length ?? 0, ...spec.series.map((s) => s.data.length));
    const band = pw / Math.max(1, n);
    const cx = (i: number) => m.l + band * (i + 0.5);
    const every = Math.ceil(n / 12);
    for (let i = 0; i < n; i += every) parts.push(`<text class="a" x="${cx(i)}" y="${m.t + ph + 18}" text-anchor="middle">${esc(clipLabel(spec.labels?.[i] ?? String(i + 1), Math.max(6, Math.floor(band / 7))))}</text>`);
    if (spec.type === "bar") {
      const k = spec.series.length;
      const bw = Math.max(2, (band * 0.72) / k);
      spec.series.forEach((s, si) =>
        s.data.forEach((d, i) => {
          if (!num(d)) return;
          const top = y(Math.max(0, d));
          const h = Math.abs(y(d) - y(0));
          const xPos = cx(i) - (bw * k) / 2 + bw * si;
          parts.push(`<rect class="s${si % 5} f" x="${xPos.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" rx="2"><title>${esc(`${s.name ? `${s.name} · ` : ""}${spec.labels?.[i] ?? i + 1}: ${fmt(d)}`)}</title></rect>`);
          if (k * n <= 16) parts.push(`<text class="v" x="${(xPos + bw / 2).toFixed(1)}" y="${(d >= 0 ? top - 4 : top + h + 12).toFixed(1)}" text-anchor="middle">${fmt(d)}</text>`);
        }),
      );
      parts.push(`<line class="z" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`);
    } else {
      spec.series.forEach((s, si) => {
        const pts = s.data.map((d, i) => (num(d) ? `${cx(i).toFixed(1)},${y(d).toFixed(1)}` : null));
        const runs = pts.map((p) => p ?? "|").join(" ").split("|").map((r) => r.trim()).filter((r) => r.includes(" "));
        for (const r of runs) parts.push(`<polyline class="s${si % 5} l" points="${r}"/>`);
        s.data.forEach((d, i) => {
          if (num(d)) parts.push(`<circle class="s${si % 5} f" cx="${cx(i).toFixed(1)}" cy="${y(d).toFixed(1)}" r="3.5"><title>${esc(`${s.name ? `${s.name} · ` : ""}${spec.labels?.[i] ?? i + 1}: ${fmt(d)}`)}</title></circle>`);
        });
      });
    }
  }
  const legend = spec.series.length > 1 || spec.series[0]?.name
    ? `<div class="md-chart-legend">${spec.series.map((s, i) => `<span><i class="s${i % 5}"></i>${esc(s.name ?? `#${i + 1}`)}</span>`).join("")}</div>`
    : "";
  const label = esc(spec.title ?? spec.series.map((s) => s.name).filter(Boolean).join(", ") ?? "chart");
  return `<figure class="md-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>${legend}</figure>`;
}
