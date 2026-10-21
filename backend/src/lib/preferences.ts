import { z } from "zod";

/** Per-user UI preferences stored in `users.preferences` (jsonb). Missing keys mean the default. */
const groups = {
  notify: z.object({
    slideRendered: z.boolean().default(true),
    mediaTranscoded: z.boolean().default(true),
    reviews: z.boolean().default(true),
    replies: z.boolean().default(true),
    /** A study task was assigned to you. */
    tasks: z.boolean().default(true),
  }),
  editor: z.object({
    fontSize: z.number().int().min(12).max(22).default(15),
    layout: z.enum(["split", "edit", "preview"]).default("split"),
  }),
};
export const preferencesSchema = z.object({ notify: groups.notify.prefault({}), editor: groups.editor.prefault({}) });

export type Preferences = z.infer<typeof preferencesSchema>;
/** Which `notify` preference gates a Web Push. */
export type NotifyPref = keyof Preferences["notify"];

export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({});

/** Deep-partial update accepted by `PATCH /auth/profile`; unknown keys are rejected. */
export const preferencesPatchSchema = z.strictObject({
  notify: z.strictObject({
    slideRendered: z.boolean().optional(),
    mediaTranscoded: z.boolean().optional(),
    reviews: z.boolean().optional(),
    replies: z.boolean().optional(),
    tasks: z.boolean().optional(),
  }).optional(),
  editor: z.strictObject({
    fontSize: z.number().int().min(12).max(22).optional(),
    layout: z.enum(["split", "edit", "preview"]).optional(),
  }).optional(),
});

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Stored value with defaults filled in. Tolerates anything in the column: each field that is missing
 * or invalid falls back to its default, and unknown keys are dropped.
 */
export function resolvePreferences(stored: unknown): Preferences {
  const source = isRecord(stored) ? stored : {};
  const result: Preferences = structuredClone(DEFAULT_PREFERENCES);
  for (const group of ["notify", "editor"] as const) {
    const values = source[group];
    if (!isRecord(values)) continue;
    const shape = groups[group].shape as Record<string, z.ZodType>;
    for (const [key, schema] of Object.entries(shape)) {
      if (!(key in values)) continue;
      const parsed = schema.safeParse(values[key]);
      if (parsed.success) (result[group] as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return result;
}

/** Applies a validated patch on top of the stored value; returns the full resolved preferences. */
export function mergePreferences(stored: unknown, patch: PreferencesPatch): Preferences {
  const current = resolvePreferences(stored);
  return {
    notify: { ...current.notify, ...stripUndefined(patch.notify) },
    editor: { ...current.editor, ...stripUndefined(patch.editor) },
  };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}
