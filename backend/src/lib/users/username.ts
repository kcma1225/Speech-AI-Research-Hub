import { pinyin } from "pinyin-pro";
import { z } from "zod";
import type { Db } from "../../db.js";
import { foldAscii, hasHan } from "../library/normalize.js";

/**
 * Accounts have two names: `username` (登入用的使用者名稱; unique case-insensitively, stored lower-case, only admins
 * change it) and `real_name` (真實姓名; shown wherever a person appears). `users.name` is a generated read-only copy of
 * `real_name` kept so every existing `u.name` read keeps showing the real name.
 */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const USERNAME_HINT = "使用者名稱需為 3–32 個字元，只能用小寫英文字母、數字與 . _ -，並以字母或數字開頭。";
export const USERNAME_TAKEN = "這個使用者名稱已被使用。";
export const REAL_NAME_HINT = "真實姓名需為 1–40 個字元。";

/** Accepts any case (stored lower-case) and surrounding whitespace. */
export const usernameSchema = z
  .string()
  .trim()
  .transform(value => value.toLowerCase())
  .refine(value => USERNAME_RE.test(value), { message: USERNAME_HINT });
export const realNameSchema = z
  .string()
  .transform(value => value.replace(/\s+/g, " ").trim())
  .refine(value => [...value].length >= 1 && [...value].length <= 40, { message: REAL_NAME_HINT });

const MAX = 32;
const trimSeparators = (s: string) => s.replace(/^[._-]+/, "").replace(/[._-]+$/, "");

/** ASCII slug for a username: Han characters via pinyin (陳柏宇 → chenboyu), Latin via accent folding, rest → "-". */
export function usernameSlug(name: string): string {
  let text = name.normalize("NFKC");
  if (hasHan(text)) {
    const chars = pinyin(text, { toneType: "none", type: "all", surname: "head", v: true }) as { origin: string; pinyin: string; isZh: boolean }[];
    // Consecutive Han syllables are joined (林雅婷 → linyating); a Han run is set apart from neighbouring Latin text.
    text = chars.map((c, i) => (c.isZh ? `${i > 0 && !chars[i - 1]!.isZh ? " " : ""}${c.pinyin}${chars[i + 1] && !chars[i + 1]!.isZh ? " " : ""}` : c.origin)).join("");
  }
  const slug = foldAscii(text)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/([._-])[._-]+/g, "$1");
  return trimSeparators(trimSeparators(slug).slice(0, MAX));
}

/** `base` made unique against `taken` (lower-case set) by a numeric suffix; short or empty bases fall back to user<N>. */
export function uniqueUsername(base: string, taken: Set<string>, fallbackIndex: number): string {
  let stem = base;
  if (!stem) stem = `user${fallbackIndex}`;
  const fits = (suffix: string) => trimSeparators(stem.slice(0, MAX - suffix.length)) + suffix;
  let candidate = stem.length >= 3 ? stem : fits("1");
  for (let n = 2; taken.has(candidate) || !USERNAME_RE.test(candidate); n++) {
    candidate = fits(String(n));
    if (n > 100_000) throw new Error("no free username");
  }
  taken.add(candidate);
  return candidate;
}

type Queryable = Pick<Db, "query">;

/** True when nobody (other than `exceptId`) uses this username, compared case-insensitively. */
export async function usernameAvailable(db: Queryable, username: string, exceptId?: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM users WHERE lower(username)=lower($1) AND ($2::uuid IS NULL OR id<>$2) LIMIT 1", [username, exceptId ?? null]);
  return !result.rowCount;
}

/**
 * Data step of migration 0103_usernames.sql (run by migrate() in the same transaction): derives a username for every
 * account that has none, oldest account first, then makes the column NOT NULL.
 */
export async function backfillUsernames(client: Queryable) {
  const rows = (await client.query<{ id: string; real_name: string; username: string | null }>(
    "SELECT id,real_name,username FROM users ORDER BY created_at,id",
  )).rows;
  const taken = new Set(rows.flatMap(r => (r.username ? [r.username.toLowerCase()] : [])));
  let index = 0;
  for (const row of rows) {
    index++;
    if (row.username) continue;
    const username = uniqueUsername(usernameSlug(row.real_name), taken, index);
    await client.query("UPDATE users SET username=$1 WHERE id=$2", [username, row.id]);
  }
  await client.query("ALTER TABLE users ALTER COLUMN username SET NOT NULL");
}
