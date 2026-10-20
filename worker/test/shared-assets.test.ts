import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashTree } from "../src/handlers/slide-render.js";

describe("hashTree", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));
  async function tree(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), "hash-"));
    dirs.push(root);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    return root;
  }

  it("is stable regardless of listing order and changes with content or paths", async () => {
    const a = await tree({ "offline-assets/a.js": "1", "offline-assets/b/c.css": "2" });
    const b = await tree({ "offline-assets/a.js": "1", "offline-assets/b/c.css": "2" });
    const changed = await tree({ "offline-assets/a.js": "1", "offline-assets/b/c.css": "3" });
    const moved = await tree({ "offline-assets/a2.js": "1", "offline-assets/b/c.css": "2" });
    const h = await hashTree(a, ["offline-assets/a.js", "offline-assets/b/c.css"]);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashTree(b, ["offline-assets/b/c.css", "offline-assets/a.js"])).toBe(h);
    expect(await hashTree(changed, ["offline-assets/a.js", "offline-assets/b/c.css"])).not.toBe(h);
    expect(await hashTree(moved, ["offline-assets/a2.js", "offline-assets/b/c.css"])).not.toBe(h);
  });
});

describe("assertNoReserved", () => {
  it("refuses deck output inside the hub's _hub/ directory", async () => {
    const { assertNoReserved } = await import("../src/handlers/slide-render.js");
    expect(() => assertNoReserved(["index.html", "img/_hub/x.png", "_hub-thumbnail.png"])).not.toThrow();
    expect(() => assertNoReserved(["index.html", "_hub/pages.json"])).toThrow(/_hub/);
    expect(() => assertNoReserved(["_hub"])).toThrow(/_hub/);
  });
});
