import { api } from "#lib/api.ts";
import type { Notification } from "#lib/types.ts";

let unread = $state(0);
let items = $state<Notification[]>([]);
let loading = $state(false);
let started = false;

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
    setInterval(() => !document.hidden && pollUnread(), 30_000);
    document.addEventListener("visibilitychange", () => !document.hidden && pollUnread());
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
    await api.post("/notifications/read", ids ? { ids } : {});
    void pollUnread();
  },
  async clear() {
    items = [];
    unread = 0;
    await api.del("/notifications", {});
  },
};
