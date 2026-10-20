import { describe, expect, it } from "vitest";
import { MAX_PEAKS, PeakAccumulator, bucketPeaks, peakArgs } from "../src/peaks.js";

/** Mono s16le PCM from sample values. */
function pcm(samples: readonly number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

describe("bucketPeaks", () => {
  it("keeps one bucket per window when there are fewer than the cap, normalized to the global max", () => {
    expect(bucketPeaks([100, 400, 200, 0])).toEqual([0.25, 1, 0.5, 0]);
  });
  it("takes the max per bucket when downsampling and rounds to 3 decimals", () => {
    expect(bucketPeaks([1, 3, 2, 3000, 5, 7], 3)).toEqual([0.001, 1, 0.002]);
    expect(bucketPeaks([1, 2, 3], 3)).toEqual([0.333, 0.667, 1]);
  });
  it("splits unevenly sized inputs into exactly `max` non-empty buckets", () => {
    const windows = Array.from({ length: 2501 }, (_, i) => i + 1000);
    const peaks = bucketPeaks(windows);
    expect(peaks).toHaveLength(MAX_PEAKS);
    expect(peaks.at(-1)).toBe(1);
    expect(peaks.every(value => value > 0 && value <= 1)).toBe(true);
    expect(peaks).toEqual([...peaks].sort((a, b) => a - b));
  });
  it("returns zeros for silence and [] for no input", () => {
    expect(bucketPeaks([0, 0, 0])).toEqual([0, 0, 0]);
    expect(bucketPeaks([])).toEqual([]);
  });
});

describe("PeakAccumulator", () => {
  it("windows samples at 1/20 s and uses the absolute value", () => {
    // 8 kHz → 400 samples per window; 2.5 windows of audio → ceil(0.125 s × 20) = 3 peaks.
    const acc = new PeakAccumulator(8000);
    const samples = [...Array(400).fill(1000), ...Array(399).fill(0), -32768, ...Array(200).fill(-16384)];
    acc.push(pcm(samples));
    expect(acc.finish()).toEqual([0.031, 1, 0.5]);
  });
  it("handles samples split across chunk boundaries", () => {
    const samples = Array.from({ length: 4000 }, (_, i) => Math.round(Math.sin(i / 37) * (i % 1000) * 30));
    const whole = new PeakAccumulator(8000);
    whole.push(pcm(samples));
    const split = new PeakAccumulator(8000);
    const bytes = pcm(samples);
    for (let i = 0; i < bytes.length; i += 7) split.push(bytes.subarray(i, i + 7));
    expect(split.finish()).toEqual(whole.finish());
  });
  it("caps long recordings at 1000 peaks without keeping the PCM", () => {
    // 2 h at 8 kHz in 1 s chunks: 144k windows folded into 1000 buckets.
    const acc = new PeakAccumulator(8000);
    const quiet = pcm(Array(8000).fill(100));
    const loud = pcm(Array(8000).fill(-20000));
    for (let second = 0; second < 7200; second++) acc.push(second === 3600 ? loud : quiet);
    const peaks = acc.finish();
    expect(peaks).toHaveLength(1000);
    expect(peaks[500]).toBe(1);
    expect(peaks[0]).toBe(0.005);
  });
  it("returns [] when nothing was decoded", () => {
    expect(new PeakAccumulator().finish()).toEqual([]);
  });
});

describe("peakArgs", () => {
  it("decodes to mono 8 kHz s16le on stdout", () => {
    const args = peakArgs("out.m4a").join(" ");
    expect(args).toContain("-i out.m4a");
    expect(args).toContain("-ac 1 -ar 8000 -f s16le pipe:1");
  });
});
