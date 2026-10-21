import type { Tone } from "#lib/components/ui/Pill.svelte";
import type { MemberRole, StudyStatus } from "./types.ts";

export const statusTone: Record<StudyStatus, Tone> = { active: "mint", paused: "butter", completed: "sky", archived: "stone" };
export const memberRoleTone: Record<MemberRole, Tone> = { owner: "peach", member: "sky", advisor: "butter" };
export const STUDY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
