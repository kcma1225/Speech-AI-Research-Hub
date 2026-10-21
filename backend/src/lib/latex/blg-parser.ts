/**
 * BibTeX and biber `.blg` parsers (own implementation; LaTeX-Workshop's MIT bibtexlog/biberlog parsers
 * served only as a reference for the message shapes).
 *
 * Mirrored byte-for-byte at `latex-runner/src/shared/blg-parser.ts` (see `latex-sync.test.ts`).
 */
import type { LatexDiagnostic, LatexSeverity } from "./contract.js";
import { withHint } from "./hints.js";
import { normalizeLogPath, scrubPaths } from "./log-parser.js";

export type BlgParse = { tool: "bibtex" | "biber" | null; errors: LatexDiagnostic[]; warnings: LatexDiagnostic[] };

/** biber copies each data source to `<tmp>/<name>.bib_<n>.utf8`; report the original name. */
export function biberSourcePath(raw: string, workRoot = "/work/"): string {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "");
  const tmp = /([^/]+?\.bib)_\d+\.utf8$/.exec(cleaned);
  return tmp ? tmp[1]! : normalizeLogPath(cleaned, workRoot);
}

export function detectBlgTool(text: string): "bibtex" | "biber" | null {
  if (/This is BibTeX|The top-level auxiliary file:/.test(text)) return "bibtex";
  if (/This is Biber|Biber\.pm|INFO - |WARN - |ERROR - /.test(text)) return "biber";
  return null;
}

export function parseBlg(text: string, options: { workRoot?: string } = {}): BlgParse {
  const tool = detectBlgTool(text);
  if (tool === "bibtex") return { tool, ...parseBibtexBlg(text, options) };
  if (tool === "biber") return { tool, ...parseBiberBlg(text, options) };
  return { tool: null, errors: [], warnings: [] };
}

function diagnostic(severity: LatexSeverity, source: "bibtex" | "biber", file: string | null, line: number | null, message: string, workRoot: string) {
  return withHint<LatexDiagnostic>({ severity, source, file, line, message: scrubPaths(message.trim(), workRoot) });
}

