import type { Extension } from "@codemirror/state";
import type { SourceFile } from "./types.ts";

/** Editor language for a source path (qmd/md → markdown; yaml; css/scss; else plain text). Loaded lazily. */
export async function languageFor(path: string): Promise<"markdown" | "plain" | Extension> {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".qmd") {
    // Quarto: YAML front matter above Markdown (otherwise the closing `---` turns the YAML into a setext heading).
    const [{ yamlFrontmatter }, { markdown, markdownLanguage }] = await Promise.all([import("@codemirror/lang-yaml"), import("@codemirror/lang-markdown")]);
    return yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: [] }) });
  }
  if (ext === ".md") return "markdown";
  if (ext === ".yml" || ext === ".yaml") return (await import("@codemirror/lang-yaml")).yaml();
  if (ext === ".css" || ext === ".scss") return (await import("@codemirror/lang-css")).css();
  return "plain";
}

export const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;
export const isImage = (path: string) => IMAGE_RE.test(path);

/** Files sorted folder-first per level, each with its depth and folder label for an indented tree. */
export function treeRows(files: SourceFile[]): ({ type: "dir"; path: string; name: string; depth: number } | { type: "file"; file: SourceFile; name: string; depth: number })[] {
  const sorted = [...files].sort((a, b) => {
    const pa = a.path.split("/");
    const pb = b.path.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const aDir = i < pa.length - 1;
      const bDir = i < pb.length - 1;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return pa[i]!.localeCompare(pb[i]!);
    }
    return pa.length - pb.length;
  });
  const rows: ReturnType<typeof treeRows> = [];
  const seen = new Set<string>();
  for (const file of sorted) {
    const parts = file.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seen.has(dir)) {
        seen.add(dir);
        rows.push({ type: "dir", path: dir, name: parts[i]!, depth: i });
      }
    }
    rows.push({ type: "file", file, name: parts.at(-1)!, depth: parts.length - 1 });
  }
  return rows;
}

/**
 * Reveal slide (horizontal index) the cursor is in: the title slide (when the front matter has a title) is 0,
 * then every `#`/`##` heading or `---` rule outside code blocks starts a new slide.
 */
export function slideIndexAt(text: string, pos: number): number {
  const lines = text.slice(0, pos).split("\n");
  let index = -1;
  let i = 0;
  if (lines[0] === "---" || text.startsWith("---\n")) {
    const all = text.split("\n");
    const end = all.indexOf("---", 1);
    const front = end > 0 ? all.slice(1, end).join("\n") : "";
    if (/^title:/m.test(front)) index = 0;
    i = end > 0 ? end + 1 : 0;
  }
  let fence = false;
  let previousBlank = true;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && (/^#{1,2} /.test(line) || (line === "---" && previousBlank))) index += 1;
    previousBlank = line.trim() === "";
  }
  return Math.max(0, index);
}

/** Calls `fn` once `ms` passed without another call; `flush()` runs a pending call now. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  const run = () => {
    timer = undefined;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const call = (...args: A) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  call.flush = () => {
    clearTimeout(timer);
    run();
  };
  call.cancel = () => {
    clearTimeout(timer);
    pending = null;
  };
  return call;
}
