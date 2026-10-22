import { describe, expect, it, vi } from "vitest";
vi.mock("#lib/i18n.svelte.ts", () => ({ t: (k: string) => k }));
import { authorsShort } from "./format.ts";

describe("authorsShort", () => {
  it("keeps CJK names whole and Latin names as family names", () => {
    expect(authorsShort([{ family: "陳", given: "柏宇" }, { family: "林", given: "雅婷" }])).toBe("陳柏宇, 林雅婷");
    expect(authorsShort([{ family: "Gulati", given: "Anmol" }, { family: "Qin", given: "James" }, { family: "Chiu" }, { family: "Parmar" }])).toBe("Gulati, Qin, Chiu et al.");
    expect(authorsShort([{ literal: "ISCA" }])).toBe("ISCA");
    expect(authorsShort([])).toBe("library.noAuthors");
  });
});
