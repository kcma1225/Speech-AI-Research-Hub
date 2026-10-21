/**
 * `latex_compile` job contract shared by the backend and `latex-runner/`.
 *
 * This file is mirrored byte-for-byte at `latex-runner/src/shared/contract.ts`
 * (checked by `backend/test/latex-sync.test.ts`); edit both or neither.
 * It must stay dependency-free so both packages can compile it.
 */

export const LATEX_JOB_KIND = "latex_compile" as const;

export const LATEX_COMPILERS = ["pdflatex", "xelatex", "lualatex"] as const;
export type LatexCompiler = (typeof LATEX_COMPILERS)[number];

/**
 * Job payload (`jobs.payload` for kind `latex_compile`).
 *
 * - `manifestKey`: S3 key of a {@link LatexSnapshotManifest} JSON listing every project file.
 * - `rootFile`: project-relative path of the root document, e.g. `main.tex`.
 * - `compiler`: from project settings (never from a `% !TEX program` comment).
 * - `outputPrefix`: S3 prefix ending in `/`, e.g. `latex/<projectId>/builds/<compileId>/`; the runner
 *   writes only below it.
 * - `draft`: one LaTeX pass, no BibTeX/biber (fast preview).
 * - `haltOnError`: stop at the first error (`-halt-on-error`); default false (`-f`, keep going so a
 *   PDF is produced whenever possible).
 */
export type LatexCompilePayload = {
  projectId: string;
  compileId: string;
  manifestKey: string;
  rootFile: string;
  compiler: LatexCompiler;
  outputPrefix: string;
  draft?: boolean;
  haltOnError?: boolean;
};

/**
 * Snapshot manifest stored at `manifestKey`. `key` is the S3 object holding the file's bytes
 * (content-addressed blobs are typical: `latex/<projectId>/blobs/<sha256>`). `sha256`, when present,
 * lets the runner skip downloads for files already in its per-project cache.
 */
export type LatexSnapshotManifest = {
  version: 1;
  files: { path: string; key: string; size?: number; sha256?: string }[];
};

export type LatexSeverity = "error" | "warning" | "badbox" | "info";
export type LatexDiagnosticSource = "latex" | "bibtex" | "biber" | "latexmk";

/**
 * One parsed problem. `file` is project-relative (`sections/intro.tex`), `<texmf>/…` for files in the
 * TeX tree, or null when unknown. `generated` marks files produced by the build (`.aux`, `.bbl`, …).
 * `code` is a key of the zh-TW hint table (`hints.ts`); `hint_zh`/`title_zh` are filled from it.
 */
export type LatexDiagnostic = {
  severity: LatexSeverity;
  source: LatexDiagnosticSource;
  file: string | null;
  line: number | null;
  message: string;
  /** Up to a few lines of TeX context (`l.12 \foo`), absolute paths stripped. */
  context?: string;
  /** Offending control sequence for "Undefined control sequence". */
  token?: string;
  generated?: boolean;
  code?: string;
  title_zh?: string;
  hint_zh?: string;
};

/**
 * Job result (`jobs.result`). A LaTeX error is NOT a job failure: the job succeeds with
 * `status: "failure"` and the parsed `errors`, so the editor can show them. The job itself fails only
 * for bad input (unsafe path, missing manifest/blob) or after retries for infrastructure errors.
 *
 * - `status`: `success` (PDF produced, no errors), `partial` (PDF produced despite errors),
 *   `failure` (no PDF), `timeout` (killed at the wall-clock limit).
 * - Keys are full S3 keys below `outputPrefix`, or null when the file was not produced:
 *   `output.pdf`, `output.synctex.gz`, `output.log`, `output.blg`, `latexmk.txt` (latexmk stdout).
 * - `errors`: every error diagnostic (max 100); `warnings`: first warnings/bad boxes (max 200).
 * - `warningCount` / `badBoxCount`: totals before truncation.
 */
export type LatexCompileResult = {
  status: "success" | "partial" | "failure" | "timeout";
  pdfKey: string | null;
  synctexKey: string | null;
  logKey: string | null;
  blgKey: string | null;
  stdoutKey: string | null;
  durationMs: number;
  pdfBytes: number | null;
  compiler: LatexCompiler;
  errors: LatexDiagnostic[];
  warnings: LatexDiagnostic[];
  warningCount: number;
  badBoxCount: number;
  /** Set when the runner deleted stale `.aux`/`.bcf` files and compiled a second time. */
  retriedAfterStaleAux?: boolean;
};

export const LATEX_OUTPUT_FILES = {
  pdf: "output.pdf",
  synctex: "output.synctex.gz",
  log: "output.log",
  blg: "output.blg",
  stdout: "latexmk.txt",
} as const;

/**
 * A project-relative path the runner accepts: forward slashes, no `..`/`.` segments, no absolute or
 * drive paths, no segment starting with `-` (would read as a CLI flag) or `.out` (build output),
 * printable characters only, ≤ 255 bytes.
 */
export function isSafeProjectPath(value: string): boolean {
  if (!value || value.length > 255 || value.includes("\\") || value.startsWith("/")) return false;
  if (/[\u0000-\u001f\u007f]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every(segment => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("-"))
    && segments[0] !== ".out";
}
