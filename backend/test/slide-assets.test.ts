import { describe, expect, it } from "vitest";
import { assetKey } from "../src/routes/slide-view.js";

describe("assetKey", () => {
  const own = "slides/p/v/output/";
  const shared = "slides/_shared/0123456789abcdef0123456789abcdef/";

  it("serves offline-assets from the shared prefix when the version has one", () => {
    expect(assetKey({ output_prefix: own, shared_prefix: shared }, "offline-assets/mathjax/tex-svg.js")).toBe(`${shared}mathjax/tex-svg.js`);
  });
  it("serves deck files from the version's own output", () => {
    expect(assetKey({ output_prefix: own, shared_prefix: shared }, "index_files/libs/revealjs/reveal.js")).toBe(`${own}index_files/libs/revealjs/reveal.js`);
  });
  it("falls back to the version's output for renders without a shared prefix", () => {
    expect(assetKey({ output_prefix: own, shared_prefix: null }, "offline-assets/katex/katex.css")).toBe(`${own}offline-assets/katex/katex.css`);
  });
});
