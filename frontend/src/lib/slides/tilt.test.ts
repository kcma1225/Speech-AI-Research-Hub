import { describe, expect, it } from "vitest";
import { deviceFrame, SPAN, tiltStep } from "./tilt.ts";

const up = (x: number, y: number, z: number) => ({ x, y, z });

describe("air-mouse laser (tiltStep)", () => {
  it("phone flat, pointing ahead: turning left moves the pointer left, tilting the top up moves it up", () => {
    const flat = up(0, 0, 9.8);
    expect(tiltStep(up(0, 0, SPAN.x), flat, 0, 0.2).dx).toBeCloseTo(-0.2);
    expect(tiltStep(up(SPAN.y, 0, 0), flat, 0, 0.2).dy).toBeCloseTo(-0.2);
  });
  it("phone held upright: left / right is the turn about the room's vertical, whatever device axis that is", () => {
    expect(tiltStep(up(0, -SPAN.x, 0), up(0, 9.8, 0), 0, 0.2).dx).toBeCloseTo(0.2);
    // Tilted 45°: the vertical is between y and z.
    const tilted = up(0, 6.93, 6.93);
    expect(tiltStep(up(0, SPAN.x / Math.SQRT2, SPAN.x / Math.SQRT2), tilted, 0, 0.2).dx).toBeCloseTo(-0.2);
  });
  it("landscape screen: up / down follows the screen's horizontal axis", () => {
    expect(tiltStep(up(0, SPAN.y, 0), up(0, 0, 9.8), 90, 0.2).dy).toBeCloseTo(-0.2);
    expect(tiltStep(up(SPAN.y, 0, 0), up(0, 0, 9.8), 90, 0.2).dy).toBeCloseTo(0);
  });
  it("ignores tremor, gaps and missing gravity", () => {
    expect(tiltStep(up(0.5, 0.5, 0.5), up(0, 0, 9.8), 0, 0.02)).toEqual({ dx: 0, dy: 0 });
    expect(tiltStep(up(50, 0, 50), up(0, 0, 9.8), 0, 2)).toEqual({ dx: 0, dy: 0 });
    expect(tiltStep(up(0, 0, SPAN.x), null, 0, 0.2).dx).toBeCloseTo(-0.2);
  });

  it("iPhone readings (Core Motion order, gravity down) move the dot like Android's", () => {
    // Flat, tilting the top edge up: a rotation about x. Android: beta; iPhone: alpha. Gravity: Android +z, iPhone -z.
    const android = deviceFrame({ alpha: 0, beta: SPAN.y, gamma: 0 }, up(0, 0, 9.8), false);
    const iphone = deviceFrame({ alpha: SPAN.y, beta: 0, gamma: 0 }, up(0, 0, -9.8), true);
    for (const [rate, g] of [android, iphone]) expect(tiltStep(rate, g, 0, 0.2)).toEqual({ dx: 0, dy: expect.closeTo(-0.2) });
    // Flat, turning left: a rotation about z. Android: alpha; iPhone: gamma.
    const a2 = deviceFrame({ alpha: SPAN.x, beta: 0, gamma: 0 }, up(0, 0, 9.8), false);
    const i2 = deviceFrame({ alpha: 0, beta: 0, gamma: SPAN.x }, up(0, 0, -9.8), true);
    for (const [rate, g] of [a2, i2]) expect(tiltStep(rate, g, 0, 0.2)).toEqual({ dx: expect.closeTo(-0.2), dy: 0 });
  });
});
