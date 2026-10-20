import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { injectAnnotatePlugin, prepareSource } from "../src/annotate.js";
import { JobInputError } from "../src/errors.js";

describe("injectAnnotatePlugin", () => {
  it("adds front matter when missing", () => {
    expect(injectAnnotatePlugin("# Hi\n")).toBe("---\nrevealjs-plugins:\n  - annotate\n---\n# Hi\n");
  });
  it("adds the key to existing front matter", () => {
    expect(injectAnnotatePlugin("---\ntitle: A\n---\nbody")).toBe("---\ntitle: A\nrevealjs-plugins:\n  - annotate\n---\nbody");
  });
  it("appends to an existing block list", () => {
    const input = "---\nrevealjs-plugins:\n  - menu\nformat: revealjs\n---\n";
    expect(injectAnnotatePlugin(input)).toBe("---\nrevealjs-plugins:\n  - menu\n  - annotate\nformat: revealjs\n---\n");
  });
  it("appends to an inline list", () => {
    expect(injectAnnotatePlugin("---\nrevealjs-plugins: [menu]\n---\n")).toBe("---\nrevealjs-plugins: [menu, annotate]\n---\n");
  });
  it("is idempotent", () => {
    for (const input of ["---\nrevealjs-plugins:\n  - annotate\n---\n", "---\nrevealjs-plugins: [annotate]\n---\n"]) {
      expect(injectAnnotatePlugin(input)).toBe(input);
    }
  });
  it("does not mistake another list's annotate item", () => {
    const input = "---\nrevealjs-plugins:\n  - menu\nkeywords:\n  - annotate\n---\n";
    expect(injectAnnotatePlugin(input)).toBe("---\nrevealjs-plugins:\n  - menu\n  - annotate\nkeywords:\n  - annotate\n---\n");
  });
  it("normalizes CRLF and rejects unclosed front matter", () => {
    expect(injectAnnotatePlugin("---\r\ntitle: A\r\n---\r\n")).toBe("---\ntitle: A\nrevealjs-plugins:\n  - annotate\n---\n");
    expect(() => injectAnnotatePlugin("---\ntitle: A\n")).toThrow(JobInputError);
  });
});

describe("prepareSource", () => {
  it("copies the extension beside the entry and drops _quarto.yml", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prep-"));
    try {
      await mkdir(path.join(dir, "deck"));
      await writeFile(path.join(dir, "deck/talk.qmd"), "---\ntitle: T\n---\n");
      await writeFile(path.join(dir, "_quarto.yml"), "project: {type: website}");
      const annotate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/annotate");
      const html = await prepareSource(dir, "deck/talk.qmd", annotate);
      expect(html).toBe("talk.html");
      expect(await readFile(path.join(dir, "deck/talk.qmd"), "utf8")).toContain("  - annotate");
      await stat(path.join(dir, "deck/_extensions/annotate/annotate.js"));
      await expect(stat(path.join(dir, "_quarto.yml"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
