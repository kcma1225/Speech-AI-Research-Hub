import { describe, expect, it } from "vitest";
import { backoffSeconds, tail } from "../src/errors.js";
import { ProgressParser, parseDuration, progressPercent, transcodeArgs } from "../src/ffmpeg.js";
import { contentType } from "../src/storage.js";

describe("ProgressParser", () => {
  it("reads out_time_us across chunk boundaries", () => {
    const parser = new ProgressParser();
    expect(parser.push("frame=0\nout_time_us=150")).toBeNull();
    expect(parser.push("0000\nprogress=continue\n")).toBe(1.5);
    expect(parser.push("out_time_us=2000000\r\nout_time_us=3000000\n")).toBe(3);
  });
  it("ignores N/A and other keys", () => {
    const parser = new ProgressParser();
    expect(parser.push("out_time_us=N/A\nout_time_ms=1000\n")).toBeNull();
  });
});

describe("progressPercent", () => {
  it("maps to 0–95 and clamps", () => {
    expect(progressPercent(5, 10)).toBe(47);
    expect(progressPercent(20, 10)).toBe(95);
    expect(progressPercent(-1, 10)).toBe(0);
    expect(progressPercent(5, null)).toBeNull();
  });
});

describe("transcode args", () => {
  it("produces 24 kHz mono 48k AAC with progress on stdout", () => {
    const args = transcodeArgs("in", "out.m4a");
    expect(args.join(" ")).toContain("-ac 1 -ar 24000 -c:a aac -b:a 48k");
    expect(args.join(" ")).toContain("-progress pipe:1");
    expect(args.at(-1)).toBe("out.m4a");
  });
  it("parses ffprobe duration", () => {
    expect(parseDuration("12.5\n")).toBe(12.5);
    expect(parseDuration("N/A")).toBeNull();
    expect(parseDuration("0")).toBeNull();
  });
});

describe("backoffSeconds", () => {
  it("doubles from 15 s and caps at 10 min", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([15, 30, 60, 120]);
    expect(backoffSeconds(20)).toBe(600);
    expect(backoffSeconds(0)).toBe(15);
  });
});

describe("helpers", () => {
  it("tail keeps the end", () => {
    expect(tail("abcdef", 3)).toBe("def");
    expect(tail("ab", 3)).toBe("ab");
  });
  it("content types", () => {
    expect(contentType("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("x.WOFF2")).toBe("font/woff2");
    expect(contentType("noext")).toBe("application/octet-stream");
  });
});

describe("mapConcurrent", () => {
  it("bounds concurrency and processes every item", async () => {
    const { mapConcurrent } = await import("../src/handlers/slide-render.js");
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async n => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("rejects on failure", async () => {
    const { mapConcurrent } = await import("../src/handlers/slide-render.js");
    await expect(mapConcurrent([1, 2, 3], 2, async n => { if (n === 2) throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
