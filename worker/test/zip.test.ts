import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { JobInputError } from "../src/errors.js";
import { assertEntry, classifyEntry, extractZip, safeEntryName } from "../src/zip.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zip-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Entry = { name: string; data?: string; mode?: number };
async function makeZip(entries: Entry[]): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) zip.addEmptyDirectory(entry.name);
    else zip.addBuffer(Buffer.from(entry.data ?? "x"), entry.name, { mode: entry.mode ?? 0o100644 });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk as Uint8Array));
  const file = path.join(dir, "in.zip");
  await writeFile(file, Buffer.concat(chunks));
  return file;
}

describe("safeEntryName", () => {
  it.each(["../x.qmd", "a/../../x.qmd", "/etc/passwd", "a\\b.qmd", "a/./b.qmd", "C:/x.qmd", "a//b.qmd", "a\0.qmd"])("rejects %s", name => {
    expect(() => safeEntryName(name)).toThrow(JobInputError);
  });
  it("accepts nested paths and strips directory slash", () => {
    expect(safeEntryName("deck/img/a.png")).toBe("deck/img/a.png");
    expect(safeEntryName("deck/")).toBe("deck");
  });
});

describe("classifyEntry", () => {
  it("skips junk directories and files", () => {
    expect(classifyEntry("__MACOSX/._index.qmd", false, 0o100644, 1)).toEqual({ skip: true });
    expect(classifyEntry(".git/config", false, 0o100644, 1)).toEqual({ skip: true });
    expect(classifyEntry("deck/node_modules/x/index.node", false, 0o100644, 1)).toEqual({ skip: true });
    expect(classifyEntry("deck/.DS_Store", false, 0o100644, 1)).toEqual({ skip: true });
  });
  it("rejects .env, symlinks, deep and huge files; skips unknown extensions", () => {
    expect(() => classifyEntry(".env", false, 0o100644, 1)).toThrow(/\.env/);
    expect(() => classifyEntry("deck/.env.local", false, 0o100644, 1)).toThrow(/\.env/);
    expect(() => classifyEntry("link.png", false, 0o120777, 1)).toThrow(/symbolic/);
    expect(classifyEntry("run.sh", false, 0o100755, 1)).toEqual({ skip: true });
    expect(classifyEntry("reports/talk.html", false, 0o100644, 1)).toEqual({ skip: false, path: "reports/talk.html" });
    expect(classifyEntry("Makefile", false, 0o100644, 1)).toEqual({ skip: true });
    expect(() => classifyEntry(Array(13).fill("d").join("/") + "/a.md", false, 0o100644, 1)).toThrow(/層級/);
    expect(() => classifyEntry("big.mp4", false, 0o100644, 101 * 1024 * 1024)).toThrow(/容量/);
  });
  it("accepts allowed files case-insensitively", () => {
    expect(classifyEntry("deck/Fig.PNG", false, 0o100644, 10)).toEqual({ skip: false, path: "deck/Fig.PNG" });
  });
});

describe("extractZip", () => {
  it("extracts allowed files, skips junk and lists qmd files", async () => {
    const zip = await makeZip([
      { name: "deck/" },
      { name: "deck/index.qmd", data: "---\ntitle: x\n---\n" },
      { name: "deck/img/a.png", data: "png" },
      { name: "__MACOSX/deck/._index.qmd", data: "junk" },
      { name: "deck/.DS_Store", data: "junk" },
    ]);
    const target = path.join(dir, "out");
    const scan = await extractZip(zip, target);
    expect(scan.qmd).toEqual(["deck/index.qmd"]);
    expect(scan.files).toBe(2);
    expect(await readFile(path.join(target, "deck/img/a.png"), "utf8")).toBe("png");
    expect((await readdir(target)).sort()).toEqual(["deck"]);
  });

  it("leaves unsupported types out and extracts the rest", async () => {
    const zip = await makeZip([{ name: "a.qmd" }, { name: "evil.exe" }, { name: "b.qmd" }]);
    await extractZip(zip, path.join(dir, "out"));
    const out = await readdir(path.join(dir, "out"));
    expect(out).toContain("b.qmd");
    expect(out).not.toContain("evil.exe");
  });

  it("rejects a forbidden entry and writes nothing after it", async () => {
    const zip = await makeZip([{ name: "a.qmd" }, { name: ".env" }, { name: "b.qmd" }]);
    await expect(extractZip(zip, path.join(dir, "out"))).rejects.toThrow(/\.env/);
    expect(await readdir(path.join(dir, "out"))).not.toContain("b.qmd");
  });

  it("rejects symlinks", async () => {
    const zip = await makeZip([{ name: "a.qmd" }, { name: "link.png", data: "/etc/passwd", mode: 0o120777 }]);
    await expect(extractZip(zip, path.join(dir, "out"))).rejects.toThrow(/symbolic link/);
  });

  it("rejects a corrupt archive as input error", async () => {
    const file = path.join(dir, "bad.zip");
    await writeFile(file, "not a zip");
    await expect(extractZip(file, path.join(dir, "out"))).rejects.toBeInstanceOf(JobInputError);
  });
});

describe("assertEntry", () => {
  it("requires an extracted qmd", () => {
    const scan = { qmd: ["deck/index.qmd"], files: 1, bytes: 1 };
    expect(assertEntry(scan, "deck/index.qmd")).toBe("deck/index.qmd");
    expect(() => assertEntry(scan, "other.qmd")).toThrow(JobInputError);
    expect(() => assertEntry(scan, "../deck/index.qmd")).toThrow(JobInputError);
  });
});
