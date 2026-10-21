/**
 * Split-file convention (spec §13 item 14): `main.tex` is the index (preamble, packages, a list of
 * `\input{sections/<name>}` lines) and every section lives in its own file. These helpers edit that list
 * without touching anything else the user wrote.
 *
 * A **managed entry** is a body line (between `\begin{document}` and `\end{document}`) whose only
 * content is one `\input{…}` or `\include{…}`, optionally indented, optionally followed by a `%` comment,
 * and optionally commented out as a whole (`% \input{…}` = disabled). Lines that mix an input with other
 * content are reported as unmanaged and never moved; removal and renaming still edit them in place.
 * Inputs in the preamble (e.g. `\input{macros}`) are not sections and are ignored.
 */

export type InputEntry = {
  /** Normalized project path, always with an extension: `sections/intro.tex`. */
  path: string;
  /** The argument as written: `sections/intro`. */
  target: string;
  command: "input" | "include";
  /** 0-based line index in the text. */
  line: number;
  disabled: boolean;
  managed: boolean;
};

const MANAGED = /^(\s*)(%\s*)?\\(input|include)\{([^{}]+)\}\s*(%.*)?$/;
const ANY_INPUT = /\\(input|include)\{([^{}]+)\}/g;

/** `sections/intro` → `sections/intro.tex`; leaves other extensions alone; strips `./`. */
export function normalizeInputPath(target: string): string {
  let value = target.trim().replace(/^"(.*)"$/, "$1");
  while (value.startsWith("./")) value = value.slice(2);
  return /\.[A-Za-z0-9]+$/.test(value.slice(value.lastIndexOf("/") + 1)) ? value : `${value}.tex`;
}

/** The `\input` argument for a project path: drops a `.tex` extension (`sections/a.tex` → `sections/a`). */
export function inputTarget(path: string): string {
  return path.replace(/\.tex$/, "");
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/), eol };
}

/** Index of the first `%` that starts a comment (not `\%`). */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return i;
  }
  return -1;
}

function code(line: string): string {
  const at = commentStart(line);
  return at < 0 ? line : line.slice(0, at);
}

