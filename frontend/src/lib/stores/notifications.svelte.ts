import { api } from "#lib/api.ts";
import type { Notification } from "#lib/types.ts";

let unread = $state(0);
let items = $state<Notification[]>([]);
let loading = $state(false);
let started = false;
let interval: ReturnType<typeof setInterval> | undefined;
const onVisible = () => !document.hidden && pollUnread();

async function pollUnread() {
  try {
    unread = (await api.get<{ count: number }>("/notifications/unread")).count;
  } catch {}
}

export const notificationsStore = {
  get unread() {
    return unread;
  },
  get items() {
    return items;
  },
  get loading() {
    return loading;
  },
  start() {
    if (started) return;
    started = true;
    void pollUnread();
    interval = setInterval(() => !document.hidden && pollUnread(), 30_000);
    document.addEventListener("visibilitychange", onVisible);
  },
  /** On logout: stop polling and forget the previous account's notifications. */
  stop() {
    started = false;
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    items = [];
    unread = 0;
  },
  async load() {
    loading = true;
    try {
      items = (await api.get<{ notifications: Notification[] }>("/notifications")).notifications;
    } finally {
      loading = false;
    }
  },
  async markRead(ids?: string[]) {
    const now = new Date().toISOString();
    items = items.map(n => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n));
    unread = items.filter(n => !n.read_at).length;
    await api.post("/notifications/read", ids ? { ids } : {}).catch(() => {});
    void pollUnread();
  },
  async clear() {
    const before = items;
    items = [];
    unread = 0;
    // Put the list back if the server refused, so nothing silently disappears.
    await api.del("/notifications", {}).catch(error => {
      items = before;
      void pollUnread();
      throw error;
    });
  },
};
