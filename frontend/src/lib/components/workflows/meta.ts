import type { Component } from "svelte";
import { Bot, Code, Combine, ListTree, Palette, PenLine, Search, ShieldCheck } from "@lucide/svelte";
import type { Tone } from "#lib/components/ui/Pill.svelte";
import type { StepRole, WorkflowStatus } from "#lib/workflows/types.ts";

export const ROLE_ICON: Record<StepRole | "orchestrator", Component> = {
  planner: ListTree,
  researcher: Search,
  writer: PenLine,
  designer: Palette,
  coder: Code,
  verifier: ShieldCheck,
  integrator: Combine,
  orchestrator: Bot,
};

export const STATUS_TONE: Record<WorkflowStatus, Tone> = {
  planning: "sky",
  awaiting_plan_approval: "butter",
  running: "sky",
  verifying: "lilac",
  awaiting_input: "butter",
  paused: "stone",
  done: "mint",
  partial: "peach",
  failed: "rose",
  cancelled: "stone",
};

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
