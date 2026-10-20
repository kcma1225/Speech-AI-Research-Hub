import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { ensureSchema } from "./schema";

export type CurrentUser = { id: string; name: string; role: "owner" | "admin" | "member" | "professor"; auth_mode: "either" | "two_factor"; theme: "system" | "light" | "dark" };
const COOKIE = "research_session";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const h = await headers();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await (await db()).query("INSERT INTO sessions (user_id,token_hash,expires_at,user_agent,ip) VALUES ($1,$2,$3,$4,$5)", [userId, hash(token), expires, h.get("user-agent"), h.get("x-real-ip")]);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.APP_ORIGIN?.startsWith("https"), path: "/", expires });
}

export async function currentUser(): Promise<CurrentUser | null> {
  await ensureSchema();
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const result = await (await db()).query<CurrentUser>(`SELECT u.id,u.name,u.role,u.auth_mode,u.theme FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`, [hash(token)]);
  return result.rows[0] ?? null;
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/");
  return user;
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await (await db()).query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
  jar.delete(COOKIE);
}

export const tokenHash = hash;
