import type { Component } from "svelte";
import {
  BookOpen, BookOpenText, BookPlus, FileDown, ScanEye, BookX, Brain, FilePen, FilePlus, FileText, Flag, FolderKanban, Gauge, Globe, ListChecks, ListPlus, ListTodo, Milestone, Presentation,
  Search, Sparkles, Trash2, Wrench, LayoutTemplate, GalleryVertical,
} from "@lucide/svelte";
import { i18n } from "#lib/i18n.svelte.ts";
import type { ToolCall, ToolLink } from "./types.ts";
import { t } from "#lib/i18n.svelte.ts";

const ICONS: Record<string, Component> = {
  list_studies: FolderKanban,
  get_study: FolderKanban,
  get_study_progress: Gauge,
  list_notes: FileText,
  get_note: FileText,
  create_note: FilePlus,
  suggest_note_edit: FilePen,
  suggest_study_summary: FilePen,
  delete_note: Trash2,
  list_tasks: ListTodo,
  create_task: ListPlus,
  update_task: ListChecks,
  delete_task: Trash2,
  add_milestone: Flag,
  set_stage: Milestone,
  list_papers: BookOpen,
  get_paper: BookOpen,
  search_papers_online: Globe,
  import_paper: BookPlus,
  add_paper_to_study: BookPlus,
  remove_paper_from_study: BookX,
  search: Search,
  list_decks: Presentation,
  get_deck: Presentation,
  create_deck: Presentation,
  get_deck_pages: GalleryVertical,
  review_deck_layout: LayoutTemplate,
  review_latex_layout: LayoutTemplate,
  read_paper: BookOpenText,
  view_paper_pages: ScanEye,
  fetch_paper_pdf: FileDown,
  suggest_deck_edit: FilePen,
  remember: Brain,
  propose_study_plan: Sparkles,
};

export const toolIcon = (name: string): Component => ICONS[name] ?? (name.startsWith("delete_") || name.startsWith("remove_") ? Trash2 : Wrench);
export const toolTitle = (c: Pick<ToolCall, "title" | "title_en">) => (i18n.locale === "en" ? c.title_en : c.title);

/** Visual risk class of a card: memory and outbound get their own badges. */
export function cardKind(c: ToolCall): "write" | "destructive" | "memory" | "outbound" {
  if (c.always_ask || c.tool === "remember") return "memory";
  if (c.risk === "destructive") return "destructive";
  if (c.approval_reason === "outbound") return "outbound";
  return "write";
}

/** One-line argument summary for timeline rows (no raw JSON). */
export function argsSummary(c: ToolCall): string {
  const a = c.args ?? {};
  const pick = ["query", "q", "title", "content", "identifier", "section", "stage", "status"].map((k) => a[k]).find((v) => typeof v === "string" && v);
  if (!pick && Array.isArray(a.pages) && a.pages.length) return `p. ${a.pages.slice(0, 6).join(", ")}`;
  return typeof pick === "string" ? (pick.length > 60 ? `${pick.slice(0, 60)}…` : pick) : "";
}

export const isFinal = (c: ToolCall) => ["done", "failed", "denied", "cancelled", "expired"].includes(c.status);

/** Strips memory citation markers (〔記憶 N〕) the model adds for the server. */
export const stripMarkers = (text: string) => text.replace(/\s?[〔[【]\s*記憶\s*#?\s*\d{1,3}\s*[〕\]】]/g, "");

/** Remote images are never loaded in chat (prompt-injection egress): `![alt](https://…)` becomes a plain link. */
export const safeChatMarkdown = (text: string) => stripMarkers(text).replace(/!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/gi, (_m, alt, url) => `[${alt || "image"} ↗](${url})`);

/** Localised label for links produced by tools (entity titles are kept as they are). */
export function linkLabel(link: ToolLink): string {
  if (link.kind === "suggestion") {
    if (link.url.includes("suggestion=")) {
      if (link.url.includes("/notes/")) return t("agent.tool.viewSuggestion");
      // Study summary suggestions link to the study page itself; decks and LaTeX keep the tool's own label.
      return /^\/studies\/[^/?]+\?/.test(link.url) ? t("agent.tool.viewSummarySuggestion") : link.label;
    }
    return t("agent.tool.autoApplied");
  }
  if (link.kind === "memory") return t("agent.memoryManage");
  if (link.kind === "study" && link.label === "已自動套用到研究簡述") return t("agent.tool.autoAppliedSummary");
  return link.label;
}
