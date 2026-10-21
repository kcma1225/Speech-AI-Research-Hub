import { existsSync } from "node:fs";
import type { Config } from "./config.js";
import { sandboxSeccompFilter } from "./seccomp-bpf.js";

/** Where the project appears inside the sandbox; the log parser strips this prefix. */
export const SANDBOX_WORK = "/work";

/** `fd3`: bytes the child reads on file descriptor 3 (bwrap's `--seccomp 3`). */
export type SandboxCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; workRoot: string; fd3?: Buffer };

/**
 * Environment of a compile. Built from scratch (never inherits the runner's environment, which holds
 * database and S3 credentials).
 */
export function compileEnv(config: Pick<Config, "TEXLIVE_BIN" | "BIBER_PAR_DIR">, home: string): Record<string, string> {
  return {
    PATH: `${config.TEXLIVE_BIN}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TEXMFVAR: `${home}/texmf-var`,
    TEXMFCONFIG: `${home}/texmf-config`,
    TEXMFHOME: `${home}/texmf`,
    XDG_CACHE_HOME: `${home}/.cache`,
    // Unwrapped logs (also set in texmf.cnf); the parser handles 79-column logs too.
    max_print_line: "10000",
    error_line: "254",
    half_error_line: "238",
    // biber is a PAR binary. It needs a writable cache dir (inc.lock); withParCache() fills
    // $HOME/par with symlinks to the cache extracted at image build instead of unpacking it (~90 s).
    PAR_GLOBAL_TEMP: `${home}/par`,
    openout_any: "p",
    shell_escape: "f",
  };
}

/** prlimit wrapper applied to latexmk and everything it starts. */
export function limits(config: Pick<Config, "LATEX_MEMORY_MB" | "LATEX_CPU_SECONDS" | "LATEX_FILE_SIZE_MB" | "LATEX_NPROC">): string[] {
  const mb = 1024 * 1024;
  return [
    "prlimit",
    `--as=${config.LATEX_MEMORY_MB * mb}`,
    `--cpu=${config.LATEX_CPU_SECONDS}`,
    `--fsize=${config.LATEX_FILE_SIZE_MB * mb}`,
    `--nproc=${config.LATEX_NPROC}`,
    "--core=0",
    "--nofile=1024",
    "--",
  ];
}

/**
 * Wraps `inner` so it sees only: the project directory read-write at /work, /usr (TeX Live, perl,
 * fonts) read-only, fontconfig config/cache and the biber cache read-only, a private /tmp and a
 * minimal /dev. No /proc, no /etc (so no /etc/passwd), no /app, no other project, no network
 * (new empty net namespace), new user/pid/ipc/uts/cgroup namespaces. The seccomp filter from
 * seccomp-bpf.ts then forbids new namespaces, mounts, ptrace etc. inside.
 */
export function bwrapCommand(config: Config, projectDir: string, inner: string[]): SandboxCommand {
  const env = compileEnv(config, "/tmp");
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", "/etc/fonts", "/etc/fonts",
    "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig",
    "--ro-bind-try", config.BIBER_PAR_DIR, config.BIBER_PAR_DIR,
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", projectDir, SANDBOX_WORK,
    "--chdir", SANDBOX_WORK,
  ];
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push("--seccomp", "3", "--", ...withParCache(inner, config.BIBER_PAR_DIR));
  return { command: "bwrap", args, env: {}, workRoot: `${SANDBOX_WORK}/`, fd3: sandboxSeccompFilter() };
}

/** Prefixes `inner` with a shell step that links the pre-extracted biber cache into $PAR_GLOBAL_TEMP. */
export function withParCache(inner: string[], parDir = "/opt/par"): string[] {
  // Same for LuaTeX: luaotfload reads its font-name database and font caches only from the writable
  // TEXMFVAR, so link the ones built into the image (else every LuaLaTeX compile rebuilds them, > 60 s).
  const script = [
    'mkdir -p "$PAR_GLOBAL_TEMP" "$TEXMFVAR"',
    '{ [ ! -d "$0" ] || cp -as "$0"/. "$PAR_GLOBAL_TEMP"/ 2>/dev/null; rm -f "$PAR_GLOBAL_TEMP/inc.lock"; }',
    '{ for d in /usr/local/texlive/20*/texmf-var/luatex-cache; do [ ! -d "$d" ] || cp -as "$d" "$TEXMFVAR"/ 2>/dev/null; done; true; }',
    'exec "$@"',
  ].join(" && ");
  return ["/bin/sh", "-c", script, parDir, ...inner];
}

/** No isolation (LATEX_SANDBOX=none): local development only. */
export function directCommand(config: Config, projectDir: string, scratch: string, inner: string[]): SandboxCommand {
  const [command, ...args] = withParCache(inner, config.BIBER_PAR_DIR);
  return { command: command!, args, env: compileEnv(config, scratch), cwd: projectDir, workRoot: `${projectDir}/` };
}

export function sandboxAvailable(): boolean {
  return existsSync("/usr/bin/bwrap");
}
