import { BookOpen, FileText, FlaskConical, NotebookPen, UsersRound } from "@lucide/svelte";
import type { Component } from "svelte";
import type { StudyPermissions } from "#lib/studies/types.ts";
import { t } from "#lib/i18n.svelte.ts";

export type NoteKind = "research" | "experiment" | "reading" | "meeting" | "custom";
export const NOTE_KINDS: NoteKind[] = ["research", "experiment", "reading", "meeting", "custom"];

export const kindIcon: Record<NoteKind, Component> = {
  research: NotebookPen,
  experiment: FlaskConical,
  reading: BookOpen,
  meeting: UsersRound,
  custom: FileText,
};
export const kindTone = { research: "sky", experiment: "mint", reading: "lilac", meeting: "peach", custom: "stone" } as const;

export type NoteTemplate = {
  id: string;
  scope: "system" | "user";
  owner_id: string | null;
  name: string;
  kind: NoteKind;
  description: string;
  body_md: string;
  ai_prompt: string;
  position: number;
  note_count: number;
};

export type NoteCard = {
  id: string;
  study_id: string;
  template_id: string | null;
  template_name: string | null;
  kind: NoteKind;
  title: string;
  excerpt: string;
  event_date: string | null;
  version: number;
  created_by: string | null;
  creator_name: string | null;
  updated_by: string | null;
  updater_name: string | null;
  created_at: string;
  updated_at: string;
  pending_suggestions: number;
};

export type Note = Omit<NoteCard, "excerpt" | "pending_suggestions"> & { content_md: string };

export type NoteDetail = {
  note: Note;
  doc_name: string;
  study: { id: string; slug: string; title: string };
  template: { id: string; name: string; kind: NoteKind; scope: string } | null;
  permissions: StudyPermissions;
};

export type NoteVersion = {
  id: string;
  version: number;
  kind: "initial" | "auto" | "manual" | "suggestion" | "autopilot" | "restore";
  label: string;
  author: "user" | "ai";
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
  size: number;
  content_md?: string;
};

/**
 * System templates are stored in zh-TW (seeded by migration 0030). While an admin has not renamed them, show their name
 * and description in the UI language; any other name is shown as stored.
 */
const SYSTEM_TEMPLATES: Record<string, { kind: Exclude<NoteKind, "custom">; description: string }> = {
  研究筆記: { kind: "research", description: "想法、觀察與進度的一般紀錄。" },
  實驗筆記: { kind: "experiment", description: "目的、設定、資料集、超參數、結果與分析。" },
  閱讀筆記: { kind: "reading", description: "論文資訊、摘要、方法、優缺點與和我研究的關係。" },
  會議筆記: { kind: "meeting", description: "會議摘要、老師回饋與待辦。" },
};

/** Display name of a template (or a note's `template_name`). */
export function templateName(name: string, scope: NoteTemplate["scope"] = "system"): string {
  const known = scope === "system" ? SYSTEM_TEMPLATES[name] : undefined;
  return known ? t(`notes.kind.${known.kind}`) : name;
}

export function templateDescription(tpl: Pick<NoteTemplate, "name" | "scope" | "description">): string {
  const known = tpl.scope === "system" ? SYSTEM_TEMPLATES[tpl.name] : undefined;
  return known && known.description === tpl.description ? t(`notes.tpl.${known.kind}.desc`) : tpl.description;
}
