/** Pure helpers for /admin/models: formatting, health per model, compatible targets, diagram structure. */
import { toneFor, type Tone } from "#lib/components/ui/Pill.svelte";
import type { AiRole, AiRoleState } from "./status.svelte.ts";
import type { Binding, Capability, Group, ModelCapability, ModelProfile, Provider, StatRow } from "./admin.ts";

export const ROLE_CAP: Record<AiRole, Capability> = { assistant: "chat", writing: "chat", slides: "chat", analysis: "chat", fast: "chat", embedding: "embedding", asr: "asr", asr_live: "asr" };
export const ROLE_ORDER: AiRole[] = ["assistant", "writing", "slides", "analysis", "fast", "embedding", "asr", "asr_live"];

/** 1000000 → "1M", 131072 → "131k", 8192 → "8k". */
export function tokens(n: number | undefined | null): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
export const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Every account keeps one pastel everywhere (bricks, provider blocks, chips). */
export const providerTone = (providerId: string | null | undefined): Tone => (providerId ? toneFor(providerId) : "stone");

export type Health = "up" | "down" | "unknown" | "off";

/** Health of one model: the role status (recent calls / probes) wins, else the account's last probe. */
export function modelHealth(m: ModelProfile | undefined, providers: Provider[] | null, bindings: Binding[] | null): Health {
  if (!m) return "unknown";
  const p = providers?.find(x => x.id === m.provider_id);
  if (p && !p.enabled) return "off";
  for (const b of bindings ?? []) for (const h of b.status?.detail.members ?? []) if (h.modelRef === m.id) return h.health;
  if (p?.last_probe) return p.last_probe.ok ? "up" : "down";
  return "unknown";
}

export const providerHealth = (p: Provider): Health => (!p.enabled ? "off" : !p.last_probe ? "unknown" : p.last_probe.ok ? "up" : "down");

export function statFor(stats: StatRow[] | undefined, m: ModelProfile): StatRow | undefined {
  return stats?.find(s => s.model_ref === m.id) ?? stats?.find(s => s.provider_id === m.provider_id && s.model === m.model_id);
}

/** Models usable for a capability (enabled in pickers unless `includeHidden`). */
export function modelsFor(models: ModelProfile[] | null, cap: ModelCapability, includeHidden = false): ModelProfile[] {
  return (models ?? []).filter(m => m.fields.capability === cap && (includeHidden || m.enabled) && m.provider_family === (cap === "asr" ? "asr" : "llm"));
}

/** Multimodal chat models that can transcribe audio (offered to the speech roles next to dedicated ASR models). */
export function audioModelsFor(models: ModelProfile[] | null, includeHidden = false): ModelProfile[] {
  return (models ?? []).filter(m => m.provider_family === "llm" && m.fields.capability === "chat" && m.audio?.audio === true && (includeHidden || m.enabled));
}

/** Models a group member / binding of `cap` may use: speech also takes audio-capable chat models. */
export function memberModelsFor(models: ModelProfile[] | null, cap: ModelCapability, includeHidden = false): ModelProfile[] {
  return cap === "asr" ? [...modelsFor(models, cap, includeHidden), ...audioModelsFor(models, includeHidden)] : modelsFor(models, cap, includeHidden);
}

/** Group ids reachable from `id` (itself included) — a group cannot be dropped into any of them. */
export function descendants(groups: Group[] | null, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (g: string) => {
    if (out.has(g)) return;
    out.add(g);
    for (const m of groups?.find(x => x.id === g)?.members ?? []) if (m.child_group_id) walk(m.child_group_id);
  };
  walk(id);
  return out;
}

/** Groups that (transitively) contain `id`. */
export function ancestors(groups: Group[] | null, id: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups ?? []) {
      if (out.has(g.id)) continue;
      if (g.members.some(m => m.child_group_id && (m.child_group_id === id || out.has(m.child_group_id)))) {
        out.add(g.id);
        changed = true;
      }
    }
  }
  return out;
}

export type TargetKey = `model:${string}` | `group:${string}`;
export const targetKey = (b: Binding): TargetKey | null => (b.target ? (b.target.type === "model" ? `model:${b.target.model_id}` : `group:${b.target.group_id}`) : null);

/** Diagram rows: unique targets in role order, each with the roles bound to it. Unbound roles come last. */
export function diagramRows(bindings: Binding[] | null): { rows: Array<{ key: TargetKey; roles: AiRole[] }>; unbound: AiRole[] } {
  const rows: Array<{ key: TargetKey; roles: AiRole[] }> = [];
  const unbound: AiRole[] = [];
  for (const role of ROLE_ORDER) {
    const b = bindings?.find(x => x.role === role);
    const key = b ? targetKey(b) : null;
    if (!key) {
      unbound.push(role);
      continue;
    }
    const row = rows.find(r => r.key === key);
    if (row) row.roles.push(role);
    else rows.push({ key, roles: [role] });
  }
  return { rows, unbound };
}

/** Accounts reached by a target (through nested groups), in first-seen order. */
export function providersOf(key: TargetKey, groups: Group[] | null, models: ModelProfile[] | null): string[] {
  const out: string[] = [];
  const add = (pid: string | null | undefined) => pid && !out.includes(pid) && out.push(pid);
  const seen = new Set<string>();
  const walk = (gid: string) => {
    if (seen.has(gid)) return;
    seen.add(gid);
    for (const m of groups?.find(g => g.id === gid)?.members ?? []) {
      if (m.child_group_id) walk(m.child_group_id);
      else add(models?.find(x => x.id === m.model_ref)?.provider_id ?? m.provider_id);
    }
  };
  if (key.startsWith("model:")) add(models?.find(m => m.id === key.slice(6))?.provider_id);
  else walk(key.slice(6));
  return out;
}

/** Load-balance share of each enabled member (percent, rounded). */
export function shares(members: Array<{ weight: number; enabled: boolean }>): number[] {
  const total = members.reduce((s, m) => s + (m.enabled ? Math.max(1, m.weight) : 0), 0) || 1;
  return members.map(m => (m.enabled ? Math.round((Math.max(1, m.weight) / total) * 100) : 0));
}

export const stateTone = (s: AiRoleState | Health | undefined): string =>
  s === "ok" || s === "up" ? "var(--success)" : s === "degraded" ? "var(--pill-butter-ink)" : s === "unavailable" || s === "down" ? "var(--danger)" : "color-mix(in oklab, var(--ink-3) 50%, transparent)";

/** StateDot value for a health (a disabled account shows as grey). */
export const dot = (h: Health): AiRoleState | "up" | "down" | "unknown" => (h === "off" ? "unconfigured" : h);
