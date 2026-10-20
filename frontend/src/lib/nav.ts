import type { Component } from "svelte";
import { FileText, House, Mic, Presentation, Settings, Sigma, Tags, Users } from "@lucide/svelte";
import type { MessageKey } from "./messages";
import type { Role } from "./types";

export type NavItem = { key: string; href: string; label: MessageKey; short?: MessageKey; icon: Component; roles?: Role[]; external?: boolean };

export const workspaceNav: NavItem[] = [
  { key: "overview", href: "/", label: "nav.overview", icon: House },
  { key: "slides", href: "/slides", label: "nav.slides", icon: Presentation },
  { key: "notes", href: "/notes", label: "nav.notes", short: "nav.notesShort", icon: FileText },
  { key: "recordings", href: "/recordings", label: "nav.recordings", icon: Mic },
];

export const manageNav: NavItem[] = [
  { key: "tags", href: "/tags", label: "nav.tags", icon: Tags, roles: ["owner", "admin", "member"] },
  { key: "latex", href: "", label: "nav.latex", icon: Sigma, external: true },
  { key: "admin", href: "/admin", label: "nav.admin", icon: Users, roles: ["owner"] },
  { key: "settings", href: "/settings", label: "nav.settings", icon: Settings },
];

export function isActive(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
