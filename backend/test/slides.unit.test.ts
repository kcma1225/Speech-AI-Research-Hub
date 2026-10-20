import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseEntry, safeEntryName, scanZip } from "../src/lib/slides/zip-validate.js";
import { safeEqual, validCapability, validViewToken, viewToken, type SlideProject } from "../src/lib/slides/access.js";
import { parseTagFilter } from "../src/lib/slides/filters.js";
import { deckCsp, patchDeckHtml, safeAssetPath } from "../src/routes/slide-view.js";
import { writeZip, type ZipEntry } from "./slides-fixtures.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "slides-unit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scan(entries: ZipEntry[]) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  await writeZip(file, entries);
  return scanZip(file);
}
const qmd = { name: "index.qmd", data: "---\ntitle: x\n---\n" };

describe("zip validation", () => {
  it("accepts a normal deck and lists QMD files", async () => {
    const result = await scan([qmd, { name: "img/a.png", data: "x" }, { name: "img/", data: "", mode: 0o040755 }, { name: "talk/b.qmd", data: "" }]);
    expect(result.qmd).toEqual(["index.qmd", "talk/b.qmd"]);
    expect(result.files).toBe(3);
  });

  it.each([
    ["path traversal", "../evil.qmd", /不安全路徑/],
    ["nested traversal", "a/../../evil.qmd", /不安全路徑/],
    ["absolute path", "/etc/passwd.qmd", /不安全路徑/],
    ["backslash", "a\\b.qmd", /不安全路徑/],
    ["dot segment", "./a.qmd", /不安全路徑/],
    [".env", ".env.local.txt", /禁止/],
    ["disallowed extension", "run.sh", /不支援檔案類型/],
    ["html", "index.html", /不支援檔案類型/],
    ["too deep", `${Array.from({ length: 12 }, (_, i) => `d${i}`).join("/")}/a.md`, /層級過深/],
  ])("rejects %s", async (_label, name, message) => {
    await expect(scan([qmd, { name, data: "x" }])).rejects.toThrow(message);
  });

  it.each([
    [".git", ".git/config"],
    ["node_modules", "node_modules/x.js"],
    ["__MACOSX (Finder)", "__MACOSX/._index.qmd"],
    [".DS_Store", "img/.DS_Store"],
    ["_site", "_site/index.html"],
    [".quarto", ".quarto/x.json"],
  ])("skips %s without counting it", async (_label, name) => {
    const result = await scan([qmd, { name, data: "x" }]);
    expect(result.files).toBe(1);
    expect(result.qmd).toEqual(["index.qmd"]);
  });

  it("rejects symbolic links", async () => {
    await expect(scan([qmd, { name: "link.md", data: "/etc/passwd", mode: 0o120777 }])).rejects.toThrow(/symbolic link/);
  });

  it("rejects garbage", async () => {
    const file = path.join(dir, "garbage.zip");
    await (await import("node:fs/promises")).writeFile(file, "not a zip");
    await expect(scanZip(file)).rejects.toThrow(/無法讀取/);
  });

  it("chooses the entry", () => {
    expect(() => chooseEntry([], undefined)).toThrow(/未包含 QMD/);
    expect(chooseEntry(["a.qmd", "index.qmd"], undefined)).toBe("index.qmd");
    expect(chooseEntry(["talk/x.qmd"], "")).toBe("talk/x.qmd");
    expect(chooseEntry(["a.qmd", "b.qmd"], "b.qmd")).toBe("b.qmd");
    expect(() => chooseEntry(["a.qmd", "b.qmd"], undefined)).toThrow(/多個 QMD/);
    expect(() => chooseEntry(["a.qmd"], "c.qmd")).toThrow(/找不到指定入口/);
    expect(() => chooseEntry(["a.qmd"], "../a.qmd")).toThrow(/不安全路徑/);
  });

  it("normalises safe names", () => {
    expect(safeEntryName("a/b.qmd")).toBe("a/b.qmd");
    expect(safeEntryName("dir/")).toBe("dir/");
  });
});

describe("view capability", () => {
  const secret = "s".repeat(40);
  const project = { id: "p1", share_key: "share-key-value", public_view: false } as SlideProject;

  it("accepts a fresh token for the same version only", () => {
    const token = viewToken(secret, "p1", "v1");
    expect(validViewToken(secret, token, "p1", "v1")).toBe(true);
    expect(validViewToken(secret, token, "p1", "v2")).toBe(false);
    expect(validViewToken("x".repeat(40), token, "p1", "v1")).toBe(false);
  });

  it("rejects expired and tampered tokens", () => {
    const old = viewToken(secret, "p1", "v1", Date.now() - 13 * 3600_000);
    expect(validViewToken(secret, old, "p1", "v1")).toBe(false);
    const token = viewToken(secret, "p1", "v1");
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(validViewToken(secret, tampered, "p1", "v1")).toBe(false);
    const [, expiry, sig] = token.split(".");
    expect(validViewToken(secret, `t.${Number(expiry) + 1000}.${sig}`, "p1", "v1")).toBe(false);
    expect(validViewToken(secret, "garbage", "p1", "v1")).toBe(false);
  });

  it("handles public and share-key capabilities", () => {
    expect(validCapability(secret, "public", project, "v1")).toBe(false);
    expect(validCapability(secret, "public", { ...project, public_view: true }, "v1")).toBe(true);
    expect(validCapability(secret, "share-key-value", project, "v1")).toBe(true);
    expect(validCapability(secret, "share-key-valuX", project, "v1")).toBe(false);
    expect(safeEqual(undefined, "x")).toBe(false);
  });
});

describe("asset serving helpers", () => {
  it("refuses unsafe or private paths", () => {
    expect(safeAssetPath("index.html")).toBe("index.html");
    expect(safeAssetPath("index_files/libs/reveal.js")).toBe("index_files/libs/reveal.js");
    for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "a\\b", "a\0b", "./a", "a//b", "slides.pdf", "pdf.log", "offline-assets/licenses/x.txt"]) {
      expect(safeAssetPath(bad), bad).toBeNull();
    }
  });

  it("patches deck HTML", () => {
    const html = patchDeckHtml('<html><head lang="en"><title>x</title></head><body><script>Reveal.initialize({hash:true})</script></body></html>');
    expect(html).toMatch(/<head lang="en"><script>\(function\(\)\{function m\(\)/);
    expect(html).toContain("Reveal.initialize({scrollActivationWidth:0,hash:true})");
    expect(html).toMatch(/min-height:44px.*<\/style><\/head>/);
  });

  it("builds the sandbox CSP", () => {
    const csp = deckCsp("https://hub.example");
    expect(csp.startsWith("sandbox allow-scripts allow-pointer-lock allow-presentation;")).toBe(true);
    expect(csp).toContain("frame-ancestors https://hub.example");
    expect(csp).toContain("connect-src 'none'");
  });

  it("parses tag filters", () => {
    expect(parseTagFilter(undefined)).toEqual({ mode: "all" });
    expect(parseTagFilter("")).toEqual({ mode: "set", ids: [], untagged: false });
    const id = "6f1d2a1e-1d7b-4c43-9a35-2f8a3a0f8f11";
    expect(parseTagFilter(`${id},none`)).toEqual({ mode: "set", ids: [id], untagged: true });
    expect(() => parseTagFilter("nope")).toThrow();
  });
});
