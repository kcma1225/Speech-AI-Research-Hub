import { describe, expect, it } from "vitest";
import { thumbnailSize } from "../src/pdf.js";

describe("thumbnailSize", () => {
  it("follows the deck aspect ratio and clamps it", () => {
    expect(thumbnailSize({ width: 1280, height: 800 })).toEqual({ width: 960, height: 600 });
    expect(thumbnailSize({ width: 1050, height: 700 })).toEqual({ width: 960, height: 640 });
    expect(thumbnailSize({ width: 0, height: 0 })).toEqual({ width: 960, height: 540 });
    expect(thumbnailSize({ width: 100, height: 400 })).toEqual({ width: 960, height: 720 });
  });
});
