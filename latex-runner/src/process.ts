import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { JobAbortedError, abortReason } from "./errors.js";

export type RunOptions = {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  /** Keep at most this many bytes of combined stdout/stderr (head and tail). */
  keepBytes?: number;
  /** Written to the child's file descriptor 3, then closed. */
  fd3?: Buffer;
};

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; output: string };

/**
 * Runs a command (no shell) in its own process group and SIGKILLs the whole group on timeout or abort.
 * Throws JobAbortedError when aborted; a timeout resolves with `timedOut: true`.
 */
export function runGroup(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new JobAbortedError(abortReason(options.signal)));
    const keep = options.keepBytes ?? 512_000;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.fd3 ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (options.fd3) {
      const fd3 = child.stdio[3] as Writable;
      fd3.on("error", () => {});
      fd3.end(options.fd3);
    }
    let head = "";
    let tail = "";
    let dropped = 0;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (head.length < keep / 4) {
        head += text;
        return;
      }
      tail += text;
      if (tail.length > keep) {
        dropped += tail.length - keep;
        tail = tail.slice(tail.length - keep);
      }
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => killGroup();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", error => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      // Make sure nothing of the group survives (bwrap's --die-with-parent covers the sandbox).
      killGroup();
      if (options.signal.aborted) return reject(new JobAbortedError(abortReason(options.signal)));
      const output = dropped ? `${head}\n… (${dropped} bytes omitted) …\n${tail}` : head + tail;
      resolve({ code, signal, timedOut, output });
    });
  });
}
