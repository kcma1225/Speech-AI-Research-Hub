import type { Component } from "svelte";
import { BookMarked, FileText, FlaskConical, Flag, ListTodo, Presentation, UsersRound } from "@lucide/svelte";
import type { MessageKey } from "#lib/messages.ts";
import type { SearchType } from "./types.ts";

/** Display order, icon and label of each result type. */
export const SEARCH_TYPES: { type: SearchType; icon: Component; label: MessageKey }[] = [
  { type: "study", icon: FlaskConical, label: "search.type.study" },
  { type: "note", icon: FileText, label: "search.type.note" },
  { type: "paper", icon: BookMarked, label: "search.type.paper" },
  { type: "meeting", icon: UsersRound, label: "search.type.meeting" },
  { type: "task", icon: ListTodo, label: "search.type.task" },
  { type: "milestone", icon: Flag, label: "search.type.milestone" },
  { type: "deck", icon: Presentation, label: "search.type.deck" },
];
export const typeMeta = (type: string) => SEARCH_TYPES.find(x => x.type === type) ?? SEARCH_TYPES[1]!;

/** Splits `text` into plain and highlighted parts. */
export function highlightParts(text: string, ranges: [number, number][]): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(s, text.length));
    const end = Math.min(e, text.length);
    if (end <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/** Starts a snippet shortly before its first highlight (for one-line previews where the match would be cut off). */
export function focusSnippet(text: string, ranges: [number, number][], lead = 14): { text: string; ranges: [number, number][] } {
  const first = ranges.length ? Math.min(...ranges.map(r => r[0])) : 0;
  if (first <= lead + 1) return { text, ranges };
  const cut = first - lead;
  return { text: `…${text.slice(cut)}`, ranges: ranges.filter(r => r[1] > cut).map(([s, e]) => [Math.max(s, cut) - cut + 1, e - cut + 1] as [number, number]) };
}
