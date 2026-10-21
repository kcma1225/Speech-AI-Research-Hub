import { describe, expect, it } from "vitest";
import { inScope, ownerOf, parseScope, resolveScope, scopeCounts } from "./scope.ts";

const cards = [
  { id: "a", my_role: "owner" as string | null },
  { id: "b", my_role: null },
  { id: "c", my_role: "advisor" },
];

describe("studies scope", () => {
  it("parses only mine/lab", () => {
    expect(parseScope("mine")).toBe("mine");
    expect(parseScope("lab")).toBe("lab");
    expect(parseScope("all")).toBeNull();
    expect(parseScope(null)).toBeNull();
  });
  it("defaults to mine when I belong to a study, else lab; the URL wins", () => {
    const none = new URLSearchParams();
    expect(resolveScope(none, null)).toBeNull(); // wait for counts
    expect(resolveScope(none, { mine: 1, lab: 2 })).toBe("mine");
    expect(resolveScope(none, { mine: 0, lab: 2 })).toBe("lab");
    expect(resolveScope(new URLSearchParams("scope=lab"), { mine: 3, lab: 4 })).toBe("lab");
    expect(resolveScope(new URLSearchParams("scope=mine"), { mine: 0, lab: 4 })).toBe("mine");
    expect(resolveScope(new URLSearchParams("member=me"), null)).toBe("mine");
    expect(resolveScope(new URLSearchParams("scope=bogus"), { mine: 0, lab: 1 })).toBe("lab");
  });
  it("counts and filters by membership (any role)", () => {
    expect(scopeCounts(cards)).toEqual({ mine: 2, lab: 3 });
    expect(inScope(cards, "mine").map(c => c.id)).toEqual(["a", "c"]);
    expect(inScope(cards, "lab")).toHaveLength(3);
    expect(scopeCounts([])).toEqual({ mine: 0, lab: 0 });
  });
  it("finds the owner", () => {
    expect(ownerOf([{ id: "1", role: "member" }, { id: "2", role: "owner" }])?.id).toBe("2");
    expect(ownerOf([])).toBeNull();
  });
});
