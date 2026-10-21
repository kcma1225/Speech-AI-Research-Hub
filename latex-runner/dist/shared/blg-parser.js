import { withHint } from "./hints.js";
import { normalizeLogPath, scrubPaths } from "./log-parser.js";
/** biber copies each data source to `<tmp>/<name>.bib_<n>.utf8`; report the original name. */
export function biberSourcePath(raw, workRoot = "/work/") {
    const cleaned = raw.trim().replace(/^['"]|['"]$/g, "");
    const tmp = /([^/]+?\.bib)_\d+\.utf8$/.exec(cleaned);
    return tmp ? tmp[1] : normalizeLogPath(cleaned, workRoot);
}
export function detectBlgTool(text) {
    if (/This is BibTeX|The top-level auxiliary file:/.test(text))
        return "bibtex";
    if (/This is Biber|Biber\.pm|INFO - |WARN - |ERROR - /.test(text))
        return "biber";
    return null;
}
export function parseBlg(text, options = {}) {
    const tool = detectBlgTool(text);
    if (tool === "bibtex")
        return { tool, ...parseBibtexBlg(text, options) };
    if (tool === "biber")
        return { tool, ...parseBiberBlg(text, options) };
    return { tool: null, errors: [], warnings: [] };
}
function diagnostic(severity, source, file, line, message, workRoot) {
    return withHint({ severity, source, file, line, message: scrubPaths(message.trim(), workRoot) });
}
const BIBTEX_LOCATION = /---?line (\d+) of file (.+?)\s*$/;
const BIBTEX_STOP = /^(I'm skipping whatever remains|\(There (were|was) \d+|Database file #|You've used|Warning--|I found no|I couldn't|Illegal|Repeated entry)/;
export function parseBibtexBlg(text, options = {}) {
    const workRoot = options.workRoot ?? "/work/";
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const errors = [];
    const warnings = [];
    let database = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const db = /^Database file #\d+: (.+)$/.exec(line);
        if (db) {
            database = normalizeLogPath(db[1], workRoot);
            continue;
        }
        if (line.startsWith("Warning--")) {
            let message = line.slice("Warning--".length);
            let file = database;
            let lineNo = null;
            const next = lines[i + 1];
            const at = next ? BIBTEX_LOCATION.exec(next) : null;
            if (at && next.trimStart().startsWith("--")) {
                lineNo = Number(at[1]);
                file = normalizeLogPath(at[2], workRoot);
                i++;
            }
            message = message.trim();
            warnings.push(diagnostic("warning", "bibtex", file, lineNo, message, workRoot));
            continue;
        }
        const located = BIBTEX_LOCATION.exec(line);
        if (located) {
            const message = line.slice(0, located.index).replace(/-+$/, "").trim();
            const context = [];
            for (let j = i + 1; j < lines.length && context.length < 4; j++) {
                const next = lines[j];
                if (!next.startsWith(" :"))
                    break;
                context.push(next);
            }
            const entry = diagnostic("error", "bibtex", normalizeLogPath(located[2], workRoot), Number(located[1]), message || line.trim(), workRoot);
            if (context.length)
                entry.context = context.join("\n");
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
        if (BIBTEX_STOP.test(line))
            continue;
    }
    return { errors, warnings };
}
const BIBER_LINE = /^(?:\[\d+\] [^>]*> )?(INFO|WARN|ERROR) - (.*)$/;
export function parseBiberBlg(text, options = {}) {
    const workRoot = options.workRoot ?? "/work/";
    const errors = [];
    const warnings = [];
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
        const match = BIBER_LINE.exec(raw);
        if (!match || match[1] === "INFO")
            continue;
        const severity = match[1] === "ERROR" ? "error" : "warning";
        let message = match[2];
        let file = null;
        let line = null;
        // "BibTeX subsystem: /tmp/…/refs.bib_123.utf8, line 5, syntax error: …"
        const subsystem = /^BibTeX subsystem: (.+?), line (\d+), (.*)$/.exec(message);
        // "Datamodel: article entry 'x' (refs.bib): Invalid field …"
        const entry = /\(([^()]+\.bib)\)/.exec(message);
        const missing = /^Cannot find '?(.+?\.bib)'?!?$|^Data source '(.+?)' not found/.exec(message);
        if (subsystem) {
            file = biberSourcePath(subsystem[1], workRoot);
            line = Number(subsystem[2]);
            message = subsystem[3];
        }
        else if (entry) {
            file = biberSourcePath(entry[1], workRoot);
        }
        else if (missing) {
            file = biberSourcePath((missing[1] ?? missing[2]), workRoot);
        }
        message = message.replace(/\/[^\s,'"]*\/([^/\s,'"]+?\.bib)_\d+\.utf8/g, "$1");
        (severity === "error" ? errors : warnings).push(diagnostic(severity, "biber", file, line, message, workRoot));
    }
    return { errors, warnings };
}
/**
 * latexmk's stdout: the "Collected error summary" and missing-tool lines, e.g.
 * `  biber: Command for 'biber' gave return code 2`. Only used when the log itself has no error.
 */
export function parseLatexmkOutput(text) {
    const out = [];
    const seen = new Set();
    const add = (message) => {
        if (seen.has(message))
            return;
        seen.add(message);
        out.push(withHint({ severity: "error", source: "latexmk", file: null, line: null, message }));
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
        if (failure)
            out.push(withHint({ severity: "error", source: "latexmk", file: null, line: null, message: scrubPaths(failure[1]) }));
    }
    return out;
}
//# sourceMappingURL=blg-parser.js.map