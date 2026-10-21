import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JobInputError, throwIfAborted } from "./errors.js";
import { runGroup } from "./process.js";
import { OUT_DIR } from "./project-cache.js";
import { bwrapCommand, directCommand, limits } from "./sandbox.js";
import { parseBlg, parseLatexmkOutput } from "./shared/blg-parser.js";
import { LATEX_COMPILERS, LATEX_OUTPUT_FILES, isSafeProjectPath, } from "./shared/contract.js";
import { withHint } from "./shared/hints.js";
import { parseLatexLog } from "./shared/log-parser.js";
import { STAGES } from "./types.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const payloadSchema = z
    .object({
    projectId: id,
    compileId: id,
    manifestKey: z.string().min(1).max(1024),
    rootFile: z.string().refine(value => isSafeProjectPath(value) && /\.(tex|ltx)$/i.test(value), "unsafe root file"),
    compiler: z.enum(LATEX_COMPILERS),
    outputPrefix: z.string().min(2).max(1024).endsWith("/"),
    draft: z.boolean().optional(),
    haltOnError: z.boolean().optional(),
})
    .refine(value => value.outputPrefix.startsWith(`latex/${value.projectId}/`) && !value.outputPrefix.includes(".."), "outputPrefix outside project")
    .refine(value => value.manifestKey.startsWith(`latex/${value.projectId}/`) && !value.manifestKey.includes(".."), "manifestKey outside project");
