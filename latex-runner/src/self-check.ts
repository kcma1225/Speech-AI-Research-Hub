import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import { runGroup } from "./process.js";
import { bwrapCommand } from "./sandbox.js";

/** Starts one empty sandbox; fails when the container's seccomp profile blocks user namespaces. */
export async function checkSandbox(config: Config): Promise<{ ok: boolean; detail: string }> {
  if (config.LATEX_SANDBOX === "none") return { ok: true, detail: "disabled" };
  const dir = await mkdtemp(path.join(tmpdir(), "sandbox-check-"));
  try {
    const command = bwrapCommand(config, dir, ["/usr/bin/true"]);
    const ran = await runGroup(command.command, command.args, { env: command.env, fd3: command.fd3, timeoutMs: 10_000, signal: new AbortController().signal });
    return { ok: ran.code === 0, detail: ran.output.trim().slice(0, 500) };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
