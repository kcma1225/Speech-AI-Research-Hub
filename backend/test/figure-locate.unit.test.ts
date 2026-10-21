import { describe, expect, it } from "vitest";
import { figureRefOf, locateFigureByLayout } from "../src/lib/library/figure-locate.js";

/** A one-page two-column "paper": body text, a drawn figure with a small label, its caption, more body text. */
function paperPdf(): Buffer {
  const body = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed";
  const text = (x: number, y: number, size: number, s: string) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
  const ops: string[] = [];
  for (let i = 0; i < 6; i++) ops.push(text(56, 720 - i * 12, 10, body), text(320, 720 - i * 12, 10, body));
  ops.push("0.2 0.4 0.8 rg 70 470 200 120 re f", "0 0 0 rg", text(150, 462, 7, "time"));
  ops.push(text(56, 440, 8, "Fig. 2. Attention maps of the selected heads."), text(56, 431, 8, "White lines are the ground truth."));
  for (let i = 0; i < 8; i++) ops.push(text(56, 405 - i * 12, 10, body));
  for (let i = 0; i < 20; i++) ops.push(text(320, 640 - i * 12, 10, body));
  const stream = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("paper figure location from the page layout", () => {
  it("parses figure / table references", () => {
    expect(figureRefOf("Fig. 2: attention maps (p. 5)")).toEqual({ kind: "figure", num: 2 });
    expect(figureRefOf("Table III — main results")).toEqual({ kind: "table", num: 3 });
    expect(figureRefOf("表 2 主要結果")).toEqual({ kind: "table", num: 2 });
    expect(figureRefOf("architecture overview")).toBeNull();
  });

  it("crops the drawing above the caption: no body text, no caption", async () => {
    const r = await locateFigureByLayout(paperPdf(), 1, "Fig. 2: attention maps");
    expect(r).not.toBeNull();
    const b = r!.box;
    // Drawing 470–590 pt (+ label at 462) of a 792 pt page, left column only.
    expect(b.top).toBeGreaterThan(1 - 600 / 792 - 0.01);
    expect(b.top).toBeLessThan(1 - 585 / 792);
    expect(b.bottom).toBeGreaterThan(1 - 462 / 792);
    expect(b.bottom).toBeLessThan(1 - 448 / 792 + 0.005);
    expect(b.left).toBeGreaterThan(0.08);
    expect(b.right).toBeLessThan(0.5);
    expect(r!.caption).toContain("Attention maps");
    expect(await locateFigureByLayout(paperPdf(), 1, "Fig. 7")).toBeNull();
  });
});
