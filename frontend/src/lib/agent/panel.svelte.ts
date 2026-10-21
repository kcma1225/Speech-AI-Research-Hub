import { api } from "#lib/api.ts";
import { ChatSession } from "./chat.svelte.ts";

const KEY = "hub-assistant-panel";

function readId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let open = $state(false);
let pendingCount = $state(0);
let timer: ReturnType<typeof setInterval> | undefined;
let watchers = 0;
const session = new ChatSession("chat");

/** Global "Ask AI" slide-over: one chat session shared by every page (remembered per tab). */
export const assistantPanel = {
  get open() {
    return open;
  },
  set open(v: boolean) {
    open = v;
    if (v && !session.id && !session.loading) {
      const id = readId();
      if (id) void session.open(id).then(() => {
        if (session.error) session.reset();
      });
    }
  },
  session,
  /** Starts a fresh conversation in the panel. */
  newChat() {
    session.reset();
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  },
  remember(id: string | null) {
    try {
      if (id) sessionStorage.setItem(KEY, id);
    } catch {}
  },
  get pending() {
    return pendingCount;
  },
  async refreshPending() {
    try {
      pendingCount = (await api.get<{ count: number }>("/agent/pending")).count;
    } catch {
      // keep the last value
    }
  },
  /** Polls the pending-approval count while something shows the badge (ref-counted). */
  watch() {
    watchers++;
    if (watchers === 1) {
      void this.refreshPending();
      timer = setInterval(() => void this.refreshPending(), 20_000);
    }
    return () => {
      watchers--;
      if (!watchers && timer) clearInterval(timer);
    };
  },
};
