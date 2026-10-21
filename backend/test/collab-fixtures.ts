import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import * as Y from "yjs";
import { ORIGIN } from "./helpers.js";

/** Starts the app on 127.0.0.1 (port 0 = random) and returns its base URL. */
export async function listen(app: FastifyInstance, port = 0) {
  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

/** `ws` with fixed cookie/origin headers (browsers send them on the upgrade). */
function wsWithHeaders(headers: Record<string, string>) {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers });
    }
  };
}

export type TestClient = {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  doc: Y.Doc;
  text: Y.Text;
  /** Resolves with the authorized scope ("read-write" | "readonly") or rejects with the denial reason. */
  authed: Promise<string>;
  synced: () => Promise<void>;
  destroy(): void;
};

export function connect(base: string, name: string, cookie: string, options: { origin?: string; doc?: Y.Doc; delay?: number } = {}): TestClient {
  const doc = options.doc ?? new Y.Doc();
  let resolveAuth!: (scope: string) => void;
  let rejectAuth!: (reason: Error) => void;
  const authed = new Promise<string>((res, rej) => {
    resolveAuth = res;
    rejectAuth = rej;
  });
  authed.catch(() => {});
  const socket = new HocuspocusProviderWebsocket({
    url: `${base.replace(/^http/, "ws")}/api/collab`,
    WebSocketPolyfill: wsWithHeaders({ cookie, origin: options.origin ?? ORIGIN }),
    // @lifeomic/attempt needs minDelay ≤ delay (default minDelay is 1000 ms), else it never connects.
    delay: options.delay ?? 100,
    minDelay: 50,
    maxDelay: 500,
    factor: 1.5,
    jitter: false,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    onAuthenticated: ({ scope }) => resolveAuth(scope),
    onAuthenticationFailed: ({ reason }) => rejectAuth(new Error(reason)),
  });
  provider.attach();
  return {
    provider,
    socket,
    doc,
    text: doc.getText("content"),
    authed,
    synced: () => waitFor(() => provider.isSynced && !provider.hasUnsyncedChanges),
    destroy() {
      provider.destroy();
      socket.destroy();
    },
  };
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition") {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Raw upgrade attempt; resolves with the HTTP status of a refused upgrade, or 101 when it opened. */
export function tryUpgrade(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/collab`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(0));
  });
}
