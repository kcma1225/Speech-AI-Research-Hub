import { artifactKey, normalizeRef, sameArtifact, type ArtifactFocus, type ArtifactHighlight, type ArtifactRef, type OpenOptions } from "./viewer.ts";

/** What the panel shows. `nonce` changes on every open/focus request, so viewers re-apply `focus` even for the same ref. */
export type ViewerEntry = { ref: ArtifactRef; key: string; focus: ArtifactFocus; highlight: ArtifactHighlight | null; nonce: number; auto: boolean };
/** How the host lays the panel out (set by `ViewerSplit`): phones never switch to the document by themselves. */
export type ViewerLayout = "split" | "drawer" | "tabs" | "none";

const AUTO_KEY = "hub.viewer.autoOpen";
const FOLLOW_KEY = "hub.viewer.follow";
const MAX_RECENT = 20;
/** Conversations whose viewer state is kept for switching back (this page session only). */
const MAX_SAVED = 30;

/** What one conversation had open in the viewer. */
type Snapshot = { current: ViewerEntry | null; recent: ArtifactRef[]; open: boolean };

function readBool(key: string, fallback: boolean) {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

/**
 * Reactive state of the assistant's document viewer (one per tab; the /assistant page and the Ask-AI panel share it).
 * The state belongs to one conversation at a time (`bindConversation`): switching saves it and restores the other
 * conversation's own documents; a new chat starts empty. Use the functions exported by `viewer.ts`.
 */
export class ViewerStore {
  /** The panel is visible (on phones: the 「文件」 tab is active). */
  open = $state(false);
  current = $state<ViewerEntry | null>(null);
  /** Opened in this page session (beyond what the conversation lists itself), newest first. */
  recent = $state<ArtifactRef[]>([]);
  /** Bumped by `refreshArtifact`: viewers reload when their counter changes. */
  revisions = $state<Record<string, number>>({});
  /** Last change notice (「已更新」 flash). */
  updated = $state<{ key: string; at: number } | null>(null);
  /** Changes that arrived while the phone layout showed the chat. */
  unseen = $state(0);
  titles = $state<Record<string, string>>({});
  layout = $state<ViewerLayout>("none");
  private autoOpenValue = $state(readBool(AUTO_KEY, true));
  private followValue = $state(readBool(FOLLOW_KEY, true));
  private nonce = 0;
  /** Conversation the state belongs to (undefined = not bound yet, null = a new chat). */
  private owner: string | null | undefined = undefined;
  private saved = new Map<string, Snapshot>();

  /** Open documents automatically when an AI write touches them. */
  get autoOpen() {
    return this.autoOpenValue;
  }
  set autoOpen(v: boolean) {
    this.autoOpenValue = v;
    writeBool(AUTO_KEY, v);
  }
  /** 「跟隨 AI」: jump/scroll to the part that changed. */
  get follow() {
    return this.followValue;
  }
  set follow(v: boolean) {
    this.followValue = v;
    writeBool(FOLLOW_KEY, v);
  }

  isCurrent(ref: ArtifactRef | null | undefined) {
    return sameArtifact(this.current?.ref, ref);
  }
  revisionOf(ref: ArtifactRef) {
    return this.revisions[artifactKey(ref)] ?? 0;
  }
  titleOf(ref: ArtifactRef) {
    return this.titles[artifactKey(ref)] ?? ref.title ?? "";
  }
  setTitle(ref: ArtifactRef, title: string) {
    const key = artifactKey(ref);
    if (title && this.titles[key] !== title) this.titles = { ...this.titles, [key]: title };
  }

  openArtifact(input: ArtifactRef, opts: OpenOptions = {}) {
    const { ref, focus } = normalizeRef(input);
    const key = artifactKey(ref);
    const highlight = typeof opts.highlight === "string" ? { text: opts.highlight } : (opts.highlight ?? null);
    const prev = this.current?.key === key ? this.current : null;
    this.current = { ref: prev ? { ...prev.ref, ...ref } : ref, key, focus: { ...focus, ...opts.focus }, highlight, nonce: ++this.nonce, auto: !!opts.auto };
    if (ref.title) this.setTitle(ref, ref.title);
    this.remember(ref);
    if (opts.auto && this.layout === "tabs" && !this.open) this.unseen++;
    else this.open = true;
  }

  /** Reload the artifact if it is shown (or when it is shown next); applies `focus` when following the AI. */
  refreshArtifact(input: ArtifactRef, opts: { focus?: ArtifactFocus } = {}) {
    const { ref, focus } = normalizeRef(input);
    const key = artifactKey(ref);
    this.revisions = { ...this.revisions, [key]: (this.revisions[key] ?? 0) + 1 };
    const cur = this.current;
    if (cur?.key === key) {
      const next = { ...focus, ...opts.focus };
      if (this.follow && Object.keys(next).length) this.current = { ...cur, focus: next, nonce: ++this.nonce, auto: true };
      if (this.layout === "tabs" && !this.open) this.unseen++;
    }
  }

  /** An AI write touched the artifact: refresh it when shown, otherwise open it (setting 「自動開啟」). */
  changed(input: ArtifactRef, opts: { focus?: ArtifactFocus } = {}) {
    this.remember(normalizeRef(input).ref);
    if (this.isCurrent(input)) {
      this.refreshArtifact(input, opts);
      if (this.layout !== "tabs" && !this.open && this.autoOpen) this.open = true;
      return;
    }
    if (this.autoOpen) this.openArtifact(input, { focus: opts.focus, auto: true });
  }

  /** The viewer reports that its content changed (remote edit, new render): 「已更新」. */
  markUpdated(ref: ArtifactRef) {
    this.updated = { key: artifactKey(ref), at: Date.now() };
  }

  remember(ref: ArtifactRef) {
    const n = normalizeRef(ref).ref;
    this.recent = [n, ...this.recent.filter((r) => !sameArtifact(r, n))].slice(0, MAX_RECENT);
  }

  /**
   * The chat now shows conversation `id` (null = a new, unsent chat). The previous conversation's documents are
   * saved and `id`'s own are restored (none yet: empty and closed). `adopt` = `id` was just created from the new chat
   * shown so far, so what that chat opened stays.
   */
  bindConversation(id: string | null, opts: { adopt?: boolean } = {}) {
    if (this.owner === id) return;
    const prev = this.owner;
    this.owner = id;
    if (prev === undefined) return; // first chat of the page: keeps the (empty) start state
    if (prev) {
      this.saved.delete(prev);
      this.saved.set(prev, { current: this.current, recent: this.recent, open: this.open });
      if (this.saved.size > MAX_SAVED) this.saved.delete(this.saved.keys().next().value!);
    }
    if (prev === null && id && opts.adopt) return;
    const s = id ? this.saved.get(id) : undefined;
    this.current = s?.current ? { ...s.current, nonce: ++this.nonce, auto: false } : null;
    this.recent = s?.recent ?? [];
    this.open = !!s?.open && !!s.current && this.layout !== "tabs";
    this.unseen = 0;
    this.updated = null;
  }

  closeViewer() {
    this.open = false;
  }

  /** Phones: show the document tab (clears the badge). */
  showDocument() {
    if (this.current) this.open = true;
    this.unseen = 0;
  }
}

export const viewer = new ViewerStore();
