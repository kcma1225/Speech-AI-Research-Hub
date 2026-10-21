import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

export interface Recorded {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: Buffer;
  at: number;
}

export type Handler = (req: Recorded, res: ServerResponse) => unknown;

/** Tiny HTTP server that records every request and dispatches to `handler`. */
export async function mockServer(handler: Handler) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec: Recorded = { method: req.method ?? "GET", url: new URL(req.url ?? "/", "http://x"), headers: req.headers, body: Buffer.concat(chunks), at: Date.now() };
    requests.push(rec);
    try {
      await handler(rec, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function sendJson(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function sendText(res: ServerResponse, body: string | Buffer, type: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(body);
}

/**
 * Build a small valid PDF with Helvetica text lines. Each line: [text, fontSize, y].
 * Offsets in the xref table are computed, so pdf.js parses it without repair.
 */
export function makePdf(lines: [string, number, number][], opts: { info?: Record<string, string>; pages?: [string, number, number][][] } = {}): Buffer {
  const pages = opts.pages ?? [lines];
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objs: string[] = [];
  // 1: catalog, 2: pages, 3: font, then per page: page obj + content obj, then info
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  pages.forEach((pl, i) => {
    const content = pl.map(([t, size, y]) => `BT /F1 ${size} Tf 72 ${y} Td (${esc(t)}) Tj ET`).join("\n");
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  const infoId = 4 + pages.length * 2;
  const info = opts.info ?? {};
  objs[infoId] = `<< ${Object.entries(info).map(([k, v]) => `/${k} (${esc(v)})`).join(" ")} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
