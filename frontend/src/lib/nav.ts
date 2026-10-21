import type { Component } from "svelte";
import { BookOpen, Bot, Cpu, Server, FlaskConical, House, Settings, Sigma, Users, UsersRound } from "@lucide/svelte";
import type { MessageKey } from "./messages";
import type { ClientConfig, CurrentUser } from "./types";

/**
 * Shell navigation (sidebar, bottom tabs, "more" drawer, ⌘K pages).
 * `admin`: only for system admins. `external`: opens outside the SPA (href resolved by the shell).
 * Modules may append ONE entry to a list below; keep keys unique.
 */
export type NavItem = { key: string; href: string; label: MessageKey; short?: MessageKey; icon: Component; admin?: boolean; external?: boolean };

export const workspaceNav: NavItem[] = [
  { key: "overview", href: "/", label: "nav.overview", icon: House },
  { key: "studies", href: "/studies", label: "nav.studies", icon: FlaskConical },
  { key: "meetings", href: "/meetings", label: "nav.meetings", icon: UsersRound },
  { key: "library", href: "/library", label: "nav.library", short: "nav.libraryShort", icon: BookOpen },
  { key: "assistant", href: "/assistant", label: "nav.assistant", icon: Bot },
];

export const manageNav: NavItem[] = [
  { key: "latex", href: "", label: "nav.latex", icon: Sigma, external: true },
  { key: "admin", href: "/admin", label: "nav.admin", icon: Users, admin: true },
  { key: "models", href: "/admin/models", label: "nav.models", icon: Cpu, admin: true },
  { key: "system", href: "/admin/system", label: "nav.system", icon: Server, admin: true },
  { key: "settings", href: "/settings", label: "nav.settings", icon: Settings },
];

/** Whether the signed-in user sees `item` (admin-only entries, the LaTeX link only when configured). */
export function canSee(item: NavItem, user: CurrentUser | null, config: ClientConfig) {
  if (item.admin && user?.role !== "admin") return false;
  // Admin accounts are system-only: no workspace pages (and no LaTeX link).
  if (user?.role === "admin" && (workspaceNav.includes(item) || item.key === "latex")) return false;
  if (item.key === "latex") return Boolean(config.latexUrl);
  return true;
}

export const hrefOf = (item: NavItem, config: ClientConfig) => (item.key === "latex" ? (config.latexUrl ?? "") : item.href);

const matches = (href: string, pathname: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));

/** Whether `href` is the current section; a more specific nav entry (e.g. /admin/models under /admin) wins. */
export function isActive(href: string, pathname: string) {
  if (!href || !matches(href, pathname)) return false;
  return ![...workspaceNav, ...manageNav].some(item => item.href.length > href.length && item.href.startsWith(href) && matches(item.href, pathname));
}

/** Paths an admin account may open; every other app page redirects admins to /admin. */
export const ADMIN_HOME = "/admin";
export const adminMayOpen = (pathname: string) => /^\/(admin|settings)(\/|$)/.test(pathname);
