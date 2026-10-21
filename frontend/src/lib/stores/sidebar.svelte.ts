/**
 * Desktop sidebar collapsed/expanded state, remembered on this device. Read synchronously at import so
 * the shell renders in the stored state on first paint (the SPA has no server-rendered markup to flash).
 */
const KEY = "hub-sidebar";

function readCached(): boolean {
  try {
    return localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

let collapsed = $state(readCached());

export const sidebar = {
  get collapsed() {
    return collapsed;
  },
  set collapsed(value: boolean) {
    collapsed = value;
    try {
      localStorage.setItem(KEY, value ? "collapsed" : "expanded");
    } catch {}
  },
  toggle() {
    this.collapsed = !collapsed;
  },
};

/** Ctrl/⌘+B toggles the sidebar, except where the key belongs to a text field or editor (Markdown bold). */
export function isSidebarShortcut(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b" || e.defaultPrevented) return false;
  const el = e.target instanceof Element ? e.target : null;
  return !el?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor");
}
