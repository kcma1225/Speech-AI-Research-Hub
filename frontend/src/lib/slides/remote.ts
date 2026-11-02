/**
 * Phone remote (backend `lib/slides/remote.ts`): the player opens a host socket while it presents, the `/remote`
 * PWA opens a control socket. Both reconnect by themselves (backoff 1 → 15 s) until closed; messages from the server
 * are validated here before anyone acts on them.
 */
export type RemoteSessionInfo = { id: string; deckId: string; versionId: string; slug: string; title: string; device: string; page: number; total: number; startedAt: string; remotes: number };

/** host ← server */
export type HostEvent =
  | { type: "session"; id: string }
  | { type: "remotes"; count: number }
  | { type: "goto"; page: number }
  | { type: "step"; dir: 1 | -1 }
  | { type: "laser"; page: number; x: number; y: number; down: boolean }
  | { type: "laserOff" };
/** control ← server */
export type ControlEvent = { type: "state"; page: number; total: number; deckId: string; versionId: string; title: string; slug: string } | { type: "ended" };

const isPage = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10_000;
const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length > 4096) return null;
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hostEvent(data: unknown): HostEvent | null {
  const m = parse(data);
  if (!m) return null;
  if (m.type === "session" && isId(m.id)) return { type: "session", id: m.id };
  if (m.type === "remotes" && Number.isInteger(m.count) && (m.count as number) >= 0) return { type: "remotes", count: m.count as number };
  if (m.type === "goto" && isPage(m.page)) return { type: "goto", page: m.page };
  if (m.type === "step" && (m.dir === 1 || m.dir === -1)) return { type: "step", dir: m.dir };
  if (m.type === "laser" && isPage(m.page) && isFraction(m.x) && isFraction(m.y) && typeof m.down === "boolean") return { type: "laser", page: m.page, x: m.x, y: m.y, down: m.down };
  if (m.type === "laserOff") return { type: "laserOff" };
  return null;
}

export function controlEvent(data: unknown): ControlEvent | null {
  const m = parse(data);
  if (!m) return null;
  if (m.type === "ended") return { type: "ended" };
  if (m.type === "state" && isPage(m.page) && Number.isInteger(m.total) && isId(m.deckId) && isId(m.versionId) && typeof m.title === "string" && typeof m.slug === "string")
    return { type: "state", page: m.page, total: m.total as number, deckId: m.deckId, versionId: m.versionId, title: m.title, slug: m.slug };
  return null;
}

/** `ws(s)://<this origin>/api…` */
export const socketUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${path}`;

export type LinkState = "connecting" | "open" | "closed";

/**
 * A socket that reconnects until `close()` (or until `onClose` returns false: e.g. the session ended). Sends while
 * disconnected are dropped (the state is re-sent on open).
 */
export function liveSocket(url: string, handlers: { onMessage: (data: unknown) => void; onState?: (s: LinkState) => void; onOpen?: () => void; onClose?: (code: number) => boolean | void }) {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (closed) return;
    handlers.onState?.("connecting");
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      delay = 1000;
      handlers.onState?.("open");
      handlers.onOpen?.();
    };
    ws.onmessage = (e) => handlers.onMessage(e.data);
    ws.onclose = (e) => {
      if (socket !== ws) return;
      socket = null;
      handlers.onState?.("closed");
      if (closed || handlers.onClose?.(e.code) === false) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  connect();
  // Back online / tab visible again: reconnect now instead of waiting for the backoff.
  const now = () => {
    if (closed || socket || document.visibilityState === "hidden") return;
    clearTimeout(timer);
    delay = 1000;
    connect();
  };
  window.addEventListener("online", now);
  document.addEventListener("visibilitychange", now);
  return {
    send(payload: object) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
      socket?.close(1000);
      socket = null;
    },
  };
}

/** Phone URL of one presentation (the QR code on the computer). */
export const remoteUrl = (sessionId?: string | null) => `${location.origin}/remote${sessionId ? `/${sessionId}` : ""}`;