export function parsePayload(payload) {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success)
        throw new JobInputError("編譯工作的參數不正確：" + parsed.error.issues.map(issue => issue.message).join("; "));
    return parsed.data;
}
const ENGINE_FLAG = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
/** latexmk command line (own wording of the standard flags); `-norc` ignores project latexmkrc files. */
export function latexmkArgs(payload) {
    const args = [
        "latexmk",
        "-norc",
        ENGINE_FLAG[payload.compiler],
        "-interaction=nonstopmode",
        "-file-line-error",
        "-synctex=1",
        "-no-shell-escape",
        `-outdir=${OUT_DIR}`,
        payload.haltOnError ? "-halt-on-error" : "-f",
    ];
    if (payload.draft)
        args.push("-e", "$max_repeat=1", "-e", "$bibtex_use=0");
    args.push(`./${payload.rootFile}`);
    return args;
}
const MAX_LOG_UPLOAD = 5 * 1024 * 1024;
const MAX_ERRORS = 100;
const MAX_WARNINGS = 200;
/** Handler for `latex_compile`. LaTeX errors produce a successful job with `status: failure`. */
export async function latexCompile(raw, ctx) {
    const payload = parsePayload(raw);
    const started = Date.now();
    const result = await ctx.cache.withProject(payload.projectId, async () => {
        ctx.progress(STAGES.prepare, 5);
        const manifestText = await ctx.storage.getText(payload.manifestKey, 8 * 1024 * 1024, ctx.signal);
        let manifest;
        try {
            manifest = JSON.parse(manifestText);
        }
        catch {
            throw new JobInputError("專案檔案清單格式錯誤。");
        }
        const { previous, downloaded } = await ctx.cache.sync(payload.projectId, manifest, {
            storage: ctx.storage,
            signal: ctx.signal,
            maxFiles: ctx.config.LATEX_MAX_FILES,
            maxBytes: ctx.config.LATEX_MAX_PROJECT_MB * 1024 * 1024,
            keyPrefix: `latex/${payload.projectId}/`,
        });
        if (!manifest.files.some(file => file.path === payload.rootFile))
            throw new JobInputError(`找不到主檔案：${payload.rootFile}`);
        ctx.log.debug({ downloaded, files: manifest.files.length }, "project synced");
        const src = ctx.cache.srcDir(payload.projectId);
        const out = path.join(src, OUT_DIR);
        if (previous.compiler !== payload.compiler || previous.rootFile !== payload.rootFile)
            await rm(out, { recursive: true, force: true });
        await prepareOutDir(src, manifest);
        const base = path.basename(payload.rootFile).replace(/\.(tex|ltx)$/i, "");
        await removeFinalOutputs(out, base);
        ctx.progress(STAGES.compile, 15);
        let run = await compileOnce(payload, ctx, src, out, base);
        let retriedAfterStaleAux = false;
        if (!run.timedOut && run.parsed.errors.some(error => error.generated)) {
            // Stale or corrupt .aux/.bcf from an earlier build: start from a clean output directory once.
            ctx.log.info("errors in generated files; retrying with a clean output directory");
            await rm(out, { recursive: true, force: true });
            await prepareOutDir(src, manifest);
            run = await compileOnce(payload, ctx, src, out, base);
            retriedAfterStaleAux = true;
        }
        ctx.progress(STAGES.upload, 90);
        const uploaded = await uploadOutputs(payload, ctx, out, base, run.stdout);
        const state = await readStateSafe(ctx.cache, payload.projectId);
        await ctx.cache.writeState(payload.projectId, { ...state, compiler: payload.compiler, rootFile: payload.rootFile, lastUsed: Date.now() });
        const errors = [...run.parsed.errors, ...run.blgErrors];
        if (run.timedOut) {
            errors.unshift({ severity: "error", source: "latexmk", file: null, line: null, message: `編譯超過 ${ctx.config.LATEX_TIMEOUT_SECONDS} 秒，已中止。`, code: "timeout", title_zh: "編譯逾時", hint_zh: "文件可能有無窮迴圈，或圖片／圖表過於複雜。可先用草稿模式編譯，或把大型 TikZ/pgfplots 圖改成預先產生的 PDF。" });
        }
        // BibTeX/biber crashing without a usable .blg only shows up in latexmk's "Collected error summary".
        if (!run.blgErrors.length) {
            const toolErrors = parseLatexmkOutput(run.stdout).filter(error => /biber|bibtex/i.test(error.message));
            errors.push(...toolErrors);
        }
        if (!uploaded.pdfKey && !errors.length) {
            errors.push(...parseLatexmkOutput(run.stdout));
            if (!errors.length)
                errors.push(withHint({ severity: "error", source: "latexmk", file: null, line: null, message: "編譯失敗，沒有產生 PDF。請查看完整編譯記錄。" }));
        }
        const warnings = [...run.parsed.warnings, ...run.blgWarnings, ...run.parsed.badBoxes];
        const status = run.timedOut ? "timeout" : !uploaded.pdfKey ? "failure" : errors.length ? "partial" : "success";
        const compileResult = {
            status,
            ...uploaded,
            durationMs: Date.now() - started,
            compiler: payload.compiler,
            errors: errors.slice(0, MAX_ERRORS),
            warnings: warnings.slice(0, MAX_WARNINGS),
            warningCount: run.parsed.warnings.length + run.blgWarnings.length,
            badBoxCount: run.parsed.badBoxes.length,
        };
        if (retriedAfterStaleAux)
            compileResult.retriedAfterStaleAux = true;
        return compileResult;
    });
    await ctx.cache.evict(payload.projectId).catch(error => ctx.log.warn({ err: error }, "cache eviction failed"));
    return result;
}
async function compileOnce(payload, ctx, src, out, base) {
    throwIfAborted(ctx.signal);
    const { config } = ctx;
    const inner = [...limits(config), ...latexmkArgs(payload)];
    let scratch = null;
    let command;
    if (config.LATEX_SANDBOX === "bwrap") {
        command = bwrapCommand(config, src, inner);
    }
    else {
        scratch = path.join(ctx.cache.dir(payload.projectId), "tmp");
        await rm(scratch, { recursive: true, force: true });
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        command = directCommand(config, src, scratch, inner);
    }
    const ran = await runGroup(command.command, command.args, {
        cwd: command.cwd,
        env: command.env,
        fd3: command.fd3,
        timeoutMs: config.LATEX_TIMEOUT_SECONDS * 1000,
        signal: ctx.signal,
    });
    if (scratch)
        await rm(scratch, { recursive: true, force: true });
    if (ran.code === null && !ran.timedOut && ran.signal)
        ctx.log.warn({ signal: ran.signal }, "latexmk killed by signal");
    // bwrap itself failing (e.g. seccomp blocks user namespaces) is an infrastructure error.
    if (/^bwrap: /m.test(ran.output) && ran.code !== 0 && !(await exists(path.join(out, `${base}.log`)))) {
        throw new Error("sandbox failed: " + ran.output.slice(0, 500));
    }
    const workRoot = command.workRoot;
    const logText = await readFile(path.join(out, `${base}.log`), "utf8").catch(() => "");
    const blgText = await readFile(path.join(out, `${base}.blg`), "utf8").catch(() => "");
    const parsed = parseLatexLog(logText, { workRoot });
    const blg = parseBlg(blgText, { workRoot });
    return { timedOut: ran.timedOut, code: ran.code, stdout: scrubStdout(ran.output, workRoot), parsed, blgErrors: blg.errors, blgWarnings: blg.warnings };
}
function scrubStdout(text, workRoot) {
    return text.split(workRoot).join("");
}
async function exists(file) {
    return stat(file).then(() => true, () => false);
}
/** `.out` plus every source directory mirrored under it (TeX writes `\include` .aux files there). */
async function prepareOutDir(src, manifest) {
    const out = path.join(src, OUT_DIR);
    await mkdir(out, { recursive: true, mode: 0o700 });
    const dirs = new Set();
    for (const file of manifest.files) {
        const parts = file.path.split("/");
        for (let i = 1; i < parts.length; i++)
            dirs.add(parts.slice(0, i).join("/"));
    }
    for (const dir of dirs)
        await mkdir(path.join(out, ...dir.split("/")), { recursive: true, mode: 0o700 });
}
/** A stale PDF/log from the previous build must never be reported as this build's output. */
async function removeFinalOutputs(out, base) {
    for (const ext of [".pdf", ".synctex.gz", ".log", ".blg", ".xdv", ".synctex(busy)"]) {
        await rm(path.join(out, base + ext), { force: true });
    }
}
async function uploadOutputs(payload, ctx, out, base, stdout) {
    const prefix = payload.outputPrefix;
    const file = (ext) => path.join(out, base + ext);
    const put = async (local, name, type) => {
        if (!(await exists(local)))
            return null;
        const key = prefix + name;
        await ctx.storage.uploadFile(key, local, type, ctx.signal);
        return key;
    };
    const pdfLocal = file(".pdf");
    const pdfStat = await stat(pdfLocal).catch(() => null);
    const pdfKey = pdfStat && pdfStat.size > 0 ? await put(pdfLocal, LATEX_OUTPUT_FILES.pdf, "application/pdf") : null;
    const synctexKey = pdfKey ? await put(file(".synctex.gz"), LATEX_OUTPUT_FILES.synctex, "application/gzip") : null;
    let logKey = null;
    const log = await readFile(file(".log")).catch(() => null);
    if (log) {
        const body = log.length > MAX_LOG_UPLOAD ? Buffer.concat([log.subarray(0, 1024 * 1024), Buffer.from("\n… (log truncated) …\n"), log.subarray(log.length - 4 * 1024 * 1024)]) : log;
        logKey = prefix + LATEX_OUTPUT_FILES.log;
        await ctx.storage.uploadBuffer(logKey, body, "text/plain; charset=utf-8", ctx.signal);
    }
    const blgKey = await put(file(".blg"), LATEX_OUTPUT_FILES.blg, "text/plain; charset=utf-8");
    const stdoutKey = prefix + LATEX_OUTPUT_FILES.stdout;
    await ctx.storage.uploadBuffer(stdoutKey, stdout, "text/plain; charset=utf-8", ctx.signal);
    return { pdfKey, synctexKey, logKey, blgKey, stdoutKey, pdfBytes: pdfKey ? pdfStat.size : null };
}
async function readStateSafe(cache, projectId) {
    try {
        return JSON.parse(await readFile(path.join(cache.dir(projectId), "state.json"), "utf8"));
    }
    catch {
        return { files: {}, lastUsed: Date.now() };
    }
}
//# sourceMappingURL=compile.js.map