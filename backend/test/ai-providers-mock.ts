/** Local mock HTTP server for AI codec tests (replays recorded-shape vendor responses). */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage["headers"];
  text: string;
  json: any;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON object, string, or chunks written with a small delay between them. */
  body?: unknown;
  chunks?: Array<string | Uint8Array>;
  delayMs?: number;
}

type Handler = (req: MockRequest) => MockResponse | Promise<MockResponse>;

export class MockServer {
  private server: Server;
  private routes: Array<{ method: string; match: string | RegExp; handler: Handler; once: boolean }> = [];
  readonly requests: MockRequest[] = [];
  url = "";

  constructor() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://mock");
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const mreq: MockRequest = { method: req.method ?? "GET", path: url.pathname, url, headers: req.headers, text, json };
      this.requests.push(mreq);
      const idx = this.routes.findIndex((r) => r.method === mreq.method && (typeof r.match === "string" ? r.match === mreq.path : r.match.test(mreq.path)));
      if (idx < 0) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no mock for ${mreq.method} ${mreq.path}` } }));
        return;
      }
      const route = this.routes[idx]!;
      if (route.once) this.routes.splice(idx, 1);
      const out = await route.handler(mreq);
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      const headers: Record<string, string> = { ...out.headers };
      if (out.chunks) {
        headers["content-type"] ??= "text/event-stream";
        res.writeHead(out.status ?? 200, headers);
        for (const c of out.chunks) {
          res.write(c);
          await new Promise((r) => setTimeout(r, 2));
        }
        res.end();
        return;
      }
      const body = typeof out.body === "string" ? out.body : out.body === undefined ? "" : JSON.stringify(out.body);
      headers["content-type"] ??= typeof out.body === "string" ? "text/plain" : "application/json";
      res.writeHead(out.status ?? 200, headers).end(body);
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  on(method: string, match: string | RegExp, handler: Handler | MockResponse, once = false) {
    this.routes.push({ method, match, handler: typeof handler === "function" ? handler : () => handler, once });
    return this;
  }

  once(method: string, match: string | RegExp, handler: Handler | MockResponse) {
    return this.on(method, match, handler, true);
  }

  reset() {
    this.routes = [];
    this.requests.length = 0;
  }

  last() {
    return this.requests[this.requests.length - 1]!;
  }
}

/** SSE body helpers. */
export const sse = (objs: unknown[], done = true) => [...objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`), ...(done ? ["data: [DONE]\n\n"] : [])];
export const sseNamed = (objs: Array<[string, unknown]>) => objs.map(([e, o]) => `event: ${e}\ndata: ${JSON.stringify(o)}\n\n`);
export const ndjsonLines = (objs: unknown[]) => objs.map((o) => `${JSON.stringify(o)}\n`);

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
