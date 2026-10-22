import { describe, expect, it } from "vitest";
import { initialLibraryScope, parseLibraryScope, rememberLibraryScope } from "./scope.ts";

const params = (q: string) => new URLSearchParams(q);
function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };

describe("library scope", () => {
  it("parses only mine|all", () => {
    expect(parseLibraryScope("mine")).toBe("mine");
    expect(parseLibraryScope("all")).toBe("all");
    expect(parseLibraryScope("lab")).toBeNull();
    expect(parseLibraryScope(null)).toBeNull();
  });
  it("defaults to mine, then remembers the viewer's choice; the URL wins", () => {
    const store = memoryStore();
    expect(initialLibraryScope(params(""), store)).toBe("mine");
    rememberLibraryScope("all", store);
    expect(initialLibraryScope(params(""), store)).toBe("all");
    expect(initialLibraryScope(params("scope=mine"), store)).toBe("mine");
    expect(initialLibraryScope(params("scope=bogus"), store)).toBe("all");
  });
  it("survives storage that throws or is missing", () => {
    expect(initialLibraryScope(params(""), broken)).toBe("mine");
    expect(() => rememberLibraryScope("all", broken)).not.toThrow();
    expect(initialLibraryScope(params(""), null)).toBe("mine");
  });
});
