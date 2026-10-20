export type Role = "owner" | "admin" | "member" | "professor";
export type ThemePref = "system" | "light" | "dark";
export type Locale = "zh-TW" | "en";

export type Preferences = {
  notify: { slideRendered: boolean; mediaTranscoded: boolean; reviews: boolean; replies: boolean };
  editor: { fontSize: number; layout: "split" | "edit" | "preview" };
};

export type CurrentUser = {
  id: string;
  name: string;
  role: Role;
  auth_mode: "either" | "two_factor";
  theme: ThemePref;
  locale: Locale;
  preferences: Preferences;
};

export type ClientConfig = { latexUrl: string | null; pushPublicKey: string | null };

export type TagRef = { id: string; name: string };

export type Dashboard = {
  stats: { slides: number; notes: number; recordings: number; pendingReviews: number; slidesThisWeek: number; notesThisWeek: number };
  latestSlide: {
    id: string;
    title: string;
    slug: string;
    version: number;
    authorName: string | null;
    publishedAt: string;
    tags: TagRef[];
    thumbnailUrl: string | null;
    reviewCount: number;
  } | null;
  activity: { kind: "slide_version" | "note" | "recording" | "review" | "reply"; id: string; title: string; url: string; actor: { id: string; name: string } | null; at: string }[];
  pendingReviews: { reviewId: string; slideId: string; slideTitle: string; excerpt: string; authorName: string | null; createdAt: string; page: number | null }[];
  recentNotes: { id: string; title: string; excerpt: string; updatedAt: string; tags: TagRef[]; hasAudio: boolean }[];
};

export type ActiveJob = {
  id: string;
  kind: "slide_render" | "media_transcode";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string | null;
  progress: number | null;
  label: string;
  url: string;
  updatedAt: string;
};

export type Notification = { id: string; kind: "media" | "slide" | "system"; title: string; body: string; url: string; read_at: string | null; created_at: string };

export type SearchResult = {
  slides: { id: string; title: string; slug: string }[];
  notes: { id: string; title: string; excerpt: string; hasAudio: boolean }[];
  tags: { id: string; name: string; kind: "note" | "slide" }[];
};

export type SessionRow = { id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; expires_at: string; current: boolean };
