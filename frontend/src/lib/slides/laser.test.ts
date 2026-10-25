import { describe, expect, it } from "vitest";
import { containBox, fromSlide, revealFitTracker, revealSlideBox, toSlide } from "./laser.ts";
import { valid } from "./sync.ts";

describe("laser geometry", () => {
  it("letterboxes a page like object-fit: contain", () => {
    expect(containBox({ left: 0, top: 0, width: 1000, height: 1000 }, 1280, 800)).toEqual({ left: 0, top: 187.5, width: 1000, height: 625 });
    expect(containBox({ left: 10, top: 20, width: 2000, height: 800 }, 1280, 800)).toEqual({ left: 370, top: 20, width: 1280, height: 800 });
  });

  it("centres Reveal's scaled slide in the frame", () => {
    const frame = { left: 100, top: 50, width: 1600, height: 900 };
    expect(revealSlideBox(frame, { width: 1280, height: 800, scale: 1 }, null)).toEqual({ left: 260, top: 100, width: 1280, height: 800 });
    // Before the deck answers: the page size fitted with no margin.
    expect(revealSlideBox(frame, null, { width: 1280, height: 800 })).toEqual({ left: 180, top: 50, width: 1440, height: 900 });
  });

  it("maps a point 1:1 between two windows of different size and aspect", () => {
    const speaker = revealSlideBox({ left: 0, top: 0, width: 640, height: 400 }, { width: 1280, height: 800, scale: 0.45 }, null);
    const player = revealSlideBox({ left: 0, top: 0, width: 1920, height: 1080 }, { width: 1280, height: 800, scale: 1.215 }, null);
    // A point at slide pixel (960, 200) on the speaker preview.
    const p = toSlide(speaker, speaker.left + 0.75 * speaker.width, speaker.top + 0.25 * speaker.height)!;
    expect(p.x).toBeCloseTo(0.75);
    expect(p.y).toBeCloseTo(0.25);
    const q = fromSlide(player, p.x, p.y);
    expect((q.x - player.left) / player.width * 1280).toBeCloseTo(960);
    expect((q.y - player.top) / player.height * 800).toBeCloseTo(200);
  });

  it("returns null outside the slide (letterbox bars)", () => {
    const box = containBox({ left: 0, top: 0, width: 1000, height: 1000 }, 1280, 800);
    expect(toSlide(box, 500, 100)).toBeNull();
    expect(toSlide(box, 500, 500)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("only accepts sane Reveal callbacks", () => {
    const fit = revealFitTracker();
    expect(fit.onCallback("getScale", "1")).toBe(false);
    expect(fit.onCallback("getScale", -1)).toBe(false);
    expect(fit.onCallback("getComputedSlideSize", { width: "50%", height: 800 })).toBe(false);
    expect(fit.fit).toBeNull();
    expect(fit.onCallback("getScale", 0.5)).toBe(true);
    expect(fit.onCallback("getComputedSlideSize", { width: 1280, height: 800, presentationWidth: 1, presentationHeight: 1 })).toBe(true);
    expect(fit.onCallback("getScale", 0.5)).toBe(false);
    expect(fit.fit).toEqual({ width: 1280, height: 800, scale: 0.5 });
    fit.reset();
    expect(fit.fit).toBeNull();
  });
});

describe("laser sync messages", () => {
  it("validates shape and sender", () => {
    expect(valid({ type: "laser", page: 3, x: 0.2, y: 1, down: false, from: "speaker" })).toBe(true);
    expect(valid({ type: "laser", page: 3, x: 0.2, y: 1, down: false, from: "player" })).toBe(false);
    expect(valid({ type: "laser", page: 3, x: 1.2, y: 0.5, down: false, from: "speaker" })).toBe(false);
    expect(valid({ type: "laser", page: 0, x: 0.2, y: 0.5, down: false, from: "speaker" })).toBe(false);
    expect(valid({ type: "laser", page: 3, x: Number.NaN, y: 0.5, down: false, from: "speaker" })).toBe(false);
    expect(valid({ type: "laser", page: 3, x: 0.2, y: 0.5, down: 1, from: "speaker" })).toBe(false);
    expect(valid({ type: "laserOff", from: "speaker" })).toBe(true);
  });
});
