import { NextResponse } from "next/server";

/** Same-origin write guard. Middleware applies it to most API writes; large-upload routes call it directly. */
export function crossOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN;
  if (expected && request.headers.get("origin") === expected) return null;
  return NextResponse.json({ error: "請從本站重新送出。" }, { status: 403 });
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => uuidPattern.test(value);