const BIBTEX_LOCATION = /---?line (\d+) of file (.+?)\s*$/;
const BIBTEX_STOP = /^(I'm skipping whatever remains|\(There (were|was) \d+|Database file #|You've used|Warning--|I found no|I couldn't|Illegal|Repeated entry)/;

export function parseBibtexBlg(text: string, options: { workRoot?: string } = {}): Omit<BlgParse, "tool"> {
  const workRoot = options.workRoot ?? "/work/";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const errors: LatexDiagnostic[] = [];
  const warnings: LatexDiagnostic[] = [];
  let database: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const db = /^Database file #\d+: (.+)$/.exec(line);
    if (db) {
      database = normalizeLogPath(db[1]!, workRoot);
      continue;
    }
    if (line.startsWith("Warning--")) {
      let message = line.slice("Warning--".length);
      let file: string | null = database;
      let lineNo: number | null = null;
      const next = lines[i + 1];
      const at = next ? BIBTEX_LOCATION.exec(next) : null;
      if (at && next!.trimStart().startsWith("--")) {
        lineNo = Number(at[1]);
        file = normalizeLogPath(at[2]!, workRoot);
        i++;
      }
      message = message.trim();
      warnings.push(diagnostic("warning", "bibtex", file, lineNo, message, workRoot));
      continue;
    }
    const located = BIBTEX_LOCATION.exec(line);
    if (located) {
      const message = line.slice(0, located.index).replace(/-+$/, "").trim();
      const context: string[] = [];
      for (let j = i + 1; j < lines.length && context.length < 4; j++) {
        const next = lines[j]!;
        if (!next.startsWith(" :")) break;
        context.push(next);
      }
      const entry = diagnostic("error", "bibtex", normalizeLogPath(located[2]!, workRoot), Number(located[1]), message || line.trim(), workRoot);
      if (context.length) entry.context = context.join("\n");
      errors.push(entry);
      continue;
    }
    if (/^(I couldn't open (database|style|auxiliary) file|I found no \\(citation|bibdata|bibstyle) command|Illegal, another \\bib)/.test(line)) {
      let message = line.trim();
      // "I found no \bibdata command---while reading file main.aux"
      const next = lines[i + 1];
      if (next && /^---while reading file/.test(next)) {
        message += " " + next.trim();
        i++;
      }
      errors.push(diagnostic("error", "bibtex", database, null, message, workRoot));
      continue;
    }
    if (BIBTEX_STOP.test(line)) continue;
  }
  return { errors, warnings };
}

const BIBER_LINE = /^(?:\[\d+\] [^>]*> )?(INFO|WARN|ERROR) - (.*)$/;

export function parseBiberBlg(text: string, options: { workRoot?: string } = {}): Omit<BlgParse, "tool"> {
  const workRoot = options.workRoot ?? "/work/";
  const errors: LatexDiagnostic[] = [];
  const warnings: LatexDiagnostic[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Newer biber names its temporary copies `<md5>_<n>.utf8`; with a single data source map them back to it.
  const sources = new Set<string>();
  for (const raw of lines) {
    const source = /Found BibTeX data source '([^']+)'|Looking for bibtex (?:format )?file '([^']+)'/.exec(raw);
    if (source) sources.add(normalizeLogPath((source[1] ?? source[2])!, workRoot));
  }
  const only = sources.size === 1 ? [...sources][0]! : null;
  const sourceOf = (raw: string) => {
    const mapped = biberSourcePath(raw, workRoot);
    return /^[0-9a-f]{32}_\d+\.utf8$/.test(mapped) ? only : mapped;
  };
  for (const raw of lines) {
    const match = BIBER_LINE.exec(raw);
    if (!match || match[1] === "INFO") continue;
    const severity: LatexSeverity = match[1] === "ERROR" ? "error" : "warning";
    let message = match[2]!;
    let file: string | null = null;
    let line: number | null = null;
    // "BibTeX subsystem: /tmp/…/refs.bib_123.utf8, line 5, syntax error: …"
    const subsystem = /^BibTeX subsystem: (.+?), line (\d+), (.*)$/.exec(message);
    // "Datamodel: article entry 'x' (refs.bib): Invalid field …"
    const entry = /\(([^()]+\.bib)\)/.exec(message);
    const missing = /^Cannot find '?(.+?\.bib)'?!?$|^Data source '(.+?)' not found/.exec(message);
    if (subsystem) {
      file = sourceOf(subsystem[1]!);
      line = Number(subsystem[2]);
      message = subsystem[3]!;
    } else if (entry) {
      file = biberSourcePath(entry[1]!, workRoot);
    } else if (missing) {
      file = biberSourcePath((missing[1] ?? missing[2])!, workRoot);
    }
    message = message
      .replace(/\/[^\s,'"]*\/([^/\s,'"]+?\.bib)_\d+\.utf8/g, "$1")
      .replace(/\/[^\s,'"]*\/[0-9a-f]{32}_\d+\.utf8/g, only ?? "(.bib)");
    (severity === "error" ? errors : warnings).push(diagnostic(severity, "biber", file, line, message, workRoot));
  }
  return { errors, warnings };
}

/**
 * latexmk's stdout: the "Collected error summary" and missing-tool lines, e.g.
 * `  biber: Command for 'biber' gave return code 2`. Only used when the log itself has no error.
 */
export function parseLatexmkOutput(text: string): LatexDiagnostic[] {
  const out: LatexDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    out.push(withHint<LatexDiagnostic>({ severity: "error", source: "latexmk", file: null, line: null, message }));
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const command = /^\s*(\S+): Command for '([^']+)' gave return code (\d+)/.exec(line);
    if (command) {
      add(`${command[2]} 結束代碼 ${command[3]}`);
      continue;
    }
    // "  biber .out/main: Could not open biber log file '.out/main.blg'" / "Latexmk: Error return from 'biber .out/main'"
    const tool = /^\s*(biber|bibtex)\b[^:]*: (.+)$/.exec(line) ?? /^Latexmk: Error return from '(biber|bibtex)\b[^']*'/.exec(line);
    if (tool) {
      add(`${tool[1]} 執行失敗${tool[2] ? "：" + scrubPaths(tool[2]) : ""}`);
      continue;
    }
    const failure = /^Latexmk: (Failure to make .*|.*not found.*|Could not find file .*)$/.exec(line.trim());
    if (failure) out.push(withHint<LatexDiagnostic>({ severity: "error", source: "latexmk", file: null, line: null, message: scrubPaths(failure[1]!) }));
  }
  return out;
}
