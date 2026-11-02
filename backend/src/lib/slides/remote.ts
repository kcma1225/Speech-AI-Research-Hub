import { randomUUID } from "node:crypto";

/**
 * Phone remote for a presentation (`/remote` PWA ↔ the player on the computer), relayed by the backend: the player
 * opens a **host** socket while it presents; the phone opens a **control** socket to one of the signed-in account's
 * host sessions. Sessions live in this process's memory (one backend container): a restart ends them and both sides
 * reconnect / re-list.
 *
 * Messages (JSON text frames, ≤ 512 bytes):
 *   host → server:    `state {page, total}`
 *   server → host:    `session {id}` · `remotes {count}` · `goto {page}` · `step {dir}` · `laser {page,x,y,down}` · `laserOff`
 *   control → server: `goto {page}` · `step {dir: 1|-1}` · `laser {page, x, y, down}` (slide fractions, laser.ts) · `laserOff`
 *   server → control: `state {page, total, deckId, versionId, title, slug}` · `ended`
 * Everything is validated here; the player validates again before acting.
 */

export type RemoteSocket = { send(data: string): void; close(code?: number, reason?: string): void; readonly readyState: number; readonly OPEN: number };
export type HostInfo = { deckId: string; versionId: string; slug: string; title: string; device: string };
export type RemoteSession = HostInfo & {
  id: string;
  userId: string;
  page: number;
  total: number;
  startedAt: string;
  host: RemoteSocket;
  controls: Set<RemoteSocket>;
};
/** What the phone lists (no sockets). */
export type SessionSummary = Omit<RemoteSession, "host" | "controls" | "userId"> & { remotes: number };

export type ControlCommand =
  | { type: "goto"; page: number }
  | { type: "step"; dir: 1 | -1 }
  | { type: "laser"; page: number; x: number; y: number; down: boolean }
  | { type: "laserOff" };

export const REMOTE_MAX_MESSAGE = 512;
/** Host sessions per account (a presenter has one or two windows; more is a leak or abuse). */
export const MAX_SESSIONS_PER_USER = 8;
/** Phones per session. */
export const MAX_CONTROLS = 4;

const isPage = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10_000;
const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function parse(raw: string): Record<string, unknown> | null {
  if (raw.length > REMOTE_MAX_MESSAGE) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A phone's command, or null when it is not one. */
export function parseControl(raw: string): ControlCommand | null {
  const m = parse(raw);
  if (!m) return null;
  if (m.type === "goto" && isPage(m.page)) return { type: "goto", page: m.page };
  if (m.type === "step" && (m.dir === 1 || m.dir === -1)) return { type: "step", dir: m.dir };
  if (m.type === "laser" && isPage(m.page) && isFraction(m.x) && isFraction(m.y) && typeof m.down === "boolean") return { type: "laser", page: m.page, x: m.x, y: m.y, down: m.down };
  if (m.type === "laserOff") return { type: "laserOff" };
  return null;
}

/** The host's state report, or null. `total` 0 = not known yet (a live deck before Reveal reported it). */
export function parseHostState(raw: string): { page: number; total: number } | null {
  const m = parse(raw);
  if (!m || m.type !== "state" || !isPage(m.page)) return null;
  const total = Number.isInteger(m.total) && (m.total as number) >= 0 && (m.total as number) <= 10_000 ? (m.total as number) : 0;
  return { page: m.page, total };
}

/** Short device label from a User-Agent (shown in the phone's list: which computer is presenting). */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? "";
  const os = /Windows/i.test(s) ? "Windows" : /Mac OS X|Macintosh/i.test(s) ? "Mac" : /CrOS/i.test(s) ? "ChromeOS" : /Android/i.test(s) ? "Android" : /iPhone|iPad/i.test(s) ? "iOS" : /Linux/i.test(s) ? "Linux" : "";
  const browser = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" · ") || "瀏覽器";
}

/** Laser frames per second a phone may send (a finger on a phone screen reports ~60–120 Hz). */
const LASER_PER_SECOND = 60;

export class RemoteHub {
  private sessions = new Map<string, RemoteSession>();
  private laserBudget = new WeakMap<RemoteSocket, { at: number; n: number }>();

  private send(socket: RemoteSocket, payload: object) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // a socket closing mid-send: its close handler cleans up
      }
    }
  }

  /** Sessions of one account, newest first. */
  list(userId: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ host: _h, controls, userId: _u, ...rest }) => ({ ...rest, remotes: controls.size }));
  }

  get(id: string): RemoteSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** A player starts presenting. null when the account already has too many sessions. */
  open(userId: string, info: HostInfo, host: RemoteSocket): RemoteSession | null {
    if ([...this.sessions.values()].filter((s) => s.userId === userId).length >= MAX_SESSIONS_PER_USER) return null;
    const session: RemoteSession = { ...info, id: randomUUID(), userId, page: 1, total: 0, startedAt: new Date().toISOString(), host, controls: new Set() };
    this.sessions.set(session.id, session);
    this.send(host, { type: "session", id: session.id });
    return session;
  }

  /** The host reported where it is: every phone follows. */
  hostMessage(session: RemoteSession, raw: string) {
    const state = parseHostState(raw);
    if (!state) return;
    session.page = state.page;
    if (state.total) session.total = state.total;
    for (const c of session.controls) this.send(c, this.stateOf(session));
  }

  /** The player stopped presenting: phones are told, the session disappears. */
  close(session: RemoteSession) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    for (const c of session.controls) {
      this.send(c, { type: "ended" });
      try {
        c.close(1000, "ended");
      } catch {}
    }
    session.controls.clear();
  }

  /** A phone takes control. false when the session is full. */
  attach(session: RemoteSession, control: RemoteSocket): boolean {
    if (session.controls.size >= MAX_CONTROLS) return false;
    session.controls.add(control);
    this.send(control, this.stateOf(session));
    this.send(session.host, { type: "remotes", count: session.controls.size });
    return true;
  }

  detach(session: RemoteSession, control: RemoteSocket) {
    if (!session.controls.delete(control)) return;
    this.send(session.host, { type: "remotes", count: session.controls.size });
  }

  /** A phone's command → the host (validated; laser frames rate-limited). */
  controlMessage(session: RemoteSession, control: RemoteSocket, raw: string) {
    const cmd = parseControl(raw);
    if (!cmd) return;
    if (cmd.type === "laser") {
      const now = Date.now();
      const b = this.laserBudget.get(control) ?? { at: now, n: 0 };
      if (now - b.at >= 1000) {
        b.at = now;
        b.n = 0;
      }
      this.laserBudget.set(control, b);
      // Excess frames are dropped (`laserOff` is its own message and always goes through).
      if (++b.n > LASER_PER_SECOND) return;
    }
    this.send(session.host, cmd);
  }

  private stateOf(s: RemoteSession) {
    return { type: "state", page: s.page, total: s.total, deckId: s.deckId, versionId: s.versionId, title: s.title, slug: s.slug };
  }

  /** Server shutdown: end every session. */
  closeAll() {
    for (const s of [...this.sessions.values()]) {
      this.close(s);
      try {
        s.host.close(1001, "shutdown");
      } catch {}
    }
  }
}
