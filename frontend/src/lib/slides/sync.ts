/**
 * Player ↔ speaker window sync on the same computer (BroadcastChannel, same Hub origin).
 * - `page`: "I am now on page n" — the other side follows (no echo: it only re-announces real changes);
 * - `step`: the speaker asks the player to go forward/back (quarto decks step through fragments too);
 * - `hello`: a window just opened and asks the others to announce their page;
 * - `bye`: the window is closing.
 */
export type SyncRole = "player" | "speaker";
export type SyncMessage =
  | { type: "page"; page: number; from: SyncRole }
  | { type: "step"; dir: 1 | -1; from: SyncRole }
  | { type: "hello"; from: SyncRole }
  | { type: "bye"; from: SyncRole };

type Outgoing<M = SyncMessage> = M extends SyncMessage ? Omit<M, "from"> : never;

function valid(data: unknown): data is SyncMessage {
  if (!data || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (m.from !== "player" && m.from !== "speaker") return false;
  if (m.type === "page") return Number.isInteger(m.page) && (m.page as number) >= 1 && (m.page as number) <= 10_000;
  if (m.type === "step") return m.dir === 1 || m.dir === -1;
  return m.type === "hello" || m.type === "bye";
}

/** Channel scoped to one deck version. Returns null where BroadcastChannel is unsupported. */
export function deckChannel(slug: string, versionId: string, role: SyncRole, onMessage: (message: SyncMessage) => void) {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(`hub-slides:${slug}:${versionId}`);
  channel.onmessage = event => valid(event.data) && event.data.from !== role && onMessage(event.data);
  const post = (message: Outgoing) => {
    try {
      channel.postMessage({ ...message, from: role });
    } catch {}
  };
  return {
    page: (page: number) => post({ type: "page", page }),
    step: (dir: 1 | -1) => post({ type: "step", dir }),
    hello: () => post({ type: "hello" }),
    close() {
      post({ type: "bye" });
      channel.close();
    },
  };
}
export type DeckChannel = NonNullable<ReturnType<typeof deckChannel>>;
