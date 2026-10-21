/**
 * Text helpers for collaborative documents: every document keeps its text in the Y.Text named `content`.
 * Changes coming from outside the editor (restore, accepted suggestions, imports) are applied as a minimal diff
 * to the live Y.Text — never by creating a fresh document.
 */
import { diffLines } from "diff";
import * as Y from "yjs";

/** Name of the Y.Text that holds the document text (shared by every namespace and the frontend binding). */
export const TEXT_FIELD = "content";

export const docText = (doc: Y.Doc) => doc.getText(TEXT_FIELD).toString();

/** A new Y.Doc state containing `text` (only for documents that have no Yjs state at all yet). */
export function initialState(text: string): Uint8Array {
  const doc = new Y.Doc();
  if (text) doc.getText(TEXT_FIELD).insert(0, text);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * Replaces the content of `ytext` with `next` using a line diff (unchanged lines keep their Yjs items, so remote
 * cursors and suggestion anchors in them survive). Call inside a transaction. Returns whether anything changed.
 */
export function replaceText(ytext: Y.Text, next: string): boolean {
  const current = ytext.toString();
  if (current === next) return false;
  let index = 0;
  for (const part of diffLines(current, next)) {
    if (part.removed) ytext.delete(index, part.value.length);
    else if (part.added) {
      ytext.insert(index, part.value);
      index += part.value.length;
    } else index += part.value.length;
  }
  return true;
}

// ---------------------------------------------------------------- relative positions

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

/**
 * Anchors the range [from, to) of `ytext`: `start` sticks to the first char of the range (assoc 0), `end` to the
 * last one (assoc -1), so text typed right before or after the range stays outside it. Base64-encoded
 * Y.RelativePosition (the frontend decodes the same format).
 */
export function anchorRange(ytext: Y.Text, from: number, to: number): { start: string; end: string } {
  return {
    start: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from, 0))),
    end: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to, -1))),
  };
}

/**
 * Current range of an anchored hunk, or null when an anchor cannot be resolved (its text was removed and
 * garbage-collected). For an empty range (pure insertion) text typed between the anchors makes `from > to`;
 * the insertion point is then `to`.
 */
export function resolveRange(doc: Y.Doc, anchors: { start: string; end: string }): { from: number; to: number } | null {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(anchors.start)), doc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(anchors.end)), doc);
    if (!start || !end) return null;
    return { from: start.index, to: end.index };
  } catch {
    return null;
  }
}
