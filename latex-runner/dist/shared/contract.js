/**
 * `latex_compile` job contract shared by the backend and `latex-runner/`.
 *
 * This file is mirrored byte-for-byte at `latex-runner/src/shared/contract.ts`
 * (checked by `backend/test/latex-sync.test.ts`); edit both or neither.
 * It must stay dependency-free so both packages can compile it.
 */
export const LATEX_JOB_KIND = "latex_compile";
export const LATEX_COMPILERS = ["pdflatex", "xelatex", "lualatex"];
export const LATEX_OUTPUT_FILES = {
    pdf: "output.pdf",
    synctex: "output.synctex.gz",
    log: "output.log",
    blg: "output.blg",
    stdout: "latexmk.txt",
};
/**
 * A project-relative path the runner accepts: forward slashes, no `..`/`.` segments, no absolute or
 * drive paths, no segment starting with `-` (would read as a CLI flag) or `.out` (build output),
 * printable characters only, ≤ 255 bytes.
 */
export function isSafeProjectPath(value) {
    if (!value || value.length > 255 || value.includes("\\") || value.startsWith("/"))
        return false;
    if (/[\u0000-\u001f\u007f]/.test(value) || /^[A-Za-z]:/.test(value))
        return false;
    const segments = value.split("/");
    return segments.every(segment => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("-"))
        && segments[0] !== ".out";
}
//# sourceMappingURL=contract.js.map