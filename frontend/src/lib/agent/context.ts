import type { PageContext } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Page context from the current URL (study / note / deck / meeting / paper), sent with each message as a hint. */
export function pageContextFrom(url: { pathname: string; searchParams: { get(name: string): string | null } }): PageContext | null {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const ctx: PageContext = { path: url.pathname };
  if (parts[0] === "studies" && parts[1] && parts[1] !== "new") {
    ctx.studySlug = parts[1];
    if (parts[2] === "notes" && parts[3] && UUID.test(parts[3])) ctx.noteId = parts[3];
    if (parts[2] === "decks" && parts[3] && UUID.test(parts[3])) {
      ctx.deckId = parts[3];
      const p = Number(url.searchParams.get("p") ?? url.searchParams.get("page"));
      if (Number.isInteger(p) && p > 0) ctx.page = p;
    }
  }
  if (parts[0] === "meetings" && parts[1] && UUID.test(parts[1])) ctx.meetingId = parts[1];
  const paper = url.searchParams.get("paper");
  if (paper && UUID.test(paper)) ctx.paperId = paper;
  if (parts[0] === "assistant") return null;
  return ctx;
}

/** Short label of a context for the composer chip. */
export function contextLabel(ctx: PageContext | null): string | null {
  if (!ctx) return null;
  if (ctx.noteId) return "note";
  if (ctx.deckId) return "deck";
  if (ctx.meetingId) return "meeting";
  if (ctx.paperId) return "paper";
  if (ctx.studySlug) return "study";
  return null;
}
