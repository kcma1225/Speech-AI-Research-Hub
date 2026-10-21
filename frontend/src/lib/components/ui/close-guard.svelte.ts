import { getContext, setContext } from "svelte";

/**
 * Unsaved-changes guard for modal forms (ui/Sheet, library/WideSheet). User dismissals (backdrop, Esc, the X button)
 * go through `request()`; while the form is dirty that opens a confirm instead of closing. Programmatic closes
 * (the parent setting `open = false` after a save) never pass through here, so they never prompt.
 *
 * Dirty is the explicit `dirty` the form passes when it tracks state itself, else "the user edited something inside":
 * native `input`/`change` events bubbling from the content, plus custom inputs (Select, Switch, Segmented,
 * DatePicker, FileDrop) that report through `markFormDirty()` since their widgets don't emit those events.
 */
export class CloseGuard {
  /** Set by user edits inside the sheet since it last opened. */
  touched = $state(false);
  /** The "discard changes?" confirm is showing. */
  confirming = $state(false);

  readonly #config: () => { guard: boolean; dirty: boolean | undefined; busy: boolean };

  constructor(config: () => { guard: boolean; dirty: boolean | undefined; busy: boolean }) {
    this.#config = config;
  }

  get dirty() {
    const { guard, dirty, busy } = this.#config();
    return guard && (busy || (dirty ?? this.touched));
  }

  /** Called when the sheet opens: a fresh form starts clean. */
  reset() {
    this.touched = false;
    this.confirming = false;
  }

  markDirty = () => {
    if (!this.touched) this.touched = true;
  };

  /** A native `input`/`change` event from inside the content; search boxes and fields under `data-guard-ignore` don't count. */
  onFieldEvent = (e: Event) => {
    const target = e.target as Partial<Element> | null;
    if (typeof target?.closest === "function" && target.closest(IGNORED)) return;
    this.markDirty();
  };

  /** A user tried to dismiss. Returns true when the caller should let the close happen. */
  request(): boolean {
    if (!this.dirty) return true;
    this.confirming = true;
    return false;
  }

  /** "Discard changes": the caller closes the sheet. */
  discard() {
    this.confirming = false;
    this.touched = false;
  }
}

const IGNORED = '[data-guard-ignore], input[type="search"]';
const key = Symbol("close-guard");

export function provideCloseGuard(guard: CloseGuard) {
  setContext(key, guard.markDirty);
}

/** For custom inputs: returns a function to call on every user change so an enclosing guarded sheet counts as dirty. */
export function markFormDirty(): () => void {
  return getContext<(() => void) | undefined>(key) ?? noop;
}

function noop() {}
