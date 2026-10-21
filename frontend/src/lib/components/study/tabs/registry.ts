import type { Component } from "svelte";
import { BookMarked, FileText, LayoutDashboard, ListTodo, Presentation, Sigma, Users, UsersRound } from "@lucide/svelte";
import type { MessageKey } from "#lib/messages.ts";
import type { StudyDetail } from "#lib/studies/types.ts";

/**
 * Tabs of the study page (`/studies/<slug>?tab=<key>`). THE contract for modules:
 * - Each tab is one Svelte component file (in this folder, or the module's own folder) whose props are `StudyTabProps`.
 * - A module replaces its placeholder entry below with `load: () => import("./NotesTab.svelte")` (lazy, so heavy
 *   editors only load when the tab opens) and may add `count`. Keep the order of the spec (§6).
 * - `detail` is GET /api/studies/<slug> (study, stages, milestones, members, counts, permissions); call `reload()`
 *   after changing something it shows. Use `detail.permissions.edit` to show editing UI (members only).
 * - Deep links: backend activity/notification URLs use `/studies/<slug>?tab=<key>`; tabs may read further query
 *   params themselves (e.g. `&note=<id>`).
 */
export type StudyTabProps = { detail: StudyDetail; reload: () => Promise<void>; tab: StudyTab };

export type StudyTab = {
  key: string;
  label: MessageKey;
  icon: Component;
  load: () => Promise<{ default: Component<StudyTabProps> }>;
  /** Small count shown next to the label (null = none). */
  count?: (detail: StudyDetail) => number | null;
};

const placeholder = () => import("./StudyTabPlaceholder.svelte");

export const studyTabs: StudyTab[] = [
  { key: "overview", label: "studies.tab.overview", icon: LayoutDashboard, load: () => import("./OverviewTab.svelte") },
  { key: "tasks", label: "studies.tab.tasks", icon: ListTodo, load: () => import("./TasksTab.svelte"), count: d => d.counts.openTasks || null },
  { key: "notes", label: "studies.tab.notes", icon: FileText, load: () => import("#lib/components/notes/NotesTab.svelte") },
  { key: "papers", label: "studies.tab.papers", icon: BookMarked, load: () => import("#lib/components/library/StudyLibraryTab.svelte") },
  { key: "decks", label: "studies.tab.decks", icon: Presentation, load: () => import("#lib/components/slides/DecksTab.svelte") },
  { key: "meetings", label: "studies.tab.meetings", icon: UsersRound, load: () => import("#lib/components/meetings/MeetingsTab.svelte") },
  { key: "latex", label: "studies.tab.latex", icon: Sigma, load: () => import("#lib/components/latex/LatexTab.svelte") },
  { key: "members", label: "studies.tab.members", icon: Users, load: () => import("./MembersTab.svelte"), count: d => d.members.length },
];

export const tabByKey = (key: string | null) => studyTabs.find(tab => tab.key === key) ?? studyTabs[0]!;
