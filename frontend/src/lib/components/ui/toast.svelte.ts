export type Toast = { id: number; message: string; tone: "default" | "success" | "error" };
let items = $state<Toast[]>([]);
let next = 1;

export const toasts = {
  get items() {
    return items;
  },
  show(message: string, tone: Toast["tone"] = "default", ms = 3200) {
    const id = next++;
    items = [...items, { id, message, tone }].slice(-3);
    setTimeout(() => this.dismiss(id), ms);
  },
  dismiss(id: number) {
    items = items.filter(t => t.id !== id);
  },
};
