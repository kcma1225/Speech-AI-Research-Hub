/**
 * The canonical view of an artifact (docs/architecture.md "Artifact view"): its units in the order and with the numbers
 * the user sees, each with what is visible and what is not (speaker notes). One definition for every consumer — the
 * requirement checks, the verifier, the assistant's tools and the writers' prompts — so a page number or 「畫面上」 means
 * the same thing everywhere (production 61666f10: steps, screenshot QA and the assistant each counted pages their own
 * way, and the judge read speaker notes as slide content).
 *
 * - Decks: page 1 is the cover when the front matter has a title, then one page per `## ` slide. `deckSourceView` reads
 *   the Quarto source; `deckRenderedView` reads the rendered revealjs HTML (title slide + `section.slide`, notes in
 *   `aside.notes`) — what the player actually shows, preferred whenever a render exists.
 * - Notes / LaTeX: sections by heading (`#…` / `\section`…), numbered from 1; text before the first heading is unit 0.
 */
import { createDocument, type DomElement } from "@mixmark-io/domino";

export type ViewUnit = {
  /** Stable within one view: `cover`, the slide's title slug / section number. */
  id: string;
  /** The number the user says: the player's page (decks), the section's position (notes / LaTeX). */
  page: number;
  kind: "cover" | "slide" | "section" | "preamble";
  title: string;
  /** What a reader sees on it (title included). */
  visible: string;
  /** What is not shown (speaker notes). */
  notes: string;
};
export type ArtifactView = { kind: "deck" | "note" | "latex"; source: "source" | "rendered"; units: ViewUnit[] };

const FRONT_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const NOTES_RE = /^:::+\s*\{?\.?notes\}?\s*\n([\s\S]*?)^:::+\s*$/gm;

