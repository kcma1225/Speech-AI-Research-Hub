import { describe, expect, it } from "vitest";
import { MAX_SHOTS, SHOT_WIDTH, SHOTS_DIR, SHOTS_MANIFEST, shotSize } from "../src/shots.js";

describe("preview shots contract", () => {
  it("1280 px wide at the deck ratio, clamped, 16:9 fallback", () => {
    expect(SHOT_WIDTH).toBe(1280);
    expect(MAX_SHOTS).toBe(20);
    expect(shotSize({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
    expect(shotSize({ width: 0, height: 0 })).toEqual({ width: 1280, height: 720 });
    expect(shotSize({ width: 100, height: 400 }).height).toBe(960); // clamped to 4:3
  });
  it("keys match the backend (lib/vision/slides.ts)", () => {
    expect(SHOTS_DIR).toBe("_hub/shots/");
    expect(SHOTS_MANIFEST).toBe("_hub/shots.json");
  });
});
