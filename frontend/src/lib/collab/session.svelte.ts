import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { toneFor } from "#lib/components/ui/Pill.svelte";

/**
 * Client side of `/api/collab` (Hocuspocus). One WebSocket per page is shared by every open document
 * (multiplexed), opened on first use and closed with the last document.
 *
 *   const s = openCollab("note:<id>", { id, name });   // in a component; s.destroy() on unmount
 *   s.text (Y.Text "content"), s.awareness, s.status, s.synced, s.readOnly, s.peers, s.onMessage(fn)
 */
export type CollabStatus = "connecting" | "connected" | "offline" | "denied";
export type CollabPeer = { clientId: number; id: string; name: string; color: string; colorLight: string };
export type CollabIdentity = { id: string; name: string };

/** Presence colours from the user id (same pastel family as avatars and pills), valid in both themes. */
export function userColor(id: string) {
  const tone = toneFor(id);
  return { tone, color: `var(--pill-${tone}-ink)`, colorLight: `color-mix(in srgb, var(--pill-${tone}-ink) 20%, transparent)` };
}

let socket: HocuspocusProviderWebsocket | null = null;
let socketUsers = 0;

function sharedSocket() {
  if (!socket) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new HocuspocusProviderWebsocket({ url: `${proto}//${location.host}/api/collab`, delay: 1000, minDelay: 500, factor: 1.6, maxDelay: 15_000, jitter: true });
  }
  socketUsers++;
  return socket;
}
function releaseSocket() {
  socketUsers--;
  if (socketUsers <= 0 && socket) {
    socket.destroy();
    socket = null;
    socketUsers = 0;
  }
}

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly text: Y.Text = this.doc.getText("content");
  readonly provider: HocuspocusProvider;
  status = $state<CollabStatus>("connecting");
  synced = $state(false);
  /** Server granted read-only access (non-members, advisors). */
  readOnly = $state(false);
  /** Local changes not yet acknowledged by the server. */
  unsynced = $state(0);
  peers = $state<CollabPeer[]>([]);
  deniedReason = $state<string | null>(null);
  private listeners = new Set<(payload: Record<string, unknown>) => void>();
  private destroyed = false;

  constructor(readonly name: string, me: CollabIdentity) {
    const ws = sharedSocket();
    const color = userColor(me.id);
    this.provider = new HocuspocusProvider({
      websocketProvider: ws,
      name,
      document: this.doc,
      onAuthenticated: ({ scope }) => {
        this.readOnly = scope === "readonly";
        this.deniedReason = null;
      },
      onAuthenticationFailed: ({ reason }) => {
        this.status = "denied";
        this.deniedReason = reason;
      },
      onSynced: ({ state }) => (this.synced = state),
      onUnsyncedChanges: ({ number }) => (this.unsynced = number),
      onStatus: ({ status }) => {
        if (this.status === "denied" && status !== WebSocketStatus.Connected) return;
        this.status = status === WebSocketStatus.Connected ? "connected" : status === WebSocketStatus.Connecting ? "connecting" : "offline";
      },
      onStateless: ({ payload }) => {
        try {
          const data = JSON.parse(payload);
          if (data && typeof data === "object") for (const fn of this.listeners) fn(data);
        } catch {}
      },
      onAwarenessChange: ({ states }) => {
        const seen = new Set<string>();
        const peers: CollabPeer[] = [];
        for (const s of states) {
          const u = (s as { user?: { id?: string; name?: string; color?: string; colorLight?: string } }).user;
          if (!u?.id || s.clientId === this.doc.clientID || seen.has(u.id) || u.id === me.id) continue;
          seen.add(u.id);
          const c = userColor(u.id);
          peers.push({ clientId: s.clientId, id: u.id, name: String(u.name ?? "?").slice(0, 60), color: c.color, colorLight: c.colorLight });
        }
        this.peers = peers;
      },
    });
    this.provider.setAwarenessField("user", { id: me.id, name: me.name, color: color.color, colorLight: color.colorLight });
    this.provider.attach();
    if (ws.status === WebSocketStatus.Connected) this.status = "connected";
  }

  get awareness() {
    return this.provider.awareness!;
  }

  /** Stateless server messages for this document (`{type:"suggestions"}`, `{type:"meta"}`…); returns an unsubscribe. */
  onMessage(fn: (payload: Record<string, unknown>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.provider.destroy();
    this.doc.destroy();
    releaseSocket();
  }
}

export const openCollab = (name: string, me: CollabIdentity) => new CollabSession(name, me);
