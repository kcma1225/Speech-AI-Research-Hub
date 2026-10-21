import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { SLIDE_METRICS, type SlideMetrics } from "../src/layout-metrics.js";

// Needs a Chrome binary: TEST_CHROME_BIN=/path/to/chrome npm test (the worker image has /opt/chrome).
const chrome = process.env.TEST_CHROME_BIN;

const page = (section: string) => `<!doctype html><html><body style="margin:0">
<div class="reveal" style="width:1280px;height:800px;font-size:26px"><div class="slides"><section id="s" style="width:1280px;height:800px;position:relative">${section}</section></div></div>
<script>window.Reveal = { getCurrentSlide: () => document.getElementById("s"), getConfig: () => ({ width: 1280, height: 800 }) };</script></body></html>`;

describe.skipIf(!chrome)("layout metrics (browser)", () => {
  it("measures words, bullets, fonts, overflow, visuals and raw diagram code", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lm-"));
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: dir, args: ["--no-sandbox"] });
    try {
      const view = await browser.newPage();
      await view.setViewport({ width: 1280, height: 800 });
      await view.setContent(page(`<h2 style="font-size:40px">Title here</h2><ul><li>one two</li><li style="font-size:12px">中文四字</li></ul>
        <pre><code>flowchart LR\n  A --> B</code></pre><div style="height:900px"></div><img style="width:300px;height:100px" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
        <aside class="notes">notes are not counted at all here</aside>`));
      const m = (await view.evaluate(SLIDE_METRICS)) as SlideMetrics;
      expect(m.bullets).toBe(2);
      expect(m.minFont).toBe(12);
      expect(m.maxFont).toBe(40);
      expect(m.rawDiagramCode).toBe(1);
      expect(m.overflowY).toBeGreaterThan(100);
      expect(m.visuals).toBe(1);
      expect(m.words).toBeGreaterThanOrEqual(8);
      expect(m.words).toBeLessThan(14);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("flags SVG labels outside their node box, small diagram text and a large empty body band", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lm-"));
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: dir, args: ["--no-sandbox"] });
    try {
      const view = await browser.newPage();
      await view.setViewport({ width: 1280, height: 800 });
      const svgImg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200" viewBox="0 0 1000 200"><rect width="1000" height="200" fill="#eee"/></svg>');
      await view.setContent(page(`<h2 style="font-size:40px;margin:0">Title</h2>
        <svg id="mermaid-1" width="600" height="120" viewBox="0 0 600 120"><g class="node"><rect x="10" y="10" width="80" height="40"/><text x="14" y="36" font-size="18">A label that is far too long</text></g>
        <g class="node"><rect x="200" y="10" width="200" height="40"/><text x="210" y="36" font-size="18">fits</text></g></svg>
        <img data-font="18" style="width:500px" src="data:image/svg+xml,${svgImg}">`));
      await view.waitForFunction(() => (document.querySelector("img") as HTMLImageElement).complete);
      const m = (await view.evaluate(SLIDE_METRICS)) as SlideMetrics;
      expect(m.textOverflow).toBe(1);
      expect(m.overflowLabels?.[0]).toContain("far too long");
      // 18 px drawn at half its natural width → 9 px on the slide.
      expect(m.minVisualFont).toBe(9);
      expect(m.emptyBand).toBeGreaterThan(0.4);
      expect(m.contentBottom).toBeLessThan(0.6);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
