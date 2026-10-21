import type { Tone } from "#lib/components/ui/Pill.svelte";
import { t } from "#lib/i18n.svelte.ts";
import type { MessageKey } from "#lib/messages.ts";
import type { Role } from "#lib/types.ts";

export type AdminUser = {
  id: string;
  /** Real name (真實姓名). */
  name: string;
  /** Login id (使用者名稱). */
  username: string;
  role: Role;
  is_admin: boolean;
  is_owner: boolean;
  auth_mode: string;
  disabled: boolean;
  disabled_at: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type InviteState = "active" | "expired" | "exhausted" | "revoked";
export type Invitation = {
  id: string;
  role: Role;
  is_admin: boolean;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
  created_at: string;
  state: InviteState;
  uses?: { id: string; name: string; used_at: string }[];
};

/** Roles an admin can switch an existing account between (admin accounts come from invitations). */
export const grantableRoles = ["student", "professor"] as const satisfies readonly Role[];
/** Roles an invitation can create. */
export const invitableRoles = ["student", "professor", "admin"] as const satisfies readonly Role[];
export type InvitableRole = (typeof invitableRoles)[number];
export type GrantableRole = (typeof grantableRoles)[number];

export const roleTone: Record<Role, Tone> = { student: "sky", professor: "butter", admin: "lilac" };
/** Pill tone for admin accounts / the initial admin. */
export const adminTone: Tone = "lilac";
export const ownerTone: Tone = "peach";
export const roleLabel = (role: Role) => `role.${role}` as MessageKey;

export const stateTone: Record<InviteState, Tone> = { active: "mint", expired: "stone", exhausted: "sky", revoked: "rose" };

export const expiryChoices = ["5m", "30m", "1h", "2h", "5h", "1d", "3d", "5d", "7d", "never"] as const;
export type ExpiryChoice = (typeof expiryChoices)[number];

/** Count message: `<key>.one` when n is 1 (English singular), else `<key>`; `{n}` is filled in. */
export const tc = (key: MessageKey, n: number, vars: Record<string, string | number> = {}) =>
  t((n === 1 ? `${key}.one` : key) as MessageKey, { ...vars, n });
