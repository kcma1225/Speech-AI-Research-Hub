/**
 * "Data changed" signal for pages that list workspace content: the AI (chat tool calls, workflows) writes in the
 * background, so open lists (study library, notes, tasks, decks, LaTeX, meetings) reload when a write of their kind
 * finishes — in this tab (window event) and in other tabs (BroadcastChannel). Bursts are coalesced.
 */
export type ChangeKind = "papers" | "notes" | "tasks" | "study" | "decks" | "latex" | "meetings";
export const ALL_KINDS: ChangeKind[] = ["papers", "notes", "tasks", "study", "decks", "latex", "meetings"];

const EVENT = "hub:changed";
const CHANNEL = "hub-changes";

/** Agent tools that write → the kinds of data they change. */
const TOOL_KINDS: Record<string, ChangeKind[]> = {
  import_paper: ["papers"],
  add_paper_to_study: ["papers"],
  remove_paper_from_study: ["papers"],
  update_study_paper: ["papers"],
  fetch_paper_pdf: ["papers"],
  create_note: ["notes"],
  delete_note: ["notes"],
  suggest_note_edit: ["notes"],
  create_task: ["tasks"],
  update_task: ["tasks"],
  delete_task: ["tasks"],
  add_milestone: ["study"],
  update_milestone: ["study"],
  set_stage: ["study"],
  suggest_study_summary: ["study"],
  propose_study_plan: ["study"],
  create_deck: ["decks"],
  suggest_deck_edit: ["decks"],
  latex_add_section: ["latex"],
  latex_update_project: ["latex"],
  latex_suggest_edit: ["latex"],
  add_meeting_feedback: ["meetings"],
  confirm_meeting_draft: ["meetings", "notes", "tasks"],
  suggest_meeting_draft_edit: ["meetings"],
};

/** Workflow artifact kinds → data kinds. */
const ARTIFACT_KINDS: Record<string, ChangeKind[]> = { paper: ["papers"], note: ["notes"], deck: ["decks"], latex_project: ["latex"], latex_file: ["latex"] };

export const kindsOfTool = (tool: string): ChangeKind[] => TOOL_KINDS[tool] ?? [];
export const kindsOfArtifact = (kind: string): ChangeKind[] => ARTIFACT_KINDS[kind] ?? [];

let channel: BroadcastChannel | null | undefined;
const bc = () => {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    } catch {
      channel = null;
    }
  }
  return channel;
};

let pending = new Set<ChangeKind>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Announces that data of these kinds changed (coalesced over 400 ms). */
export function emitChanged(kinds: ChangeKind[]) {
  if (typeof window === "undefined" || !kinds.length) return;
  for (const k of kinds) pending.add(k);
  if (timer) return;
  timer = setTimeout(() => {
    const detail = { kinds: [...pending] };
    pending = new Set();
    timer = null;
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
    bc()?.postMessage(detail);
  }, 400);
}

/** Calls `fn` when data of any of `kinds` changed (this tab or another); returns the unsubscribe function. */
export function onChanged(kinds: ChangeKind[], fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const want = (detail: unknown) => Array.isArray((detail as { kinds?: unknown })?.kinds) && (detail as { kinds: string[] }).kinds.some((k) => kinds.includes(k as ChangeKind));
  const local = (e: Event) => want((e as CustomEvent).detail) && fn();
  const remote = (e: MessageEvent) => want(e.data) && fn();
  window.addEventListener(EVENT, local);
  const ch = bc();
  ch?.addEventListener("message", remote);
  return () => {
    window.removeEventListener(EVENT, local);
    ch?.removeEventListener("message", remote);
  };
}
