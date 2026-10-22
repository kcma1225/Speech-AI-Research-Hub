import { afterEach, describe, expect, it, vi } from "vitest";
import { clampRatio, loadFlag, loadRatio, ratioAt, ratioForKey, saveFlag, saveRatio } from "./split.ts";

describe("split ratios", () => {
  it("clamps to the limits and recovers from NaN", () => {
    expect(clampRatio(0.1)).toBe(0.25);
    expect(clampRatio(0.9)).toBe(0.75);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(0.05, { min: 0.2, max: 0.6 })).toBe(0.2);
  });
  it("maps a pointer position inside the container", () => {
    expect(ratioAt(600, 100, 1000)).toBeCloseTo(0.5);
    expect(ratioAt(0, 100, 1000)).toBe(0.25);
    expect(ratioAt(2000, 100, 1000)).toBe(0.75);
    expect(ratioAt(10, 0, 0)).toBe(0.5);
  });
  it("moves with the keyboard", () => {
    expect(ratioForKey("ArrowLeft", 0.5)).toBeCloseTo(0.48);
    expect(ratioForKey("ArrowRight", 0.5, true)).toBeCloseTo(0.6);
    expect(ratioForKey("Home", 0.5)).toBe(0.25);
    expect(ratioForKey("End", 0.5)).toBe(0.75);
    expect(ratioForKey("a", 0.5)).toBeNull();
  });
});

describe("split storage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("remembers ratios and flags", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(loadRatio("x", 0.5)).toBe(0.5);
    saveRatio("x", 0.612345);
    expect(loadRatio("x", 0.5)).toBe(0.612);
    store.set("hub.split.y", "garbage");
    expect(loadRatio("y", 0.4)).toBe(0.4);
    store.set("hub.split.z", "0.99");
    expect(loadRatio("z", 0.4)).toBe(0.75);
    expect(loadFlag("f", true)).toBe(true);
    saveFlag("f", false);
    expect(loadFlag("f", true)).toBe(false);
  });
  it("survives blocked storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(loadRatio("x", 0.5)).toBe(0.5);
    expect(() => saveRatio("x", 0.3)).not.toThrow();
    expect(loadFlag("f", false)).toBe(false);
    expect(() => saveFlag("f", true)).not.toThrow();
  });
});
