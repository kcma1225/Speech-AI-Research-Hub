import { mkdtemp, readFile, rm, symlink, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latexmkArgs, parsePayload } from "../src/compile.js";
import { loadConfig } from "../src/config.js";
import { JobInputError } from "../src/errors.js";
import { ProjectCache, validateManifest } from "../src/project-cache.js";
import { bwrapCommand } from "../src/sandbox.js";
import { CLONE_NAMESPACE_FLAGS, sandboxSeccompFilter } from "../src/seccomp-bpf.js";
import type { Storage } from "../src/storage.js";

const config = loadConfig({ WORKER_DB_PASSWORD: "x", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "x" });
const pid = "0b5c3e0e-0000-4000-8000-000000000001";
const valid = {
  projectId: pid,
  compileId: "c1",
  manifestKey: `latex/${pid}/snapshots/a.json`,
  rootFile: "main.tex",
  compiler: "xelatex",
  outputPrefix: `latex/${pid}/builds/c1/`,
};

describe("payload", () => {
  it("accepts a valid payload", () => {
    expect(parsePayload(valid)).toMatchObject(valid);
  });

  it.each([
    ["root traversal", { rootFile: "../x.tex" }],
    ["root flag", { rootFile: "-shell-escape.tex" }],
    ["root not tex", { rootFile: "main.sh" }],
    ["unknown engine", { compiler: "luatex" }],
    ["output outside project", { outputPrefix: "latex/other/builds/" }],
    ["output without slash", { outputPrefix: `latex/${pid}/builds/c1` }],
    ["manifest outside project", { manifestKey: "slides/x.json" }],
    ["bad id", { projectId: "../x" }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parsePayload({ ...valid, ...patch })).toThrow(JobInputError);
  });
});

