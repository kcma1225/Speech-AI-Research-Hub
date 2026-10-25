/**
 * Player ↔ speaker window sync on the same computer (BroadcastChannel, same Hub origin).
 * - `page`: "I am now on page n" — the other side follows (no echo: it only re-announces real changes);
 * - `step`: the speaker asks the player to go forward/back (quarto decks step through fragments too);
 * - `hello`: a window just opened and asks the others to announce their page;
 * - `bye`: the window is closing;
 * - `laser`: the speaker's laser pointer is at (x, y) on page `page`, as fractions (0–1) of the slide's own
 *   box (see `laser.ts`); `down` while pressed. The player draws it only when it shows the same page;
 * - `laserOff`: hide the mirrored laser (pointer left the slide, laser mode off).
 */
export type SyncRole = "player" | "speaker";
export type SyncMessage =
  | { type: "page"; page: number; from: SyncRole }
  | { type: "step"; dir: 1 | -1; from: SyncRole }
  | { type: "hello"; from: SyncRole }
  | { type: "bye"; from: SyncRole }
  | { type: "laser"; page: number; x: number; y: number; down: boolean; from: SyncRole }
  | { type: "laserOff"; from: SyncRole };

type Outgoing<M = SyncMessage> = M extends SyncMessage ? Omit<M, "from"> : never;

const isPage = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10_000;
const isFraction = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

export function valid(data: unknown): data is SyncMessage {
  if (!data || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (m.from !== "player" && m.from !== "speaker") return false;
  if (m.type === "page") return isPage(m.page);
  if (m.type === "step") return m.dir === 1 || m.dir === -1;
  // Only the speaker window points; the player never sends a laser.
  if (m.type === "laser") return m.from === "speaker" && isPage(m.page) && isFraction(m.x) && isFraction(m.y) && typeof m.down === "boolean";
  return m.type === "hello" || m.type === "bye" || m.type === "laserOff";
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
    laser: (page: number, x: number, y: number, down: boolean) => post({ type: "laser", page, x, y, down }),
    laserOff: () => post({ type: "laserOff" }),
    close() {
      post({ type: "bye" });
      channel.close();
    },
  };
}
export type DeckChannel = NonNullable<ReturnType<typeof deckChannel>>;