/** [start, end) line range of the document body; the whole file when there is no `\begin{document}`. */
function bodyRange(lines: string[]): [number, number] {
  let start = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const text = code(lines[i]!);
    if (start === 0 && /\\begin\{document\}/.test(text)) start = i + 1;
    if (/\\end\{document\}/.test(text)) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function parseEntries(lines: string[]): InputEntry[] {
  const [start, end] = bodyRange(lines);
  const entries: InputEntry[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const managed = MANAGED.exec(line);
    if (managed) {
      entries.push({
        path: normalizeInputPath(managed[4]!),
        target: managed[4]!,
        command: managed[3] as "input" | "include",
        line: i,
        disabled: !!managed[2],
        managed: true,
      });
      continue;
    }
    for (const match of code(line).matchAll(ANY_INPUT)) {
      entries.push({ path: normalizeInputPath(match[2]!), target: match[2]!, command: match[1] as "input" | "include", line: i, disabled: false, managed: false });
    }
  }
  return entries;
}

/** Lists the section inputs of `main.tex` in document order. */
export function listInputs(main: string): InputEntry[] {
  return parseEntries(splitLines(main).lines);
}

function samePath(a: string, b: string) {
  return normalizeInputPath(a) === normalizeInputPath(b);
}

/**
 * Adds `\input{<path>}` on its own line. Position: after the entry for `after` when given; otherwise
 * after the last managed entry; otherwise before the bibliography/appendix/`\end{document}`.
 * No-op (returns the text unchanged) when the path is already listed.
 */
export function addInput(main: string, path: string, options: { after?: string; command?: "input" | "include" } = {}): string {
  const { lines, eol } = splitLines(main);
  const entries = parseEntries(lines);
  if (entries.some(entry => samePath(entry.path, path))) return main;
  const managed = entries.filter(entry => entry.managed);
  const anchor = options.after ? managed.find(entry => samePath(entry.path, options.after!)) : managed[managed.length - 1];
  const newLine = (indent: string) => `${indent}\\${options.command ?? "input"}{${inputTarget(normalizeInputPath(path))}}`;
  if (anchor) {
    const indent = /^\s*/.exec(lines[anchor.line]!)![0];
    lines.splice(anchor.line + 1, 0, newLine(indent));
    return lines.join(eol);
  }
  const [start, end] = bodyRange(lines);
  let at = end;
  for (let i = start; i < end; i++) {
    if (/\\(bibliographystyle|bibliography|printbibliography|appendix|backmatter)\b/.test(code(lines[i]!))) {
      at = i;
      break;
    }
  }
  lines.splice(at, 0, newLine(""));
  return lines.join(eol);
}

/** Removes every input of `path` (managed lines are deleted; inline occurrences are cut out). */
export function removeInput(main: string, path: string): string {
  const { lines, eol } = splitLines(main);
  const entries = parseEntries(lines).filter(entry => samePath(entry.path, path));
  const drop = new Set<number>();
  for (const entry of entries) {
    if (entry.managed) {
      drop.add(entry.line);
      continue;
    }
    const line = lines[entry.line]!;
    const at = commentStart(line);
    const head = at < 0 ? line : line.slice(0, at);
    const tail = at < 0 ? "" : line.slice(at);
    lines[entry.line] = head.replace(ANY_INPUT, (whole, _cmd: string, target: string) => (samePath(target, path) ? "" : whole)) + tail;
  }
  return lines.filter((_, index) => !drop.has(index)).join(eol);
}

/** Points inputs of `from` at `to`, keeping the line, its command, indentation and comments. */
export function renameInput(main: string, from: string, to: string): string {
  const { lines, eol } = splitLines(main);
  const [start, end] = bodyRange(lines);
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const managed = MANAGED.exec(line);
    if (managed && samePath(managed[4]!, from)) {
      lines[i] = line.replace(`{${managed[4]!}}`, `{${inputTarget(normalizeInputPath(to))}}`);
      continue;
    }
    const at = commentStart(line);
    const head = at < 0 ? line : line.slice(0, at);
    const tail = at < 0 ? "" : line.slice(at);
    lines[i] = head.replace(ANY_INPUT, (whole, cmd: string, target: string) => (samePath(target, from) ? `\\${cmd}{${inputTarget(normalizeInputPath(to))}}` : whole)) + tail;
  }
  return lines.join(eol);
}

/** Comments out (`disabled = true`) or restores a managed entry. */
export function setInputEnabled(main: string, path: string, enabled: boolean): string {
  const { lines, eol } = splitLines(main);
  for (const entry of parseEntries(lines)) {
    if (!entry.managed || !samePath(entry.path, path) || entry.disabled === !enabled) continue;
    const line = lines[entry.line]!;
    lines[entry.line] = enabled ? line.replace(/^(\s*)%\s*/, "$1") : line.replace(/^(\s*)/, "$1% ");
  }
  return lines.join(eol);
}

/**
 * Reorders the managed entries. `order` lists paths in the new order; managed entries not in `order`
 * keep their relative order after the listed ones. Every managed line keeps its own content (comments,
 * `\include`, disabled state) and moves as a whole into the existing slots, so lines between entries
 * (`\appendix`, `\clearpage`, comments) stay where they are. Unknown paths are ignored.
 */
export function reorderInputs(main: string, order: string[]): string {
  const { lines, eol } = splitLines(main);
  const managed = parseEntries(lines).filter(entry => entry.managed);
  const slots = managed.map(entry => entry.line);
  const remaining = [...managed];
  const sorted: InputEntry[] = [];
  for (const path of order) {
    const index = remaining.findIndex(entry => samePath(entry.path, path));
    if (index >= 0) sorted.push(remaining.splice(index, 1)[0]!);
  }
  sorted.push(...remaining);
  const original = slots.map(slot => lines[slot]!);
  sorted.forEach((entry, index) => {
    lines[slots[index]!] = original[managed.indexOf(entry)]!;
  });
  return lines.join(eol);
}