describe("latexmk command", () => {
  it("never enables shell escape and ignores project rc files", () => {
    const args = latexmkArgs({ compiler: "pdflatex", rootFile: "thesis/main.tex" });
    expect(args).toEqual(["latexmk", "-norc", "-pdf", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-no-shell-escape", "-outdir=.out", "-f", "./thesis/main.tex"]);
    expect(latexmkArgs({ compiler: "xelatex", rootFile: "m.tex", draft: true, haltOnError: true })).toEqual(
      expect.arrayContaining(["-xelatex", "-halt-on-error", "$max_repeat=1", "$bibtex_use=0"]),
    );
  });
});

describe("sandbox", () => {
  it("clears the environment, binds only the project read-write and installs the seccomp filter", () => {
    const command = bwrapCommand(config, "/var/latex/projects/p/src", ["latexmk"]);
    const args = command.args;
    expect(command.command).toBe("bwrap");
    expect(command.env).toEqual({});
    expect(args).toContain("--clearenv");
    expect(args).toContain("--unshare-all");
    const binds = args.flatMap((arg, i) => (arg === "--bind" ? [`${args[i + 1]}->${args[i + 2]}`] : []));
    expect(binds).toEqual(["/var/latex/projects/p/src->/work"]);
    const roBinds = args.flatMap((arg, i) => (arg.startsWith("--ro-bind") ? [args[i + 1]] : []));
    expect(roBinds).not.toContain("/etc");
    expect(roBinds).not.toContain("/app");
    expect(args).not.toContain("--proc");
    expect(args.join(" ")).not.toMatch(/S3_|PASSWORD/);
    expect(args.slice(args.indexOf("--seccomp"), args.indexOf("--seccomp") + 2)).toEqual(["--seccomp", "3"]);
    expect(command.fd3!.length % 8).toBe(0);
  });

  it("builds a well-formed BPF program", () => {
    const filter = sandboxSeccompFilter();
    const count = filter.length / 8;
    expect(count).toBeGreaterThan(40);
    expect(count).toBeLessThan(255);
    // Every jump lands inside the program; the last two instructions are returns.
    for (let i = 0; i < count; i++) {
      const code = filter.readUInt16LE(i * 8);
      if ((code & 0x07) === 0x05) {
        expect(i + 1 + filter.readUInt8(i * 8 + 2)).toBeLessThan(count);
        expect(i + 1 + filter.readUInt8(i * 8 + 3)).toBeLessThan(count);
      }
    }
    expect(filter.readUInt16LE((count - 1) * 8)).toBe(0x06);
    expect(filter.readUInt32LE((count - 1) * 8 + 4)).toBe(0x00050026);
    expect(filter.readUInt32LE((count - 2) * 8 + 4)).toBe(0x00050001);
    expect(CLONE_NAMESPACE_FLAGS).toBe(2114060288);
  });
});

describe("manifest validation", () => {
  const options = { maxFiles: 3, maxBytes: 100, keyPrefix: "latex/p/" };
  const ok = (path: string) => ({ path, key: `latex/p/blobs/${path.length}` });
  it.each([
    ["traversal", [ok("../x")]],
    ["absolute", [ok("/etc/passwd")]],
    ["backslash", [ok("a\\b")]],
    ["dot segment", [ok("a/./b")]],
    ["build dir", [ok(".out/main.pdf")]],
    ["duplicate", [ok("a"), ok("a")]],
    ["file and folder", [ok("a"), ok("a/b")]],
    ["foreign key", [{ path: "a", key: "latex/q/blobs/1" }]],
    ["too many", [ok("a"), ok("b"), ok("c"), ok("d")]],
    ["too big", [{ ...ok("a"), size: 1000 }]],
  ])("rejects %s", (_name, files) => {
    expect(() => validateManifest({ version: 1, files }, options)).toThrow(JobInputError);
  });
});

describe("project cache", () => {
  let root: string;
  const downloads: string[] = [];
  const blobs = new Map<string, string>();
  const storage = {
    async download(key: string, file: string) {
      downloads.push(key);
      const body = blobs.get(key);
      if (body === undefined) throw new JobInputError("missing");
      await writeFile(file, body);
      return Buffer.byteLength(body);
    },
  } as unknown as Storage;
  const sync = (cache: ProjectCache, files: { path: string; key: string }[]) =>
    cache.sync("p", { version: 1, files }, { storage, signal: new AbortController().signal, maxFiles: 100, maxBytes: 1_000_000, keyPrefix: "latex/p/" });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "latex-cache-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("downloads only changed files, prunes removed ones and keeps .out", async () => {
    const cache = new ProjectCache(root, 4);
    blobs.set("latex/p/1", "main v1").set("latex/p/2", "intro").set("latex/p/3", "main v2");
    await sync(cache, [{ path: "main.tex", key: "latex/p/1" }, { path: "sections/intro.tex", key: "latex/p/2" }]);
    const src = cache.srcDir("p");
    await mkdir(path.join(src, ".out"), { recursive: true });
    await writeFile(path.join(src, ".out", "main.aux"), "aux");
    await writeFile(path.join(src, "stray.tex"), "x");
    await symlink("/etc/passwd", path.join(src, "link.tex"));
    downloads.length = 0;
    await sync(cache, [{ path: "main.tex", key: "latex/p/3" }]);
    expect(downloads).toEqual(["latex/p/3"]);
    expect(await readFile(path.join(src, "main.tex"), "utf8")).toBe("main v2");
    expect((await readdir(src)).sort()).toEqual([".out", "main.tex"]);
    expect(await readFile(path.join(src, ".out", "main.aux"), "utf8")).toBe("aux");
    // A file modified in place (e.g. by a compile) is downloaded again.
    downloads.length = 0;
    await writeFile(path.join(src, "main.tex"), "tampered!");
    await sync(cache, [{ path: "main.tex", key: "latex/p/3" }]);
    expect(downloads).toEqual(["latex/p/3"]);
    expect(await readFile(path.join(src, "main.tex"), "utf8")).toBe("main v2");
  });

  it("serializes work per project", async () => {
    const cache = new ProjectCache(root, 4);
    const order: string[] = [];
    await Promise.all([
      cache.withProject("x", async () => {
        order.push("a-start");
        await new Promise(resolve => setTimeout(resolve, 30));
        order.push("a-end");
      }),
      cache.withProject("x", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
