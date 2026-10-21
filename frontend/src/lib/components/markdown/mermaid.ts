import { sanitizeSvg } from "#lib/markdown.ts";
import { t } from "#lib/i18n.svelte.ts";

/**
 * Lazy Mermaid rendering for `.md-mermaid` placeholders (from ```mermaid fences). Mermaid (MIT) is loaded on the
 * first diagram only, runs with `securityLevel: "strict"` and SVG-only labels, and its SVG passes DOMPurify.
 * Results are cached per source + theme so live previews re-render instantly while typing.
 */
type Mermaid = (typeof import("mermaid"))["default"];
let loading: Promise<Mermaid> | null = null;
let configured: "light" | "dark" | null = null;
const cache = new Map<string, { svg?: string; error?: string }>();
let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then(m => m.default);
  return loading;
}

const fontFamily = `"Inter Variable", "Noto Sans TC Variable", ui-sans-serif, system-ui, sans-serif`;

export async function renderMermaidIn(root: HTMLElement, dark: boolean): Promise<void> {
  const mode = dark ? "dark" : "light";
  const nodes = [...root.querySelectorAll<HTMLElement>(".md-mermaid")].filter(n => n.dataset.rendered !== mode);
  if (!nodes.length) return;
  // Cached diagrams first (synchronously), so a re-render of the preview does not flash the source.
  const pending: HTMLElement[] = [];
  for (const node of nodes) {
    const source = sourceOf(node);
    const hit = cache.get(`${mode}\n${source}`);
    if (hit) paint(node, hit, mode);
    else pending.push(node);
  }
  if (!pending.length) return;
  const mermaid = await load();
  // Mermaid keeps global state: render one diagram at a time.
  queue = queue.then(async () => {
    if (configured !== mode) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily, htmlLabels: false, flowchart: { htmlLabels: false } });
      configured = mode;
    }
    for (const node of pending) {
      if (!node.isConnected || node.dataset.rendered === mode) continue;
      const source = sourceOf(node);
      const key = `${mode}\n${source}`;
      let result = cache.get(key);
      if (!result) {
        try {
          const { svg } = await mermaid.render(`hub-mermaid-${++seq}`, source);
          result = { svg: sanitizeSvg(svg) };
        } catch (e) {
          result = { error: (e as Error).message?.split("\n")[0]?.slice(0, 200) || "error" };
          // Mermaid leaves its error SVG in <body>; remove it.
          document.getElementById(`dhub-mermaid-${seq}`)?.remove();
        }
        if (cache.size > 200) cache.delete(cache.keys().next().value!);
        cache.set(key, result);
      }
      if (node.isConnected) paint(node, result, mode);
    }
  }).catch(() => {});
  await queue;
}

/** The diagram source (kept in `data-source` once the placeholder text is replaced by the SVG). */
function sourceOf(node: HTMLElement): string {
  node.dataset.source ??= node.querySelector(".md-mermaid-src")?.textContent ?? "";
  return node.dataset.source;
}

function paint(node: HTMLElement, result: { svg?: string; error?: string }, mode: string) {
  node.dataset.rendered = mode;
  if (result.svg) {
    node.innerHTML = result.svg;
    // Responsive size from the viewBox (Mermaid's width="100%" + max-width style is unreliable inside scrolling panes).
    const svg = node.querySelector("svg");
    const box = svg?.getAttribute("viewBox")?.split(/\s+/).map(Number);
    if (svg && box && box.length === 4 && box[2]! > 0 && box[3]! > 0) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("style", `display:block;margin:0 auto;width:100%;max-width:${box[2]}px;height:auto;aspect-ratio:${box[2]} / ${box[3]}`);
    }
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", t("mdx.mermaid.label"));
  } else {
    node.querySelector(".md-mermaid-error")?.remove();
    const error = document.createElement("p");
    error.className = "md-mermaid-error";
    error.textContent = t("mdx.mermaid.error", { message: result.error ?? "" });
    node.append(error);
  }
}
