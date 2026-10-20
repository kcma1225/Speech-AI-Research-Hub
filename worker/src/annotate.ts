import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobInputError } from "./errors.js";

/**
 * Adds `annotate` to the deck's `revealjs-plugins` front matter. Returns the new text, or the
 * original when it is already enabled.
 */
export function injectAnnotatePlugin(text: string): string {
  const source = text.replace(/\r\n?/g, "\n");
  const hasFront = source.startsWith("---\n");
  const end = hasFront ? source.indexOf("\n---", 4) : -1;
  if (hasFront && end < 0) throw new JobInputError("QMD front matter 未關閉。");
  if (!hasFront) return "---\nrevealjs-plugins:\n  - annotate\n---\n" + source;
  const front = source.slice(4, end);
  const pluginsAt = /^revealjs-plugins:[ \t]*$/m.exec(front);
  if (pluginsAt) {
    // Only look inside the revealjs-plugins list (indented "- name" lines that follow it).
    const after = front.slice(pluginsAt.index + pluginsAt[0].length);
    const list = /^(?:\n[ \t]+-[^\n]*)*/.exec(after)![0];
    if (/^[ \t]+-[ \t]*annotate[ \t]*$/m.test(list.replace(/^\n/, ""))) return source;
    const insertAt = 4 + pluginsAt.index + pluginsAt[0].length + list.length;
    return source.slice(0, insertAt) + "\n  - annotate" + source.slice(insertAt);
  }
  const inline = /^revealjs-plugins:[ \t]*\[([^\]]*)\][ \t]*$/m.exec(front);
  if (inline) {
    const items = inline[1]!.split(",").map(item => item.trim()).filter(Boolean);
    if (items.includes("annotate")) return source;
    const replaced = `revealjs-plugins: [${[...items, "annotate"].join(", ")}]`;
    return source.slice(0, 4 + inline.index) + replaced + source.slice(4 + inline.index + inline[0].length);
  }
  return source.slice(0, end) + "\nrevealjs-plugins:\n  - annotate" + source.slice(end);
}

/**
 * Prepares an extracted deck for a single-file render: copies the annotate extension next to the
 * entry, drops project-level `_quarto.yml` (an upload is one deck, not a Quarto website) and
 * enables the plugin. Returns the entry HTML name relative to the output dir.
 */
export async function prepareSource(sourceDir: string, entry: string, annotateDir: string): Promise<string> {
  const extensionDir = path.join(sourceDir, path.posix.dirname(entry), "_extensions", "annotate");
  await mkdir(extensionDir, { recursive: true });
  for (const name of ["_extension.yml", "annotate.css", "annotate.js"]) {
    await cp(path.join(annotateDir, name), path.join(extensionDir, name));
  }
  await rm(path.join(sourceDir, "_quarto.yml"), { force: true });
  await rm(path.join(sourceDir, "_quarto.yaml"), { force: true });
  const file = path.join(sourceDir, ...entry.split("/"));
  const text = await readFile(file, "utf8");
  const updated = injectAnnotatePlugin(text);
  if (updated !== text) await writeFile(file, updated);
  return path.posix.basename(entry, path.posix.extname(entry)) + ".html";
}
