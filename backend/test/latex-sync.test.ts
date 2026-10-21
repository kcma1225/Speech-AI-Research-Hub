import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// latex-runner/src/shared/* are copies of backend/src/lib/latex/* (run latex-runner/scripts/sync-shared.sh).
const SHARED = ["contract.ts", "hints.ts", "log-parser.ts", "blg-parser.ts"];

describe("latex-runner shared files", () => {
  it.each(SHARED)("%s is identical in backend and latex-runner", async name => {
    const backend = await readFile(fileURLToPath(new URL(`../src/lib/latex/${name}`, import.meta.url)), "utf8");
    const runner = await readFile(fileURLToPath(new URL(`../../latex-runner/src/shared/${name}`, import.meta.url)), "utf8");
    expect(runner).toBe(backend);
  });
});
