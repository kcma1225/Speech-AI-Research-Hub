/**
 * Account kind. `admin` accounts are system-only (users, invitations, models, system settings) and never use the
 * research workspace; `is_admin` always equals `role === "admin"`; `is_owner` marks the initial admin (bootstrap account).
 */
export type Role = "student" | "professor" | "admin";
export type ThemePref = "system" | "light" | "dark";
export type Locale = "zh-TW" | "en";

export type Preferences = {
  notify: { slideRendered: boolean; mediaTranscoded: boolean; reviews: boolean; replies: boolean; tasks: boolean };
  editor: { fontSize: number; layout: "split" | "edit" | "preview" };
};

export type CurrentUser = {
  id: string;
  /** Real name (真實姓名), shown wherever the person appears. */
  name: string;
  /** Login id (使用者名稱), lower-case. */
  username: string;
  role: Role;
  is_admin: boolean;
  is_owner: boolean;
  auth_mode: "either" | "two_factor";
  theme: ThemePref;
  locale: Locale;
  preferences: Preferences;
};

export type ClientConfig = { latexUrl: string | null; pushPublicKey: string | null };

/** Minimal study reference embedded in other objects. */
export type StudyRef = { id: string; slug: string; title: string };

export type ActiveJob = {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string | null;
  progress: number | null;
  label: string;
  url: string | null;
  updatedAt: string;
};

export type Notification = { id: string; kind: string; title: string; body: string; url: string; read_at: string | null; created_at: string };

export type SessionRow = { id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; expires_at: string; current: boolean };