const yamlScalar = (v: string) => {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      // fall through
    }
  }
  return t.replace(/^(['"])([\s\S]*)\1$/, "$2");
};

/** Markdown / Quarto source as a reader sees it: no comments, link targets, attributes, fence lines. */
export function visibleMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)(?:\{[^}]*\})?/g, "$1")
    .replace(/\]\((?:[^()]|\([^)]*\))*\)/g, "]")
    .replace(/\{[.#][^}\n]*\}/g, " ")
    .replace(/^:::+.*$/gm, " ")
    .replace(/^\s*```.*$/gm, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const slug = (t: string, i: number) => `${i}:${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

/** A Quarto deck source → cover (page 1, when the front matter has a title) + one unit per `## ` slide. */
export function deckSourceView(qmd: string): ArtifactView {
  const text = qmd.replace(/\r\n/g, "\n");
  const fm = FRONT_RE.exec(text);
  const units: ViewUnit[] = [];
  if (fm) {
    const field = (k: string) => {
      const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm[1]!);
      return m ? yamlScalar(m[1]!) : "";
    };
    const title = field("title");
    if (title) units.push({ id: "cover", page: 1, kind: "cover", title, visible: [title, field("subtitle"), field("author"), field("date")].filter(Boolean).join("\n"), notes: "" });
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const parts = body.split(/^(?=## )/m).filter((p) => p.startsWith("## "));
  parts.forEach((p, i) => {
    const nl = p.indexOf("\n");
    const title = (nl < 0 ? p.slice(3) : p.slice(3, nl)).replace(/\{[^}]*\}\s*$/, "").trim();
    const rest = nl < 0 ? "" : p.slice(nl + 1);
    const notes = [...rest.matchAll(NOTES_RE)].map((m) => m[1]!.trim()).join("\n");
    units.push({ id: slug(title, i), page: units.length + 1, kind: "slide", title, visible: `${title}\n${visibleMarkdown(rest.replace(NOTES_RE, ""))}`.trim(), notes: visibleMarkdown(notes) });
  });
  return { kind: "deck", source: "source", units };
}

const textOf = (el: DomElement | null) => (el?.textContent ?? "").replace(/[ \t\r]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** Rendered revealjs HTML → the pages the player shows (title slide, `section.slide`), notes kept apart. */
export function deckRenderedView(html: string): ArtifactView {
  const doc = createDocument(html);
  // Not text a reader sees: styles / scripts (MathJax injects CSS into notes), the MathML copy of a formula.
  for (const el of Array.from(doc.querySelectorAll("style, script, noscript, template, .katex-mathml, mjx-assistive-mml"))) el.remove();
  const units: ViewUnit[] = [];
  const cover = doc.querySelector("section#title-slide");
  if (cover) {
    const title = textOf(cover.querySelector(".title, h1"));
    units.push({ id: "cover", page: 1, kind: "cover", title, visible: textOf(cover), notes: "" });
  }
  const slides = Array.from(doc.querySelectorAll("section.slide"));
  slides.forEach((s, i) => {
    const notesEl = Array.from(s.querySelectorAll("aside.notes"));
    const notes = notesEl.map((n) => textOf(n)).join("\n");
    for (const n of notesEl) n.remove();
    const title = textOf(s.querySelector("h2, h1"));
    // Text inside images is not text: alt / captions are what a reader sees of a figure.
    const alts = Array.from(s.querySelectorAll("img[alt]")).map((img) => img.getAttribute("alt") ?? "").filter(Boolean);
    units.push({ id: slug(title, i), page: units.length + 1, kind: "slide", title, visible: [textOf(s), ...alts].filter(Boolean).join("\n"), notes });
  });
  return { kind: "deck", source: "rendered", units };
}

/** A Markdown note → sections by heading (1-based; text before the first heading is unit 0). */
export function noteView(md: string): ArtifactView {
  const units: ViewUnit[] = [];
  let cur: ViewUnit = { id: "0", page: 0, kind: "preamble", title: "", visible: "", notes: "" };
  let fence = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      if (cur.title || cur.visible.trim()) units.push(cur);
      cur = { id: String(units.length + 1), page: units.filter((u) => u.kind === "section").length + 1, kind: "section", title: h[1]!.trim(), visible: `${h[1]!.trim()}\n`, notes: "" };
    } else cur.visible += `${line}\n`;
  }
  if (cur.title || cur.visible.trim()) units.push(cur);
  return { kind: "note", source: "source", units: units.map((u) => ({ ...u, visible: visibleMarkdown(u.visible) })) };
}

/** A LaTeX file → sections by \chapter / \section / \subsection (comments dropped). */
export function latexView(tex: string): ArtifactView {
  const src = tex.replace(/\r\n/g, "\n").replace(/(?<!\\)%.*$/gm, "");
  const units: ViewUnit[] = [];
  const re = /\\(?:chapter|section|subsection)\*?\{([^}]*)\}/g;
  let last = 0;
  let title = "";
  let m: RegExpExecArray | null;
  const push = (end: number) => {
    const body = src.slice(last, end).trim();
    if (title || body) units.push({ id: String(units.length), page: units.filter((u) => u.kind === "section").length + (title ? 1 : 0), kind: title ? "section" : "preamble", title, visible: body, notes: "" });
  };
  while ((m = re.exec(src))) {
    push(m.index);
    title = m[1]!.trim();
    last = m.index;
  }
  push(src.length);
  return { kind: "latex", source: "source", units };
}

/** The unit a user's number names: the player's page (-1 = the last page); null when there is none. */
export function unitAt(view: ArtifactView, page: number): ViewUnit | null {
  const pages = view.units.filter((u) => u.kind !== "preamble");
  if (page < 0) return pages[pages.length + page] ?? null;
  return pages.find((u) => u.page === page) ?? null;
}

/** 「第 1 頁（封面）」「第 3 頁「Main results」」「第 2 節「方法」」. */
export function unitLabel(view: ArtifactView, u: ViewUnit): string {
  if (u.kind === "cover") return "第 1 頁（封面）";
  if (u.kind === "preamble") return "開頭";
  return `${view.kind === "deck" ? `第 ${u.page} 頁` : `第 ${u.page} 節`}「${u.title}」`;
}

/** The unit holding an offset of a deck source (front matter = the cover). */
export function deckPageOfOffset(qmd: string, at: number): number {
  const text = qmd.replace(/\r\n/g, "\n");
  const fm = FRONT_RE.exec(text);
  if (fm && at < fm[0].length) return 1;
  const cover = !!fm && /^title:\s*\S/m.test(fm[1]!);
  return Math.max(1, (text.slice(0, at).match(/^## /gm) ?? []).length + (cover ? 1 : 0));
}

/**
 * The view as a model reads it: every unit labeled with the number the user says, its visible text, and its notes
 * marked as not shown. Verifiers and the assistant see pages exactly as the checks count them.
 */
export function viewText(view: ArtifactView, opts: { maxChars?: number; notes?: boolean } = {}): string {
  const out = view.units.map((u) => {
    const head = u.kind === "preamble" ? "<!-- 開頭 -->" : `<!-- ${unitLabel(view, u)} -->`;
    const notes = opts.notes !== false && u.notes ? `\n[講稿（不顯示在投影片上）]\n${u.notes}` : "";
    return `${head}\n${u.visible}${notes}`;
  }).join("\n\n");
  return opts.maxChars ? out.slice(0, opts.maxChars) : out;
}

/** The rendered view of a deck preview (`deck_previews` ready row: its output HTML), or null. */
export async function previewView(db: { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> }, storage: { getBuffer(key: string): Promise<Buffer | null> }, previewId: string | null | undefined): Promise<ArtifactView | null> {
  if (!previewId) return null;
  const row = (await db.query<{ output_prefix: string; entry_html: string | null; status: string }>("SELECT output_prefix, entry_html, status FROM deck_previews WHERE id=$1", [previewId])).rows[0];
  if (!row || row.status !== "ready" || !row.entry_html) return null;
  const html = await storage.getBuffer(`${row.output_prefix}${row.entry_html}`).catch(() => null);
  return html ? deckRenderedView(html.toString("utf8")) : null;
}
