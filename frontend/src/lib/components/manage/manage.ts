import type { Tone } from "#lib/components/ui/Pill.svelte";
import type { MessageKey } from "#lib/messages.ts";
import type { Role } from "#lib/types.ts";

export type TagKind = "note" | "slide";
export type ManagedTag = { id: string; name: string; count: number };

export type AdminUser = {
  id: string;
  name: string;
  role: Role;
  auth_mode: string;
  disabled: boolean;
  disabled_at: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type InviteState = "active" | "expired" | "exhausted" | "revoked";
export type Invitation = {
  id: string;
  role: Exclude<Role, "owner">;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
  created_at: string;
  state: InviteState;
  uses?: { id: string; name: string; used_at: string }[];
};

export const grantableRoles = ["member", "admin", "professor"] as const satisfies readonly Role[];
export type GrantableRole = (typeof grantableRoles)[number];

export const roleTone: Record<Role, Tone> = { owner: "peach", admin: "lilac", member: "sky", professor: "butter" };
export const roleLabel = (role: Role) => `role.${role}` as MessageKey;

export const stateTone: Record<InviteState, Tone> = { active: "mint", expired: "stone", exhausted: "sky", revoked: "rose" };

export const expiryChoices = ["5m", "30m", "1h", "2h", "5h", "1d", "3d", "5d", "7d", "never"] as const;
export type ExpiryChoice = (typeof expiryChoices)[number];

/** API base and the list page a tag filter links to, per namespace. */
export const tagNamespaces: Record<TagKind, { api: string; list: string; label: MessageKey; count: MessageKey; confirm: MessageKey }> = {
  note: { api: "/tags", list: "/notes", label: "manage.tags.tab.note", count: "manage.tags.count.note", confirm: "manage.tags.confirmNote" },
  slide: { api: "/slide-tags", list: "/slides", label: "manage.tags.tab.slide", count: "manage.tags.count.slide", confirm: "manage.tags.confirmSlide" },
};
