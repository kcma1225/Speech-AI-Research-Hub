import { withHint } from "./hints.js";
const GENERATED_EXT = /\.(aux|bbl|bcf|toc|lof|lot|out|nav|snm|vrb|ind|idx|ilg|gls|glo|ist|acn|acr|alg|run\.xml|fls|fdb_latexmk|xdv|brf|thm|loa|lol|synctex)$/i;
const TEXMF = /^\/(?:usr\/local\/texlive\/[^/]+|usr\/share\/texlive|usr\/share\/texmf|opt\/texlive\/[^/]+)\/(?:texmf-dist|texmf-var|texmf-local|texmf)\//;
/**
 * Makes a path from the log presentable: project-relative (strips `./`, the sandbox root `/work/`),
 * `<texmf>/…` for the TeX tree, and only the base name for any other absolute path.
 */
export function normalizeLogPath(raw, workRoot = "/work/") {
    let value = raw.trim().replace(/^"(.*)"$/, "$1");
    if (workRoot && value.startsWith(workRoot))
        value = value.slice(workRoot.length);
    const texmf = TEXMF.exec(value);
    if (texmf)
        return "<texmf>/" + value.slice(texmf[0].length);
    if (value.startsWith("/"))
        return value.slice(value.lastIndexOf("/") + 1);
    value = value.replace(/\/\.\//g, "/");
    while (value.startsWith("./"))
        value = value.slice(2);
    return value;
}
export function isGeneratedPath(file) {
    return !!file && (file.startsWith(".out/") || GENERATED_EXT.test(file));
}
/** Strips absolute container paths from free text (messages, context). */
export function scrubPaths(text, workRoot = "/work/") {
    return text
        .replace(/\/(?:usr\/local\/texlive\/[^/\s]+|usr\/share\/texlive)\/(?:texmf-dist|texmf-var|texmf-local)\//g, "<texmf>/")
        .split(workRoot).join("")
        .replace(/\/tmp\/[^\s'"`)]*\//g, "");
}
/** TeX wraps log lines at `max_print_line` (79 by default). Rejoin them when the log looks wrapped. */
export function unwrapLog(lines, width = 79) {
    const wrapped = lines.filter(line => line.length === width).length;
    if (wrapped < 3 || wrapped < lines.length * 0.01)
        return lines;
    const out = [];
    let current = "";
    for (const line of lines) {
        current += line;
        if (line.length !== width) {
            out.push(current);
            current = "";
        }
    }
    if (current)
        out.push(current);
    return out;
}
const FILE_TOKEN = /^\(("[^"]+"|[^\s()"[\]{}]+)/;
function looksLikeFile(token) {
    const value = token.replace(/^"|"$/g, "");
    if (!value || value.length > 400)
        return false;
    if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../"))
        return true;
    return /\.[A-Za-z0-9]{1,8}$/.test(value) && !/^\d/.test(value) && !value.includes(":");
}
/** Tracks the `(file` … `)` nesting TeX prints while reading input files. */
class FileStack {
    stack = [];
    feed(line) {
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === "(") {
                const match = FILE_TOKEN.exec(line.slice(i));
                if (match && looksLikeFile(match[1])) {
                    this.stack.push(match[1]);
                    i += match[0].length - 1;
                }
                else {
                    this.stack.push(null);
                }
            }
            else if (ch === ")") {
                this.stack.pop();
            }
        }
    }
    current() {
        for (let i = this.stack.length - 1; i >= 0; i--)
            if (this.stack[i])
                return this.stack[i];
        return null;
    }
}
const FILE_LINE_ERROR = /^((?:\.{0,2}\/|[^\s:!()]+\/)?[^\s:!()]*\.[A-Za-z0-9]+|\/[^:]+):(\d+): (.*)$/;
const BANG_ERROR = /^! (.*)$/;
const WARNING = /^((?:LaTeX|Package|Class|Module)(?: (\S+))?(?: Font)? Warning|LaTeX Font Warning|pdfTeX warning(?: \(([^)]+)\))?|LaTeX3 Warning): (.*)$/;
const BADBOX = /^((?:Over|Under)full \\[hv]box \([^)]*\)) (?:in paragraph|in alignment|detected|has occurred while \\output is active)(?: at lines? (\d+)(?:--(\d+))?)?/;
const CONTEXT_LINE = /^l\.(\d+) ?(.*)$/;
const CONTINUATION = /^\(([A-Za-z0-9_\-.@/ ]+)\)\s+(.*)$/;
const MISSING_CHAR = /^Missing character: There is no (.+?) in font (.+?)!?$/;
const OUTPUT_WRITTEN = /^Output written on .*\((\d+) pages?/;
function lastControlSequence(text) {
    const matches = text.match(/\\(?:[A-Za-z@]+|.)/g);
    return matches?.[matches.length - 1];
}
/**
 * Parses a LaTeX log. `workRoot` is the absolute project directory as seen by TeX (the runner
 * compiles in `/work/`), stripped from every path.
 */
export function parseLatexLog(text, options = {}) {
    const workRoot = options.workRoot ?? "/work/";
    const maxContext = options.maxContextLines ?? 6;
    const lines = unwrapLog(text.replace(/\r\n?/g, "\n").split("\n"));
    const files = new FileStack();
    const errors = [];
    const warnings = [];
    const badBoxes = [];
    const seen = new Set();
    let pages = null;
    const missingGlyphs = new Map();
    const push = (list, diagnostic) => {
        const key = `${diagnostic.severity}|${diagnostic.file}|${diagnostic.line}|${diagnostic.message}`;
        if (seen.has(key))
            return;
        seen.add(key);
        list.push(withHint(diagnostic));
    };
    const make = (severity, file, line, message) => {
        const normalized = file ? normalizeLogPath(file, workRoot) : null;
        const diagnostic = { severity, source: "latex", file: normalized, line, message: scrubPaths(message.trim(), workRoot) };
        if (isGeneratedPath(normalized))
            diagnostic.generated = true;
        return diagnostic;
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fileLine = FILE_LINE_ERROR.exec(line);
        const bang = fileLine ? null : BANG_ERROR.exec(line);
        if ((fileLine && looksLikeFile(fileLine[1])) || bang) {
            let message = fileLine ? fileLine[3] : bang[1];
            let lineNo = fileLine ? Number(fileLine[2]) : null;
            // LaTeX wraps long error messages onto indented lines ("Unicode character X (U+…)\n    not set up…").
            let first = i + 1;
            while (first < lines.length && /^\s{2,}\S/.test(lines[first]) && first <= i + 3)
                message += " " + lines[first++].trim();
            const context = [];
            let token;
            // Context runs until a blank line; the `l.<n>` line (plus the continuation after it) may come after
            // LaTeX's help text, so keep looking for it a little longer.
            let collecting = true;
            for (let j = first; j < lines.length && j <= i + 16; j++) {
                const next = lines[j];
                const ctx = CONTEXT_LINE.exec(next);
                if (ctx) {
                    lineNo ??= Number(ctx[1]);
                    token = lastControlSequence(ctx[2]);
                    context.push(next);
                    const after = lines[j + 1];
                    if (after !== undefined && after.trim() && !BANG_ERROR.test(after) && !FILE_LINE_ERROR.test(after))
                        context.push(after);
                    break;
                }
                const following = FILE_LINE_ERROR.exec(next);
                // A missing file is reported as "! LaTeX Error" followed by "./main.tex:3: Emergency stop.".
                if (following && lineNo === null && /Emergency stop/.test(following[3]))
                    lineNo = Number(following[2]);
                if (BANG_ERROR.test(next) || following || WARNING.test(next))
                    break;
                if (!next.trim())
                    collecting = false;
                else if (collecting && context.length < maxContext)
                    context.push(next);
            }
            const diagnostic = make("error", fileLine ? fileLine[1] : files.current(), lineNo, message);
            if (context.length)
                diagnostic.context = scrubPaths(context.slice(0, maxContext + 1).join("\n"), workRoot);
            if (token && /Undefined control sequence/.test(message))
                diagnostic.token = token;
            push(errors, diagnostic);
            continue;
        }
        const warning = WARNING.exec(line);
        if (warning) {
            let message = warning[4];
            let j = i + 1;
            // `(pkg)   continued text` lines, and LaTeX warnings that wrap without a prefix until a period.
            while (j < lines.length) {
                const cont = CONTINUATION.exec(lines[j]);
                if (!cont)
                    break;
                message += " " + cont[2].trim();
                j++;
            }
            files.feed(lines.slice(i + 1, j).join("\n"));
            i = j - 1;
            const at = /on input line (\d+)/.exec(message);
            const prefix = warning[1].replace(/ Warning$/, "");
            const label = prefix === "LaTeX" ? "" : prefix + ": ";
            push(warnings, make("warning", files.current(), at ? Number(at[1]) : null, label + message));
            files.feed(line);
            continue;
        }
        const badbox = BADBOX.exec(line);
        if (badbox) {
            push(badBoxes, make("badbox", files.current(), badbox[2] ? Number(badbox[2]) : null, line.trim()));
            continue;
        }
        const missing = MISSING_CHAR.exec(line);
        if (missing) {
            const font = missing[2];
            const entry = missingGlyphs.get(font) ?? { chars: new Set(), file: files.current() };
            if (entry.chars.size < 12)
                entry.chars.add(missing[1]);
            missingGlyphs.set(font, entry);
            continue;
        }
        const output = OUTPUT_WRITTEN.exec(line);
        if (output)
            pages = Number(output[1]);
        files.feed(line);
    }
    for (const [font, entry] of missingGlyphs) {
        push(warnings, make("warning", entry.file, null, `Missing character: There is no ${[...entry.chars].join(", ")} in font ${font}`));
    }
    // "Emergency stop" / "job aborted" only restate an earlier error.
    const meaningful = errors.filter(error => !/^(Emergency stop|\*\*\* \(job aborted|==> Fatal error)/.test(error.message));
    return { errors: meaningful.length ? meaningful : errors, warnings, badBoxes, pages };
}
//# sourceMappingURL=log-parser.js.map