/** The global setup blocks the real scholarly APIs (test/setup/block-scholarly.ts). */
import { describe, expect, it } from "vitest";
import { BLOCKED_HOST_RE } from "./setup/block-scholarly.js";

describe("no real scholarly APIs in tests", () => {
  it("blocks the scholarly hosts and leaves others alone", async () => {
    for (const h of ["api.openalex.org", "api.semanticscholar.org", "export.arxiv.org", "arxiv.org", "api.crossref.org", "api.unpaywall.org", "doi.org"]) expect(BLOCKED_HOST_RE.test(h)).toBe(true);
    expect(BLOCKED_HOST_RE.test("127.0.0.1")).toBe(false);
    expect(BLOCKED_HOST_RE.test("notarxiv.org.example")).toBe(false);
  });
});
