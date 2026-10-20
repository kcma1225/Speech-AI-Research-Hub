import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";

export async function GET() {
  await ensureSchema();
  return NextResponse.json({ status: "ok" });
}
