/**
 * Pointer drag-and-drop for the routing diagram (mouse, pen and touch). A press only becomes a drag after the
 * pointer moves 6px, so clicks and menus keep working. Drop zones are found with elementsFromPoint:
 *   [data-drop="role"][data-role]          bind a role
 *   [data-drop="group"][data-group-id]     insert into a group; the index comes from its [data-slot-index] children
 * Every action has a keyboard/menu equivalent in the diagram; this is only the pointer shortcut.
 */
import type { AiRole } from "#lib/ai/status.svelte.ts";
import type { Capability } from "#lib/ai/admin.ts";

export type DragItem =
  | { kind: "member"; groupId: string; index: number; label: string; capability: Capability; modelRef: string | null; childGroupId: string | null }
  | { kind: "model"; modelId: string; label: string; capability: Capability }
  | { kind: "group"; groupId: string; label: string; capability: Capability };

export type DropTarget = { kind: "role"; role: AiRole } | { kind: "group"; groupId: string; index: number };

export class DragController {
  item = $state<DragItem | null>(null);
  x = $state(0);
  y = $state(0);
  over = $state<DropTarget | null>(null);
  valid = $state(false);
  private pending: { item: DragItem; x: number; y: number; id: number } | null = null;

  constructor(
    private readonly accept: (item: DragItem, target: DropTarget) => boolean,
    private readonly drop: (item: DragItem, target: DropTarget) => void,
  ) {}

  press(e: PointerEvent, item: DragItem) {
    if (e.button !== 0 || e.pointerType === "touch") return; // touch: menus (and the page keeps scrolling)
    if ((e.target as HTMLElement).closest("button,a,input,[role=menu],[data-no-drag]")) return;
    e.stopPropagation();
    e.preventDefault(); // no text selection while dragging
    this.pending = { item, x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  move = (e: PointerEvent) => {
    if (this.pending && !this.item) {
      if (Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) < 6) return;
      this.item = this.pending.item;
    }
    if (!this.item) return;
    e.preventDefault();
    this.x = e.clientX;
    this.y = e.clientY;
    this.over = this.hit(e.clientX, e.clientY);
    this.valid = Boolean(this.over && this.accept(this.item, this.over));
  };

  up = () => {
    const item = this.item;
    const over = this.over;
    const ok = this.valid;
    this.cancel();
    if (item && over && ok) this.drop(item, over);
  };

  cancel = () => {
    this.pending = null;
    this.item = null;
    this.over = null;
    this.valid = false;
  };

  key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.item) this.cancel();
  };

  private hit(x: number, y: number): DropTarget | null {
    for (const el of document.elementsFromPoint(x, y) as HTMLElement[]) {
      const zone = el.closest<HTMLElement>("[data-drop]");
      if (!zone) continue;
      if (zone.dataset.drop === "role" && zone.dataset.role) return { kind: "role", role: zone.dataset.role as AiRole };
      if (zone.dataset.drop === "group" && zone.dataset.groupId) {
        const slots = [...zone.querySelectorAll<HTMLElement>(":scope > [data-slot-index]")];
        let index = slots.length;
        for (const s of slots) {
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) {
            index = Number(s.dataset.slotIndex);
            break;
          }
        }
        return { kind: "group", groupId: zone.dataset.groupId, index };
      }
    }
    return null;
  }

  isOver(t: DropTarget): boolean {
    const o = this.over;
    if (!o || !this.item) return false;
    return o.kind === t.kind && (o.kind === "role" ? o.role === (t as { role: AiRole }).role : o.groupId === (t as { groupId: string }).groupId);
  }
}
