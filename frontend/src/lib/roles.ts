import { t } from "./i18n.svelte.ts";
import type { MessageKey } from "./messages.ts";
import type { Role } from "./types.ts";

/** "學生" / "教授" / "管理員" / "初始管理員" for an account. */
export function accountLabel(user: { role: Role; is_admin?: boolean; is_owner?: boolean }): string {
  if (user.is_owner) return t("role.owner");
  return t(`role.${user.role}` as MessageKey);
}

/** Admin accounts are system-only; they never see or use the research workspace. */
export const isAdminAccount = (user: { role: Role } | null | undefined) => user?.role === "admin";
