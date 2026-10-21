/**
 * External-service settings of the library (system_settings, managed on /admin/system → 文獻服務) and the
 * LibraryService built from them. API keys are encrypted with PROVIDER_TOKEN_KEY (AES-256-GCM, AAD
 * `system_settings:<key>`) and never returned unmasked. The contact email is the only address sent to external
 * APIs (Crossref mailto, User-Agent); it is never derived from a user account.
 */
import type { Queryable } from "../../db.js";
import { decryptJson, encryptJson } from "../../ai/platform/crypto.js";
import { deleteSetting, getSetting, setSetting } from "../settings.js";
import { createLibraryService, type LibraryConfig, type LibraryService } from "./service.js";

export const LIBRARY_SETTING_KEYS = {
  contactEmail: "library.contact_email",
  unpaywallEmail: "library.unpaywall_email",
  grobidUrl: "library.grobid_url",
  openalexKey: "library.openalex_api_key",
  s2Key: "library.s2_api_key",
  zoteroKey: "library.zotero_api_key",
  zoteroLibrary: "library.zotero_library",
} as const;

type SecretName = "openalexKey" | "s2Key" | "zoteroKey";
type Encrypted = { enc: string; last4: string };

const aad = (key: string) => `system_settings:${key}`;

export type LibrarySettings = {
  contactEmail: string | null;
  unpaywallEmail: string | null;
  grobidUrl: string | null;
  openalexKey: string | null;
  s2Key: string | null;
  zoteroKey: string | null;
  /** Lab Zotero library read with `zoteroKey` (e.g. the lab group). */
  zoteroLibrary: { type: "user" | "group"; id: string; name?: string } | null;
};

/** Masked view for the admin UI. */
export type LibrarySettingsView = {
  contact_email: string | null;
  unpaywall_email: string | null;
  grobid_url: string | null;
  openalex_api_key: { set: boolean; last4: string | null };
  s2_api_key: { set: boolean; last4: string | null };
  zotero_api_key: { set: boolean; last4: string | null };
  zotero_library: LibrarySettings["zoteroLibrary"];
};

async function readSecret(db: Queryable, name: SecretName): Promise<{ value: string | null; last4: string | null }> {
  const key = LIBRARY_SETTING_KEYS[name];
  const v = await getSetting<Encrypted>(db, key);
  if (!v?.enc) return { value: null, last4: null };
  try {
    return { value: decryptJson<string>(Buffer.from(v.enc, "base64"), aad(key)), last4: v.last4 };
  } catch {
    return { value: null, last4: v.last4 };
  }
}

export async function loadLibrarySettings(db: Queryable): Promise<LibrarySettings> {
  const [contactEmail, unpaywallEmail, grobidUrl, zoteroLibrary, oa, s2, zot] = await Promise.all([
    getSetting<string>(db, LIBRARY_SETTING_KEYS.contactEmail),
    getSetting<string>(db, LIBRARY_SETTING_KEYS.unpaywallEmail),
    getSetting<string>(db, LIBRARY_SETTING_KEYS.grobidUrl),
    getSetting<LibrarySettings["zoteroLibrary"]>(db, LIBRARY_SETTING_KEYS.zoteroLibrary),
    readSecret(db, "openalexKey"),
    readSecret(db, "s2Key"),
    readSecret(db, "zoteroKey"),
  ]);
  return { contactEmail, unpaywallEmail, grobidUrl, zoteroLibrary, openalexKey: oa.value, s2Key: s2.value, zoteroKey: zot.value };
}

export async function librarySettingsView(db: Queryable): Promise<LibrarySettingsView> {
  const [s, oa, s2, zot] = await Promise.all([loadLibrarySettings(db), readSecret(db, "openalexKey"), readSecret(db, "s2Key"), readSecret(db, "zoteroKey")]);
  return {
    contact_email: s.contactEmail,
    unpaywall_email: s.unpaywallEmail,
    grobid_url: s.grobidUrl,
    openalex_api_key: { set: Boolean(oa.last4), last4: oa.last4 },
    s2_api_key: { set: Boolean(s2.last4), last4: s2.last4 },
    zotero_api_key: { set: Boolean(zot.last4), last4: zot.last4 },
    zotero_library: s.zoteroLibrary,
  };
}

export type LibrarySettingsPatch = {
  contactEmail?: string | null;
  unpaywallEmail?: string | null;
  grobidUrl?: string | null;
  openalexKey?: string | null;
  s2Key?: string | null;
  zoteroKey?: string | null;
  zoteroLibrary?: LibrarySettings["zoteroLibrary"];
};

/** `undefined` = unchanged, `null`/"" = remove. Secrets are encrypted (throws PlatformError without PROVIDER_TOKEN_KEY). */
export async function saveLibrarySettings(db: Queryable, patch: LibrarySettingsPatch, userId: string) {
  for (const name of ["contactEmail", "unpaywallEmail", "grobidUrl", "zoteroLibrary"] as const) {
    const v = patch[name];
    if (v === undefined) continue;
    if (v === null || v === "") await deleteSetting(db, LIBRARY_SETTING_KEYS[name]);
    else await setSetting(db, LIBRARY_SETTING_KEYS[name], v, userId);
  }
  for (const name of ["openalexKey", "s2Key", "zoteroKey"] as const) {
    const v = patch[name];
    if (v === undefined) continue;
    const key = LIBRARY_SETTING_KEYS[name];
    if (v === null || v === "") await deleteSetting(db, key);
    else await setSetting(db, key, { enc: encryptJson(v, aad(key)).toString("base64"), last4: v.slice(-4) } satisfies Encrypted, userId);
  }
  serviceCache = undefined;
}

export const libraryConfigOf = (s: LibrarySettings): LibraryConfig => ({
  contactEmail: s.contactEmail ?? undefined,
  unpaywallEmail: s.unpaywallEmail ?? s.contactEmail ?? undefined,
  openalexApiKey: s.openalexKey ?? undefined,
  s2ApiKey: s.s2Key ?? undefined,
  grobidUrl: s.grobidUrl ?? undefined,
});

let serviceCache: { stamp: string; service: LibraryService; at: number } | undefined;
/** Test hook: overrides the service built from settings (e.g. mock base URLs). */
let override: ((config: LibraryConfig) => LibraryService) | undefined;
export function setLibraryServiceFactory(factory: ((config: LibraryConfig) => LibraryService) | undefined) {
  override = factory;
  serviceCache = undefined;
}

/** The LibraryService for the current settings (rebuilt when a setting changes; rate limiters are process-wide). */
export async function libraryService(db: Queryable): Promise<{ service: LibraryService; settings: LibrarySettings }> {
  const settings = await loadLibrarySettings(db);
  const config = libraryConfigOf(settings);
  const stamp = JSON.stringify(config);
  if (!serviceCache || serviceCache.stamp !== stamp) serviceCache = { stamp, service: (override ?? createLibraryService)(config), at: Date.now() };
  return { service: serviceCache.service, settings };
}
