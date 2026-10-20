import { spawn } from "node:child_process";
import { JobAbortedError, abortReason, tail } from "./errors.js";

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  /** Called with each stdout chunk (as text). */
  onStdout?: (chunk: string) => void;
  /** Keep this many trailing characters of combined output. */
  keepLog?: number;
};

export type RunResult = { code: number | null; timedOut: boolean; log: string };

/**
 * Runs a command without a shell. Kills it (SIGTERM, then SIGKILL after 5 s) on timeout or abort.
 * Throws JobAbortedError when aborted; otherwise resolves with the exit code and output tail.
 */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new JobAbortedError(abortReason(options.signal)));
    const keep = options.keepLog ?? 16_000;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      log = tail(log + chunk.toString("utf8"), keep);
    };
    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk);
      options.onStdout?.(chunk.toString("utf8"));
    });
    child.stderr.on("data", append);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", error => {
      cleanup();
      reject(error);
    });
    child.on("close", code => {
      cleanup();
      if (options.signal.aborted) return reject(new JobAbortedError(abortReason(options.signal)));
      resolve({ code, timedOut, log });
    });
  });
}
